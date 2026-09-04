import { expect, test } from 'vitest';
// The core's source as a string, through Vite's `?raw`. Deliberately not
// `node:fs`: adding node types to the app's tsconfig would let any component in
// a webview import a filesystem, and no test is worth that.
import orchestrator from '../../../src/orchestrator.ts?raw';
import charge from '../../../src/charge.ts?raw';
import cli from '../../../src/cli.ts?raw';
import { ending } from './format';
import { CYCLE_OF } from './model';

/**
 * The one place the app reaches across into the core, and it reaches for a
 * contract rather than for code (#159).
 *
 * The cockpit places a phase into a cycle through a **closed map**, because a
 * phase it cannot place is left out of the column rather than guessed into one -
 * which is the right behaviour, and also a silent one. A fifth phase added to
 * the loop would simply never appear, and nobody would find out from the app.
 *
 * So: read the phases the core actually narrates, and require every one of them
 * to have a home. This fails on the commit that adds a phase, in the repo that
 * added it, which is the only moment anybody is in a position to decide where it
 * belongs.
 *
 * A **grep for a literal**, not an import of the module. `orchestrator.ts` is
 * NodeNext ESM with `@src/*` aliases; importing it here would drag the whole
 * loop into a webview test to learn four strings.
 */

/** Phases named in a `phase_started` payload. */
function narratedPhases(): string[] {
  // Comments stripped, so a phase discussed in prose is not mistaken for one
  // that is emitted - `phase: 'complete'` appears in a comment about
  // `consistency.ts` and is not a phase the loop ever narrates.
  const code = orchestrator.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const found = new Set<string>();
  for (const m of code.matchAll(/id:\s*'phase_started'[\s\S]{0,200}?phase:\s*'([a-z-]+)'/g)) {
    if (m[1] !== undefined) found.add(m[1]);
  }
  return [...found].sort();
}

test('the core narrates the four phases this version knows about', () => {
  // Pinned so the set is visible here rather than only in the loop. If this
  // fails, read the diff before touching it: a new phase is a decision about
  // which cycle it belongs to, not a list to extend.
  expect(narratedPhases()).toEqual(['critique', 'implementing', 'planning', 'review']);
});

test('every phase the core narrates has a cycle to sit in', () => {
  for (const phase of narratedPhases()) {
    expect(Object.keys(CYCLE_OF)).toContain(phase);
  }
});

/** The `EXIT` table in `src/charge.ts`, as `[name, code]` pairs. */
function exitCodes(): Array<[string, number]> {
  const table = /export const EXIT = \{([\s\S]*?)\n\} as const;/.exec(charge)?.[1];
  // A hard failure rather than an empty list. An empty one would make every
  // assertion below vacuously pass, which is the shape of guard that reports
  // green for years after the thing it watched moved.
  if (table === undefined) throw new Error('EXIT table not found in src/charge.ts');
  const found: Array<[string, number]> = [];
  for (const m of table.matchAll(/^\s{2}([A-Z_]+): (\d+),$/gm)) {
    const [, name, code] = m;
    if (name !== undefined && code !== undefined) found.push([name, Number(code)]);
  }
  return found;
}

test('the eight exit codes this build has phrases for', () => {
  // Pinned so the set is visible here and not only in the core. A ninth code is
  // a decision about what to tell somebody it happened to - read the diff before
  // extending this.
  expect(exitCodes()).toEqual([
    ['OK', 0],
    ['ERROR', 1],
    ['NEEDS_HUMAN', 2],
    ['NO_CONVERGENCE', 3],
    ['BUDGET', 4],
    ['RATE_LIMITED', 5],
    ['PREFLIGHT', 6],
    ['UNVERIFIED', 7],
  ]);
});

test('every exit code the core can return has a phrase in the footer', () => {
  for (const [name, code] of exitCodes()) {
    expect(ending(code), `${name} (${code}) has no phrase`).not.toBeNull();
  }
});

test('neither of the two endings that are not failures uses the word failed', () => {
  // `UNVERIFIED` is documented in the core as "not an error and not a stall",
  // and `NEEDS_HUMAN` is how an ordinary long run pauses. Calling either a
  // failure sends somebody looking for a bug in work that is fine, which is the
  // specific smoothing #162 was filed to prevent.
  for (const code of [2, 7]) {
    const how = ending(code);
    expect(how).not.toBeNull();
    const text = `${how?.kicker} ${how?.detail} ${how?.next ?? ''}`.toLowerCase();
    expect(text).not.toContain('fail');
    expect(text).not.toContain('error');
  }
});

test('a code from a newer core has no phrase invented for it', () => {
  expect(ending(8)).toBeNull();
  expect(ending(-1)).toBeNull();
});

/**
 * The two narration ids the footer's reason line depends on.
 *
 * Reading the core's source rather than trusting a comment, because the failure
 * mode is silent in exactly the way #159's phase map was: drop the id from
 * `cli.ts` and the footer simply stops showing why a run failed, with nothing
 * anywhere going red. This fails in the repo that removed it.
 */
test('the core still marks the two places a run ends badly', () => {
  expect(cli).toContain("id: 'run_escalated'");
  expect(cli).toContain("id: 'run_failed'");
});
