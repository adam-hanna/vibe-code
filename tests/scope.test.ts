import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import {
  collectDeferred,
  orchestrate,
  reconcileFollowUps,
  runTurn,
  writeFollowUps,
} from '@src/orchestrator.js';
import type { AgentTurns } from '@src/orchestrator.js';
import {
  critiquePrompt,
  fixPrompt,
  renderPlanDoc,
  revisePlanPrompt,
  reviewPrompt,
} from '@src/prompts.js';
import { createRun } from '@src/run.js';
import { FINDINGS_SCHEMA, PLAN_SCHEMA } from '@src/schemas.js';
import { parseFindings, parsePlan, ShapeError } from '@src/validate.js';
import type {
  ClaudeTurnResult,
  Config,
  Finding,
  OutOfScopeItem,
  Plan,
  RunState,
} from '@src/types.js';

/**
 * The scope axis: a plan states what it is deliberately not doing, a reviewer
 * can call a finding real-but-elsewhere, and that work is written down.
 *
 * These cases pin the structure - schema shape, parse behaviour, what the
 * rendered plan and the prompts carry, and the artifact - because the prose
 * that actually persuades the models is not assertable. Nothing here touches
 * the loop: a deferred finding is P2/P3 and was already non-blocking.
 */

const ITEM: OutOfScopeItem = { item: 'token accounting', why: 'tracked in issue #16' };

function plan(over: Partial<Plan> = {}): Plan {
  return {
    plan_md: '# the plan\n\nDo the thing.',
    assumptions: [],
    open_questions: [],
    ...over,
  };
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'some-finding',
    severity: 'P2',
    title: 'Some finding',
    detail: 'Detail.',
    suggested_fix: 'Fix it.',
    ...over,
  };
}

/** The raw shape a model returns, before `parseFindings`. */
function rawFinding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'raw-finding',
    severity: 'P2',
    title: 'Raw finding',
    detail: 'Detail.',
    suggested_fix: 'Fix it.',
    ...over,
  };
}

function freshRun(): RunState {
  return createRun(mkdtempSync(path.join(tmpdir(), 'vibe-scope-')), 'scope fixture', true);
}

const followUpsPath = (state: RunState): string => path.join(state.dir, 'FOLLOW-UPS.md');

// ---- Schema shape ----------------------------------------------------------

test('PLAN_SCHEMA requires out_of_scope, with a typed item/why pair', () => {
  assert.ok(
    (PLAN_SCHEMA.required as readonly string[]).includes('out_of_scope'),
    'the planner must draw a boundary before the critic tests one',
  );
  const items = PLAN_SCHEMA.properties.out_of_scope.items;
  assert.deepEqual(items.required, ['item', 'why']);
  assert.equal(items.properties.item.type, 'string');
  assert.equal(items.properties.why.type, 'string');
});

test('FINDINGS_SCHEMA requires defer on every finding, as a boolean', () => {
  const item = FINDINGS_SCHEMA.properties.findings.items;
  assert.ok((item.required as readonly string[]).includes('defer'));
  // Required without a type is not enforcement: with additionalProperties
  // false, a string or a number would still satisfy the schema, and
  // `parseFindings` reads anything but literal `true` as false.
  assert.equal(item.properties.defer.type, 'boolean');
});

// ---- parsePlan: strict, because this only ever sees fresh model output ------

test('a plan with no out_of_scope is rejected', () => {
  assert.throws(
    () => parsePlan({ plan_md: 'x', assumptions: [], open_questions: [] }),
    ShapeError,
  );
});

test('a malformed out_of_scope entry is rejected', () => {
  assert.throws(
    () =>
      parsePlan({
        plan_md: 'x',
        assumptions: [],
        open_questions: [],
        out_of_scope: [{ item: 1, why: 'nope' }],
      }),
    ShapeError,
  );
});

test('a valid out_of_scope round-trips', () => {
  const parsed = parsePlan({
    plan_md: 'x',
    assumptions: [],
    open_questions: [],
    out_of_scope: [ITEM],
  });
  assert.deepEqual(parsed.out_of_scope, [ITEM]);
});

// ---- parseFindings: tolerant, because an old run must still be readable -----

test('a finding with no defer field - an old run - is read without throwing', () => {
  const report = parseFindings({ verdict: 'REVISE', summary: '', findings: [rawFinding()] });
  assert.equal(report.findings[0]?.defer, false);
});

