import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHeartbeat,
  dueForEmit,
  emptySnapshot,
  formatElapsed,
  formatHeartbeat,
  parseClaudeLine,
  parseCodexLine,
  progressOptions,
  rememberContextWindow,
  withHeartbeat,
} from '@src/progress.js';
import type {
  ActivityObservation,
  Heartbeat,
  LineParser,
  ProgressSnapshot,
  RepeatingTimer,
  TimerApi,
} from '@src/progress.js';
import { DEFAULTS } from '@src/config.js';
import type { Config, RunState } from '@src/types.js';

/** A recorded `assistant` event, shaped as claude.ts parseStream expects them. */
function assistantLine(message: Record<string, unknown>): string {
  return JSON.stringify({ type: 'assistant', message });
}

test('a tool_use block per line is counted and named with its target', () => {
  const snapshot = emptySnapshot();

  const recognised = parseClaudeLine(
    snapshot,
    assistantLine({
      content: [
        { type: 'tool_use', name: 'Grep', input: { pattern: 'claudeTurn' } },
        { type: 'tool_use', name: 'Read', input: { file_path: 'src/orchestrator.ts' } },
      ],
    }),
  );

  assert.equal(recognised, true);
  assert.equal(snapshot.activities, 2);
  assert.equal(snapshot.lastActivity, 'Read src/orchestrator.ts');
});

test('a tool_use with no recognisable target still counts, under its bare name', () => {
  const snapshot = emptySnapshot();

  parseClaudeLine(snapshot, assistantLine({ content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [] } }] }));

  assert.equal(snapshot.activities, 1);
  assert.equal(snapshot.lastActivity, 'TodoWrite');
});

test('a long tool target is truncated rather than wrapping the terminal', () => {
  const snapshot = emptySnapshot();
  const longPath = `src/${'nested/'.repeat(20)}file.ts`;

  parseClaudeLine(snapshot, assistantLine({ content: [{ type: 'tool_use', name: 'Read', input: { file_path: longPath } }] }));

  assert.ok((snapshot.lastActivity ?? '').length < longPath.length);
  assert.match(snapshot.lastActivity ?? '', /^Read src\/nested\//);
});

test('claude usage accumulates turn tokens and replaces the prompt size', () => {
  const snapshot = emptySnapshot();
  const usage = (input: number, output: number): string =>
    assistantLine({
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 1_000,
        cache_creation_input_tokens: 100,
      },
    });

  parseClaudeLine(snapshot, usage(10, 5));
  assert.equal(snapshot.tokens, 1_115);
  assert.equal(snapshot.promptTokens, 1_110);

  parseClaudeLine(snapshot, usage(20, 5));
  // Tokens are cumulative work; promptTokens is the latest request only.
  assert.equal(snapshot.tokens, 1_115 + 1_125);
  assert.equal(snapshot.promptTokens, 1_120);
});

test('a claude result event is recognised but changes nothing', () => {
  const snapshot = emptySnapshot();

  const recognised = parseClaudeLine(snapshot, JSON.stringify({ type: 'result', usage: { input_tokens: 9_999 } }));

  assert.equal(recognised, true);
  assert.deepEqual(snapshot, emptySnapshot());
});

test('no malformed or unrecognised line can disturb the snapshot or throw', () => {
  for (const line of [
    '',
    '   ',
    'not json',
    '{',
    '[]',
    'null',
    '{"type":"assistant"}',
    '{"type":"assistant","message":{"content":"oops"}}',
    '{"type":"assistant","message":{"content":[null,3,{"type":"text"}]}}',
    '{"type":"system","subtype":"init"}',
  ]) {
    const snapshot = emptySnapshot();
    let recognised: boolean | null = null;
    assert.doesNotThrow(() => {
      recognised = parseClaudeLine(snapshot, line);
    }, `claude parser threw on ${JSON.stringify(line)}`);
    assert.equal(recognised, false, `claude parser claimed ${JSON.stringify(line)}`);
    assert.deepEqual(snapshot, emptySnapshot());

    const codexSnapshot = emptySnapshot();
    assert.doesNotThrow(() => {
      recognised = parseCodexLine(codexSnapshot, line);
    }, `codex parser threw on ${JSON.stringify(line)}`);
    assert.equal(recognised, false);
    assert.deepEqual(codexSnapshot, emptySnapshot());
  }
});

