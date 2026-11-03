import type { AgentProvider } from '@src/runtime.js';
import type {
  FileChange,
  JudgeBlob,
  JudgeFile,
  JudgeSeatVerdict,
  JudgeVerdict,
  VerifyConfig,
} from '@src/types.js';

/**
 * A change that touches the run's own judge (#112).
 *
 * The gate is the thing that decides a run is done, and the tests and
 * `vibe.config.json` are what the gate runs. So a round that edits them is
 * grading its own homework - and on PR #110's run it did, rewriting an
 * assertion in `tests/fork.test.ts`, with the gate green and the reviewer
 * silent. This module decides which changed files are part of the judge and
 * pairs each with the reviewer's verdict. It measures nothing itself and
 * judges nothing: the facts come from git, the verdict from the reviewer.
 *
 * Nothing here blocks anything. It makes such a change impossible to pass in
 * silence, which is option 1 of the issue and the whole of what was decided.
 *
 * The review is not the only place the judge can be edited (#485). The final
 * fix is never reviewed again, and neither are the verify fixes after it, so
 * `editedAfterReview` compares the judge files before and after that road, by
 * content. It asks nothing of anyone either: what it lists is a fact from git.
 */

/**
 * Where tests conventionally live, across the ecosystems this tool is run on.
 *
 * **A naming convention, not a measurement.** Nobody counted which patterns
 * catch which share of real test files; these are the spellings test runners
 * document as defaults. That is why `verify.testPaths` *replaces* the list
 * rather than extending it: a project whose tests live elsewhere knows that
 * better than a list here can.
 */
export const DEFAULT_TEST_PATHS: readonly string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/test_*.py',
  '**/*_test.py',
  '**/*_test.go',
];

/**
 * Always part of the judge, whatever `verify.testPaths` says - including `[]`.
 *
 * The gate commands live in it, so editing it is the most direct way to change
 * what decides the run passed, and vibe knows that without guessing. Matched at
 * the work directory's root only: a `vibe.config.json` in a subdirectory is not
 * the file vibe reads.
 */
export const CONFIG_FILE = 'vibe.config.json';

/**
 * Always part of the judge too, root-exact like `CONFIG_FILE` (#389).
 *
 * The repository's review standards. A run reads them from the commit it
 * started at, so an edit here does not change THIS run's review - it weakens
 * the NEXT one's, which is exactly why the reviewer is asked whether the plan
 * called for it. A `REVIEW.md` in a subdirectory is not the file vibe reads.
 */
export const REVIEW_FILE = 'REVIEW.md';