test('defer survives on a non-blocking finding and is dropped on a blocking one', () => {
  const report = parseFindings({
    verdict: 'REVISE',
    summary: '',
    findings: [
      rawFinding({ id: 'nit', severity: 'P3', defer: true }),
      rawFinding({ id: 'real', severity: 'P1', defer: true }),
      rawFinding({ id: 'stopper', severity: 'P0', defer: true }),
    ],
  });
  assert.equal(report.findings[0]?.defer, true);
  // Deferring costs the same honesty as downgrading a severity does, so a
  // blocking finding can never buy its way out by claiming to be elsewhere.
  assert.equal(report.findings[1]?.defer, false);
  assert.equal(report.findings[2]?.defer, false);
});

test('a non-boolean defer is read as false rather than as truthy', () => {
  const report = parseFindings({
    verdict: 'REVISE',
    summary: '',
    findings: [rawFinding({ defer: 'yes' })],
  });
  assert.equal(report.findings[0]?.defer, false);
});

// ---- Rendering: three distinct states --------------------------------------

const PREDATES = 'predates the out-of-scope field';
const DECLARED_NONE = 'declared nothing out of scope';
const DEFECT_IN_FINDING = 'is a defect in your finding';

function renderings(outOfScope: readonly OutOfScopeItem[] | undefined): string[] {
  const p = outOfScope === undefined ? plan() : plan({ out_of_scope: [...outOfScope] });
  return [
    renderPlanDoc(p),
    critiquePrompt(p.plan_md, p.assumptions, p.out_of_scope, 1, false, null),
    reviewPrompt('diff', ['a.ts'], p.plan_md, p.out_of_scope, 1, false, null),
  ];
}

test('a stated boundary reaches the rendered plan and both reviewer prompts', () => {
  for (const text of renderings([ITEM])) {
    assert.ok(text.includes(ITEM.item), 'the item must survive rendering');
    assert.ok(text.includes(ITEM.why), 'so must the reason it is separable');
  }
});

test('an explicitly empty boundary reads as a considered claim', () => {
  for (const text of renderings([])) {
    assert.ok(text.includes(DECLARED_NONE));
    assert.ok(!text.includes(PREDATES));
  }
});

test('an absent boundary is never rendered as an explicit empty one', () => {
  for (const text of renderings(undefined)) {
    assert.ok(text.includes(PREDATES));
    assert.ok(
      !text.includes(DECLARED_NONE),
      'a legacy plan never claimed there was nothing to exclude',
    );
  }
});

// ---- The guidance is conditional on a boundary existing --------------------

test('the defer-for-out-of-scope instruction is given only where a boundary exists', () => {
  for (const boundary of [[ITEM], []] as const) {
    const [, critique, review] = renderings(boundary);
    assert.ok(critique?.includes(DEFECT_IN_FINDING));
    assert.ok(review?.includes(DEFECT_IN_FINDING));
  }

  const [, legacyCritique, legacyReview] = renderings(undefined);
  // Otherwise a reviewer could wave off a legitimate finding on the authority
  // of a boundary the plan never drew - and a legacy run is exactly the one
  // with nothing to check the finding against.
  assert.ok(!legacyCritique?.includes(DEFECT_IN_FINDING));
  assert.ok(!legacyReview?.includes(DEFECT_IN_FINDING));
  assert.ok(legacyCritique?.includes('no boundary was recorded'));
  assert.ok(legacyReview?.includes('no boundary was recorded'));
});

// ---- The boundary survives a revision and a session rotation ---------------

test('a revision is told the boundary it is revising', () => {
  const prompt = revisePlanPrompt({ findings: [finding()], outOfScope: [ITEM], round: 2 });
  assert.ok(prompt.includes(ITEM.item));
  assert.ok(prompt.includes('restate every item that still holds'));
});

test('a revision of a legacy plan is not handed a fabricated empty boundary', () => {
  const prompt = revisePlanPrompt({ findings: [finding()], round: 2 });
  assert.ok(prompt.includes(PREDATES));
  assert.ok(!prompt.includes(DECLARED_NONE));
});

test('a rehydrated session is given the boundary, not just plan_md', async () => {
  const state = freshRun();
  // sessionStarted is false on a fresh run, which is the state a rotation
  // leaves behind: the next turn rebuilds context from the handoff prefix.
  state.sessionStarted = false;
  state.plan = plan({ out_of_scope: [ITEM] });

  const prompts: string[] = [];
  const turns: AgentTurns = {
    claude: (options): Promise<ClaudeTurnResult> => {
      prompts.push(options.prompt);
      return Promise.resolve({
        text: 'ok',
        costUsd: 0,
        sessionId: options.sessionId,
        denials: [],
        numTurns: 1,
        usage: null,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
      });
    },
    codex: () => Promise.reject(new Error('codex should not be reached')),
  };

  const cfg: Config = {
    ...DEFAULTS,
    codex: { ...DEFAULTS.codex, readRateLimits: false },
    progress: { ...DEFAULTS.progress, enabled: false },
    context: { ...DEFAULTS.context, enabled: false },
  };

  await runTurn(
    state,
    cfg,
    { role: 'planner', prompt: 'revise it', cwd: process.cwd(), label: 'revise-1', timeoutMs: 1_000 },
    turns,
  );

  assert.ok(prompts[0]?.includes(ITEM.item), 'the plan of record must carry its own boundary');
});

