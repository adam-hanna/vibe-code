import { describe, expect, test } from 'vitest';
import type { Frame } from '../host';
import type { LiveRun } from '../cockpit/hosts';
import { emptyRun, reduce } from '../cockpit/model';
import type { Run } from '../cockpit/model';
import type { Draft } from '../cockpit/pending';
import { noCommands } from '../cockpit/commands';
import { bindingOf, boundRun, sameBinding } from './bound';
import type { BindArgs, Binding } from './bound';
import { systemPrompt } from './brief';
import { execute, settleCall } from './tools';

/**
 * A pilot conversation reads the run it is bound to, by id (#438).
 *
 * The report: in the chat that launched run `20261023-111151`, after the run had
 * finished `done`/`complete` with its round cards showing in the same chat, the
 * pilot said the run's narration was empty and the run block showed nothing,
 * and guessed setup was still running. The chat file shows how. A `read_output`
 * asked a second after the launch was still owed when the conversation was
 * restored onto the ended run 57 minutes later. It was settled at once against
 * the pane's `run` prop, which was the column's run. The column was blank
 * because the opened run's replay had not come back yet. The cards arrived with
 * the replay a moment later.
 *
 * These cases drive `bindingOf` and the tools the pane drives with it, with
 * runs folded from real frames rather than written by hand.
 */

const say = (id: string, data: Record<string, unknown>, message = 'x'): Frame => ({
  type: 'narration',
  level: 'info',
  message,
  id,
  data,
});

function fold(frames: readonly Frame[]): Run {
  return frames.reduce<Run>((run, frame) => reduce(run, frame as Parameters<typeof reduce>[1], 1_000), emptyRun());
}

/** A run that said who it is, planned, and exited 0. */
function finished(runId: string, repo: string, line: string): Run {
  return fold([
    say('run_started', { runId, dir: `${repo}/.vibe/runs/${runId}`, repo, task: 'build it' }),
    say('phase_started', { phase: 'planning', round: 0 }, line),
    say('turn_started', { role: 'planner', kind: 'plan', round: 0 }, 'Claude is planning'),
    { type: 'result', id: 0, exit: 0 },
  ]);
}

function going(runId: string, repo: string, line: string): Run {
  return fold([
    say('run_started', { runId, dir: `${repo}/.vibe/runs/${runId}`, repo, task: 'build it' }),
    say('phase_started', { phase: 'planning', round: 0 }, line),
  ]);
}

function entry(over: Partial<LiveRun> = {}): LiveRun {
  return {
    handle: 'run-7',
    invokeId: 7,
    watched: false,
    unclaimed: [],
    answered: new Set(),
    live: true,
    dir: '/repo',
    asked: null,
    task: 'build it',
    sent: null,
    draft: null,
    held: null,
    adopted: 'moved',
    pid: 100,
    heard: true,
    pausing: false,
    stopping: false,
    run: emptyRun(),
    ...over,
  };
}

function draft(over: Partial<Draft> = {}): Draft {
  return { dir: '/repo', id: 'draft-1', task: 'build it', createdAt: 0, launched: true, runId: null, name: null, ...over };
}

const args = (over: Partial<BindArgs>): BindArgs => ({
  spot: { dir: '/repo', runId: null },
  drafts: [],
  lives: [],
  opened: null,
  ...over,
});

const call = (name: string, input: unknown = {}) => ({ name, input, unreadable: null });

/** What the pane hands the tools: the bound run, and the binding. */
function read(binding: Binding, name: string, input: unknown = {}): Record<string, unknown> {
  const out = execute(call(name, input), { run: boundRun(binding, emptyRun()), bound: binding, commands: noCommands(), dir: '/repo' });
  expect(out.kind).toBe('ran');
  return JSON.parse(out.kind === 'ran' ? out.content : '{}') as Record<string, unknown>;
}

const ID = '20261023-111151-brief';

