import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { emptyRun, foldReplay, reduce } from './model';
import type { Run, Turn } from './model';
import { liveSeatsLine } from './rail';
import { inFlight, rounds } from './rounds';
import { LoopColumn } from './LoopColumn';
import { LIVE, REPLAYED } from './fixtures/review-round-20261023-111151';
import settings from './Settings.tsx?raw';
import type { Frame } from '../host';

/**
 * Several review seats running at once, as the window holds and draws them (#403).
 *
 * With `review.maxParallel` above 1, finders and verifiers overlap. The window
 * kept one running turn, so each `turn_started` closed the last one while it was
 * still running and every heartbeat went to the newest - a wrong measurement on
 * screen. A seat's frames now carry its label: a labelled start leaves the other
 * labelled turns running, a frame is attributed by its label, and the loop says
 * when each one finished. A turn with no label is folded exactly as before,
 * which is every run that never raised the setting and every replayed run.
 */

function say(id: string, data: Record<string, unknown>): Frame {
  return { type: 'narration', level: 'info', message: 'x', id, data };
}

function fold(frames: readonly Frame[], t0 = 1_000_000): Run {
  return frames.reduce((run, frame, i) => reduce(run, frame, t0 + i), emptyRun());
}

const REVIEW = say('phase_started', { phase: 'review', round: 0 });
const REVIEWER = say('turn_started', { role: 'reviewer', kind: 'review', round: 0 });
const vote = (k: number, finding: string, n: number): Frame =>
  say('turn_started', {
    role: 'reviewer',
    kind: 'vote',
    round: 0,
    verifier: k,
    seat: `review.verifiers[${String(k - 1)}]`,
    finding,
    label: `vote-0-${String(n)}-v${String(k)}`,
  });
const beat = (label: string | null, elapsedMs: number): Frame =>
  say('heartbeat', {
    ...(label === null ? {} : { label }),
    elapsedMs,
    activities: 3,
    unit: 'tool use',
  });

const turnsOf = (run: Run): Turn[] => run.cycles.flatMap((c) => c.phases.flatMap((p) => p.turns));
const byLabel = (run: Run, label: string): Turn | undefined => turnsOf(run).find((t) => t.label === label);

describe('labelled turns run side by side', () => {
  test('two labelled starts leave both running, and the reviewer before them finished', () => {
    const run = fold([REVIEW, REVIEWER, vote(1, 'alpha', 1), vote(2, 'alpha', 1)]);
    expect(run.live.map((t) => t.label)).toEqual(['vote-0-1-v1', 'vote-0-1-v2']);
    expect(run.running?.label).toBe('vote-0-1-v2');
    expect(byLabel(run, 'vote-0-1-v1')?.endedAt).toBeNull();
    const reviewer = turnsOf(run).find((t) => t.kind === 'review');
    expect(reviewer?.endedAt).not.toBeNull();
    expect(byLabel(run, 'vote-0-1-v1')?.seat).toEqual({ verifier: 1, finding: 'alpha' });
  });

  test('a heartbeat goes to the turn its label names, not the newest', () => {
    const run = fold([REVIEW, vote(1, 'alpha', 1), vote(2, 'alpha', 1), beat('vote-0-1-v1', 5_000)]);
    expect(byLabel(run, 'vote-0-1-v1')?.beat?.elapsedMs).toBe(5_000);
    expect(byLabel(run, 'vote-0-1-v2')?.beat).toBeNull();
    // `live` and the drawn turns are the same objects' state.
    expect(run.live[0]?.beat?.elapsedMs).toBe(5_000);
  });

  test('a beat naming no live seat, or naming nothing while seats run, is dropped', () => {
    const before = fold([REVIEW, vote(1, 'alpha', 1), vote(2, 'alpha', 1)]);
    for (const frame of [beat('vote-0-9-v9', 5_000), beat(null, 5_000)]) {
      const after = reduce(before, frame, 2_000_000);
      expect(turnsOf(after).every((t) => t.beat === null)).toBe(true);
    }
  });

  test('turn_finished ends its own turn and leaves the other running', () => {
    const run = fold([
      REVIEW,
      vote(1, 'alpha', 1),
      vote(2, 'alpha', 1),
      say('turn_finished', { label: 'vote-0-1-v1', role: 'reviewer', kind: 'vote', round: 0 }),
    ]);
    expect(byLabel(run, 'vote-0-1-v1')?.endedAt).not.toBeNull();
    expect(run.live.map((t) => t.label)).toEqual(['vote-0-1-v2']);
    // An unknown label closes nothing.
    const same = reduce(run, say('turn_finished', { label: 'vote-0-7-v1' }), 3_000_000);
    expect(same.live.map((t) => t.label)).toEqual(['vote-0-1-v2']);
  });

  test('a new phase, and an unlabelled start, close every live seat', () => {
    const seats = [REVIEW, vote(1, 'alpha', 1), vote(2, 'beta', 2)];
    for (const next of [say('phase_started', { phase: 'implementing', round: 1 }), say('turn_started', { role: 'implementer', kind: 'review-fix', round: 1 })]) {
      const run = fold([...seats, next]);
      expect(byLabel(run, 'vote-0-1-v1')?.endedAt).not.toBeNull();
      expect(byLabel(run, 'vote-0-2-v2')?.endedAt).not.toBeNull();
    }
  });

  test('the round in flight is the one holding any live seat', () => {
    const run = fold([REVIEW, vote(1, 'alpha', 1), vote(2, 'alpha', 1)]);
    expect(inFlight(rounds(run), run, 'review')?.turns.length).toBe(2);
  });
});

