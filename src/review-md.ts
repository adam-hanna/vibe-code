import { gitBin } from '@src/git.js';
import { redact, secrets } from '@src/heldkeys.js';
import { run } from '@src/proc.js';
import { recordAndSay } from '@src/run.js';
import type { ReviewStandards } from '@src/prompts.js';
import type { ReviewMdRecord, RunState } from '@src/types.js';

/**
 * The repository's own review standards (#389): a `REVIEW.md` at the root of
 * the commit the run started from, handed to the reviewer, every additional
 * finder and the verifiers - and to no other role.
 *
 * **Read from the start commit only, never the working tree.** That is the
 * whole point: a run that adds or edits `REVIEW.md` changes the NEXT run's
 * review, never its own, so a change cannot weaken the review it is about to
 * receive. Anthropic's Code Review reads its `REVIEW.md` from the base branch
 * for the same reason.
 */
export const REVIEW_MD = 'REVIEW.md';

/**
 * Over this, the run log, the summary and doctor say so - as a warning, never
 * as a limit: the file is always sent whole, with no cap and no truncation.
 *
 * 32 KiB is the limit Codex applies to `AGENTS.md` (it reads only the first
 * 32 KiB of one). It is borrowed here as "long enough that standing text is
 * read less carefully". It was NOT measured for this purpose, and nothing
 * here claims a model reads a 33 KiB file worse than a 31 KiB one.
 */
export const REVIEW_MD_WARN_BYTES = 32 * 1024;

export type ReviewMdRead =
  | { kind: 'present'; text: string; blob: string; bytes: number }
  | { kind: 'absent' }
  | { kind: 'refused' | 'unreadable'; reason: string };

/** "812 bytes" or "4.1 KiB": a size as a reader says it, from git's own count. */
export function describeBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KiB`;
}

const short = (sha: string): string => sha.slice(0, 7);

/** A child's failure as a sentence, redacted: these reasons reach logs and state. */
function failure(what: string, code: number | null, stderr: string): string {
  return redact(`${what} exited ${String(code)}: ${stderr.trim() || 'it printed nothing'}`);
}

function thrown(what: string, err: unknown): string {
  return redact(`${what} could not be run: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * `REVIEW.md` at the root of `sha`, as committed. Never throws.
 *
 * `ls-tree` for the mode and the object id, then `cat-file blob` - never
 * `git show <sha>:REVIEW.md`, which follows nothing but cannot tell a symlink
 * from a file either: it prints a link's target path as though it were the
 * text. A link or a submodule is refused, the link rule of #53: following one
 * would read something that was never committed as `REVIEW.md`.
 *
 * **Both reads skip `run`'s redaction.** A held key that happened to occur
 * inside the hex object id would otherwise turn it into `[redacted key]` and a
 * valid file would fail to load; and a redacted text is not the file the
 * owners committed while the blob id and size still describe it. So the text
 * is sent verbatim or not at all: a file that contains a key vibe holds is
 * refused, because sending it would put the key in a prompt and a transcript.
 */
export async function readReviewMd(cwd: string, sha: string): Promise<ReviewMdRead> {
  // Every reason is redacted HERE, at the one exit, rather than at each site:
  // a held key can be any string of eight or more characters - "REVIEW.md"
  // included - so even a fixed sentence can carry one, and these reasons are
  // recorded in state, narrated, and shown by doctor and the settings note.
  const read = await readUnredacted(cwd, sha);
  return read.kind === 'refused' || read.kind === 'unreadable' ? { ...read, reason: redact(read.reason) } : read;
}

async function readUnredacted(cwd: string, sha: string): Promise<ReviewMdRead> {
  const list = `git ls-tree ${short(sha)}`;
  let listed: { code: number | null; stdout: string; stderr: string };
  try {
    listed = await run(gitBin(), ['ls-tree', '-l', sha, '--', REVIEW_MD], { cwd, redact: false });
  } catch (err: unknown) {
    return { kind: 'unreadable', reason: thrown(list, err) };
  }
  // A commit that does not exist, a corrupt repository: not "no such path", so
  // never rendered as absent in silence.
  if (listed.code !== 0) return { kind: 'unreadable', reason: failure(list, listed.code, listed.stderr) };
  const line = listed.stdout.replace(/\n$/, '');
  if (line === '') return { kind: 'absent' };

  // `<mode> <type> <oid> <size>\t<path>`; the size is `-` for a submodule.
  const m = /^(\d{6}) (\w+) ([0-9a-f]{40,64}) +(\S+)\t/.exec(line);
  if (m === null) {
    return { kind: 'unreadable', reason: redact(`${list} printed a line vibe could not read: ${line}`) };
  }
  const [, mode, type, oid, size] = m as unknown as [string, string, string, string, string];
  if (mode === '120000') {
    return { kind: 'refused', reason: 'REVIEW.md is a symbolic link; vibe does not follow it (#53)' };
  }
  if (mode === '160000') return { kind: 'refused', reason: 'REVIEW.md is a submodule, not a file' };
  if (type === 'tree') return { kind: 'refused', reason: 'REVIEW.md is a directory, not a file' };
  if (type !== 'blob' || (mode !== '100644' && mode !== '100755') || !/^\d+$/.test(size)) {
    return { kind: 'refused', reason: `REVIEW.md is not a regular file (mode ${mode}, ${type})` };
  }

  const cat = `git cat-file blob ${short(oid)}`;
  let blob: { code: number | null; stdout: string; stderr: string };
  try {
    blob = await run(gitBin(), ['cat-file', 'blob', oid], { cwd, redact: false });
  } catch (err: unknown) {
    return { kind: 'unreadable', reason: thrown(cat, err) };
  }
  if (blob.code !== 0) return { kind: 'unreadable', reason: failure(cat, blob.code, blob.stderr) };
  if (secrets().some((k) => blob.stdout.includes(k))) {
    return {
      kind: 'refused',
      reason:
        'REVIEW.md contains a key vibe holds; it is not sent, so the key never reaches a prompt or a transcript',
    };
  }
  return { kind: 'present', text: blob.stdout, blob: oid, bytes: Number(size) };
}

