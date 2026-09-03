import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrate } from '@src/orchestrator.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { recordAndSay } from '@src/run.js';
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
 * The durability rule (#133), and the guard that keeps it honest.
 *
 * The rule, decided in `recordAndSay`'s own doc comment: a narration line is
 * durable when a later process needs it - a decision or transition the run can
 * be resumed from or judged by - and everything else is ephemeral. The
 * consequence, which is the part worth testing, is that **narration never
 * creates an event**. `state.events` is the run's memory, read by `vibe list`
 * and by the planner's past-run index, and #133 says in as many words that it
 * must not become a transcript.
 *
 * So the load-bearing case in this file is not that `recordAndSay` works. It is
 * that a clean pass still records the same events it always did.
 */

function cleanRun(): RunState {
  return freshRun({
    prefix: 'vibe-durable-',
    task: 'durability',
    planOnly: false,
    git: true,
    commit: true,
  });
}

function passing(state: RunState): Handlers {
  return {
    claude: (label) =>
      label === 'plan' || label.startsWith('revise-') ? planFixture() : work(state, `${label}.txt`),
    codex: () => report([]),
  };
}

/** Run the loop with the console muted, collecting narration. */
async function pass(state: RunState): Promise<Narration[]> {
  const seen: Narration[] = [];
  const realLog = console.log;
  const realError = console.error;
  log.setSink((n) => void seen.push(n));
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(
      state,
      config({}, { ...committing(), ...verifying(state) }),
      false,
      agents(passing(state), []),
    );
  } finally {
    console.log = realLog;
    console.error = realError;
    log.setSink(null);
  }
  return seen;
}

test('a clean pass records the events it always did, and no more', async () => {
  // THE guard. If narration ever starts creating events, this is what catches
  // it - and it catches it as a *set*, so a new type is a failure rather than a
  // number nobody looks at.
  const state = cleanRun();
  const seen = await pass(state);

  assert.deepEqual(
    [...new Set(state.events.map((e) => e.type))].sort(),
    ['claude_turn', 'codex_turn', 'plan_approved', 'review_approved', 'verify_passed'],
  );
  assert.equal(state.events.length, 7);

  // And the run narrated several times that number, which is the ratio the rule
  // exists to protect. Asserted as an inequality, not a fixed count: the point
  // is that narration is the denser channel, not that it says exactly 23 things.
  assert.ok(
    seen.length > state.events.length * 2,
    `narration ${seen.length} vs events ${state.events.length}`,
  );
});

test('a durable fact arrives at the sink under its own event type', async () => {
  const state = cleanRun();
  const seen = await pass(state);

  // `review_approved` is one of the seven sites where a fact was already being
  // both recorded and narrated, and is now one call.
  const approved = seen.filter((n) => n.id === 'review_approved');
  assert.equal(approved.length, 1);
  assert.equal(approved[0]?.level, 'ok');
  assert.deepEqual(approved[0]?.data, { findings: 0 });

  // The archive and the host agree about the fact rather than about two
  // spellings of it: same identity, same payload.
  const event = state.events.find((e) => e.type === 'review_approved');
  assert.equal(event?.['findings'], 0);
});

test('the event is durable before the sentence is said', async () => {
  // Persist first, narrate second. A sentence claiming something that a kill
  // then prevented from being written would be a lie the archive could not
  // correct - so by the time a host hears it, it is already true on disk.
  const state = cleanRun();
  const realLog = console.log;
  console.log = () => undefined;

  let sawEventWhenTold: boolean | null = null;
  log.setSink((n) => {
    if (n.id !== 'review_approved') return;
    sawEventWhenTold = state.events.some((e) => e.type === 'review_approved');
  });
  try {
    recordAndSay(state, 'ok', 'review_approved', 'Review clean - 0 non-blocking finding(s)', {
      findings: 0,
    });
  } finally {
    log.setSink(null);
    console.log = realLog;
  }

  assert.equal(sawEventWhenTold, true);
});

test('a host that throws cannot cost the archive a fact', async () => {
  // The durable record is the priority and narration is a guest. A sink that
  // throws must not be able to unwind a write that already happened.
  const state = cleanRun();
  const realLog = console.log;
  console.log = () => undefined;
  log.setSink(() => {
    throw new Error('the host is on fire');
  });
  try {
    recordAndSay(state, 'warn', 'report_unusable', 'unreadable', { name: 'x.json' });
  } finally {
    log.setSink(null);
    console.log = realLog;
  }

  assert.equal(
    state.events.filter((e) => e.type === 'report_unusable').length,
    1,
  );
});
