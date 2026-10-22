import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { Footer } from './Footer';
import { foldReplay, openedEnding } from './model';
import type { Run } from './model';
import { rounds } from './rounds';
import cockpit from './Cockpit.tsx?raw';
import footerSource from './Footer.tsx?raw';

/**
 * An opened run whose process has gone is drawn as lost, not as running (#396).
 *
 * A run was held at the `implemented` gate when the machine shut down. Opened
 * after the relaunch, its implement turn was drawn running with "code"
 * blinking, Pause and Stop did nothing, and there was no Resume. Its record
 * stops at `reviewing`, which has no exit, so nothing in the fold closed the
 * turn. Shaped on that run's replay: the implement turn opens and is charged,
 * and nothing after it ends anything.
 */

const T = 1_000_000;

const step = (at: number, id: string, data: Record<string, unknown>) => ({
  at,
  narration: { level: 'info' as const, message: 'x', id, data },
});

const STOPPED = [
  step(T, 'phase_started', { phase: 'implementing', round: 1 }),
  step(T, 'turn_started', { role: 'implementer', kind: 'implement', round: 1, unmeasured: false }),
  step(T + 600_000, 'claude_turn', { label: 'implement', tokens: 4_000_000 }),
];
const LAST = T + 600_000;

const LOST = 'Its record stops at "reviewing" with no ending, and the lock check says: held by pid 4242 on box, which is no longer running';

function opened(ending: { exit: number | null; lost: string | null }): Run {
  return openedEnding(foldReplay(STOPPED), ending, LAST);
}

function footer(run: Run): string {
  return renderToStaticMarkup(createElement(Footer, {
    run, busy: false, pausing: false, stopping: false, caps: null, gates: null, order: [],
    onDecide: () => {}, onPause: () => {}, onUnpause: () => {}, onStop: () => {},
    onResume: () => {}, onImplement: () => {}, onShowRuns: () => {},
  }));
}

test('without an ending the fold leaves the turn open: the defect this closes', () => {
  // The premise, stated so the fix below is measured against it.
  expect(foldReplay(STOPPED).running).not.toBeNull();
});

test('a lost run closes its turn at the replay’s last step and says why', () => {
  const run = opened({ exit: null, lost: LOST });
  expect(run.running).toBeNull();
  expect(run.lost).toBe(LOST);
  expect(run.gate).toBeNull();
  // No exit code is invented for it: a lost host is not one of the run's eight.
  expect(run.completed).toBeNull();
  const code = rounds(run).find((c) => c.phase === 'implementing');
  expect(code?.turns.every((t) => t.endedAt === LAST)).toBe(true);
});

test('a run something still holds is drawn exactly as it was', () => {
  // `lost` null with no exit: a live process holds it, or the lock could not
  // rule one out. Either way the turn is open because it may well be.
  const run = opened({ exit: null, lost: null });
  expect(run).toEqual(foldReplay(STOPPED));
  expect(run.running).not.toBeNull();
});

test('an exit is the ending, whatever else is said', () => {
  // The core never sends both, and if it did the run's own exit is the fact.
  const run = opened({ exit: 2, lost: LOST });
  expect(run.completed).toEqual({ exit: 2 });
  expect(run.lost).toBeNull();
  expect(run.running).toBeNull();
});

test('the lost footer offers the runs list, and no live controls', () => {
  const html = footer(opened({ exit: null, lost: LOST }));
  expect(html).toContain('the process running this run has gone');
  expect(html).toContain('Open the runs list');
  // Pause and Stop need a host to answer them, and there is none.
  expect(html).not.toContain('Pause');
  expect(html).not.toContain('Stop run');
});

test('the runs list is opened for the run’s own repository', () => {
  // The list is per repository, so a lost run from another project must not
  // open the list of the one the window last pointed at. Source-read, as the
  // other wiring pins in `opened-run.test.ts` are: the press needs a DOM.
  expect(footerSource).toContain('onClick={() => onShowRuns(run.identity?.repo ?? null)}');
  const show = cockpit.slice(cockpit.indexOf('const showRuns = '));
  expect(show).toMatch(/if \(repo !== null\) rememberRepo\(repo\);\s*setTab\('runs'\);/);
  expect(cockpit).toMatch(/onShowRuns=\{showRuns\}/);
});
