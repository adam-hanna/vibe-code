import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchestrate, runTurn } from '@src/orchestrator.js';
import {
  critiquePrompt,
  implementPrompt,
  renderPlanDoc,
  reviewPrompt,
  revisePlanPrompt,
} from '@src/prompts.js';
import { loadRun, saveState } from '@src/run.js';
import { PLAN_SCHEMA } from '@src/schemas.js';
import { parsePlan, ShapeError } from '@src/validate.js';
import {
  agents,
  committing,
  config,
  freshRun,
  p1,
  planFixture,
  report,
  reviewingRun,
  work,
} from './helpers/loop-harness.js';
import type { AcceptanceCriterion, Finding, Plan, RunState } from '@src/types.js';

/**
 * The acceptance axis: a plan states how anyone can tell it worked, that bar is
 * argued over by the critic, frozen when the gate passes, and read from the
 * freeze by everyone downstream.
 *
 * Two properties are worth more than the rest here. The **freeze**: the
 * implementer and the reviewer are told the bar the critic approved, and no
 * later edit of `state.plan` - by replacement or in place - can move it. And
 * the **silence**: a criterion changes what someone is told and what a finding
 * may cite, never whether a turn happens, so a run carrying no criteria must
 * produce the implementation prompt it always did, and the same turns in the
 * same order.
 */

const CRITERION: AcceptanceCriterion = {
  id: 'resumes-without-repair',
  criterion: 'A run stored before this field resumes with no repair recorded',
  check: 'command',
  how: 'npm test',
};

const OTHER: AcceptanceCriterion = {
  id: 'unapproved-bar',
  criterion: 'Something the critic never saw',
  check: 'inspection',
  how: 'read the diff',
};

const LEGACY = 'predates the acceptance-criteria field';
const CONSIDERED = 'a claim that done-ness here is unobservable';
const IMPL_HEADING = '## Acceptance criteria';

/** A plan from before the field existed: absent, not empty. */
function planWithout(over: Partial<Plan> = {}): Plan {
  const plan = planFixture(over);
  delete plan.acceptance_criteria;
  return plan;
}

function repairsOf(state: RunState): string[] {
  return state.events.filter((e) => e.type === 'state_repaired').map((e) => String(e['field']));
}

// ---- the schema, and the strict parser it governs ---------------------------

test('PLAN_SCHEMA requires acceptance_criteria, with a typed and enumerated item', () => {
  assert.ok(
    (PLAN_SCHEMA.required as readonly string[]).includes('acceptance_criteria'),
    'a plan with no definition of done is not a plan the schema accepts',
  );

  const items = PLAN_SCHEMA.properties.acceptance_criteria.items;
  assert.deepEqual([...items.required], ['id', 'criterion', 'check', 'how']);
  assert.equal(items.additionalProperties, false);
  // Typed as well as required, for the reason `defer` is: under
  // additionalProperties:false a required property with no `type` still accepts
  // a number, and nothing downstream would say so.
  assert.equal(items.properties.check.type, 'string');
  assert.deepEqual([...items.properties.check.enum], ['command', 'inspection', 'qa']);
});

const FRESH = { plan_md: 'x', assumptions: [], open_questions: [], out_of_scope: [] };

test('a plan with no acceptance_criteria is rejected', () => {
  assert.throws(() => parsePlan({ ...FRESH }), ShapeError);
});

test('a non-array acceptance_criteria is rejected', () => {
  assert.throws(() => parsePlan({ ...FRESH, acceptance_criteria: 'later' }), ShapeError);
});

test('a criterion missing its id is rejected', () => {
  const withoutId = { criterion: CRITERION.criterion, check: CRITERION.check, how: CRITERION.how };
  assert.throws(() => parsePlan({ ...FRESH, acceptance_criteria: [withoutId] }), ShapeError);
});

test('a criterion whose check is not one of the three is rejected', () => {
  assert.throws(
    () => parsePlan({ ...FRESH, acceptance_criteria: [{ ...CRITERION, check: 'smoke' }] }),
    ShapeError,
  );
});

test('a valid bar round-trips, and an empty one is legal', () => {
  assert.deepEqual(parsePlan({ ...FRESH, acceptance_criteria: [CRITERION] }).acceptance_criteria, [
    CRITERION,
  ]);
  // No minItems: a parse failure strands the run, while an empty list reaches
  // the critic, whose whole job is to attack a claim like this one.
  assert.deepEqual(parsePlan({ ...FRESH, acceptance_criteria: [] }).acceptance_criteria, []);
});