// ---- FOLLOW-UPS.md ---------------------------------------------------------

test('deferred findings from multiple rounds land in FOLLOW-UPS.md', () => {
  const state = freshRun();

  collectDeferred(state, [
    finding({ id: 'plan-round-item', defer: true }),
    finding({ id: 'blocking-item', severity: 'P1', defer: true }),
    finding({ id: 'not-deferred' }),
  ]);
  collectDeferred(state, [
    finding({ id: 'review-round-item', severity: 'P3', defer: true }),
    finding({ id: 'plan-round-item', title: 'Restated better', defer: true }),
  ]);

  const file = writeFollowUps(state, plan({ out_of_scope: [ITEM] }));
  assert.notEqual(file, null);
  const body = readFileSync(followUpsPath(state), 'utf8');

  assert.ok(body.includes('plan-round-item'));
  assert.ok(body.includes('review-round-item'));
  assert.ok(body.includes(ITEM.item), "the approved plan's boundary belongs here too");
  // Deduped by id, later round winning: the same finding restated is usually
  // better stated, but it is still one follow-up.
  assert.equal(body.split('`plan-round-item`').length - 1, 1);
  assert.ok(body.includes('Restated better'));
  // A blocker is not a follow-up, whatever it claimed about itself.
  assert.ok(!body.includes('blocking-item'));
  assert.ok(!body.includes('not-deferred'));
});

test('collectDeferred enforces the P2/P3 invariant at its own boundary', () => {
  const state = freshRun();
  // Straight past parseFindings, which is where the normalisation usually
  // happens - the helper is exported, so its own contract has to hold.
  collectDeferred(state, [finding({ id: 'blocker', severity: 'P1', defer: true })]);
  assert.deepEqual(state.deferred ?? [], []);
});

test('stored entries sharing an id are deduped rather than passed through as clean', () => {
  const state = freshRun();
  // Individually valid, so the per-entry predicate has nothing to say - but
  // `RunState` documents `deferred` as deduped by id, and only the merge
  // enforces it. Treating this as clean would return early and keep both.
  state.deferred = [
    finding({ id: 'dupe', title: 'First telling', defer: true }),
    finding({ id: 'dupe', title: 'Better telling', defer: true }),
  ];

  collectDeferred(state, []);

  assert.equal(state.deferred.length, 1);
  assert.equal(state.deferred[0]?.title, 'Better telling', 'later entry wins, as in a merge');
});

test('a duplicate reached straight through writeFollowUps renders once', () => {
  const state = freshRun();
  // The exported artifact path, with state no collection has passed over: it
  // makes the claim, so it has to render what collecting first would have.
  state.deferred = [
    finding({ id: 'dupe', title: 'First telling', defer: true }),
    finding({ id: 'dupe', title: 'Better telling', defer: true }),
  ];

  const file = writeFollowUps(state, plan({ out_of_scope: [] }));
  assert.notEqual(file, null);

  const body = readFileSync(file as string, 'utf8');
  assert.equal(body.split('Better telling').length - 1, 1);
  assert.ok(!body.includes('First telling'), 'the superseded telling is not also rendered');
});

test('a run with nothing to defer produces no misleading empty file', () => {
  const state = freshRun();
  assert.equal(writeFollowUps(state, plan({ out_of_scope: [] })), null);
  assert.equal(existsSync(followUpsPath(state)), false);
});

test('dropping the last out-of-scope item removes the stale artifact', () => {
  const state = freshRun();

  assert.notEqual(writeFollowUps(state, plan({ out_of_scope: [ITEM] })), null);
  assert.equal(existsSync(followUpsPath(state)), true);

  // Exactly what `revisePlan` persists when a revision takes the excluded work
  // on: an artifact left standing here would contradict PLAN.md.
  assert.equal(writeFollowUps(state, plan({ out_of_scope: [] })), null);
  assert.equal(existsSync(followUpsPath(state)), false);
});

