import { expect, test } from 'vitest';
// The core's source as a string, through Vite's `?raw`. Deliberately not
// `node:fs`: adding node types to the app's tsconfig would let any component in
// a webview import a filesystem, and no test is worth that.
import orchestrator from '../../../src/orchestrator.ts?raw';
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
