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
      // Which branch the commits land on, before any phase (#223). `prepareGit`
      // has always known this and never said it, so the window could not put a
      // branch in hi-fi 1's identity header. `state.branch` is already durable,
      // so nothing new was recorded - this is narration with no event, on the
      // `findings_reported` precedent.
      'run_branch',
      'phase_started', // planning
      'turn_started', //  the planner
      'claude_turn', //   what that turn spent (#223)
      'phase_started', // critique
      'turn_started', //  the critic
      'codex_turn',
      'findings_reported', // the four counts against the tolerance
      'plan_approved', //    and what the gate made of them
      'phase_started', //  implementing
      'claude_turn',
      // What the implement turn left in the tree, once, as the turn ended
      // (#136). The sampler's own `work_progress` readings would appear here
      // too, and none do: they fire on a sixty-second timer and these turns are
      // injected functions that return immediately. That is the sampler's
      // cadence being real rather than the case being lucky - a write turn short
      // enough to have no readings is one there was nothing to report about.
      'work_measured',
      // What the round put in the history, and the range it spans (#223). The
      // commit has always happened here and `maybeCommit` has always printed
      // `Committed abc1234`; what it had no id for was the pair of shas, so
      // nothing watching a run could show one round's diff while the run was
      // going. Narration with no event, on the same precedent as `run_branch`
      // above: the sha is durable twice already, in git and in the checkpoint
      // meta this line is immediately followed by.
      'round_committed',
      'verify_started',
      'verify_passed', // the verdict, which the run has always recorded (#223)
      'phase_started', // review
      'turn_started', //  the reviewer
      'codex_turn',
      'findings_reported',
      'review_approved',
    ],
  );
});

test('the sequence grew by facts the run already recorded, and by nothing else', async () => {
  // The other half of #223's claim, and the reason the case above could be
  // re-pinned rather than argued about. Everything added to that sequence is
  // either a fact `state.events` already held - so `recordAndSay` collapsed two
  // calls into one - or narration with no event at all. **Nothing new became
  // durable**, which is the rule `durable-narration.test.ts` guards from the
  // other side by pinning the event set itself.
  const state = cleanRun('vibe-ident-added-');
  const seen = await pass(state);
  const said = new Set(seen.filter((n) => n.id !== null).map((n) => n.id));
  const recorded = new Set(state.events.map((e) => e.type));

  // Said and recorded: one call, one fact, one spelling.
  for (const id of ['claude_turn', 'codex_turn', 'verify_passed', 'plan_approved']) {
    assert.ok(said.has(id), `${id} was not said`);
    assert.ok(recorded.has(id), `${id} was not recorded`);
  }

  // Said and deliberately NOT recorded. A census of a round is derivable from
  // the round's own artifact and adds nothing a resume needs, so it stays out of
  // the run's memory - which #133 says in as many words must not become a
  // transcript.
  assert.ok(said.has('findings_reported'));
  assert.equal(recorded.has('findings_reported'), false);
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