describe('a conversation whose run has ended still reads that run', () => {
  test('restored onto an opened, ended run: the read waits for the record instead of answering blank', () => {
    // The report's moment: the run is not hosted here any more (its entry was
    // pruned), it is opened, and its replay has not arrived.
    const reading = bindingOf(args({ spot: { dir: '/repo', runId: ID }, opened: { dir: '/repo', runId: ID, run: null, failure: null } }));
    expect(reading).toEqual({ kind: 'reading', runId: ID, via: 'own' });
    const ctx = { run: boundRun(reading, emptyRun()), bound: reading, commands: noCommands(), dir: '/repo' };
    expect(settleCall(call('read_output'), ctx).kind).toBe('waits');
    expect(settleCall(call('read_run'), ctx).kind).toBe('waits');

    // The replay arrives: the same call now answers with the run's narration and ending.
    const replay = finished(ID, '/repo', 'Planning');
    const bound = bindingOf(args({ spot: { dir: '/repo', runId: ID }, opened: { dir: '/repo', runId: ID, run: replay, failure: null } }));
    const output = read(bound, 'read_output');
    expect(output['run']).toMatchObject({ id: ID, state: 'ended', ending: { exit: 0 } });
    expect(output['returned']).toBeGreaterThan(0);
    expect(JSON.stringify(output['lines'])).toContain('Planning');

    const run = read(bound, 'read_run');
    expect(run['run']).toMatchObject({ id: ID, about: expect.stringContaining('own'), state: 'ended' });
    expect(run['completed']).toEqual({ exit: 0 });
    expect((run['cycles'] as unknown[]).length).toBeGreaterThan(0);
  });

  test("an ended run this window hosted is read from the window's own copy while its replay loads", () => {
    const ended = entry({ live: false, run: finished(ID, '/repo', 'Planning') });
    const bound = bindingOf(args({ spot: { dir: '/repo', runId: ID }, lives: [ended], opened: { dir: '/repo', runId: ID, run: null, failure: null } }));
    expect(bound).toMatchObject({ kind: 'run', runId: ID, state: 'ended', source: 'window' });
    expect(read(bound, 'read_output')['returned']).toBeGreaterThan(0);
  });

  test("a draft's conversation reads the run the draft became, after that run ends", () => {
    const ended = entry({ live: false, draft: { id: 'draft-1', dir: '/repo' }, run: finished(ID, '/repo', 'Planning') });
    const bound = bindingOf(args({ spot: { dir: '/repo', runId: 'draft-1' }, drafts: [draft({ runId: ID })], lives: [ended] }));
    expect(bound).toMatchObject({ kind: 'run', runId: ID, via: 'started', state: 'ended' });
    expect(read(bound, 'read_run')['run']).toMatchObject({ about: expect.stringContaining('started') });
  });

  test('a launch that has not said its id yet is starting, said as such', () => {
    const launch = entry({ adopted: null, draft: { id: 'draft-1', dir: '/repo' } });
    const bound = bindingOf(args({ spot: { dir: '/repo', runId: 'draft-1' }, drafts: [draft()], lives: [launch] }));
    expect(bound).toMatchObject({ kind: 'run', runId: null, state: 'starting' });
  });

  test('a run whose host has gone reads as lost, with the host’s sentence', () => {
    const lostRun = { ...going(ID, '/repo', 'Planning'), lost: 'the run host exited with code 1' };
    const bound = bindingOf(args({ spot: { dir: '/repo', runId: ID }, opened: { dir: '/repo', runId: ID, run: lostRun, failure: null } }));
    expect(read(bound, 'read_run')['run']).toMatchObject({ state: 'lost', ending: { lost: 'the run host exited with code 1' } });
  });

  test('a record that cannot be read is said, never answered as an empty run', () => {
    const bound = bindingOf(args({ spot: { dir: '/repo', runId: ID }, opened: { dir: '/repo', runId: ID, run: null, failure: 'no such run' } }));
    const run = read(bound, 'read_run');
    expect(run['run']).toMatchObject({ id: ID, unreadable: expect.stringContaining('no such run') });
    expect(run).not.toHaveProperty('cycles');
  });
});

