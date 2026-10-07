import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { readDecision } from '@src/host.js';
import type { GateContext, Host } from '@src/host.js';
import {
  agents,
  committing,
  config,
  freshRun,
  planFixture,
  report,
  verifying,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { RunState } from '@src/types.js';

/**
 * The host gate (#134): the one place something outside the loop can get in
 * front of it.
 *
 * The claim under test is the one that made this worth building in-process
 * rather than as an exit: **holding costs nothing.** The process stays alive, so
 * the agent session stays warm and the run resumes from the await rather than
 * from disk. `holds and then releases` below asserts exactly that, by checking
 * the Claude conversation id is the same one on both sides of the hold.
 */

function fullRun(prefix: string): RunState {
  return freshRun({ prefix, task: 'host gate', planOnly: false, git: true, commit: true });
}

function passing(state: RunState): Handlers {
  return {
    claude: (label) =>
      label === 'plan' || label.startsWith('revise-') ? planFixture() : work(state, `${label}.txt`),
    codex: () => report([]),
  };
}

/** A host that answers immediately, recording what it was asked. */
function answering(answer: unknown): Host & { asked: GateContext[] } {
  const asked: GateContext[] = [];
  return {
    asked,
    decide: (ctx) => {
      asked.push(ctx);
      return Promise.resolve(answer);
    },
  };
}

function muted<T>(body: () => Promise<T>): Promise<T> {
  const realLog = console.log;
  const realError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  return body().finally(() => {
    console.log = realLog;
    console.error = realError;
  });
}

test('a run with no host behaves exactly as it does today', async () => {
  // The groundwork bar. Every existing caller passes no host, so this is the
  // case that says nothing shipped changes.
  const state = fullRun('vibe-gate-none-');
  const calls: string[] = [];

  await muted(() =>
    orchestrate(
      state,
      config({}, { ...committing(), ...verifying(state) }),
      false,
      agents(passing(state), calls),
    ),
  );

  assert.deepEqual(calls, ['plan', 'critique-0', 'implement', 'review-0']);
  assert.equal(state.status, 'done');
});

test('a host is asked at every boundary except complete', async () => {
  const state = fullRun('vibe-gate-all-');
  const host = answering({ kind: 'continue' });

  await muted(() =>
    orchestrate(
      state,
      config({}, { ...committing(), ...verifying(state) }),
      false,
      agents(passing(state), []),
      host,
    ),
  );

  const boundaries = host.asked.map((c) => c.boundary);
  // A gate exists to hold BEFORE the next thing. At `complete` there is no next
  // thing, so asking would offer a decision that could not change anything.
  assert.equal(boundaries.includes('complete'), false, boundaries.join(', '));
  assert.ok(boundaries.includes('plan-approved'), boundaries.join(', '));
  assert.ok(boundaries.includes('implemented'), boundaries.join(', '));
  // The context says where in the run it is, not only which boundary.
  const approved = host.asked.find((c) => c.boundary === 'plan-approved');
  assert.equal(typeof approved?.planRound, 'number');
  assert.equal(approved?.phase, 'implementing');
});

test('it holds where it is told, and releases onto the same warm session', async () => {
  // The acceptance test #134 names, and the reason the app links this source
  // instead of shelling out.
  const state = fullRun('vibe-gate-hold-');
  const calls: string[] = [];

  // No-op initializers rather than `null`: assigning only inside the executor
  // leaves control-flow analysis narrowing the binding to `never` at the call.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached: () => void = () => undefined;
  const atGate = new Promise<void>((resolve) => {
    reached = resolve;
  });

  let sessionAtHold: string | null = null;
  const host: Host = {
    decide: async (ctx) => {
      if (ctx.boundary !== 'plan-approved') return { kind: 'continue' };
      sessionAtHold = state.sessionId;
      reached();
      await held;
      return { kind: 'continue' };
    },
  };

  const run = muted(() =>
    orchestrate(
      state,
      config({}, { ...committing(), ...verifying(state) }),
      false,
      agents(passing(state), calls),
      host,
    ),
  );

  // The gate itself says when it has been reached, so there is no sleep and no
  // guess about how many ticks a plan phase takes. By the time this resolves the
  // loop is inside `decide`, blocked on `held`, and cannot proceed.
  await atGate;
  // A few turns of the event loop on top, so "nothing further ran" is a claim
  // about a loop that had the chance to run rather than one that was merely not
  // asked yet.
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));

  assert.deepEqual(calls, ['plan', 'critique-0'], 'the loop ran past the gate');
  assert.notEqual(sessionAtHold, null, 'the gate was never reached');

  release();
  await run;

  assert.deepEqual(calls, ['plan', 'critique-0', 'implement', 'review-0']);
  // The whole point: the conversation on the far side of the hold is the one
  // that was open before it. Nothing was re-sent and nothing was paid for twice.
  assert.equal(state.sessionId, sessionAtHold);
  assert.equal(state.status, 'done');
});

