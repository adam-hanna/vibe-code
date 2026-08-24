import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { orchestrate } from '@src/orchestrator.js';
import { fixPrompt, implementPrompt } from '@src/prompts.js';
import { loadRun } from '@src/run.js';
import {
  agents,
  committing,
  config,
  findingFixture,
  freshRun,
  p1,
  planFixture,
  report,
  verifying,
  work,
} from './helpers/loop-harness.js';
import type { Finding, RunState } from '@src/types.js';

/**
 * The one round whose findings reach nobody: the plan critique that *passes*
 * the gate.
 *
 * A revising round already hands its deferrals to the planner through
 * `pendingFindings`, and `FOLLOW-UPS.md` records every one regardless of the
 * gate - but the implementer reads the plan, not the artifact, so before this
 * it could implement work the critic had explicitly declined.
 *
 * What these cases pin is that the fix *records* rather than *revises*: the
 * turn order is the assertion, because the whole design turns on a deferral
 * changing what someone is told and never whether a turn happens. The gate,
 * the verdict rule and every guard are untouched, which is why nothing here
 * asserts on them.
 */

const RUN = { prefix: 'vibe-declined-', task: 'declined findings' } as const;

const DECLINED = findingFixture({ id: 'declined-one', severity: 'P2', defer: true });

const CARRIED_HEADING = '## Known open issues with this plan';
const DECLINED_HEADING = '## Declined by the reviewer';

/** A run that will not stop after planning, in a repo it can commit to. */
function fullRun(): RunState {
  return freshRun({ ...RUN, planOnly: false, git: true, commit: true });
}

interface Driven {
  state: RunState;
  calls: string[];
  prompts: Map<string, string>;
}

/**
 * One clean pass, with the critique returning whatever the case names.
 *
 * Every Claude prompt is kept, since the implementation prompt is what this
 * file is about; the writing turns still touch the tree so the per-round
 * commits are not vacuous.
 */
async function drive(findings: readonly Finding[], loop = {}): Promise<Driven> {
  const state = fullRun();
  const calls: string[] = [];
  const prompts = new Map<string, string>();

  await orchestrate(
    state,
    config(loop, { ...committing(), ...verifying(state) }),
    false,
    agents(
      {
        claude: (label, options) => {
          prompts.set(label, options.prompt);
          return label === 'plan' || label.startsWith('revise-')
            ? planFixture()
            : work(state, `${label}.txt`);
        },
        codex: (label) => (label.startsWith('critique') ? report([...findings]) : report([])),
      },
      calls,
    ),
  );

  return { state, calls, prompts };
}

/** The implementation prompt a case is asserting on. */
function implementPromptOf(driven: Driven): string {
  const prompt = driven.prompts.get('implement');
  assert.ok(prompt !== undefined, 'the implementation turn must have run');
  return prompt;
}

// ---- the central case: no round is added -----------------------------------

test('a critique that defers and blocks nothing adds no planner turn', async () => {
  const declined = await drive([DECLINED]);
  const clean = await drive([]);

  // The property the whole design turns on: identical to the turn order of a
  // run whose critique found nothing at all.
  assert.deepEqual(declined.calls, ['plan', 'critique-0', 'implement', 'review-0']);
  assert.deepEqual(declined.calls, clean.calls);
  assert.equal(declined.state.planRound, clean.state.planRound);
  assert.equal(declined.state.phase, 'complete');
  assert.equal(declined.state.status, 'done');
  // The approving round consumed them, so a resume has nothing to revise for.
  assert.equal(declined.state.pendingFindings, null);
});

test('the approving round records its deferrals on the run state and in the event', async () => {
  const { state } = await drive([DECLINED]);

  assert.deepEqual(state.declined?.map((f) => f.id), ['declined-one']);
  const approved = state.events.filter((e) => e.type === 'plan_approved');
  assert.equal(approved.length, 1);
  assert.deepEqual(approved[0]?.['declined'], ['declined-one']);
});

// ---- what the implementer is told ------------------------------------------

test('the declined finding reaches the implementation prompt in its own section', async () => {
  const prompt = implementPromptOf(await drive([DECLINED]));

  assert.ok(prompt.includes(DECLINED_HEADING), 'the declined section must be rendered');
  assert.ok(prompt.includes('declined-one'));
  assert.ok(prompt.includes(DECLINED.detail));
  // The instruction is the opposite of the carried one, and nothing was carried.
  assert.ok(prompt.includes('work to **not** do'));
  assert.ok(!prompt.includes(CARRIED_HEADING), 'no P1 was tolerated, so nothing is carried');
});

test('carried P1s and declined findings are two sections, not one list', async () => {
  const prompt = implementPromptOf(
    await drive([p1('tolerated-one'), DECLINED], { p1Tolerance: 1 }),
  );

  const carriedAt = prompt.indexOf(CARRIED_HEADING);
  const declinedAt = prompt.indexOf(DECLINED_HEADING);
  assert.ok(carriedAt >= 0 && declinedAt > carriedAt, 'both sections, in that order');
  // Work to do sits under the first heading; work to leave alone under the
  // second. A single merged list would put them on the same side of the line.
  const toleratedAt = prompt.indexOf('tolerated-one');
  const declinedIdAt = prompt.indexOf('declined-one');
  assert.ok(toleratedAt > carriedAt && toleratedAt < declinedAt);
  assert.ok(declinedIdAt > declinedAt);
});

