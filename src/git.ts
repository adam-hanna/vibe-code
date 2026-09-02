import { run, resolveBin } from '@src/proc.js';
import { detail, warn } from '@src/log.js';

let cachedBin: string | null = null;

export function gitBin(): string {
  cachedBin ??= resolveBin('git', { envVar: 'VIBE_GIT_BIN' });
  return cachedBin;
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * `raw` returns stdout untouched. Off at every call site that predates #49, so
 * those are byte-for-byte what they always were.
 *
 * The trim is right for a sha, a branch name or a porcelain status, and wrong
 * for two things this file now reads: a NUL-separated path list, where a
 * filename may legitimately begin or end with whitespace, and a patch body,
 * where trailing whitespace on the last changed line is *review content* - and
 * silently rewriting it would have the tool show the reviewer something other
 * than the change.
 */
async function git(
  cwd: string,
  args: readonly string[],
  options: { allowFail?: boolean; raw?: boolean } = {},
): Promise<GitResult> {
  const { code, stdout, stderr } = await run(gitBin(), args, { cwd });
  if (code !== 0 && !options.allowFail) {
    throw new Error(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`);
  }
  return {
    code,
    stdout: options.raw === true ? stdout : stdout.trim(),
    stderr: stderr.trim(),
  };
}

/**
 * Split `--name-only -z` output into paths.
 *
 * Empty output is NO files, not one nameless one: `''.split('\0')` is `['']`,
 * which would put a phantom empty entry in the reviewer's file list and in
 * `state.reviewCoverage` - a file the run claims to have shown and cannot name.
 *
 * Nothing else is filtered and nothing is trimmed, so `" x "` and `"a\nb"`
 * survive as themselves. That is the whole reason for `-z`: under
 * `core.quotePath` the newline-separated form would come back quoted, and the
 * quoted name does not match the path handed back to `git diff --`.
 */
export function splitNul(out: string): string[] {
  if (out === '') return [];
  const body = out.endsWith('\0') ? out.slice(0, -1) : out;
  return body === '' ? [] : body.split('\0');
}

/**
 * Remove ONE trailing newline, and nothing else.
 *
 * Each per-file patch ends with a newline that would double up when the pieces
 * are joined with one. `trim()` would also eat trailing spaces on the final
 * changed line, which is exactly the content that must survive.
 */
function stripFinalNewline(out: string): string {
  if (out.endsWith('\r\n')) return out.slice(0, -2);
  if (out.endsWith('\n')) return out.slice(0, -1);
  return out;
}

export async function isRepo(cwd: string): Promise<boolean> {
  const { code } = await git(cwd, ['rev-parse', '--git-dir'], { allowFail: true });
  return code === 0;
}

/**
 * `isRepo`, made total: the answer, and why it could not be obtained.
 *
 * `isRepo` passes `allowFail`, which covers only a git that ran and exited
 * nonzero. It still throws when the binary cannot be *resolved* - `VIBE_GIT_BIN`
 * pointing at a missing file, or nothing named `git` on PATH - or cannot be
 * spawned at all, because `resolveBin` throws and `run` rejects. A caller whose
 * job is to decide an exit code cannot tell those apart from a crash, and would
 * report a broken git as a generic error instead of as the environment fault it
 * is (#71, review round 1).
 *
 * Here they are an answer rather than an exception: not a repository, and the
 * reason. This is fail-closed and not a silent degrade - the reason is carried
 * out for the caller to say out loud, never discarded.
 */
export async function repoStatus(cwd: string): Promise<{ isRepo: boolean; error: string | null }> {
  try {
    return { isRepo: await isRepo(cwd), error: null };
  } catch (err) {
    return { isRepo: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const { stdout } = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  return stdout || null;
}

export async function hasCommits(cwd: string): Promise<boolean> {
  const { code } = await git(cwd, ['rev-parse', 'HEAD'], { allowFail: true });
  return code === 0;
}

export async function isDirty(cwd: string): Promise<boolean> {
  const { stdout } = await git(cwd, ['status', '--porcelain']);
  return stdout.length > 0;
}

export async function createBranch(cwd: string, name: string): Promise<void> {
  await git(cwd, ['checkout', '-b', name]);
  detail(`on branch ${name}`);
}

/** A full object id, never an abbreviation: 40 lowercase hex characters. */
const FULL_SHA = /^[0-9a-f]{40}$/;

export function isFullSha(v: unknown): v is string {
  return typeof v === 'string' && FULL_SHA.test(v);
}

/**
 * The canonical 40-hex id `sha` names, or null. Never throws.
 *
 * `^{commit}` so a tag or a tree is not accepted as a commit, and callers
 * compare the answer to what they stored rather than adopting it: a checkpoint
 * that recorded an abbreviation, a branch name or a tag would otherwise resolve
 * to *something*, and forking from "whatever `main` means today" is not forking
 * from the commit the round produced.
 */
export async function resolveCommit(cwd: string, sha: string): Promise<string | null> {
  const { code, stdout } = await git(cwd, ['rev-parse', '--verify', '--quiet', sha], {
    allowFail: true,
  });
  if (code !== 0 || !isFullSha(stdout)) return null;
  // The object type in its own call rather than `<sha>^{commit}` peel syntax:
  // git 2.31 answers "Needed a single revision" to that form under `--verify`,
  // and `^` is cmd.exe's escape character besides. Two plain invocations answer
  // the same question everywhere.
  const { code: typed, stdout: kind } = await git(cwd, ['cat-file', '-t', stdout], {
    allowFail: true,
  });
  return typed === 0 && kind === 'commit' ? stdout : null;
}

export async function branchExists(cwd: string, name: string): Promise<boolean> {
  const { code } = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], {
    allowFail: true,
  });
  return code === 0;
}

/**
 * `git branch <name> <sha>`: creates the REF only.
 *
 * HEAD, the index and the working tree are untouched, which is the whole
 * difference from `createBranch` above. `vibe fork` creates a run and stops; it
 * has no business moving the user's tree, and the forked run checks its own
 * branch out when it is actually resumed (`prepareGit`).
 *
 * Reports failure rather than throwing: `commitFork` has to roll back what it
 * created before it refuses, which it cannot do from inside a throw it did not
 * expect.
 */
export async function createBranchRef(
  cwd: string,
  name: string,
  sha: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { code, stderr } = await git(cwd, ['branch', name, sha], { allowFail: true });
  return code === 0 ? { ok: true } : { ok: false, error: stderr };
}

/** `git branch -D <name>`, for a ref this process created moments ago and is rolling back. */
export async function deleteBranchRef(cwd: string, name: string): Promise<boolean> {
  const { code } = await git(cwd, ['branch', '-D', name], { allowFail: true });
  return code === 0;
}

/** `git checkout <name>` for a branch that already exists. Reports failure rather than throwing. */
export async function checkoutBranch(
  cwd: string,
  name: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { code, stderr } = await git(cwd, ['checkout', name], { allowFail: true });
  if (code === 0) {
    detail(`on branch ${name}`);
    return { ok: true };
  }
  return { ok: false, error: stderr };
}

/** Diff marker for the implementation. Null in a repo with no commits yet. */
export async function markBase(cwd: string): Promise<string | null> {
  if (!(await hasCommits(cwd))) return null;
  const { stdout } = await git(cwd, ['rev-parse', 'HEAD']);
  return stdout;
}

/**
 * What a commit attempt did.
 *
 * `string | null` could not tell "there was nothing to commit" from "the commit
 * failed", and a checkpoint has to record which: one is a round that changed no
 * files, the other is a round whose work is not in the history at all.
 */
export type CommitResult = { sha: string } | { sha: null; why: 'nothing-to-commit' | 'failed' };

export async function commitAll(cwd: string, message: string): Promise<CommitResult> {
  // vibe's own run directory is kept out of the user's history by the
  // `.gitignore` written inside `.vibe` itself (see `ensureVibeIgnored`), not
  // by a pathspec here. `:(exclude).vibe` was worse than useless: git counts a
  // negative pathspec as explicitly naming the path, so the moment the target
  // repo's own .gitignore also listed `.vibe` - the obvious thing for a user to
  // write - `add` failed with "the following paths are ignored", exit 1, and
  // took the run down after the implementation had already been paid for.
  await git(cwd, ['add', '-A', '--', '.']);
  // Ask what is *staged*, not what is dirty. `.vibe` stays permanently
  // untracked by design, so a working-tree check would always report pending
  // work and every no-op round would attempt an empty commit.
  const { stdout: staged } = await git(cwd, ['diff', '--cached', '--name-only']);
  if (!staged) {
    detail('nothing to commit');
    return { sha: null, why: 'nothing-to-commit' };
  }
  const { code, stderr } = await git(cwd, ['commit', '-m', message], { allowFail: true });
  if (code !== 0) {
    warn(`commit failed: ${stderr}`);
    return { sha: null, why: 'failed' };
  }
  // The FULL sha, not `--short`. An abbreviation is unique in the repo it was
  // taken from at the moment it was taken; a checkpoint is read months later,
  // by which point the same seven characters may be ambiguous or name another
  // commit entirely - and forking from the wrong commit is not a failure a
  // reader could spot.
  const { stdout: sha } = await git(cwd, ['rev-parse', 'HEAD']);
  return { sha };
}

/**
 * The ceiling on what one reviewer turn is shown. Shared by `diffSince` and
 * `diffChunks` so the single-chunk path and the packer cannot disagree about
 * where "too big" starts. The figure itself is unchanged by #49 - raising it
 * would move the hole, not close it.
 */
const DIFF_MAX_CHARS = 400_000;

/** What a cut diff says, in both the whole-diff and the per-file case. */
function truncationMarker(maxChars: number): string {
  return `\n\n[... diff truncated at ${maxChars} chars - review the working tree directly ...]`;
}

/**
 * The diff handed to the reviewer. Falls back to staged-everything in a repo
 * with no baseline commit, so a greenfield run still gets reviewed.
 */
export async function diffSince(
  cwd: string,
  baseSha: string | null,
  options: { maxChars?: number } = {},
): Promise<string> {
  const maxChars = options.maxChars ?? DIFF_MAX_CHARS;
  let out: string;

  if (baseSha) {
    ({ stdout: out } = await git(cwd, ['diff', `${baseSha}..HEAD`]));
    if (!out) ({ stdout: out } = await git(cwd, ['diff', 'HEAD']));
  } else {
    await git(cwd, ['add', '-A'], { allowFail: true });
    ({ stdout: out } = await git(cwd, ['diff', '--cached']));
  }

  if (out.length > maxChars) {
    return out.slice(0, maxChars) + truncationMarker(maxChars);
  }
  return out;
}

/** One reviewer turn's worth of the change: whole files, in git's order. */
export interface DiffChunk {
  files: string[];
  diff: string;
  /** Files whose own diff exceeded the limit and was cut inside this chunk. */
  truncated: string[];
}

/**
 * The diff mode, decided ONCE, plus the whole diff it produced.
 *
 * A diff and a separately-taken `--name-only` read can describe different
 * changes: `diffSince` falls back to the working tree when `baseSha..HEAD` is
 * empty, and the file list `changedFiles` took did not, so with
 * `git.commitEachRound: false` the reviewer used to be handed a working-tree
 * diff beside an EMPTY file list. Harmless while the list was decoration; fatal
 * once the list is what the change is chunked by, since the reviewer would be
 * handed nothing at all (#49). That is why the mode is decided here, once, and
 * why both reads below are built from the same `prefix`.
 *
 * `changedFiles` itself is gone (#93): it was left behind by #49 with no caller,
 * still diverging, and still answering `[]` where it meant "I could not look".
 *
 * The whole diff comes back through the trimming read on purpose: it is what
 * the single-chunk path returns verbatim, and it has to stay byte-identical to
 * `diffSince`.
 */
async function resolveDiffMode(
  cwd: string,
  baseSha: string | null,
): Promise<{ prefix: string[]; whole: string }> {
  if (baseSha) {
    let { stdout: whole } = await git(cwd, ['diff', `${baseSha}..HEAD`]);
    if (whole) return { prefix: ['diff', `${baseSha}..HEAD`], whole };
    ({ stdout: whole } = await git(cwd, ['diff', 'HEAD']));
    return { prefix: ['diff', 'HEAD'], whole };
  }
  await git(cwd, ['add', '-A'], { allowFail: true });
  const { stdout: whole } = await git(cwd, ['diff', '--cached']);
  return { prefix: ['diff', '--cached'], whole };
}

/**
 * The change, split into as many reviewer turns as it takes.
 *
 * The unit is a whole file: it is the natural boundary for a review comment,
 * and it is what the file list already gives. Greedy first-fit in git's own
 * order rather than optimal bin-packing - a split a human can predict from
 * `git diff --name-only` is worth more than a tighter one.
 *
 * A file whose own diff exceeds `maxChars` is still cut, inside its own chunk,
 * and named in `truncated`. Splitting it by `@@` hunks would need the
 * `diff --git`/`---`/`+++` header reconstructed onto every piece - a second
 * mechanism with its own failure mode - so it is recorded rather than silent,
 * which is the half of #49 that mattered.
 *
 * Under the limit this returns the whole diff verbatim as one chunk and makes
 * no per-file call at all, so an ordinary round is the same string `diffSince`
 * has always produced, from the same command.
 *
 * Considered and rejected: splitting the whole diff on `^diff --git ` instead of
 * asking git per file. It saves n subprocesses but needs the `a/`.../`b/` header
 * paths parsed - quoting, renames, mode-only changes - to name each piece, and
 * the name is precisely what `reviewCoverage` and `truncated` assert on.
 */
export async function diffChunks(
  cwd: string,
  baseSha: string | null,
  options: { maxChars?: number } = {},
): Promise<{ chunks: DiffChunk[]; files: string[] }> {
  const maxChars = options.maxChars ?? DIFF_MAX_CHARS;
  const { prefix, whole } = await resolveDiffMode(cwd, baseSha);

  // Before the size branch, not after it: both paths return this list, and the
  // caller needs it for the prompt and for the coverage record even when there
  // is only one chunk.
  //
  // `--literal-pathspecs` because `--` separates options from paths but does NOT
  // disable pathspec magic: a file honestly named `[x].txt` would otherwise be
  // read as a glob and match something else, or nothing, while still being
  // recorded as covered. `--no-renames` so this list and the per-file diffs
  // below describe the same set of files - `--name-only` reports only a
  // rename's destination, and the diff for that destination can be empty.
  const listArgs = ['--literal-pathspecs', ...prefix, '--name-only', '-z', '--no-renames'];
  const { stdout: listed } = await git(cwd, listArgs, { raw: true });
  const files = splitNul(listed);

  if (whole.length <= maxChars) {
    return { chunks: [{ files: [...files], diff: whole, truncated: [] }], files };
  }

  const chunks: DiffChunk[] = [];
  let current: DiffChunk = { files: [], diff: '', truncated: [] };

  for (const file of files) {
    const args = ['--literal-pathspecs', ...prefix, '--no-renames', '--', file];
    const { stdout } = await git(cwd, args, { raw: true });
    let body = stripFinalNewline(stdout);
    const oversized = body.length > maxChars;
    if (oversized) body = body.slice(0, maxChars) + truncationMarker(maxChars);

    // The separator counts. Without it a chunk of two files could exceed the
    // limit by the byte the join adds, which is the sort of off-by-one that
    // only shows up on the one diff that lands exactly on the boundary.
    const separator = current.files.length > 0 ? 1 : 0;
    const fits = current.diff.length + separator + body.length <= maxChars;
    if (current.files.length > 0 && (oversized || !fits)) {
      chunks.push(current);
      current = { files: [], diff: '', truncated: [] };
    }

    // Keyed on the file count, exactly as `separator` above is, so the join and
    // the size accounting cannot disagree. They differ only for a file whose own
    // diff is empty, which nothing here is known to produce - `--no-renames`
    // makes a rename a delete plus an add, and a mode-only change still prints
    // its mode lines. So this buys the two rules one definition rather than
    // fixing an observed defect, and no test claims otherwise (#49 review).
    const first = current.files.length === 0;
    current.files.push(file);
    current.diff = first ? body : `${current.diff}\n${body}`;
    if (oversized) {
      current.truncated.push(file);
      chunks.push(current);
      current = { files: [], diff: '', truncated: [] };
    }
  }

  // The trailing chunk, and the empty-change case: a run that reaches here with
  // nothing packed still gets one chunk, because "no chunks" is not a thing the
  // caller can review.
  if (current.files.length > 0 || chunks.length === 0) chunks.push(current);
  return { chunks, files };
}

