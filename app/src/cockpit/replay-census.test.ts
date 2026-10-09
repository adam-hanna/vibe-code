import { expect, test } from 'vitest';
import replay from '../../../src/replay.ts?raw';
import run from '../../../src/run.ts?raw';
import orchestrator from '../../../src/orchestrator.ts?raw';
import { SEVERITIES, emptyRun, reduce } from './model';
import { rounds } from './rounds';
import type { Frame } from '../host';

/**
 * A replayed census reaches the round card (#292).
 *
 * The live loop said its counts as `P0`-`P3` and the replay said `p0`-`p3`;
 * `readCounts` reads the first and refuses the second, so every opened run -
 * and every run the window reopened after a relaunch - drew its round cards
 * with no counts at all. Two packages, one spelling: these read both writers as
 * source, the way `artifacts.test.ts` reads the loop's naming, and fail on the
 * commit that lets them drift.
 */

const spelled = `{ ${SEVERITIES.map((s) => `${s}: 0`).join(', ')} }`;

test('both writers of a census spell the counts the way the reducer reads them', () => {
  expect(orchestrator).toContain(`const counts = ${spelled};`);
  expect(run).toContain(`const counts = ${spelled};`);
  expect(replay).toContain(`counts: { ${SEVERITIES.map((s) => `${s}: number`).join('; ')} };`);
});

test('a census in that spelling lands on its card', () => {
  const say = (id: string, data: Record<string, unknown>): Frame => ({
    type: 'narration',
    level: 'detail',
    message: 'x',
    id,
    data,
  });
  const folded = [
    say('phase_started', { phase: 'review', round: 0 }),
    say('turn_started', { role: 'reviewer', kind: 'review', round: 0, unmeasured: true }),
    say('findings_reported', { phase: 'review', counts: { P0: 0, P1: 3, P2: 0, P3: 0 } }),
  ].reduce((r, f) => reduce(r, f, 1_000), emptyRun());
  expect(rounds(folded)[0]?.census?.counts['P1']).toBe(3);
});