test('codex item events count and name the item type', () => {
  const snapshot = emptySnapshot();

  parseCodexLine(snapshot, JSON.stringify({ type: 'item.started', item: { type: 'reasoning' } }));
  parseCodexLine(snapshot, JSON.stringify({ type: 'item.completed', item: { type: 'command_execution' } }));

  assert.equal(snapshot.activities, 2);
  assert.equal(snapshot.lastActivity, 'command_execution');
});

test('codex turn.completed totals two fields, not four', () => {
  const snapshot = emptySnapshot();

  parseCodexLine(
    snapshot,
    JSON.stringify({
      type: 'turn.completed',
      // cached_input_tokens is a SUBSET of input_tokens on OpenAI's nesting.
      usage: { input_tokens: 29_163, cached_input_tokens: 13_056, output_tokens: 59, reasoning_output_tokens: 41 },
    }),
  );

  assert.equal(snapshot.tokens, 29_222);
  assert.equal(snapshot.promptTokens, 0);
});

test('elapsed time reads as a duration at every scale', () => {
  assert.equal(formatElapsed(0), '0s');
  assert.equal(formatElapsed(-5), '0s');
  assert.equal(formatElapsed(58_000), '58s');
  assert.equal(formatElapsed(252_000), '4m12s');
  assert.equal(formatElapsed(3_840_000), '1h04m');
});

function snapshotOf(over: Partial<ProgressSnapshot>): ProgressSnapshot {
  return { ...emptySnapshot(), ...over };
}

test('a full heartbeat line carries every segment the stream supplied', () => {
  const line = formatHeartbeat({
    label: 'plan-0',
    elapsedMs: 252_000,
    unit: 'tool use',
    contextWindow: 200_000,
    snapshot: snapshotOf({
      activities: 23,
      lastActivity: 'Read src/orchestrator.ts',
      tokens: 340_000,
      promptTokens: 62_000,
    }),
  });

  assert.equal(line, 'plan-0: 4m12s · 23 tool uses · Read src/orchestrator.ts · 340k tok · ctx 31%');
});

test('a heartbeat with nothing to report is still an elapsed time', () => {
  const line = formatHeartbeat({
    label: 'answers-0',
    elapsedMs: 45_000,
    unit: 'event',
    snapshot: emptySnapshot(),
  });

  assert.equal(line, 'answers-0: 45s');
});

test('the ctx segment is omitted unless both the window and a prompt size exist', () => {
  const withPrompt = snapshotOf({ promptTokens: 62_000 });

  assert.doesNotMatch(formatHeartbeat({ label: 'p', elapsedMs: 0, unit: 'event', snapshot: withPrompt }), /ctx/);
  assert.doesNotMatch(
    formatHeartbeat({ label: 'p', elapsedMs: 0, unit: 'event', snapshot: emptySnapshot(), contextWindow: 200_000 }),
    /ctx/,
  );
  assert.match(
    formatHeartbeat({ label: 'p', elapsedMs: 0, unit: 'event', snapshot: withPrompt, contextWindow: 200_000 }),
    /ctx 31%/,
  );
});

test('the activity count is pluralised', () => {
  const one = formatHeartbeat({ label: 'p', elapsedMs: 0, unit: 'tool use', snapshot: snapshotOf({ activities: 1 }) });
  const two = formatHeartbeat({ label: 'p', elapsedMs: 0, unit: 'tool use', snapshot: snapshotOf({ activities: 2 }) });

  assert.match(one, /1 tool use\b/);
  assert.match(two, /2 tool uses\b/);
});

test('the throttle is due exactly on the interval, not a millisecond before', () => {
  assert.equal(dueForEmit(1_000, 1_000 + 30_000, 30_000), true);
  assert.equal(dueForEmit(1_000, 1_000 + 29_999, 30_000), false);
});

/** A timer that never fires on its own: the test invokes the captured tick. */
function fakeTimers(): { api: TimerApi; tick: () => void; unrefs: number; cancels: number } {
  const state = { unrefs: 0, cancels: 0, tick: () => {} };
  const api: TimerApi = {
    repeat: (tick) => {
      state.tick = tick;
      const handle: RepeatingTimer = {
        unref: () => {
          state.unrefs += 1;
        },
        cancel: () => {
          state.cancels += 1;
        },
      };
      return handle;
    },
  };
  return {
    api,
    tick: () => state.tick(),
    get unrefs() {
      return state.unrefs;
    },
    get cancels() {
      return state.cancels;
    },
  };
}

