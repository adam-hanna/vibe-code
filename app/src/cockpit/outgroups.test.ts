import { describe, expect, test } from 'vitest';
import { emptyRun, reduce } from './model';
import { groupTitle, groups, readTranscript } from './outgroups';
import type { OutputLine, Run } from './model';
import type { Frame } from '../host';

/**
 * The output, cut into the rounds the loop announced (`1c`, #223).
 *
 * The pane was one stream with a filter over it, and a filter is not a
 * structure: it shows one phase by hiding the rest, so reading a run end to end
 * meant clicking through every phase and holding the order in your head.
 *
 * **Every boundary here is told.** `phase` and `round` are stamped on the line by
 * `reduce` from `phase_started` — the id and its data, never the sentence — so
 * the cases below drive frames rather than asserting on prose.
 */

const say = (id: string | null, data: Record<string, unknown> | null, message = 'x'): Frame => ({
  type: 'narration',
  level: 'info',
  message,
  id,
  data,
});

const fold = (frames: readonly Frame[]): Run =>
  frames.reduce((run, frame, i) => reduce(run, frame, 1_000 + i), emptyRun());

describe('a group is a round, and the boundary comes off the frame', () => {
  test('two plan rounds are two groups, not one heading over both', () => {
    const run = fold([
      say('run_started', { runId: 'r', dir: 'd' }),
      say('phase_started', { phase: 'planning', round: 0 }),
      say('turn_started', { role: 'planner', kind: 'plan' }),
      say('phase_started', { phase: 'critique', round: 0 }),
      say('phase_started', { phase: 'planning', round: 1 }),
    ]);
    expect(groups(run.output).map((g) => g.title)).toEqual([
      // The run announcement belongs to no phase, which is a real state rather
      // than a gap — preflight and the identity genuinely precede every phase.
      'before the first phase',
      'plan 0',
      'critique 0',
      'plan 1',
    ]);
  });

  test('the line that opens a round is inside it, not above it', () => {
    // `reduce` corrects the stamp for `phase_started` alone. Without that every
    // heading would be the last line of the group before it.
    const run = fold([
      say('phase_started', { phase: 'planning', round: 0 }, 'Plan round 0'),
      say('turn_started', { role: 'planner', kind: 'plan' }, 'Claude is planning'),
    ]);
    const [first] = groups(run.output);
    expect(first?.title).toBe('plan 0');
    expect(first?.lines.map((l) => l.message)).toEqual(['Plan round 0', 'Claude is planning']);
  });

  test('re-entering a phase makes a second group, in the order it happened', () => {
    // The loop re-opens `implementing` on every review fix. Gathering every
    // `implementing` line under one heading would read as one long phase and
    // hide that the loop went round again — the merged-card mistake, in a log.
    const run = fold([
      say('phase_started', { phase: 'implementing', round: 0 }),
      say('phase_started', { phase: 'review', round: 0 }),
      say('phase_started', { phase: 'implementing', round: 1 }),
    ]);
    expect(groups(run.output).map((g) => g.title)).toEqual(['code 0', 'review 0', 'code 1']);
  });

  test('a group holding a warning says so, which is why you collapse a run', () => {
    const run = fold([
      say('phase_started', { phase: 'planning', round: 0 }),
      { type: 'narration', level: 'warn', message: 'something', id: null, data: null },
    ]);
    expect(groups(run.output)[0]?.alarming).toBe(true);
  });

  test('keys are stable and unique, so a collapsed group stays collapsed', () => {
    const run = fold([
      say('phase_started', { phase: 'planning', round: 0 }),
      say('phase_started', { phase: 'critique', round: 0 }),
      say('phase_started', { phase: 'planning', round: 1 }),
    ]);
    const keys = groups(run.output).map((g) => g.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test('no lines is no groups, rather than one empty one', () => {
    expect(groups([])).toEqual([]);
  });
});

describe('a heading is the loop’s own word for the phase', () => {
  test('the column’s vocabulary, not a second map', () => {
    // `title()` from `rounds.ts`, so a heading here and a heading in the loop
    // column cannot disagree about what `implementing` is called.
    expect(groupTitle('implementing', 2)).toBe('code 2');
    expect(groupTitle('critique', 0)).toBe('critique 0');
  });

  test('an unnumbered phase has no number, and an unknown one is its own name', () => {
    expect(groupTitle('planning', null)).toBe('plan');
    expect(groupTitle('reconciling', 1)).toBe('reconciling 1');
  });
});

describe('a finished run’s transcript is prose, and is read as prose', () => {
  const line = (level: string, msg: string): string =>
    `[2026-09-10T20:50:30.834Z] ${level} ${msg}`;

  test('the level is parsed because this repo writes it; nothing else is', () => {
    const read = readTranscript(
      [line('STEP ', 'Plan round 0'), line('WARN ', 'a gate failed'), line('OK   ', 'done')].join(
        '\n',
      ),
    );
    expect(read.map((l) => l.level)).toEqual(['step', 'warn', 'ok']);
    expect(read.map((l) => l.message)).toEqual(['Plan round 0', 'a gate failed', 'done']);
  });

  test('no ids, no phases and no rounds are claimed', () => {
    // The file carries none of the three. A pane that grouped it by looking for
    // the word "plan" in a sentence would be doing exactly what the live path
    // exists to avoid — so a transcript is one group, honestly.
    const read = readTranscript(line('INFO ', 'Plan round 0'));
    expect(read[0]?.id).toBeNull();
    expect(read[0]?.phase).toBeNull();
    expect(read[0]?.round).toBeNull();
    expect(groups(read)).toHaveLength(1);
  });

  test('a continuation line is kept whole rather than dropped', () => {
    // A stack frame under an error has no stamp and no level. Dropping it would
    // silently shorten the one record of a run nobody is narrating any more.
    const read = readTranscript([line('ERROR', 'it threw'), '    at foo (bar.js:1)'].join('\n'));
    expect(read).toHaveLength(2);
    expect(read[1]?.message).toBe('    at foo (bar.js:1)');
    expect(read[1]?.level).toBe('info');
  });

  test('a heading keeps its text and loses its rules', () => {
    expect(readTranscript('[2026-09-10T20:50:30.834Z] === Plan ===')[0]).toMatchObject({
      level: 'heading',
      message: 'Plan',
    });
  });

  test('blank lines are not lines', () => {
    expect(readTranscript('\n\n  \n')).toEqual([]);
  });

  test('an empty file is empty, which the pane says rather than showing nothing', () => {
    expect(readTranscript('')).toEqual([]);
  });
});

describe('grouping does not mutate what it was handed', () => {
  test('the input array and its lines come back untouched', () => {
    const lines: OutputLine[] = [
      { n: 1, level: 'info', message: 'a', id: null, phase: 'planning', round: 0, role: null },
      { n: 2, level: 'info', message: 'b', id: null, phase: 'planning', round: 0, role: null },
    ];
    const snapshot = JSON.stringify(lines);
    groups(lines);
    expect(JSON.stringify(lines)).toBe(snapshot);
    expect(lines).toHaveLength(2);
  });
});