/**
 * A glob as an anchored regular expression: `*`, `**` and `?`, nothing else.
 *
 * Hand-written rather than `path.matchesGlob`, which arrived in Node 22 while
 * `engines` says 20, and rather than a dependency, because the published
 * package has none. Paths are git's spelling - `/`-separated, repo-relative.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === '*' && pattern[i + 1] === '*') {
      const atStart = i === 0 || pattern[i - 1] === '/';
      const slashAfter = pattern[i + 2] === '/';
      if (atStart && slashAfter) {
        // `**/` - zero or more whole directories.
        out += '(?:.*/)?';
        i += 3;
      } else {
        out += '.*';
        i += 2;
      }
      continue;
    }
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

export function matchesGlob(file: string, pattern: string): boolean {
  return globToRegExp(pattern).test(file);
}

/** The patterns in force: the configured list, or the conventions above. */
export function judgePatterns(verify: Pick<VerifyConfig, 'testPaths'>): readonly string[] {
  return verify.testPaths ?? DEFAULT_TEST_PATHS;
}

/**
 * What the record names as matched against, `vibe.config.json` and
 * `REVIEW.md` included.
 *
 * Included because it is in force: a record reading `patterns: []` beside a
 * config-file entry would name less than was actually matched. The matching
 * itself stays root-exact in `isJudge`; this list is only what the record says.
 */
export function recordedPatterns(patterns: readonly string[]): string[] {
  return [...new Set([...patterns, CONFIG_FILE, REVIEW_FILE])];
}

export function isJudge(file: string, patterns: readonly string[]): boolean {
  return file === CONFIG_FILE || file === REVIEW_FILE || patterns.some((p) => matchesGlob(file, p));
}

/**
 * The changes that touch the judge. A rename counts if EITHER side matches:
 * otherwise moving a test out of `tests/` is exactly how one would disappear.
 */
export function judgeChanges(
  changes: readonly FileChange[],
  patterns: readonly string[],
): FileChange[] {
  return changes.filter(
    (c) => isJudge(c.path, patterns) || (c.oldPath !== null && isJudge(c.oldPath, patterns)),
  );
}

/** One verdict as the reviewer returned it, before it is attached to anything. */
export interface RawVerdict {
  file: string;
  justified: boolean;
  reason: string;
}

/**
 * Pair the files each part listed with the verdicts that part returned.
 *
 * Three rules, each fail-closed:
 *
 * - **A verdict attaches only to a file listed in the part that returned it**,
 *   by its path or, for a rename, its old path. One naming a file nobody listed
 *   attaches to nothing - it must never satisfy a different file.
 * - **The first verdict wins.** Parts in order, which is git's file order, then
 *   the order within a part, so the same turns always produce the same record.
 *   A later contradictory entry is ignored rather than allowed to replace the
 *   one already stated; quietly overwriting is how a record ends up saying
 *   something the reviewer said once and then took back without anyone seeing.
 * - **A listed file with no verdict is `unjudged`**, never justified. That is
 *   the case this whole issue exists to catch.
 *
 * A file listed in more than one part - a rename whose sides fell in different
 * chunks - is one entry, in the order it was first shown.
 */
export function attachVerdicts(
  listedPerPart: readonly (readonly FileChange[])[],
  verdictsPerPart: readonly (readonly RawVerdict[])[],
): JudgeFile[] {
  const out = new Map<string, JudgeFile>();
  for (const [i, listed] of listedPerPart.entries()) {
    for (const change of listed) {
      if (!out.has(change.path)) out.set(change.path, { ...change, verdict: 'unjudged' });
    }
    for (const raw of verdictsPerPart[i] ?? []) {
      const name = raw.file.trim();
      const target = listed.find((c) => c.path === name || (c.oldPath !== null && c.oldPath === name));
      if (target === undefined) continue;
      const entry = out.get(target.path);
      if (entry === undefined || entry.verdict !== 'unjudged') continue;
      const verdict: JudgeVerdict = { justified: raw.justified, reason: raw.reason };
      entry.verdict = verdict;
    }
  }
  return [...out.values()];
}

export interface TestChangeCounts {
  files: number;
  justified: number;
  notJustified: number;
  unjudged: number;
}

export function testChangeCounts(files: readonly JudgeFile[]): TestChangeCounts {
  let justified = 0;
  let notJustified = 0;
  let unjudged = 0;
  for (const f of files) {
    if (f.verdict === 'unjudged') unjudged += 1;
    else if (f.verdict.justified) justified += 1;
    else notJustified += 1;
  }
  return { files: files.length, justified, notJustified, unjudged };
}

/** One review seat's judge files, each with that seat's own verdict (#404). */
export interface SeatJudgement {
  seat: string;
  provider: AgentProvider;
  model: string;
  /** `attachVerdicts` over the round's listed files and this seat's verdicts. */
  files: JudgeFile[];
}

/**
 * The round's judge record from every seat that reported, failing closed (#404).
 *
 * Per file: any seat that said not justified makes it not justified; otherwise
 * any seat that left it unjudged makes it unjudged; only when every seat said
 * justified is it justified. A dissent is never outvoted. A verdict is one
 * judge's statement about the judge itself, and #112 records that statement
 * rather than adjudicating it - a majority that waves a rewritten assertion
 * through is exactly the silence the record exists to break. A finder that
 * failed is not in `seats` at all, as it contributes no findings either, so it
 * cannot make a file unjudged.
 *
 * `seats[0]` is `roles.reviewer` and the rest are in config order, so the
 * reason carried by the combined verdict - the first dissent's, or the first
 * seat's - is the same whichever finder finished first. Every seat was attached
 * from the same listed files; one that somehow lacks a file reads as unjudged
 * for it, never as agreeing.
 */
export function combineVerdicts(seats: readonly SeatJudgement[]): JudgeFile[] {
  const [first] = seats;
  if (first === undefined) return [];
  return first.files.map((file) => {
    const verdicts: JudgeSeatVerdict[] = seats.map((s) => ({
      seat: s.seat,
      provider: s.provider,
      model: s.model,
      verdict: s.files.find((f) => f.path === file.path)?.verdict ?? 'unjudged',
    }));
    const dissent = verdicts.find((v) => v.verdict !== 'unjudged' && !v.verdict.justified);
    const verdict: JudgeFile['verdict'] =
      dissent !== undefined
        ? dissent.verdict
        : verdicts.some((v) => v.verdict === 'unjudged')
          ? 'unjudged'
          : (verdicts[0]?.verdict ?? 'unjudged');
    const { path, oldPath, status, added, removed } = file;
    return { path, oldPath, status, added, removed, verdict, verdicts };
  });
}

/**
 * Files the seats disagreed on: at least one said justified and another said
 * not justified (#404). An unjudged seat beside a justified one is an omission,
 * not a disagreement. Zero for a record with no `verdicts`.
 */
export function disagreements(files: readonly JudgeFile[]): number {
  return files.filter((f) => {
    const said = (f.verdicts ?? []).flatMap((v) => (v.verdict === 'unjudged' ? [] : [v.verdict.justified]));
    return said.includes(true) && said.includes(false);
  }).length;
}

/**
 * What the final fix road did to the judge after the last review (#485).
 *
 * `judged` is the judge listing at the end of the road, `blobs` the content id
 * of each of its paths (null for a deleted one), and `all` the whole end
 * listing before the judge filter. A judged path is edited when the snapshot
 * did not have it - it was untouched at the review - or when its content id
 * moved. Deleted at both ends is null against null, and unchanged.
 *
 * A snapshot path git no longer lists at all is back to its base content: it
 * changed after the review, and has no status to report, so it is `restored`.
 * Read against `all` rather than `judged` so that a pattern changed between the
 * two reads cannot pass for a restore, and a path that is now the old side of a
 * rename is covered by that rename's own entry.
 */
export function editedAfterReview(
  snapshot: readonly JudgeBlob[],
  judged: readonly FileChange[],
  blobs: ReadonlyMap<string, string | null>,
  all: readonly FileChange[],
): { files: FileChange[]; restored: string[] } {
  const before = new Map(snapshot.map((f) => [f.path, f.blob]));
  const files = judged.filter((c) => {
    if (!before.has(c.path)) return true;
    return (blobs.get(c.path) ?? null) !== before.get(c.path);
  });
  const listed = new Set(all.flatMap((c) => (c.oldPath === null ? [c.path] : [c.path, c.oldPath])));
  const restored = snapshot.map((f) => f.path).filter((p) => !listed.has(p));
  return { files, restored };
}

/**
 * Which of a rename-free listing's paths belong to the judge (#485).
 *
 * The listing compares path by path, so it carries no renames. A path is in
 * when it matches, when `renamedFrom` pairs it as the destination of a rename
 * from a path that matches (`judgeChanges`' either-side rule), or when `keep`
 * names it.
 *
 * The two reads use different halves. The snapshot passes git's pairing and no
 * `keep`, so it classifies as the review did. The end of the road passes the
 * snapshot's paths as `keep` and NO pairing: git decides pairing afresh, and a
 * final fix that deletes an unrelated identical file can make it pair a
 * different, untouched destination with the old test - which would then read as
 * new to the judge, and so as edited, with nothing about it changed. A path that
 * was judge at the review stays compared through `keep`, and a test moved out
 * after the review still shows as its old path's deletion.
 */
export function judgeTracked(
  changes: readonly FileChange[],
  renamedFrom: ReadonlyMap<string, string>,
  patterns: readonly string[],
  keep: ReadonlySet<string> = new Set(),
): FileChange[] {
  return changes.filter((c) => {
    if (keep.has(c.path) || isJudge(c.path, patterns)) return true;
    const from = renamedFrom.get(c.path);
    return from !== undefined && isJudge(from, patterns);
  });
}

/**
 * Whether ANY seat gave this file a verdict at its review (#485).
 *
 * Not the same question as the record's combined `verdict`. `combineVerdicts`
 * fails closed, so a file the reviewer called justified and a finder left
 * unjudged combines to `unjudged` while the reviewer's verdict is still there in
 * `verdicts`. Saying of that file that nobody judged it would be untrue.
 */
export function hadVerdict(file: JudgeFile): boolean {
  if (file.verdict !== 'unjudged') return true;
  return (file.verdicts ?? []).some((v) => v.verdict !== 'unjudged');
}
