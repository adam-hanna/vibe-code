import { describe, expect, test } from 'vitest';
import { launchArgv } from '../cockpit/argv';
import { emptyRun, OUTPUT_KEEP, reduce } from '../cockpit/model';
import { declare, execute, ORIGIN, TOOLS } from './tools';
import type { Run } from '../cockpit/model';
import type { Settlement } from './tools';

/**
 * What the pilot may touch, and what happens when it asks wrongly (#144).
 *
 * Every executor is pure, so this file drives them directly - a run in, a
 * settlement out. The cases that matter are not the happy ones: a model sends a
 * number where a string was declared, asks for a gate that is not open, or omits
 * the one field there is deliberately no default for, and each of those has to
 * come back as a sentence the next turn can act on rather than as something that
 * ran anyway.
 *
 * The run fixtures are built by folding real frames through `cockpit/model.ts`,
 * not by hand-writing a `Run`. A hand-built one would let a tool pass against a
 * shape the loop never produces.
 */

function run(...frames: Parameters<typeof reduce>[1][]): Run {
  // A fixed arrival time rather than `Date.now()`: nothing here reads our clock,
  // and a test that did would be pinning a number that moves.
  return frames.reduce((state, frame) => reduce(state, frame, 1_000), emptyRun());
}

function narration(id: string, data: Record<string, unknown>, message = 'x') {
  return { type: 'narration' as const, level: 'info' as const, message, id, data };
}

function ran(settlement: Settlement): Record<string, unknown> {
  expect(settlement.kind).toBe('ran');
  return JSON.parse(settlement.kind === 'ran' ? settlement.content : '{}') as Record<
    string,
    unknown
  >;
}

const call = (name: string, input: unknown) => ({ name, input, unreadable: null });

