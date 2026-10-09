import type { FileChange, JudgeFile, JudgeVerdict, VerifyConfig } from '@src/types.js';

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
 * What the record names as matched against, `vibe.config.json` included.
 *
 * Included because it is in force: a record reading `patterns: []` beside a
 * config-file entry would name less than was actually matched. The matching
 * itself stays root-exact in `isJudge`; this list is only what the record says.
 */
export function recordedPatterns(patterns: readonly string[]): string[] {
  return [...new Set([...patterns, CONFIG_FILE])];
}

export function isJudge(file: string, patterns: readonly string[]): boolean {
  return file === CONFIG_FILE || patterns.some((p) => matchesGlob(file, p));
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