/**
 * One sentence about what a read found at a commit, shared by the run's
 * narration and `vibe doctor` so the two never word the same fact twice.
 * `at` names where the commit came from - `HEAD`, a ref - or is null.
 */
export function describeReviewMdAt(at: string | null, sha: string, read: ReviewMdRead): string {
  const where = at === null ? short(sha) : `${at} (${short(sha)})`;
  switch (read.kind) {
    case 'present':
      return `REVIEW.md at ${where}, ${describeBytes(read.bytes)}${overWarning(read.bytes)}`;
    case 'absent':
      return `No REVIEW.md at ${where}`;
    default:
      return `REVIEW.md at ${where} is ${read.kind}: ${read.reason}`;
  }
}

/** The size warning's clause, or nothing. Never a limit: the file is sent whole. */
export function overWarning(bytes: number): string {
  return bytes > REVIEW_MD_WARN_BYTES
    ? ' - over 32 KiB, long enough that standing text may be read less carefully; it is sent whole'
    : '';
}

/**
 * What this process has already settled for each run, keyed by the state
 * object: null when the reviewer gets nothing.
 *
 * Read ONCE per run, at the first review, and the answer is reused by every
 * later round in the same process - a transient git failure on round three
 * must not withdraw standards rounds one and two were given. A resume loads a
 * new state object, so it misses here and does its own re-read and blob check.
 */
const answered = new WeakMap<RunState, ReviewStandards | null>();

/**
 * The repository's review standards for this run's review turns, or undefined.
 *
 * The first review reads from `start.sha`, else `baseSha` - the commit the run
 * started at - and records the outcome together with its one `review_md`
 * narration in a single write, so the record never exists without the event
 * that says it. A resumed run re-reads the recorded commit and requires the
 * recorded blob; a mismatch means the record and the repository disagree, and
 * it fails closed: a warning, and nothing sent.
 */
export async function reviewStandardsFor(
  state: RunState,
  cwd: string,
): Promise<ReviewStandards | undefined> {
  if (answered.has(state)) return answered.get(state) ?? undefined;
  const settle = (value: ReviewStandards | null): ReviewStandards | undefined => {
    answered.set(state, value);
    return value ?? undefined;
  };

  const record = state.reviewMd;
  if (record === undefined) {
    const commit = state.start?.sha ?? state.baseSha;
    // No commit at all: a repository with nothing committed has no REVIEW.md.
    if (commit === null) return settle(null);
    const read = await readReviewMd(cwd, commit);
    state.reviewMd = toRecord(commit, read);
    const data: Record<string, unknown> = { commit, outcome: read.kind };
    if (read.kind === 'present') data['bytes'] = read.bytes;
    if (read.kind === 'refused' || read.kind === 'unreadable') data['reason'] = read.reason;
    if (read.kind === 'present') {
      recordAndSay(
        state,
        read.bytes > REVIEW_MD_WARN_BYTES ? 'warn' : 'info',
        'review_md',
        `REVIEW.md read from ${short(commit)} (${describeBytes(read.bytes)})${overWarning(read.bytes)}`,
        data,
      );
      return settle({ text: read.text, commit });
    }
    if (read.kind === 'absent') {
      recordAndSay(state, 'info', 'review_md', `No REVIEW.md at ${short(commit)}`, data);
    } else {
      recordAndSay(
        state,
        'warn',
        'review_md',
        `REVIEW.md at ${short(commit)} was not given to the reviewer: ${read.reason}`,
        data,
      );
    }
    return settle(null);
  }

  // A record from an earlier process: nothing to send unless it was present.
  if (record.outcome !== 'present') return settle(null);
  const again = await readReviewMd(cwd, record.commit);
  if (again.kind === 'present' && again.blob === record.blob) {
    return settle({ text: again.text, commit: record.commit });
  }
  const found = again.kind === 'present' ? `blob ${again.blob}` : again.kind === 'absent' ? 'no REVIEW.md' : again.reason;
  const reason = redact(
    `the recorded blob ${String(record.blob)} no longer matches what ${short(record.commit)} holds (${found})`,
  );
  state.reviewMd = { ...record, outcome: 'unreadable', reason };
  recordAndSay(
    state,
    'warn',
    'review_md_mismatch',
    `REVIEW.md was not given to the reviewer: ${reason}`,
    { commit: record.commit, blob: record.blob, reason },
  );
  return settle(null);
}

function toRecord(commit: string, read: ReviewMdRead): ReviewMdRecord {
  switch (read.kind) {
    case 'present':
      return { commit, outcome: 'present', blob: read.blob, bytes: read.bytes };
    case 'absent':
      return { commit, outcome: 'absent' };
    default:
      return { commit, outcome: read.kind, reason: read.reason };
  }
}