// ---- the tolerant reader that meets older state -----------------------------

/** Rewrite a fresh run's stored plan, then load it through the real loader. */
function storedPlan(plan: unknown): RunState {
  const state = freshRun({ prefix: 'vibe-criteria-stored-' });
  const file = path.join(state.dir, 'state.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  raw['plan'] = plan;
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
  return loadRun(state.targetDir, state.id);
}

test('a stored plan with no bar keeps the absence, and needs no repair', () => {
  const loaded = storedPlan({ plan_md: '# p', assumptions: [], open_questions: [] });

  assert.ok(loaded.plan !== null);
  assert.equal('acceptance_criteria' in loaded.plan, false, 'absence is preserved, not filled in');
  assert.deepEqual(repairsOf(loaded), [], 'a plan older than the field is not damage');
});

test('a stored bar with one malformed criterion drops the entry, not the state', () => {
  const loaded = storedPlan({
    plan_md: '# p',
    assumptions: [],
    open_questions: [],
    acceptance_criteria: [CRITERION, { ...CRITERION, check: 'smoke' }, 'nonsense'],
  });

  assert.deepEqual(loaded.plan?.acceptance_criteria, [CRITERION]);
  assert.ok(
    repairsOf(loaded).some((f) => f.startsWith('plan.acceptance_criteria')),
    'the repair is recorded rather than silently applied',
  );
});

// ---- rendering: three states, and the one consumer with two -----------------

/** Everything that renders the plan's own bar, in its three-state form. */
function renderings(criteria: readonly AcceptanceCriterion[] | undefined): string[] {
  const p =
    criteria === undefined ? planWithout() : planFixture({ acceptance_criteria: [...criteria] });
  return [
    renderPlanDoc(p),
    critiquePrompt(
      p.plan_md,
      p.assumptions,
      p.out_of_scope,
      1,
      false,
      null,
      undefined,
      p.acceptance_criteria,
    ),
    reviewPrompt(
      'diff',
      ['a.ts'],
      p.plan_md,
      p.out_of_scope,
      1,
      false,
      null,
      undefined,
      p.acceptance_criteria,
    ),
    revisePlanPrompt({ findings: [], acceptanceCriteria: p.acceptance_criteria, round: 2 }),
  ];
}

test('a stated bar reaches the plan document and every model-facing prompt', () => {
  for (const text of renderings([CRITERION])) {
    assert.ok(text.includes(CRITERION.id), 'a finding has to be able to cite it');
    assert.ok(text.includes(CRITERION.criterion));
    assert.ok(text.includes(CRITERION.how));
  }
  // The implementer is told too - it is the one being held to the bar.
  const implemented = implementPrompt('BODY', [], [], [CRITERION]);
  assert.ok(implemented.includes(CRITERION.criterion));
  assert.ok(implemented.includes(CRITERION.how));
});

test('an explicitly empty bar reads as a considered claim', () => {
  for (const text of renderings([])) {
    assert.ok(text.includes(CONSIDERED));
    assert.ok(!text.includes(LEGACY));
  }
});

test('an absent bar is never rendered as an explicit empty one', () => {
  for (const text of renderings(undefined)) {
    assert.ok(text.includes(LEGACY));
    assert.ok(!text.includes(CONSIDERED), 'a legacy plan never claimed done-ness was unobservable');
  }
});

test('the implementer is shown a bar or nothing - never a claim about not having one', () => {
  // The one two-state consumer, and only because a run with no criteria must
  // produce the prompt it produced before the field existed.
  for (const empty of [[], undefined] as const) {
    const prompt = implementPrompt('BODY', [], [], empty);
    assert.ok(!prompt.includes(IMPL_HEADING));
    assert.ok(!prompt.includes(CONSIDERED));
    assert.ok(!prompt.includes(LEGACY));
  }
});

// ---- through the loop -------------------------------------------------------

interface Driven {
  state: RunState;
  calls: string[];
  prompts: Map<string, string>;
}

interface DriveOptions {
  plan?: Plan;
  /** Critique findings, round by round. The last entry repeats. */
  rounds?: readonly (readonly Finding[])[];
  seed?: (state: RunState) => void;
  /** Fires as a Claude turn is dispatched - after its prompt was built. */
  during?: (label: string, state: RunState) => void;
  state?: RunState;
  resume?: boolean;
}

function fullRun(prefix = 'vibe-criteria-'): RunState {
  return freshRun({ prefix, task: 'acceptance criteria', planOnly: false, git: true, commit: true });
}

/** One pass of the whole loop, keeping every prompt both agents were given. */
async function drive(options: DriveOptions = {}): Promise<Driven> {
  const state = options.state ?? fullRun();
  options.seed?.(state);
  const calls: string[] = [];
  const prompts = new Map<string, string>();
  const rounds = options.rounds ?? [[]];
  const planned = options.plan ?? planFixture();
  let critiques = 0;

  await orchestrate(
    state,
    config({}, committing()),
    options.resume ?? false,
    agents(
      {
        claude: (label, turn) => {
          prompts.set(label, turn.prompt);
          options.during?.(label, state);
          return label === 'plan' || label.startsWith('revise-')
            ? planned
            : work(state, `${label}.txt`);
        },
        codex: (label, turn) => {
          prompts.set(label, turn.prompt);
          if (!label.startsWith('critique')) return report([]);
          const found = rounds[Math.min(critiques, rounds.length - 1)] ?? [];
          critiques += 1;
          return report([...found]);
        },
      },
      calls,
    ),
  );

  return { state, calls, prompts };
}

function promptOf(driven: Driven, label: string): string {
  const prompt = driven.prompts.get(label);
  assert.ok(prompt !== undefined, `the ${label} turn must have run`);
  return prompt;
}

test('a criterion reaches the critique, revision, implementation, review and PLAN.md', async () => {
  const driven = await drive({
    plan: planFixture({ acceptance_criteria: [CRITERION] }),
    rounds: [[p1('finding-one'), p1('finding-two')], []],
  });

  assert.deepEqual(driven.calls, [
    'plan',
    'critique-0',
    'revise-1',
    'critique-1',
    'implement',
    'review-0',
  ]);
  for (const label of ['critique-0', 'revise-1', 'implement', 'review-0']) {
    assert.ok(promptOf(driven, label).includes(CRITERION.id), `${label} was told the bar`);
  }
  const planDoc = readFileSync(path.join(driven.state.dir, 'PLAN.md'), 'utf8');
  assert.ok(planDoc.includes(CRITERION.criterion));
  assert.ok(planDoc.includes('## Acceptance criteria'));
});

// ---- the freeze: the assertion the whole design turns on --------------------

test('replacing the plan bar after the gate does not change what the reviewer is told', async () => {
  const driven = await drive({
    plan: planFixture({ acceptance_criteria: [CRITERION] }),
    during: (label, state) => {
      if (label !== 'implement' || state.plan === null) return;
      state.plan.acceptance_criteria = [OTHER];
    },
  });

  const review = promptOf(driven, 'review-0');
  assert.ok(review.includes(CRITERION.id), 'the approved bar is the one that stands');
  assert.ok(!review.includes(OTHER.id), 'a criterion the critic never saw is not an approved one');
});

test('mutating the plan bar in place after the gate does not change it either', async () => {
  const driven = await drive({
    plan: planFixture({ acceptance_criteria: [CRITERION] }),
    during: (label, state) => {
      if (label !== 'implement') return;
      const bar = state.plan?.acceptance_criteria;
      assert.ok(bar !== undefined);
      // The half a replacement-only snapshot would miss: same array, same
      // objects, edited underneath the run.
      const first = bar[0];
      assert.ok(first !== undefined);
      first.criterion = 'MUTATED';
      bar.push(OTHER);
    },
  });

  const review = promptOf(driven, 'review-0');
  assert.ok(review.includes(CRITERION.criterion));
  assert.ok(!review.includes('MUTATED'), 'the snapshot is a copy, not a view');
  assert.ok(!review.includes(OTHER.id));
});

/** A run parked at implementation with its plan approved, by killing the turn. */
async function parkedBeforeImplementation(plan: Plan): Promise<RunState> {
  const state = fullRun('vibe-criteria-parked-');
  const calls: string[] = [];

  await assert.rejects(() =>
    orchestrate(
      state,
      config({}, committing()),
      false,
      agents(
        {
          claude: (label) => {
            if (label === 'plan') return plan;
            throw new Error('the implementation turn died');
          },
          codex: () => report([]),
        },
        calls,
      ),
    ),
  );

  assert.deepEqual(calls, ['plan', 'critique-0', 'implement']);
  return state;
}

/** Rewrite the stored plan of a parked run, then load it through the loader. */
function reloadWithStoredPlan(
  state: RunState,
  mutate: (plan: Record<string, unknown>) => void,
): RunState {
  const file = path.join(state.dir, 'state.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const plan = raw['plan'];
  assert.ok(plan !== null && typeof plan === 'object');
  mutate(plan as Record<string, unknown>);
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
  return loadRun(state.targetDir, state.id);
}

test('the approved bar survives a stop between approval and implementation', async () => {
  const parked = await parkedBeforeImplementation(
    planFixture({ acceptance_criteria: [CRITERION] }),
  );
  const loaded = reloadWithStoredPlan(parked, (plan) => {
    plan['acceptance_criteria'] = [OTHER];
  });

  assert.deepEqual(loaded.acceptanceCriteria, [CRITERION], 'the snapshot is what was stored');

  const resumed = await drive({ state: loaded, resume: true });
  assert.ok(!resumed.calls.some((c) => c.startsWith('critique')), 'nothing is re-bought');
  for (const label of ['implement', 'review-0']) {
    const prompt = promptOf(resumed, label);
    assert.ok(prompt.includes(CRITERION.id), `${label} reads the snapshot`);
    assert.ok(!prompt.includes(OTHER.id), `${label} does not read the stored plan's bar`);
  }
});

test('the approved bar outlives a stored plan that had to be repaired away', async () => {
  const parked = await parkedBeforeImplementation(
    planFixture({ acceptance_criteria: [CRITERION] }),
  );
  const file = path.join(parked.dir, 'state.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  raw['plan'] = { plan_md: 3 };
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');

  const loaded = loadRun(parked.targetDir, parked.id);
  assert.equal(loaded.plan, null, 'an unusable plan is replaced with null');
  // The live way a bar could vanish with no bad actor at all - which is why the
  // snapshot does not live inside the plan.
  assert.deepEqual(loaded.acceptanceCriteria, [CRITERION]);
});

// ---- the record: unconditional, and honest about absence --------------------

function approvalEvent(state: RunState): Record<string, unknown> {
  const event = state.events.find((e) => e.type === 'plan_approved');
  assert.ok(event !== undefined, 'the plan must have been approved');
  return event as unknown as Record<string, unknown>;
}

test('an approving round owns the snapshot outright', async () => {
  const stale: AcceptanceCriterion = { ...OTHER, id: 'stale-from-before' };
  const driven = await drive({
    plan: planFixture({ acceptance_criteria: [] }),
    seed: (state) => {
      state.acceptanceCriteria = [stale];
    },
  });

  assert.deepEqual(
    driven.state.acceptanceCriteria,
    [],
    'this round states the bar, not an earlier one',
  );
  assert.deepEqual(approvalEvent(driven.state)['criteria'], []);
  const implement = promptOf(driven, 'implement');
  assert.ok(!implement.includes('stale-from-before'));
  assert.ok(!implement.includes(IMPL_HEADING));
});

test('a legacy plan approved as it stands records no bar at all', async () => {
  const state = fullRun('vibe-criteria-legacy-');
  state.plan = planWithout();
  saveState(state);

  const driven = await drive({ state, resume: true });

  assert.deepEqual(
    driven.calls,
    ['critique-0', 'implement', 'review-0'],
    'the stored plan is not redrafted',
  );
  assert.equal(driven.state.acceptanceCriteria, undefined);
  // `?? []` here would have the event claim an empty bar the plan never stated.
  assert.ok(!('criteria' in approvalEvent(driven.state)), 'absence is not recorded as emptiness');
  assert.ok(promptOf(driven, 'review-0').includes(LEGACY));
  assert.ok(!promptOf(driven, 'implement').includes(IMPL_HEADING));
});

// ---- older state, unchanged -------------------------------------------------

test('a real state.json from before this field loads with the bar absent and no repair', () => {
  const file = fileURLToPath(
    new URL('../../tests/fixtures/state/done-widest.json', import.meta.url),
  );
  const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const id = String(stored['id']);

  const targetDir = mkdtempSync(path.join(tmpdir(), 'vibe-criteria-fixture-'));
  const dir = path.join(targetDir, '.vibe', 'runs', id);
  mkdirSync(dir, { recursive: true });
  copyFileSync(file, path.join(dir, 'state.json'));

  const loaded = loadRun(targetDir, id);
  assert.deepEqual(repairsOf(loaded), [], 'a real state file needs no repair');
  assert.equal(loaded.acceptanceCriteria, undefined);
  assert.ok(loaded.plan !== null);
  assert.equal('acceptance_criteria' in loaded.plan, false);
});

test('a run with no bar anywhere still completes, and the reviewer is told why', async () => {
  const state = reviewingRun({ prefix: 'vibe-criteria-none-' });
  state.plan = planWithout();
  const calls: string[] = [];
  const prompts = new Map<string, string>();

  await orchestrate(
    state,
    config(),
    true,
    agents(
      {
        claude: (label) => work(state, `${label}.txt`),
        codex: (label, turn) => {
          prompts.set(label, turn.prompt);
          return report([]);
        },
      },
      calls,
    ),
  );

  assert.equal(state.phase, 'complete');
  assert.equal(state.status, 'done');
  const review = prompts.get('review-0');
  assert.ok(review !== undefined);
  assert.ok(review.includes(LEGACY));
});

// ---- the silence: nothing about the loop moves ------------------------------

test('an empty or absent bar changes not one byte of the implementation prompt', () => {
  const md = planFixture().plan_md;
  assert.equal(implementPrompt(md, [], [], []), implementPrompt(md));
  assert.equal(implementPrompt(md, [], [], undefined), implementPrompt(md));
  assert.equal(
    implementPrompt(md, [p1('carried-one')], [], []),
    implementPrompt(md, [p1('carried-one')]),
  );
});

test('a run whose plan states no criteria produces the implementation prompt it always did', async () => {
  const driven = await drive();

  assert.equal(promptOf(driven, 'implement'), implementPrompt(planFixture().plan_md, []));
});

test('a bar adds no round, and stops nothing', async () => {
  const withBar = await drive({ plan: planFixture({ acceptance_criteria: [CRITERION] }) });
  const without = await drive();

  assert.deepEqual(withBar.calls, ['plan', 'critique-0', 'implement', 'review-0']);
  assert.deepEqual(withBar.calls, without.calls);
  assert.equal(withBar.state.planRound, without.state.planRound);
  assert.equal(withBar.state.reviewRound, without.state.reviewRound);
  assert.equal(withBar.state.status, without.state.status);
  assert.equal(withBar.state.phase, without.state.phase);
});

// ---- the rehydration prefix reads the freeze too ----------------------------

/** One turn for a role whose conversation carries nothing, keeping its prompt. */
async function memorylessTurn(state: RunState, role: 'implementer' | 'planner'): Promise<string> {
  const calls: string[] = [];
  const prompts = new Map<string, string>();

  await runTurn(
    state,
    config(),
    { role, prompt: 'TURN BODY', cwd: state.targetDir, label: role },
    agents(
      {
        claude: (label, turn) => {
          prompts.set(label, turn.prompt);
          return 'done';
        },
      },
      calls,
    ),
  );

  const prompt = prompts.get(role);
  assert.ok(prompt !== undefined, 'the turn must have run');
  return prompt;
}

function driftedRun(prefix: string): RunState {
  const state = freshRun({ prefix, task: 'rehydration', planOnly: false });
  // The plan of record has moved since the gate; the snapshot has not.
  state.plan = planFixture({ acceptance_criteria: [OTHER] });
  state.acceptanceCriteria = [CRITERION];
  state.handoff = 'what the previous session knew';
  return state;
}

test('a rehydrated implementer is given the frozen bar, not the one its plan drifted to', async () => {
  const prompt = await memorylessTurn(driftedRun('vibe-criteria-rehydrate-'), 'implementer');

  // Without this the direct prompt and the prefix would state two different
  // definitions of done inside the same turn.
  assert.ok(prompt.includes(CRITERION.criterion), 'the approved bar travels with the plan');
  assert.ok(!prompt.includes(OTHER.criterion), 'an unapproved bar never reaches the implementer');
});

test('a rehydrated planner is still shown the plan it is revising', async () => {
  const prompt = await memorylessTurn(driftedRun('vibe-criteria-rehydrate-planner-'), 'planner');

  // The planner is not bound by the freeze: it is the role that writes the bar,
  // and hiding its own current text would have it re-derive one from nothing.
  assert.ok(prompt.includes(OTHER.criterion));
});

test('a rehydrated implementer with no frozen bar is told nothing about one', async () => {
  const state = freshRun({ prefix: 'vibe-criteria-rehydrate-none-', planOnly: false });
  state.plan = planFixture({ acceptance_criteria: [OTHER] });
  state.handoff = 'what the previous session knew';

  const prompt = await memorylessTurn(state, 'implementer');
  assert.ok(!prompt.includes(IMPL_HEADING), 'the same two-state rule the direct prompt follows');
  assert.ok(!prompt.includes(OTHER.criterion));
  assert.ok(!prompt.includes(LEGACY));
});
