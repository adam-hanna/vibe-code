import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { LoopColumn } from './LoopColumn';
import { foldReplay, reduce } from './model';
import type { Run } from './model';
import type { Frame } from '../host';
import { liveTab, nowStatus, runningGate } from './rail';
import { inFlight, rounds } from './rounds';
import cockpit from './Cockpit.tsx?raw';
import verifyPane from './VerifyPane.tsx?raw';

/**
 * Where the run is, said everywhere it is drawn (#409).
 *
 * The #393 run was resumed at `reviewing`. The loop re-ran the core gate first,
 * for minutes, and the window said *Ready for the next turn · The run is between
 * turns*, with Code marked complete and Code review not started. The reducer
 * already had the gate open at `running`; nothing asked it. And the tab bar said
 * nothing about where the run was, while each stage's tab drew only finished
 * rounds - a critique turn in flight was on none of them.
 */

const T = 1_000_000;

const step = (at: number, id: string, data: Record<string, unknown>) => ({
  at,
  narration: { level: 'info' as const, message: 'x', id, data },
});

/** The resumed #393 run: an implement round that ended, then the gate re-run. */
const RESUMED = [
  step(T, 'phase_started', { phase: 'implementing', round: 1 }),
  step(T, 'turn_started', { role: 'implementer', kind: 'implement', round: 1, unmeasured: false }),
  step(T + 60_000, 'claude_turn', { label: 'implement', tokens: 1_000 }),
  step(T + 60_000, 'phase_started', { phase: 'review', round: 1 }),
  step(T + 120_000, 'verify_started', { gate: 'core', round: 1 }),
];

const gating = (): Run => foldReplay(RESUMED);

/** A run with one turn open in the given phase. */
function turnIn(phase: string, role: string, kind: string): Run {
  return foldReplay([
    step(T, 'phase_started', { phase, round: 1 }),
    step(T, 'turn_started', { role, kind, round: 1, unmeasured: false }),
  ]);
}

// ---- a running gate is not between turns -----------------------------------

test('the premise: the gate is open and no turn is', () => {
  const run = gating();
  expect(run.running).toBeNull();
  expect(runningGate(run)?.name).toBe('core');
});

test('the now card says it is verifying, and never that the run is between turns', () => {
  const status = nowStatus(gating());
  expect(status).toEqual({ title: 'Verifying', detail: 'Running the core gate', tone: 'running' });
});

test('once the gate settles with nothing else open, the run is between turns again', () => {
  const run = foldReplay([...RESUMED, step(T + 180_000, 'verify_passed', { gate: 'core', round: 1, runs: 1 })]);
  expect(runningGate(run)).toBeNull();
  expect(nowStatus(run).title).toBe('Ready for the next turn');
});

test('a gate the run never settled is not running once the run is ending, has ended or has gone', () => {
  const ending = foldReplay([...RESUMED, step(T + 180_000, 'run_failed', { reason: 'the core gate could not start' })]);
  expect(ending.reason).not.toBeNull();
  const finished: Run = { ...gating(), completed: { exit: 1 } };
  const lost: Run = { ...gating(), lost: 'the process running this run has gone' };
  for (const run of [ending, finished, lost]) expect(runningGate(run)).toBeNull();
});

test('an open turn is what is running, so a gate under it does not take the now card', () => {
  const run = foldReplay([
    ...RESUMED,
    step(T + 130_000, 'turn_started', { role: 'implementer', kind: 'verify-fix', round: 1, unmeasured: false }),
  ]);
  expect(runningGate(run)).toBeNull();
  expect(nowStatus(run).detail).toBe('Implementer is fixing the verification failure');
});

// ---- the run path ------------------------------------------------------------

function stageStates(run: Run): Record<string, string> {
  const html = renderToStaticMarkup(createElement(LoopColumn, { run, now: T + 150_000, compact: true }));
  const states: Record<string, string> = {};
  for (const m of html.matchAll(/<section class="[^"]*" data-state="(\w+)">.*?<span class="text-body-sm font-medium [^"]*">([^<]+)<\/span>/g)) {
    states[m[2] as string] = m[1] as string;
  }
  return states;
}

test('the run path draws Code running while the gate runs, and Code review still to come', () => {
  const states = stageStates(gating());
  expect(states['Code']).toBe('running');
  expect(states['Code review']).not.toBe('running');
  const html = renderToStaticMarkup(createElement(LoopColumn, { run: gating(), now: T + 150_000, compact: true }));
  // Visible without expanding anything, as it already was: the row is outside
  // the stage's disclosure.
  expect(html).toContain('running core');
  // And the now card has a clock, from when the gate started.
  expect(html).toContain('Verifying');
  expect(html).toContain('30s');
});