interface Harness {
  heartbeat: ReturnType<typeof createHeartbeat>;
  lines: string[];
  seen: ActivityObservation[];
  advance: (ms: number) => void;
  /** Fires the timer by hand, so the suite waits for nothing. */
  tick: () => void;
  timers: ReturnType<typeof fakeTimers>;
}

function harness(over: { parse?: LineParser; intervalMs?: number } = {}): Harness {
  const lines: string[] = [];
  const seen: ActivityObservation[] = [];
  const timers = fakeTimers();
  let clock = 1_000;

  const heartbeat = createHeartbeat({
    label: 'plan',
    intervalMs: over.intervalMs ?? 30_000,
    parse: over.parse ?? parseClaudeLine,
    unit: 'tool use',
    now: () => clock,
    emit: (line) => lines.push(line),
    onActivity: (observation) => seen.push(observation),
    timers: timers.api,
  });

  return {
    heartbeat,
    lines,
    seen,
    advance: (ms) => {
      clock += ms;
    },
    tick: timers.tick,
    timers,
  };
}

const TOOL_LINE = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] },
});

test('a line that also triggers an emission still notifies exactly once', () => {
  const h = harness();

  h.advance(30_000);
  h.heartbeat.onLine(TOOL_LINE);

  assert.equal(h.lines.length, 1);
  assert.equal(h.seen.length, 1);
  assert.equal(h.seen[0]?.source, 'stdout');
  h.heartbeat.stop();
});

test('a thousand lines inside one interval emit nothing and still report liveness', () => {
  const h = harness();

  for (let i = 0; i < 1_000; i += 1) h.heartbeat.onLine(TOOL_LINE);

  assert.equal(h.lines.length, 0);
  assert.equal(h.seen.length, 1_000);
  h.heartbeat.stop();
});

test('a silent turn still emits and still records activity from the tick alone', () => {
  const h = harness();

  h.advance(30_000);
  h.tick();

  assert.equal(h.lines.length, 1);
  assert.equal(h.lines[0], 'plan: 30s');
  assert.equal(h.seen.length, 1);
  assert.equal(h.seen[0]?.source, 'heartbeat');
  assert.equal(h.seen[0]?.lastLineAt, null);

  // A second tick inside the same interval is not a second line.
  h.tick();
  assert.equal(h.lines.length, 1);
  assert.equal(h.seen.length, 1);
  h.heartbeat.stop();
});

test('a tick that finds the throttle not yet due neither emits nor notifies', () => {
  const h = harness();

  h.advance(29_999);
  h.tick();

  assert.equal(h.lines.length, 0);
  assert.equal(h.seen.length, 0);
  h.heartbeat.stop();
});

test('an observation carries the time of the last line, not of the observation', () => {
  const h = harness();

  h.advance(5_000);
  h.heartbeat.onLine(TOOL_LINE);
  h.advance(30_000);
  h.tick();

  const tick = h.seen.at(-1);
  assert.equal(tick?.source, 'heartbeat');
  assert.equal(tick?.lastLineAt?.getTime(), 6_000);
  assert.equal(tick?.at.getTime(), 36_000);
  h.heartbeat.stop();
});

test('flush records the last line without emitting a line of its own', () => {
  const h = harness();

  h.advance(1_000);
  h.heartbeat.onLine(TOOL_LINE);
  h.heartbeat.flush();

  assert.equal(h.lines.length, 0);
  const final = h.seen.at(-1);
  assert.equal(final?.source, 'final');
  assert.equal(final?.lastLineAt?.getTime(), 2_000);
  h.heartbeat.stop();
});

test('flush before any output, and after stop, is a no-op', () => {
  const h = harness();

  h.heartbeat.flush();
  assert.equal(h.seen.length, 0);

  h.heartbeat.onLine(TOOL_LINE);
  h.heartbeat.stop();
  const afterStop = h.seen.length;
  h.heartbeat.flush();
  assert.equal(h.seen.length, afterStop);
});