describe('the seat line', () => {
  test('names each finding being voted on and the seats voting on it', () => {
    const run = fold([REVIEW, vote(1, 'alpha', 1), vote(3, 'alpha', 1), vote(2, 'beta', 2)]);
    expect(liveSeatsLine(run)).toBe('verifiers voting · alpha: v1, v3 · beta: v2 running');
  });

  test('names finders by number', () => {
    const finder = (k: number): Frame =>
      say('turn_started', { role: 'reviewer', kind: 'review', round: 0, finder: k, seat: `review.finders[${String(k - 1)}]`, label: `review-0-f${String(k)}` });
    expect(liveSeatsLine(fold([REVIEW, REVIEWER, finder(1), finder(2)]))).toBe('finders reviewing · f1, f2 running');
  });

  test('says nothing with one turn running', () => {
    expect(liveSeatsLine(fold([REVIEW, REVIEWER]))).toBeNull();
    expect(liveSeatsLine(fold([REVIEW, vote(1, 'alpha', 1)]))).toBeNull();
  });
});

describe('a run with no labels is folded as it always was', () => {
  test('a replayed run keeps one running turn at most, and the reducer’s single-turn rule', () => {
    for (const steps of [REPLAYED, LIVE]) {
      const run = foldReplay(steps);
      expect(run.live.length).toBeLessThanOrEqual(1);
      expect(run.running).toBe(run.live[0] ?? null);
      expect(turnsOf(run).every((t) => t.label === undefined && t.seat === undefined)).toBe(true);
      // Every turn but the last was closed by the start of the next.
      const turns = turnsOf(run);
      expect(turns.slice(0, -1).every((t) => t.endedAt !== null)).toBe(true);
    }
  });

  test('an unlabelled start still ends the turn before it, and a beat still goes to the running turn', () => {
    const run = fold([REVIEW, REVIEWER, say('turn_started', { role: 'reviewer', kind: 'vote', round: 0, verifier: 1 }), beat(null, 4_000)]);
    const [first, second] = turnsOf(run);
    expect(first?.endedAt).not.toBeNull();
    expect(second?.beat?.elapsedMs).toBe(4_000);
    expect(run.live).toEqual([run.running]);
    // The fields a labelled turn gains are absent, not null, so a turn is the shape it always was.
    expect(Object.keys(second ?? {}).sort()).toEqual(['beat', 'endedAt', 'id', 'kind', 'role', 'round', 'startedAt', 'work']);
  });
});

describe('the loop column draws every live seat', () => {
  const LIVE_ROW = 'border-accent-border bg-active';
  const count = (html: string, needle: string): number => html.split(needle).length - 1;

  test('two labelled live turns are both drawn live, under the seat line', () => {
    const run = fold([REVIEW, vote(1, 'alpha', 1), vote(2, 'alpha', 1)]);
    const html = renderToStaticMarkup(createElement(LoopColumn, { run, now: 1_000_010 }));
    expect(count(html, LIVE_ROW)).toBe(2);
    expect(html).toContain('verifiers voting · alpha: v1, v2 running');
    const rail = renderToStaticMarkup(createElement(LoopColumn, { run, now: 1_000_010, compact: true }));
    expect(rail).toContain('verifiers voting · alpha: v1, v2 running');
  });

  test('a run with no labels draws exactly one live row, and no seat line', () => {
    const run = fold([REVIEW, REVIEWER, say('turn_started', { role: 'reviewer', kind: 'vote', round: 0, verifier: 1 })]);
    const html = renderToStaticMarkup(createElement(LoopColumn, { run, now: 1_000_010 }));
    expect(count(html, LIVE_ROW)).toBe(1);
    expect(html).not.toContain('running</p>');
  });
});

