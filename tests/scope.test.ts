import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { collectDeferred, runTurn, writeFollowUps } from '@src/orchestrator.js';
import type { AgentTurns } from '@src/orchestrator.js';
import { critiquePrompt, renderPlanDoc, revisePlanPrompt, reviewPrompt } from '@src/prompts.js';
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