test('stop ends the run resumably, and nothing after the boundary runs', async () => {
  const state = fullRun('vibe-gate-stop-');
  const calls: string[] = [];

  const err = await muted(() =>
    orchestrate(
      state,
      config({}, { ...committing(), ...verifying(state) }),
      false,
      agents(passing(state), calls),
      answering({ kind: 'stop', reason: 'I want to read the plan first' }),
    ).then(
      () => null,
      (e: unknown) => e,
    ),
  );

  assert.ok(err instanceof Escalation, String(err));
  // The exit-resumable path the round caps already use: `execute` turns this
  // into `status: 'needs-input'` and writes NEEDS-INPUT.md.
  assert.equal(err.code, EXIT.NEEDS_HUMAN);
  assert.match(err.message, /I want to read the plan first/);
  assert.deepEqual(calls, ['plan', 'critique-0']);
  // A stop IS a transition, so it is in the archive as well as on the terminal.
  assert.ok(state.events.some((e) => e.type === 'gate_stopped'));
});

test('an answer nobody can read stops rather than continues', async () => {
  // Fail closed, and the direction matters. Continuing on an unparseable
  // instruction spends tokens and writes code on the strength of a message that
  // may have said the opposite; stopping is recoverable from a checkpoint.
  assert.deepEqual(readDecision(undefined), {
    kind: 'stop',
    reason: 'the host answered with no decision',
  });
  assert.equal(readDecision({ kind: 'proceed' }).kind, 'stop');
  assert.equal(readDecision({ kind: 'continue' }).kind, 'continue');
  assert.deepEqual(readDecision({ kind: 'stop' }), { kind: 'stop', reason: null });

  // And through the loop, not only through the parser.
  const state = fullRun('vibe-gate-junk-');
  const calls: string[] = [];
  const err = await muted(() =>
    orchestrate(
      state,
      config({}, { ...committing(), ...verifying(state) }),
      false,
      agents(passing(state), calls),
      answering({ kind: 'carry on then' }),
    ).then(
      () => null,
      (e: unknown) => e,
    ),
  );

  assert.ok(err instanceof Escalation);
  assert.match(err.message, /not a decision this version understands/);
  assert.deepEqual(calls, ['plan', 'critique-0']);
});

test('waiting is narrated with an id and recorded as nothing', async () => {
  // The durability rule from #133, applied to the line #133 named. A gate that
  // is waiting is not a transition - nothing resumes from "was waiting" - so it
  // gets an id a host can act on and no row in state.events.
  const state = fullRun('vibe-gate-narrate-');
  const seen: Narration[] = [];
  log.setSink((n) => void seen.push(n));
  try {
    await muted(() =>
      orchestrate(
        state,
        config({}, { ...committing(), ...verifying(state) }),
        false,
        agents(passing(state), []),
        answering({ kind: 'continue' }),
      ),
    );
  } finally {
    log.setSink(null);
  }

  const waiting = seen.filter((n) => n.id === 'gate_waiting');
  assert.ok(waiting.length > 0, 'the gate never said it was waiting');
  assert.equal(waiting[0]?.data?.['boundary'], 'plan-approved');
  assert.ok(seen.some((n) => n.id === 'gate_released'));

  assert.equal(
    state.events.some((e) => e.type === 'gate_waiting' || e.type === 'gate_released'),
    false,
    'a gate that only waited should leave no row in the archive',
  );
});