describe('the setting', () => {
  test('sits in the review section beside the quorum and saves review.maxParallel', () => {
    const quorum = settings.indexOf('htmlFor="review-quorum"');
    const parallel = settings.indexOf('htmlFor="review-maxParallel"');
    expect(quorum).toBeGreaterThan(0);
    expect(parallel).toBeGreaterThan(quorum);
    expect(settings).toMatch(/onSave=\{\(n\) => save\(\{ review: \{ maxParallel: n \} \}\)\}/);
    expect(settings).toMatch(/source\('review', 'maxParallel'\)/);
  });
});

/**
 * The plan critique's seats, at `critique.maxParallel` above 1 (#452): the same
 * labelled frames as the review's, under the critique's labels and kinds, so the
 * fold keeps them live side by side and the seat line names them in the review
 * card's words.
 */
describe('critique seats run side by side as review seats do', () => {
  const CRITIQUE = say('phase_started', { phase: 'critique', round: 0 });
  const CRITIC = say('turn_started', { role: 'critic', kind: 'critique', round: 0 });
  const critiqueFinder = (k: number): Frame =>
    say('turn_started', {
      role: 'critic',
      kind: 'critique',
      round: 0,
      finder: k,
      seat: `critique.finders[${String(k - 1)}]`,
      label: `critique-0-f${String(k)}`,
    });
  const critiqueVote = (k: number, finding: string, n: number): Frame =>
    say('turn_started', {
      role: 'critic',
      kind: 'vote',
      round: 0,
      verifier: k,
      seat: `critique.verifiers[${String(k - 1)}]`,
      finding,
      label: `critique-0-vote-${String(n)}-v${String(k)}`,
    });

  test('two labelled critique finders are both live, and the critic before them finished', () => {
    const run = fold([CRITIQUE, CRITIC, critiqueFinder(1), critiqueFinder(2)]);
    expect(run.live.map((t) => t.label)).toEqual(['critique-0-f1', 'critique-0-f2']);
    expect(byLabel(run, 'critique-0-f1')?.seat).toEqual({ finder: 1 });
    const critic = turnsOf(run).find((t) => t.kind === 'critique' && t.label === undefined);
    expect(critic?.endedAt).not.toBeNull();
  });

  test('a heartbeat goes to the critique seat its label names', () => {
    const run = fold([CRITIQUE, critiqueFinder(1), critiqueFinder(2), beat('critique-0-f2', 4_000)]);
    expect(byLabel(run, 'critique-0-f2')?.beat?.elapsedMs).toBe(4_000);
    expect(byLabel(run, 'critique-0-f1')?.beat).toBeNull();
  });

  test('turn_finished ends its own critique seat and leaves the other running', () => {
    const run = fold([
      CRITIQUE,
      critiqueFinder(1),
      critiqueFinder(2),
      say('turn_finished', { label: 'critique-0-f1', role: 'critic', kind: 'critique', round: 0 }),
    ]);
    expect(byLabel(run, 'critique-0-f1')?.endedAt).not.toBeNull();
    expect(run.live.map((t) => t.label)).toEqual(['critique-0-f2']);
  });

  test('the seat line names critique finders by number, and votes as the review card does', () => {
    expect(liveSeatsLine(fold([CRITIQUE, CRITIC, critiqueFinder(1), critiqueFinder(2)]))).toBe(
      'finders critiquing · f1, f2 running',
    );
    expect(liveSeatsLine(fold([CRITIQUE, critiqueVote(1, 'alpha', 1), critiqueVote(2, 'alpha', 1)]))).toBe(
      'verifiers voting · alpha: v1, v2 running',
    );
  });

  test('the loop column draws both live, under the seat line, in the full and the compact rail', () => {
    const run = fold([CRITIQUE, CRITIC, critiqueFinder(1), critiqueFinder(2)]);
    const html = renderToStaticMarkup(createElement(LoopColumn, { run, now: 1_000_010 }));
    expect(html.split('border-accent-border bg-active').length - 1).toBe(2);
    expect(html).toContain('finders critiquing · f1, f2 running');
    const rail = renderToStaticMarkup(createElement(LoopColumn, { run, now: 1_000_010, compact: true }));
    expect(rail).toContain('finders critiquing · f1, f2 running');
  });

  test('its setting sits in the critique section beside its quorum and saves critique.maxParallel', () => {
    const quorum = settings.indexOf('htmlFor="critique-quorum"');
    const parallel = settings.indexOf('htmlFor="critique-maxParallel"');
    expect(quorum).toBeGreaterThan(0);
    expect(parallel).toBeGreaterThan(quorum);
    expect(settings).toMatch(/onSave=\{\(n\) => save\(\{ critique: \{ maxParallel: n \} \}\)\}/);
    expect(settings).toMatch(/source\('critique', 'maxParallel'\)/);
  });
});