// ---- the tab for what is running --------------------------------------------

test('each stage marks its own tab, and a running gate marks Verify', () => {
  expect(liveTab(turnIn('planning', 'planner', 'plan'))).toBe('plans');
  expect(liveTab(turnIn('critique', 'critic', 'critique'))).toBe('critique');
  expect(liveTab(turnIn('implementing', 'implementer', 'implement'))).toBe('code');
  expect(liveTab(turnIn('review', 'reviewer', 'review'))).toBe('review');
  expect(liveTab(gating())).toBe('verify');
});

test('no tab is marked while a decision is waiting, nor once the run has ended or gone', () => {
  const ask = { type: 'ask', id: 1, context: { boundary: 'plan-approved', planRound: 0, reviewRound: 0, verifyRound: 0 } } as Frame;
  const held = reduce(turnIn('planning', 'planner', 'plan'), ask, T + 1);
  expect(held.gate).not.toBeNull();
  expect(liveTab(held)).toBeNull();
  expect(liveTab({ ...turnIn('planning', 'planner', 'plan'), completed: { exit: 0 } })).toBeNull();
  expect(liveTab({ ...gating(), lost: 'gone' })).toBeNull();
});

test('the five stage tabs carry the mark, drawn as the run path draws its live stage', () => {
  for (const tab of ['plans', 'critique', 'code', 'review', 'verify']) {
    expect(cockpit).toContain(`<RunningMark on={live === '${tab}'} />`);
  }
  const mark = cockpit.slice(cockpit.indexOf('function RunningMark'));
  const body = mark.slice(0, mark.indexOf('\n}\n'));
  // The rail's live dot, pulsing: #307's rule is that a pulse means work is
  // running, and the mark is only drawn while it is.
  expect(body).toContain('<LivenessDot state="live" />');
  // A state, not a count: the bar's counts are `· n`, and this is no number.
  expect(body).not.toContain('·');
  // The dot has no words of its own, so the tab says it for a screen reader.
  expect(body).toContain('<span className="sr-only">running:</span>');
});

// ---- the round in flight on its tab ------------------------------------------

test('the round holding the open turn is the one in flight, on its own stage only', () => {
  const run = turnIn('critique', 'critic', 'critique');
  const cards = rounds(run);
  expect(inFlight(cards, run, 'critique')?.phase).toBe('critique');
  expect(inFlight(cards, run, 'plan')).toBeNull();
  expect(inFlight(cards, run, 'review')).toBeNull();
});

test('a round whose turn has ended is not drawn as running', () => {
  const run = foldReplay([
    step(T, 'phase_started', { phase: 'critique', round: 1 }),
    step(T, 'turn_started', { role: 'critic', kind: 'critique', round: 1, unmeasured: false }),
    step(T + 60_000, 'phase_started', { phase: 'planning', round: 2 }),
  ]);
  expect(inFlight(rounds(run), run, 'critique')).toBeNull();
  // A gate running between turns is drawn by the Verify pane, not as a round.
  expect(inFlight(rounds(gating()), gating(), 'code')).toBeNull();
});

test('each of the four stage panes draws the round in flight, from the column’s run', () => {
  for (const [tab, cycle] of [['plans', 'plan'], ['critique', 'critique'], ['review', 'review'], ['code', 'code']]) {
    expect(cockpit).toMatch(new RegExp(`\\{tab === '${tab}' && \\(\\s*<InFlight card=\\{flying\\('${cycle}'\\)\\}>`));
  }
  expect(cockpit).toContain('const flying = (cycle: CycleKind): RoundCardData | null => inFlight(columnCards, columnRun, cycle);');
  // The wrapper is drawn whether or not a round is running, so a round starting
  // never remounts the pane and costs it the sections somebody opened.
  const wrapper = cockpit.slice(cockpit.indexOf('function InFlight'));
  expect(wrapper.slice(0, wrapper.indexOf('\n}\n'))).toMatch(/return \(\s*<div className="flex min-h-0 flex-1 flex-col">\s*\{children\}/);
});

test('the Verify pane already draws a running gate, and keeps doing so', () => {
  // Checked rather than rebuilt (#409): this is the one stage pane that had it.
  expect(verifyPane).toContain("if (gate.status === 'running') return 'RUNNING';");
  expect(verifyPane).toContain("gate.status === 'running' && 'border-accent-border bg-active'");
});