test('a parser that throws costs the parse, not the turn', () => {
  const h = harness({
    parse: () => {
      throw new Error('bad line');
    },
  });

  h.advance(30_000);
  assert.doesNotThrow(() => h.heartbeat.onLine(TOOL_LINE));

  assert.equal(h.lines.length, 1);
  assert.equal(h.seen.length, 1);
  h.heartbeat.stop();
});

test('a throwing sink or a throwing state write does not propagate', () => {
  const timers = fakeTimers();
  let clock = 0;
  const heartbeat = createHeartbeat({
    label: 'plan',
    intervalMs: 1_000,
    parse: parseClaudeLine,
    unit: 'tool use',
    now: () => clock,
    emit: () => {
      throw new Error('sink is gone');
    },
    onActivity: () => {
      throw new Error('state write failed');
    },
    timers: timers.api,
  });

  clock += 1_000;
  assert.doesNotThrow(() => heartbeat.onLine(TOOL_LINE));
  assert.doesNotThrow(() => heartbeat.flush());
  heartbeat.stop();
});

test('the repeating timer is unref\'d at construction and cancelled by stop', () => {
  const h = harness();

  assert.equal(h.timers.unrefs, 1);
  assert.equal(h.timers.cancels, 0);

  h.heartbeat.stop();
  assert.equal(h.timers.cancels, 1);

  // Idempotent: adapters call stop() from a finally that can run twice over.
  h.heartbeat.stop();
  assert.equal(h.timers.cancels, 1);
});

test('after stop, neither a line nor a tick emits or notifies', () => {
  const h = harness();

  h.heartbeat.stop();
  h.advance(60_000);
  h.heartbeat.onLine(TOOL_LINE);
  h.tick();

  assert.equal(h.lines.length, 0);
  assert.equal(h.seen.length, 0);
});

/** A heartbeat that records the order its lifecycle methods were called in. */
function recordingHeartbeat(): { heartbeat: Heartbeat; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    heartbeat: {
      onLine: () => calls.push('line'),
      flush: () => calls.push('flush'),
      stop: () => calls.push('stop'),
    },
  };
}

test('withHeartbeat flushes then stops on a completed turn', async () => {
  const { heartbeat, calls } = recordingHeartbeat();

  const result = await withHeartbeat(heartbeat, () => Promise.resolve('the output'));

  assert.equal(result, 'the output');
  assert.deepEqual(calls, ['flush', 'stop']);
});

test('withHeartbeat stops but does not flush a turn that failed', async () => {
  const { heartbeat, calls } = recordingHeartbeat();

  await assert.rejects(
    () => withHeartbeat(heartbeat, () => Promise.reject(new Error('claude timed out after 1ms'))),
    /timed out/,
  );

  assert.deepEqual(calls, ['stop']);
});

test('withHeartbeat passes the value through when progress is disabled', async () => {
  assert.equal(await withHeartbeat(null, () => Promise.resolve(7)), 7);
});

function state(): RunState {
  return { dir: '/nowhere', events: [] } as unknown as RunState;
}

function config(over: Partial<Config['progress']> = {}, model = 'opus'): Config {
  return {
    ...DEFAULTS,
    claude: { ...DEFAULTS.claude, model },
    progress: { ...DEFAULTS.progress, ...over },
  };
}

test('progress options are undefined when progress is switched off', () => {
  assert.equal(progressOptions(state(), config({ enabled: false }), 'plan'), undefined);
});

test('progress options carry the label and the configured cadence', () => {
  const options = progressOptions(state(), config({ intervalMs: 5_000 }), 'plan-0');

  assert.equal(options?.label, 'plan-0');
  assert.equal(options?.intervalMs, 5_000);
});

test('a context window is offered only for the model it was measured under', () => {
  // Distinct model names per test: the window note is process-local by design,
  // so tests must not depend on being able to reset it.
  rememberContextWindow('fixture-measured', 200_000);

  assert.equal(progressOptions(state(), config({}, 'fixture-measured'), 'plan')?.contextWindow, 200_000);
  assert.equal(progressOptions(state(), config({}, 'fixture-other'), 'plan')?.contextWindow, undefined);
});

test('a window of zero is not remembered: it would render as ctx 0%', () => {
  rememberContextWindow('fixture-zero', 0);

  assert.equal(progressOptions(state(), config({}, 'fixture-zero'), 'plan')?.contextWindow, undefined);
});