describe('an empty window names the last run', () => {
  test('a project chat with no run says so, and names the last run it started and how it ended', () => {
    const ended = entry({ live: false, adopted: 'moved', held: { dir: '/repo', runId: null }, run: finished(ID, '/repo', 'Planning') });
    const bound = bindingOf(args({ spot: { dir: '/repo', runId: null }, lives: [ended] }));
    expect(bound).toEqual({ kind: 'none', last: { runId: ID, state: 'ended', exit: 0, lost: null } });
    const run = read(bound, 'read_run');
    expect(run['run']).toMatchObject({ id: null, none: expect.stringContaining(ID) });
    expect(String((run['run'] as Record<string, unknown>)['none'])).toContain('ended (exit 0)');
    // No fields of an empty run beside it, which would read as a run doing nothing yet.
    expect(run).not.toHaveProperty('cycles');
    expect(read(bound, 'read_output')).toMatchObject({ returned: 0, run: { id: null } });
  });

  test('with nothing started at all, it says that too', () => {
    const bound = bindingOf(args({}));
    expect(read(bound, 'read_run')['run']).toMatchObject({ none: expect.stringContaining('has not started one') });
  });

  test('the prompt carries the same header the tool does', () => {
    const ended = entry({ live: false, held: { dir: '/repo', runId: null }, run: finished(ID, '/repo', 'Planning') });
    const bound = bindingOf(args({ lives: [ended] }));
    const prompt = systemPrompt(emptyRun(), null, 'native', null, null, null, null, bound);
    expect(prompt).toContain(`The last run it started was ${ID}`);
  });
});

describe('two runs in one window do not cross', () => {
  const A = '20261023-111151-a';
  const B = '20261023-111221-b';
  const lives = [
    entry({ handle: 'run-364', draft: { id: 'draft-a', dir: '/repo' }, run: going(A, '/repo', 'line of A') }),
    entry({ handle: 'run-390', invokeId: 9, draft: { id: 'draft-b', dir: '/repo' }, run: going(B, '/repo', 'line of B') }),
  ];

  test("each run's own chat reads its own narration, whichever run is on screen", () => {
    const a = read(bindingOf(args({ spot: { dir: '/repo', runId: A }, lives })), 'read_output');
    const b = read(bindingOf(args({ spot: { dir: '/repo', runId: B }, lives })), 'read_output');
    expect(JSON.stringify(a['lines'])).toContain('line of A');
    expect(JSON.stringify(a['lines'])).not.toContain('line of B');
    expect(JSON.stringify(b['lines'])).toContain('line of B');
    expect(JSON.stringify(b['lines'])).not.toContain('line of A');
    expect(a['run']).toMatchObject({ id: A });
    expect(b['run']).toMatchObject({ id: B });
  });

  test("each draft's chat reads the run that draft started, not the other", () => {
    const drafts = [draft({ id: 'draft-a', runId: A }), draft({ id: 'draft-b', runId: B })];
    const a = bindingOf(args({ spot: { dir: '/repo', runId: 'draft-a' }, drafts, lives }));
    const b = bindingOf(args({ spot: { dir: '/repo', runId: 'draft-b' }, drafts, lives }));
    expect(a).toMatchObject({ runId: A });
    expect(b).toMatchObject({ runId: B });
  });

  test('an opened replay of one run is never read by the other run’s chat', () => {
    const replayA = finished(A, '/repo', 'replayed A');
    const onlyB = [lives[1] as LiveRun];
    const b = bindingOf(args({ spot: { dir: '/repo', runId: B }, lives: onlyB, opened: { dir: '/repo', runId: A, run: replayA, failure: null } }));
    expect(b).toMatchObject({ runId: B, source: 'window' });
  });

  test('the same id in another repository is another run', () => {
    const other = entry({ handle: 'run-9', run: going(A, '/elsewhere', 'other repo') });
    const bound = bindingOf(args({ spot: { dir: '/repo', runId: A }, lives: [other] }));
    expect(bound.kind).toBe('unread');
  });
});

test('an unchanged answer is the same object, so the pane does not re-run its effects', () => {
  const lives = [entry({ run: going(ID, '/repo', 'x') })];
  const one = bindingOf(args({ spot: { dir: '/repo', runId: ID }, lives }));
  const two = bindingOf(args({ spot: { dir: '/repo', runId: ID }, lives }));
  expect(one).not.toBe(two);
  expect(sameBinding(one, two)).toBe(true);
  expect(sameBinding(one, bindingOf(args({})))).toBe(false);
});

describe('the window wires it', async () => {
  const pane = (await import('./PilotPane.tsx?raw')).default;
  const cockpit = (await import('../cockpit/Cockpit.tsx?raw')).default;

  test('the pane leaves a waiting read owed, and the cockpit binds every pane by its own conversation', () => {
    expect(pane).toContain("if (out.kind === 'waits') continue;");
    expect(pane).toContain('settleCall(call, { run, bound: binding,');
    expect(cockpit).toContain('const bound = bindPane(pane, { dir: at.dir, runId: at.runId });');
    expect(cockpit).toContain('binding={bound.binding}');
  });
});