test('a run that defers nothing produces the implementation prompt it always did', async () => {
  const prompt = implementPromptOf(await drive([]));

  assert.equal(prompt, implementPrompt(planFixture().plan_md, []));
  assert.ok(!prompt.includes(DECLINED_HEADING));
});

test('an empty declined list changes not one byte of the prompt', () => {
  const md = planFixture().plan_md;
  assert.equal(implementPrompt(md, [], []), implementPrompt(md));
  assert.equal(implementPrompt(md, [p1('carried-one')], []), implementPrompt(md, [p1('carried-one')]));
});

// ---- across a stop ----------------------------------------------------------

/**
 * A run parked at the implementation phase with its plan approved, by killing
 * the implementation turn.
 *
 * That is the window the field has to survive: `state.declined` is written on
 * the same state save that clears the pending findings, before the phase
 * advances, so a process that dies here must still know what was declined.
 */
async function parkedBeforeImplementation(): Promise<RunState> {
  const state = fullRun();
  const calls: string[] = [];

  await assert.rejects(() =>
    orchestrate(
      state,
      config({}, committing()),
      false,
      agents(
        {
          claude: (label) => {
            if (label === 'plan') return planFixture();
            throw new Error('the implementation turn died');
          },
          codex: () => report([DECLINED]),
        },
        calls,
      ),
    ),
  );

  assert.deepEqual(calls, ['plan', 'critique-0', 'implement']);
  return state;
}

/** Rewrite a parked run's stored state, then load it through the real loader. */
function reloadWith(state: RunState, value: unknown): RunState {
  const file = path.join(state.dir, 'state.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  raw['declined'] = value;
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
  return loadRun(state.targetDir, state.id);
}

/** Resume a loaded run to completion, keeping its prompts and turn labels. */
async function resume(loaded: RunState): Promise<Driven> {
  const calls: string[] = [];
  const prompts = new Map<string, string>();

  await orchestrate(
    loaded,
    config({}, committing()),
    true,
    agents(
      {
        claude: (label, options) => {
          prompts.set(label, options.prompt);
          return work(loaded, `${label}.txt`);
        },
        codex: () => report([]),
      },
      calls,
    ),
  );

  return { state: loaded, calls, prompts };
}

test('the declined findings survive a stop between plan approval and implementation', async () => {
  const parked = await parkedBeforeImplementation();
  const loaded = loadRun(parked.targetDir, parked.id);

  assert.deepEqual(loaded.declined?.map((f) => f.id), ['declined-one']);

  const resumed = await resume(loaded);
  // Resumed at the implementation, not re-critiqued: the record is carried, not
  // re-bought.
  assert.ok(!resumed.calls.some((c) => c.startsWith('critique')));
  assert.ok(implementPromptOf(resumed).includes('declined-one'));
});

test('a corrupt declined list never reaches the implementation prompt', async () => {
  const parked = await parkedBeforeImplementation();

  const wrecked = reloadWith(parked, 'not a list');
  assert.deepEqual(wrecked.declined, []);
  assert.ok(
    wrecked.events.some((e) => e.type === 'state_repaired' && e['field'] === 'declined'),
    'the repair is recorded rather than silently applied',
  );
  const afterWreck = implementPromptOf(await resume(wrecked));
  assert.ok(!afterWreck.includes(DECLINED_HEADING));
  assert.ok(!afterWreck.includes('undefined'));
});

test('a stored entry that is not a deferred non-blocking finding is dropped', async () => {
  const parked = await parkedBeforeImplementation();

  // Three kinds of junk in one list: a shapeless entry the validator drops, a
  // blocking finding `parseFindings` could never have produced, and a
  // non-deferred one. Only the real deferral may be shown, because the section
  // claims in prose that everything in it was agreed to belong elsewhere.
  const loaded = reloadWith(parked, [
    DECLINED,
    { id: 'junk' },
    { ...p1('smuggled-p1'), defer: true },
    findingFixture({ id: 'not-deferred' }),
  ]);
  assert.deepEqual(loaded.declined?.map((f) => f.id), [
    'declined-one',
    'smuggled-p1',
    'not-deferred',
  ]);

  const prompt = implementPromptOf(await resume(loaded));
  assert.ok(prompt.includes('declined-one'));
  assert.ok(!prompt.includes('smuggled-p1'));
  assert.ok(!prompt.includes('not-deferred'));
  assert.ok(!prompt.includes('undefined'));
});

// ---- the review side, which needed no change --------------------------------

test('the final fix round is already told what its own round deferred', () => {
  // `reviewPhase` hands the whole round to `fixPrompt` - deferrals included -
  // so the review half of this issue is already covered and nothing there was
  // changed. This pins it, so a future edit that filtered the findings would
  // fail here rather than quietly reintroducing the loss.
  const prompt = fixPrompt([p1('must-fix'), DECLINED], 1);

  assert.ok(prompt.includes('declined-one'));
  assert.ok(prompt.includes('**Deferred by the reviewer**'));
  assert.ok(prompt.includes('leave it alone'));
});
