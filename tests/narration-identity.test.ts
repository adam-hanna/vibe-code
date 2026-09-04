import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { orchestrate } from '@src/orchestrator.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
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
 * The last part of #133: a host can follow the loop without reading English.
 *
 * The issue's own bar - *"assert on the sequence of narration events by type
 * rather than by matching English"* - is what this file does, and it is the
 * point of the whole seam. A cockpit that branched on `Codex is critiquing the
 * plan` would break the next time somebody improved that sentence; one that
 * branches on `turn_started` with `{role: 'critic'}` would not.
 *
 * Two ids carry the structure, and they nest the way the design's loop column
 * does: `phase_started` opens a cycle, `turn_started` names who is working
 * inside it.
 */

function cleanRun(prefix: string): RunState {
  return freshRun({ prefix, task: 'identity', planOnly: false, git: true, commit: true });
}

function passing(state: RunState): Handlers {
  return {
    claude: (label) =>
      label === 'plan' || label.startsWith('revise-') ? planFixture() : work(state, `${label}.txt`),
    codex: () => report([]),
  };
}

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

test('a clean pass is legible as a sequence of ids, with no sentence read', async () => {
  const state = cleanRun('vibe-ident-seq-');
  const seen = await pass(state);

  assert.deepEqual(
    seen.filter((n) => n.id !== null).map((n) => n.id),
    [
      'phase_started', // planning
      'turn_started', //  the planner
      'phase_started', // critique
      'turn_started', //  the critic
      'phase_started', // implementing
      'verify_started',
      'phase_started', // review
      'turn_started', //  the reviewer
      'review_approved',
    ],
  );
});

test('turn_started names the role, so a host need not infer it from the label', async () => {
  // `holderLabel` renders the PROVIDER - "Claude", "Codex" - because that is
  // what a human wants to read. A host wants the role, because that is what the
  // role table, the toolset and the warnings are all keyed by.
  const state = cleanRun('vibe-ident-role-');
  const seen = await pass(state);

  assert.deepEqual(
    seen.filter((n) => n.id === 'turn_started').map((n) => n.data?.['role']),
    ['planner', 'critic', 'reviewer'],
  );
  assert.deepEqual(
    seen.filter((n) => n.id === 'turn_started').map((n) => n.data?.['kind']),
    ['plan', 'critique', 'review'],
  );
});

test('the round a card carries is the one that names the artifact behind it', async () => {
  // The display adds one because humans count from one; the archive does not.
  // A host correlating a review card with its findings needs the archive's
  // number, so that is what travels in the data even though the sentence beside
  // it says "round 1".
  const state = cleanRun('vibe-ident-round-');
  const seen = await pass(state);

  const critique = seen.find(
    (n) => n.id === 'phase_started' && n.data?.['phase'] === 'critique',
  );
  assert.equal(critique?.data?.['round'], 0);
  assert.match(critique?.message ?? '', /round 1/);
  assert.equal(
    existsSync(path.join(state.dir, 'plan-critique-0.json')),
    true,
    'the round the card names should be the artifact that exists',
  );
});

test('the implementing phase is announced, and its turn is the phase', async () => {
  // Worth pinning rather than leaving as a surprise. Every other phase contains
  // one or more turns that announce themselves; the implementing phase contains
  // exactly one implementer turn and has never had a `log.step` of its own.
  //
  // So `phase_started` IS the implement turn's announcement. Adding a step line
  // purely to make the vocabulary symmetrical would change what the terminal
  // prints, and the CLI's output is a contract - symmetry is not worth that.
  const state = cleanRun('vibe-ident-impl-');
  const seen = await pass(state);

  const implementing = seen.filter(
    (n) => n.id === 'phase_started' && n.data?.['phase'] === 'implementing',
  );
  assert.equal(implementing.length, 1);
  assert.equal(
    seen.some((n) => n.id === 'turn_started' && n.data?.['role'] === 'implementer'),
    false,
  );
});

test('an id never replaces the sentence beside it', async () => {
  // The whole seam is additive. Every line still carries the message the
  // terminal prints, so a host that wants to show the prose can, and the CLI is
  // unaffected either way.
  const state = cleanRun('vibe-ident-msg-');
  const seen = await pass(state);

  for (const n of seen.filter((x) => x.id !== null)) {
    assert.ok(n.message.length > 0, `${n.id} carried no message`);
  }
});