test('a legacy plan with no boundary contributes no section and no file', () => {
  const state = freshRun();
  assert.equal(writeFollowUps(state, plan()), null);
  assert.equal(existsSync(followUpsPath(state)), false);
});

// ---- The deferral reaches the prompts that show a finding -------------------

/**
 * A deferral that is not rendered is a deferral the next agent absorbs. These
 * pin the three states - deferred, not deferred, and the legacy shape with no
 * `defer` field at all - on both prompts that show findings.
 */

const DEFERRED_MARK = 'Deferred by the reviewer';
const PLANNER_NOTE = 'Preserving the boundary is the correct response';
const FIXER_NOTE = 'A deferred finding is not work to do here';
const OTHER: OutOfScopeItem = { item: 'configurable roles', why: 'tracked in issue #2' };

test('a revision is told which of its findings the reviewer deferred', () => {
  // The mixed round is the case: a blocker is what sends the plan back at all,
  // and the deferred item rides along with it.
  const prompt = revisePlanPrompt({
    findings: [finding({ id: 'keep', defer: true }), finding({ id: 'fix', severity: 'P1' })],
    outOfScope: [ITEM],
    round: 2,
  });
  assert.ok(prompt.includes(DEFERRED_MARK));
  assert.ok(prompt.includes(PLANNER_NOTE));
});

test('a revision whose findings are all live carries no deferral wording', () => {
  const prompt = revisePlanPrompt({ findings: [finding()], outOfScope: [ITEM], round: 2 });
  assert.ok(!prompt.includes(DEFERRED_MARK));
  assert.ok(!prompt.includes(PLANNER_NOTE));
});

test('the fixer is told a deferred finding is not work to do', () => {
  const deferred = fixPrompt([finding({ defer: true })], 1);
  assert.ok(deferred.includes(DEFERRED_MARK));
  // Otherwise "address P2s where the fix is contained and low-risk" offers the
  // reviewer's own declined item back to the implementer as easy work.
  assert.ok(deferred.includes(FIXER_NOTE));

  const live = fixPrompt([finding()], 1);
  assert.ok(!live.includes(DEFERRED_MARK));
  assert.ok(!live.includes(FIXER_NOTE));
});

test('a finding with no defer field renders exactly as one that declines to defer', () => {
  const legacy: Finding = {
    id: 'old',
    severity: 'P2',
    title: 'Old finding',
    detail: 'Detail.',
    suggested_fix: 'Fix it.',
  };
  const explicit = finding({ ...legacy, defer: false });

  assert.equal(fixPrompt([legacy], 1), fixPrompt([explicit], 1));
  assert.equal(
    revisePlanPrompt({ findings: [legacy], round: 2 }),
    revisePlanPrompt({ findings: [explicit], round: 2 }),
  );
  assert.ok(!fixPrompt([legacy], 1).includes(DEFERRED_MARK));
});

test('a round that defers without blocking is recorded even though no revision runs', () => {
  // `revisePlanPrompt` is reached only when the gate fails, so a critique whose
  // only findings are deferred passes straight through. The artifact, written
  // every round before the gate is consulted, is the record that always exists.
  const state = freshRun();
  collectDeferred(state, [finding({ id: 'later', defer: true })]);

  assert.notEqual(writeFollowUps(state, plan({ out_of_scope: [] })), null);
  assert.ok(readFileSync(followUpsPath(state), 'utf8').includes('later'));
});

// ---- collectDeferred sanitises what it inherits -----------------------------

/** What `loadRun` can hand back: JSON cast to `RunState`, never validated. */
const storedDeferred = (state: RunState): unknown =>
  (JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as Record<string, unknown>)[
    'deferred'
  ];

test('a bad entry already in state is dropped, on a round that defers nothing', () => {
  const state = freshRun();
  state.deferred = [
    finding({ id: 'blocker', severity: 'P1', defer: true }),
    finding({ id: 'not-deferred' }),
    { id: 'junk' } as unknown as Finding,
    finding({ id: 'good', defer: true }),
  ];

  collectDeferred(state, []);

  assert.deepEqual((state.deferred ?? []).map((f) => f.id), ['good']);
  // Persisted, not just mutated: the early return used to skip the write, so a
  // bad entry outlived the only code that would have removed it.
  assert.deepEqual(storedDeferred(state), [{ ...finding({ id: 'good', defer: true }) }]);
});

test('sanitising down to nothing persists the empty list', () => {
  const state = freshRun();
  state.deferred = [finding({ id: 'blocker', severity: 'P1', defer: true })];

  collectDeferred(state, []);

  assert.deepEqual(state.deferred, []);
  assert.deepEqual(storedDeferred(state), []);
});