describe('the table is what it says it is', () => {
  test('a declaration carries no executor across the wire', () => {
    // The vendor is told the name, the description and the schema. `call` is the
    // half that stays here, which is the whole reason a tool cannot exist
    // without an implementation.
    const declared = declare();
    expect(declared.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    for (const tool of declared) {
      expect(Object.keys(tool).sort()).toEqual(['description', 'input_schema', 'name']);
    }
  });

  test('a tool this build does not have is refused by name', () => {
    // Both vendors will invent a plausible tool when a conversation drifts, and
    // the model can only correct for it if it is told which one it asked for.
    const settlement = execute(call('delete_everything', {}), { run: emptyRun() });
    expect(settlement.kind).toBe('refused');
    expect(settlement.kind === 'refused' && settlement.content).toContain('delete_everything');
  });

  test('arguments that did not parse never reach an executor', () => {
    const settlement = execute(
      { name: 'read_run', input: undefined, unreadable: 'Unexpected end of JSON input' },
      { run: emptyRun() },
    );
    expect(settlement.kind).toBe('refused');
  });
});

describe('reading is immediate; acting is not', () => {
  test('read_run reports the loop it was told about, and says what it cannot see', () => {
    const state = run(
      { type: 'ready', protocol: 1, pid: 4 },
      narration('phase_started', { phase: 'planning', round: 0 }),
      narration('turn_started', { role: 'planner', kind: 'plan', round: 0 }),
      narration('heartbeat', { elapsedMs: 42_000, activities: 3, unit: 'tool use' }),
    );
    const seen = ran(execute(call('read_run', {}), { run: state }));

    expect(seen['protocol']).toBe(1);
    expect(seen['running']).toMatchObject({ role: 'planner', kind: 'plan', elapsedMs: 42_000 });
    // Named rather than left out. A model that cannot see the archive would
    // otherwise answer "has this been tried before" from nothing at all.
    expect(JSON.stringify(seen['unavailable'])).toContain('#114');
  });

  test("read_run's elapsed is the loop's own figure, absent until it reports one", () => {
    // Never our clock. `Run` carries wall-clock instants and a duration is what
    // is true whenever it is read; a turn nobody has measured is not a turn that
    // has taken no time.
    const state = run(narration('turn_started', { role: 'planner', kind: 'plan' }));
    const seen = ran(execute(call('read_run', {}), { run: state }));
    expect(seen['running']).toMatchObject({ elapsedMs: null, lastActivity: null });
  });

  test('read_output returns lines with their ids, and says how many it kept back', () => {
    const state = run(
      narration('phase_started', { phase: 'planning' }, 'first'),
      narration('turn_started', { role: 'planner', kind: 'plan' }, 'second'),
    );
    const seen = ran(execute(call('read_output', { lines: 1 }), { run: state }));
    expect(seen['returned']).toBe(1);
    // Both numbers, because "1 of 1" and "1 of 2" are different facts and only
    // one of them means there is more to ask for.
    expect(seen['kept']).toBe(2);
    expect(JSON.stringify(seen['lines'])).toContain('turn_started');
  });

  test('a line count outside the window is refused rather than clamped', () => {
    // A model that asked for 5000 was reasoning about a window that does not
    // exist, and silently handing it 500 leaves that belief in place.
    for (const lines of [0, -1, 2.5, OUTPUT_KEEP + 1, 'forty']) {
      const settlement = execute(call('read_output', { lines }), { run: emptyRun() });
      expect(settlement.kind).toBe('refused');
    }
    expect(execute(call('read_output', {}), { run: emptyRun() }).kind).toBe('ran');
  });
});

describe('start_run proposes, and never starts', () => {
  const good = { task: 'do the thing', directory: '/repo', plan_only: true };

  test('it builds the argv the launch form builds, and stops there', () => {
    const settlement = execute(call('start_run', good), { run: emptyRun() });
    expect(settlement.kind).toBe('proposes');
    if (settlement.kind !== 'proposes') return;
    // The same function the button uses. Two spellings of form-to-argv would
    // drift on the next flag anybody adds, and `parseArgs` would stop being the
    // one definition of a legal invocation.
    expect(settlement.effect).toEqual({
      kind: 'invoke',
      argv: launchArgv('do the thing', '/repo', true),
    });
  });

  test('plan_only has no default, because that is not a fallback-value decision', () => {
    // The difference between a plan and a run that writes code and commits.
    const settlement = execute(
      call('start_run', { task: 'x', directory: '/repo' }),
      { run: emptyRun() },
    );
    expect(settlement.kind).toBe('refused');
    expect(settlement.kind === 'refused' && settlement.content).toContain('plan_only');
  });

  test('a field of the wrong type is refused by name, not coerced', () => {
    for (const input of [
      { task: 7, directory: '/repo', plan_only: true },
      { task: 'x', directory: '', plan_only: true },
      { task: '   ', directory: '/repo', plan_only: false },
      'not an object',
    ]) {
      expect(execute(call('start_run', input), { run: emptyRun() }).kind).toBe('refused');
    }
  });

  test('a full run says so in the summary, because that one commits', () => {
    const settlement = execute(call('start_run', { ...good, plan_only: false }), {
      run: emptyRun(),
    });
    expect(settlement.kind === 'proposes' && settlement.summary).toContain('commits');
  });
});

describe('answer_gate proposes a decision the core will judge', () => {
  const holding = run({
    type: 'ask',
    id: 9,
    context: { boundary: 'plan-approved', phase: 'implementing', planRound: 1, reviewRound: 0, verifyRound: 0 },
  });

  test('a continue carries the gate id the host allocated, and who asked', () => {
    const settlement = execute(call('answer_gate', { decision: 'continue' }), { run: holding });
    expect(settlement.kind).toBe('proposes');
    if (settlement.kind !== 'proposes') return;
    expect(settlement.effect).toEqual({
      kind: 'answer',
      askId: 9,
      // Unnarrowed on the wire - `readDecision` owns that vocabulary - with the
      // origin alongside so the release leaves an attributed row.
      decision: { kind: 'continue', origin: ORIGIN },
    });
  });

  test('a stop with no reason carries null, not a sentence nobody wrote', () => {
    // `holdAt` has its own wording for a stop with no reason, and it reaches
    // NEEDS-INPUT.md. Inventing one here would put words in that file.
    const settlement = execute(call('answer_gate', { decision: 'stop', reason: '  ' }), {
      run: holding,
    });
    expect(settlement.kind === 'proposes' && settlement.effect).toEqual({
      kind: 'answer',
      askId: 9,
      decision: { kind: 'stop', reason: null, origin: ORIGIN },
    });
  });

  test('there is nothing to answer when no gate is open', () => {
    // Refused with the state rather than proposed into the void: `serve.ts`
    // rejects an answer to a gate nobody is waiting on, and finding that out
    // after a person pressed a button is finding it out in the wrong place.
    const settlement = execute(call('answer_gate', { decision: 'continue' }), {
      run: emptyRun(),
    });
    expect(settlement.kind).toBe('refused');
  });

  test('a decision the loop does not understand is refused here rather than read as a stop', () => {
    const settlement = execute(call('answer_gate', { decision: 'implement anyway' }), {
      run: holding,
    });
    expect(settlement.kind).toBe('refused');
  });
});
