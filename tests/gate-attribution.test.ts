import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrate } from '@src/orchestrator.js';
import { readDecision, readOrigin } from '@src/host.js';
import type { Host } from '@src/host.js';
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
 * Who released a gate, when it was not simply the person at the window (#144).
 *
 * The pilot chat can propose a decision, and a human fires it. That makes the
 * *action* the human's and the *proposal* something else's, and six months later
 * the difference between those two is the whole audit question. So the answer
 * carries a label, and an answer that carries one leaves a row.
 *
 * The rule this file pins is the carve-out and its edges, in both directions: an
 * attributed release records, an unattributed one still records nothing, and an
 * origin nobody can read never stops a run over it.
 */

function fullRun(prefix: string): RunState {
  return freshRun({ prefix, task: 'gate attribution', planOnly: false, git: true, commit: true });
}

function passing(state: RunState): Handlers {
  return {
    claude: (label) =>
      label === 'plan' || label.startsWith('revise-') ? planFixture() : work(state, `${label}.txt`),
    codex: () => report([]),
  };
}

function answering(answer: unknown): Host {
  return { decide: () => Promise.resolve(answer) };
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

function drive(state: RunState, host: Host): Promise<unknown> {
  return muted(() =>
    orchestrate(
      state,
      config({}, { ...committing(), ...verifying(state) }),
      false,
      agents(passing(state), []),
      host,
    ),
  );
}

test('an origin is read separately from the decision, and drops what it cannot read', () => {
  // The two failure directions, which are deliberately opposite. An unreadable
  // DECISION stops the run - it is an instruction nobody could parse. An
  // unreadable ORIGIN is a label on one, and refusing to work over a malformed
  // label would stop the run for a reason unrelated to the run.
  assert.equal(readOrigin({ kind: 'continue', origin: 'pilot' }), 'pilot');
  assert.equal(readOrigin({ kind: 'continue' }), null);
  assert.equal(readOrigin({ kind: 'continue', origin: '' }), null);
  assert.equal(readOrigin({ kind: 'continue', origin: '   ' }), null);
  assert.equal(readOrigin({ kind: 'continue', origin: 7 }), null);
  assert.equal(readOrigin(undefined), null);
  // Long enough to name a thing, short enough that it cannot become a message -
  // and over the ceiling it is dropped rather than truncated, because a
  // truncated label is a different label.
  assert.equal(readOrigin({ origin: 'x'.repeat(41) }), null);
  assert.equal(readOrigin({ origin: 'x'.repeat(40) }), 'x'.repeat(40));
  // Trimmed, because a label with a stray newline in it is the same label - and
  // the trim is what makes the emptiness check above mean anything.
  assert.equal(readOrigin({ origin: ' pilot\n' }), 'pilot');

  // And the half that must NOT move: an origin, readable or not, never changes
  // what the loop was told to do.
  assert.equal(readDecision({ kind: 'continue', origin: 7 }).kind, 'continue');
  assert.deepEqual(readDecision({ kind: 'stop', origin: 'pilot' }), {
    kind: 'stop',
    reason: null,
  });
});

test('an attributed release leaves a row, and an unattributed one still does not', async () => {
  // Both halves in one test on purpose: the claim is the DIFFERENCE, and either
  // assertion alone would pass against a build that recorded every release or
  // none of them.
  const attributed = fullRun('vibe-origin-yes-');
  await drive(attributed, answering({ kind: 'continue', origin: 'pilot' }));
  const rows = attributed.events.filter((e) => e.type === 'gate_released');
  assert.ok(rows.length > 0, 'an attributed release recorded nothing');
  for (const row of rows) {
    assert.equal(row['origin'], 'pilot');
    assert.equal(typeof row['boundary'], 'string');
  }

  const plain = fullRun('vibe-origin-no-');
  await drive(plain, answering({ kind: 'continue' }));
  assert.equal(
    plain.events.some((e) => e.type === 'gate_released'),
    false,
    'a person pressing continue should leave the archive exactly as it was',
  );
});

test('a stop carries who asked for it, alongside why', async () => {
  // `gate_stopped` was already recorded, so this adds a field rather than a row.
  // The reason and the origin are two facts and neither substitutes for the
  // other: the reason is what to do about it, the origin is who decided.
  const state = fullRun('vibe-origin-stop-');
  await drive(
    state,
    answering({ kind: 'stop', reason: 'the plan never converged', origin: 'pilot' }),
  ).catch(() => undefined);

  const stopped = state.events.find((e) => e.type === 'gate_stopped');
  assert.equal(stopped?.['origin'], 'pilot');
  assert.equal(stopped?.['reason'], 'the plan never converged');
});

test('an unreadable origin is dropped, and the run continues on the decision it was given', async () => {
  // The direction that matters. A host that mangles a label has still said
  // `continue`, and stopping there would refuse work over bookkeeping.
  const state = fullRun('vibe-origin-junk-');
  await drive(state, answering({ kind: 'continue', origin: { who: 'pilot' } }));

  assert.equal(state.status, 'done');
  assert.equal(
    state.events.some((e) => e.type === 'gate_released'),
    false,
    'an origin nobody could read must not be recorded as somebody',
  );
});
