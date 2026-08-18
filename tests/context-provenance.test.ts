import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { rotateSession, shouldRotate } from '@src/context.js';
import { handoffContext } from '@src/prompts.js';
import { progressOptions } from '@src/progress.js';
import {
  createRun,
  measuredRatio,
  measuredWindow,
  recordContextMeasurement,
  resetContextMeasurement,
} from '@src/run.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import type { ClaudeTurnResult, Config, RunState } from '@src/types.js';

/** A started session, with whatever context measurement the case is about. */
function stateWith(over: Partial<RunState>): RunState {
  return {
    dir: '/nowhere',
    events: [],
    sessionStarted: true,
    contextRatio: 0,
    ...over,
  } as unknown as RunState;
}

function cfgWith(model: string, context: Partial<Config['context']> = {}): Config {
  return {
    ...DEFAULTS,
    claude: { ...DEFAULTS.claude, model },
    context: { ...DEFAULTS.context, ...context },
  };
}

test('a ratio measured under a larger window does not defer rotation on a smaller one', () => {
  // 0.4 of a 1M window is 2.0 of a 200k one: read as a number it sits below the
  // 0.5 threshold and compaction never fires.
  const state = stateWith({
    contextModel: 'opus',
    contextRatio: 0.4,
    contextWindow: 1_000_000,
  });

  assert.equal(shouldRotate(state, cfgWith('sonnet')), true);
  // The same number under the model that produced it is trusted as a number.
  assert.equal(shouldRotate(state, cfgWith('opus')), false);
});

test('a measurement over the threshold under its own model still rotates', () => {
  const state = stateWith({ contextModel: 'opus', contextRatio: 0.6, contextWindow: 200_000 });

  assert.equal(shouldRotate(state, cfgWith('opus')), true);
});

test('a session that has never been measured is not evidence of anything', () => {
  // The turn reported no usage, so there is no ratio - rotating here would fire
  // at every turn boundary for the rest of the run.
  const state = stateWith({ contextRatio: 0 });

  assert.equal(shouldRotate(state, cfgWith('sonnet')), false);
});

test('a legacy measurement with no model tag is unknown, not valid', () => {
  const state = stateWith({ contextRatio: 0.4 });

  assert.equal(measuredRatio(state, 'opus'), null);
  assert.equal(shouldRotate(state, cfgWith('opus')), true);
});

test('the baseline rotation is asked for once, not at every turn boundary', () => {
  const state = stateWith({ contextRatio: 0.4 });
  assert.equal(shouldRotate(state, cfgWith('sonnet')), true);

  resetContextMeasurement(state, 'sonnet');

  assert.equal(shouldRotate(state, cfgWith('sonnet')), false);
});

test('a rotation that changes models does not report the old window', () => {
  const state = stateWith({ contextModel: 'opus', contextRatio: 0.4, contextWindow: 1_000_000 });

  resetContextMeasurement(state, 'fixture-rotated');

  assert.equal('contextWindow' in state, false);
  assert.equal(measuredWindow(state, 'fixture-rotated'), undefined);
  assert.equal(
    progressOptions(state, cfgWith('fixture-rotated'), 'plan')?.contextWindow,
    undefined,
  );
});

test('switched-off compaction beats unknown provenance', () => {
  const state = stateWith({ contextRatio: 0.9 });

  assert.equal(shouldRotate(state, cfgWith('sonnet', { enabled: false })), false);
  assert.equal(shouldRotate(stateWith({ contextRatio: 0.9, sessionStarted: false }), cfgWith('sonnet')), false);
});

test('provenance survives the JSON round-trip state.json goes through', () => {
  const state = stateWith({});
  recordContextMeasurement(state, 'opus', 0.4, 1_000_000);

  const reloaded = JSON.parse(JSON.stringify(state)) as RunState;

  assert.equal(measuredRatio(reloaded, 'opus'), 0.4);
  assert.equal(measuredWindow(reloaded, 'opus'), 1_000_000);
  assert.equal(measuredRatio(reloaded, 'sonnet'), null);
});

/** A run with a real directory: rotation writes artifacts and state. */
function runFor(task: string): RunState {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-rot-'));
  return createRun(dir, task, false);
}

function turnResult(text: string): ClaudeTurnResult {
  return {
    text,
    costUsd: 0.01,
    sessionId: 'ignored',
    denials: [],
    numTurns: 1,
    usage: null,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
  };
}