test('a stored value that is not an array is replaced rather than filtered', () => {
  // `stored ?? []` defended against null only; a string or an object is truthy
  // and `.filter` throws - inside the code a resume calls before it can
  // reconcile or delete anything.
  for (const bad of ['oops', { id: 'x' }, null, 7]) {
    const state = freshRun();
    (state as unknown as Record<string, unknown>)['deferred'] = bad;

    assert.doesNotThrow(() => collectDeferred(state, []));
    assert.deepEqual(state.deferred, []);
    assert.deepEqual(storedDeferred(state), []);
  }
});

test('a clean round on clean state invents no empty list', () => {
  const state = freshRun();
  collectDeferred(state, []);
  assert.equal(state.deferred, undefined);
  assert.equal(storedDeferred(state), undefined);
});

test('the inherited list is sanitised on a round that does defer something', () => {
  const state = freshRun();
  state.deferred = [finding({ id: 'blocker', severity: 'P1', defer: true })];

  collectDeferred(state, [finding({ id: 'nit', severity: 'P3', defer: true })]);

  assert.deepEqual((state.deferred ?? []).map((f) => f.id), ['nit']);
});

test('writeFollowUps refuses a bad container too', () => {
  const state = freshRun();
  (state as unknown as Record<string, unknown>)['deferred'] = 'oops';

  const file = writeFollowUps(state, plan({ out_of_scope: [ITEM] }));

  assert.notEqual(file, null);
  const body = readFileSync(followUpsPath(state), 'utf8');
  assert.ok(body.includes(ITEM.item));
  // It is this function that claims everything below was non-blocking, and it
  // is exported, so it can be reached with state no collection passed over.
  assert.ok(!body.includes('## Deferred by review'));
});

// ---- FOLLOW-UPS.md cannot outlive the plan it describes ---------------------

test('a stale artifact is rewritten from the plan actually stored', () => {
  const state = freshRun();
  writeFollowUps(state, plan({ out_of_scope: [ITEM] }));
  state.plan = plan({ out_of_scope: [OTHER] });

  assert.notEqual(reconcileFollowUps(state), null);

  const body = readFileSync(followUpsPath(state), 'utf8');
  assert.ok(body.includes(OTHER.item));
  assert.ok(!body.includes(ITEM.item));
});

test('reconciling can mean deleting', () => {
  const state = freshRun();
  writeFollowUps(state, plan({ out_of_scope: [ITEM] }));
  assert.equal(existsSync(followUpsPath(state)), true);

  // What a run killed between `state.plan = plan` and the artifact write leaves
  // behind: a file asserting a boundary the stored plan no longer draws.
  state.plan = plan({ out_of_scope: [] });

  assert.equal(reconcileFollowUps(state), null);
  assert.equal(existsSync(followUpsPath(state)), false);
});

test('junk in stored state is not resurrected by the reconciliation', () => {
  const state = freshRun();
  writeFollowUps(state, plan({ out_of_scope: [ITEM] }));
  state.deferred = [finding({ id: 'blocker', severity: 'P1', defer: true })];
  state.plan = plan({ out_of_scope: [] });

  assert.equal(reconcileFollowUps(state), null);
  assert.equal(existsSync(followUpsPath(state)), false);
  assert.deepEqual(state.deferred, []);
});

test('a run with no stored plan reconciles nothing', () => {
  const state = freshRun();
  assert.equal(reconcileFollowUps(state), null);
  assert.equal(existsSync(followUpsPath(state)), false);
});

test('the run entry point reconciles before any phase runs', async () => {
  // Drives the real `orchestrate`: resume skips git, and a completed run
  // returns before any turn. If the call is dropped, this fails.
  const state = freshRun();
  writeFollowUps(state, plan({ out_of_scope: [ITEM] }));
  state.plan = plan({ out_of_scope: [] });
  state.phase = 'complete';

  await orchestrate(state, DEFAULTS, true);

  assert.equal(existsSync(followUpsPath(state)), false);
});

test('the run entry point rewrites a stale artifact as well as removing one', async () => {
  const state = freshRun();
  writeFollowUps(state, plan({ out_of_scope: [ITEM] }));
  state.plan = plan({ out_of_scope: [OTHER] });
  state.phase = 'complete';

  await orchestrate(state, DEFAULTS, true);

  const body = readFileSync(followUpsPath(state), 'utf8');
  assert.ok(body.includes(OTHER.item));
  assert.ok(!body.includes(ITEM.item));
});