test('a baseline rotation asks the model that grew the conversation for the handoff', async () => {
  const state = runFor('baseline handoff model');
  recordContextMeasurement(state, 'opus', 0.4, 1_000_000);
  state.sessionStarted = true;
  // A briefing flagged stale by an earlier failure; this rotation replaces it.
  state.handoffStale = true;
  const asked: ClaudeTurnOptions[] = [];

  await rotateSession(state, cfgWith('sonnet'), (options) => {
    asked.push(options);
    return Promise.resolve(turnResult('briefing'));
  });

  assert.equal(asked.length, 1);
  assert.equal(asked[0]?.model, 'opus');
  assert.equal(state.handoff, 'briefing');
  assert.equal('handoffStale' in state, false);
  assert.equal(state.contextModel, 'sonnet');
  assert.equal(state.contextRatio, 0);
  assert.equal('contextWindow' in state, false);
});

test('a failed baseline handoff with no prior briefing still carries the plan', async () => {
  // The damaging case: nothing to fall back on, and revisePlanPrompt does not
  // restate the plan - so a fresh session with neither was asked to revise a
  // plan it could not see.
  const state = runFor('baseline no prior handoff');
  state.contextRatio = 0.4;
  state.sessionStarted = true;
  state.handoff = null;
  state.plan = { plan_md: '# the plan of record', assumptions: [], open_questions: [] };

  await rotateSession(state, cfgWith('sonnet'), () => Promise.reject(new Error('prompt too long')));

  assert.equal(state.handoff, null);
  assert.equal(state.handoffStale, true);
  const prefix = handoffContext(state.handoff, state.plan?.plan_md ?? null, state.handoffStale === true);
  assert.match(prefix, /# the plan of record/);
  assert.match(prefix, /no briefing could be taken/i);
});

test('a briefing kept through a failed rotation is presented as stale, not as current', () => {
  const prefix = handoffContext('an earlier briefing', '# the plan of record', true);

  assert.match(prefix, /earlier point in the run/);
  assert.match(prefix, /# the plan of record/);
  // The claim the fresh session must not be given: that this is what it knew
  // when the session it is replacing ended.
  assert.doesNotMatch(prefix, /This briefing is what you knew/);
});

test('a fresh session with neither a briefing nor a plan gets no preamble', () => {
  assert.equal(handoffContext(null, null), '');
});

test('a failed baseline handoff still leaves the unattributed session behind', async () => {
  // The whole point of the baseline is that the outgoing conversation may not
  // fit the model now configured - so the request that loads it is the one most
  // likely to fail, and failing it must not park the run back on that session.
  const state = runFor('baseline handoff failure');
  state.contextRatio = 0.4;
  state.sessionStarted = true;
  state.handoff = 'an earlier briefing';
  const oldSession = state.sessionId;

  await rotateSession(state, cfgWith('sonnet'), () =>
    Promise.reject(new Error('prompt is too long for this model')),
  );

  assert.notEqual(state.sessionId, oldSession);
  assert.equal(state.sessionStarted, false);
  assert.equal(state.sessionRotations, 1);
  // Not nulled - a briefing from earlier in the run beats no seed at all - but
  // flagged, so it is never handed over as the session that just ended.
  assert.equal(state.handoff, 'an earlier briefing');
  assert.equal(state.handoffStale, true);
  assert.equal(state.contextModel, 'sonnet');
  assert.equal(shouldRotate(state, cfgWith('sonnet')), false);
  assert.equal(
    state.events.filter((e) => e.type === 'session_rotated' && e['handoff'] === false).length,
    1,
  );
});

test('a measured rotation still fails loudly when its handoff fails', async () => {
  // Unchanged behaviour: the existing session is known to be usable here, so
  // withConcurrentCompaction is right to catch this and keep working on it.
  const state = runFor('measured handoff failure');
  recordContextMeasurement(state, 'opus', 0.6, 200_000);
  state.sessionStarted = true;
  const oldSession = state.sessionId;

  await assert.rejects(
    () => rotateSession(state, cfgWith('opus'), () => Promise.reject(new Error('claude timed out'))),
    /timed out/,
  );

  assert.equal(state.sessionId, oldSession);
  assert.equal(state.sessionRotations, 0);
  assert.equal(measuredRatio(state, 'opus'), 0.6);
});
