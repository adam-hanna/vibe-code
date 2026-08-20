import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import type { AgentTurns } from '@src/orchestrator.js';
import { createRun, takePendingFindings } from '@src/run.js';
import type {
  ClaudeTurnResult,
  Config,
  Finding,
  LoopConfig,
  Plan,
  RunState,
  TokenUsage,
} from '@src/types.js';

/**
 * What a stalled run does with the findings it has already paid for.
 *
 * Both loops are shaped turn -> gate -> guard -> consume, and the guard throws
 * in the gap. The findings used to live only in a local binding, so a
 * convergence or budget stop discarded them and the resumed loop re-entered at
 * the turn that bought them - 7.5M tokens to re-derive the same two P1s byte for
 * byte, twice, plus a second `RoundRecord` for a plan that had not changed.
 *
 * These cases are about *order*: which turn a resumed loop takes first. Nothing
 * is spawned - the agents are injected through `orchestrate`'s seam, and
 * `codex.readRateLimits` is off so the rate-limit probe returns before it would
 * connect to an app-server.
 */

// ---- fixtures --------------------------------------------------------------

function tokens(total: number): TokenUsage {
  return { input: total, output: 0, cacheRead: 0, cacheCreation: 0, total };
}

function planFixture(over: Partial<Plan> = {}): Plan {
  return {
    plan_md: '# the plan\n\nDo the thing.',
    assumptions: [],
    open_questions: [],
    out_of_scope: [],
    ...over,
  };
}

function p1(id: string): Finding {
  return {
    id,
    severity: 'P1',
    title: `Finding ${id}`,
    detail: 'Detail.',
    suggested_fix: 'Fix it.',
  };
}

/** What the critic or the reviewer returns. Two P1s beat the default tolerance of one. */
function report(findings: readonly Finding[]): object {
  return {
    verdict: findings.length > 0 ? 'REVISE' : 'APPROVE',
    summary: 'summary',
    findings: [...findings],
  };
}

const BLOCKING = [p1('finding-one'), p1('finding-two')];

/**
 * Progress is *enabled*, unlike the other seam tests: `ProgressOptions` is the
 * only place a turn's label reaches a provider on the Claude side, and every
 * case here is an assertion about which labelled turn ran first. Nothing in the
 * progress machinery runs - it lives inside the real adapters, which these
 * cases replace.
 */
function config(loop: Partial<LoopConfig> = {}, over: Partial<Config> = {}): Config {
  return {
    ...DEFAULTS,
    codex: { ...DEFAULTS.codex, readRateLimits: false },
    context: { ...DEFAULTS.context, enabled: false },
    progress: { ...DEFAULTS.progress, enabled: true, intervalMs: 60_000 },
    verify: { ...DEFAULTS.verify, enabled: false },
    git: { ...DEFAULTS.git, commitEachRound: false },
    // The plan-budget guard is not what these cases are about; the round cap is.
    budget: { ...DEFAULTS.budget, planShare: 0 },
    loop: { ...DEFAULTS.loop, ...loop },
    ...over,
  };
}

interface Handlers {
  /** Claude's turn: an object is returned as JSON, a string as raw text. */
  claude?: (label: string) => unknown;
  /** Codex's turn: the structured findings report. */
  codex?: (label: string) => unknown;
}

/**
 * Both providers, recording the label of every turn in order.
 *
 * The order *is* the assertion in almost every case below: a resumed loop that
 * revises before it critiques is the fix, and one that critiques first is the
 * defect.
 */
function agents(handlers: Handlers, calls: string[]): AgentTurns {
  return {
    claude: (options): Promise<ClaudeTurnResult> => {
      const label = options.progress?.label ?? '(unlabelled)';
      calls.push(label);
      const produced = handlers.claude?.(label) ?? 'claude said so';
      return Promise.resolve({
        text: typeof produced === 'string' ? produced : JSON.stringify(produced),
        costUsd: 0.01,
        sessionId: options.sessionId,
        denials: [],
        numTurns: 1,
        usage: null,
        tokens: tokens(1000),
      });
    },
    codex: (options) => {
      calls.push(options.schemaName);
      const structured = handlers.codex?.(options.schemaName) ?? report([]);
      return Promise.resolve({
        structured,
        raw: JSON.stringify(structured),
        sessionId: 'thread-1',
        tokens: tokens(500),
      });
    },
  };
}

function freshRun(): RunState {
  return createRun(mkdtempSync(path.join(tmpdir(), 'vibe-pending-')), 'pending findings', true);
}

/** A run parked at the review phase, in a repo `git diff` can be asked about. */
function reviewingRun(): RunState {
  const state = createRun(mkdtempSync(path.join(tmpdir(), 'vibe-pending-')), 'pending findings', false);
  execFileSync('git', ['init', '-q'], { cwd: state.targetDir });
  state.plan = planFixture();
  state.phase = 'reviewing';
  state.baseSha = null;
  return state;
}

/**
 * A plan run stopped at the round cap with two P1s outstanding.
 *
 * The cap is the cheapest deterministic stall: `guardProgress` records its
 * `RoundRecord` and *then* throws, which is the exact shape of the defect.
 */
async function stalledPlan(): Promise<{ state: RunState; calls: string[] }> {
  const state = freshRun();
  state.plan = planFixture();
  const calls: string[] = [];
  const turns = agents({ codex: () => report(BLOCKING) }, calls);

  await assert.rejects(
    () => orchestrate(state, config({ maxPlanRounds: 1 }), true, turns),
    (err: unknown) => err instanceof Escalation && err.code === EXIT.NO_CONVERGENCE,
  );
  return { state, calls };
}

/** A review run stopped at the round cap with two P1s outstanding. */
async function stalledReview(): Promise<{ state: RunState; calls: string[] }> {
  const state = reviewingRun();
  const calls: string[] = [];
  const turns = agents({ codex: () => report(BLOCKING) }, calls);

  await assert.rejects(
    () => orchestrate(state, config({ maxReviewRounds: 1 }), true, turns),
    (err: unknown) => err instanceof Escalation && err.code === EXIT.NO_CONVERGENCE,
  );
  return { state, calls };
}

/** A critic that fails the case if it is asked twice. */
function onceThenApprove(calledTwice: () => never): (label: string) => unknown {
  let calls = 0;
  return () => {
    calls += 1;
    if (calls > 1) calledTwice();
    return report([]);
  };
}

// ---- the plan phase --------------------------------------------------------

test('a plan stall leaves the findings it paid for recoverable', async () => {
  const { state, calls } = await stalledPlan();

  assert.deepEqual(calls, ['critique-0']);
  assert.equal(state.pendingFindings?.phase, 'plan');
  assert.deepEqual(
    state.pendingFindings?.findings.map((f) => f.id),
    ['finding-one', 'finding-two'],
  );
  // The artifact was always written; what was missing is a record the loop reads.
  assert.equal(existsSync(path.join(state.dir, 'plan-critique-0.json')), true);
  assert.equal(state.p1Rounds.length, 1);
});

test('a resumed plan run revises against the carried findings instead of re-critiquing', async () => {
  const { state } = await stalledPlan();

  const calls: string[] = [];
  const turns = agents(
    {
      claude: (label) => {
        assert.equal(label, 'revise-1', 'the first turn of a resume must be the revision');
        return planFixture({ plan_md: '# revised' });
      },
      codex: onceThenApprove(() => assert.fail('the critique was re-bought on resume')),
    },
    calls,
  );

  await orchestrate(state, config({ maxPlanRounds: 5 }), true, turns);

  assert.deepEqual(calls, ['revise-1', 'critique-1']);
  assert.equal(state.pendingFindings, null);
  assert.equal(state.planRound, 1);
  // What the revision was asked about, not what the critic re-derived.
  assert.equal(state.plan?.plan_md, '# revised');
});

test('a resumed plan run records no second round for a plan it has not revised', async () => {
  const { state } = await stalledPlan();
  const before = state.p1Rounds.length;

  const calls: string[] = [];
  await orchestrate(
    state,
    config({ maxPlanRounds: 5 }),
    true,
    agents({ claude: () => planFixture(), codex: () => report([]) }, calls),
  );

  // Both halves matter: the resume revised rather than re-critiquing, *and* it
  // added no second observation. A duplicate record of an unchanged plan is what
  // made the next stall arrive sooner and understated how much the findings
  // actually turned over.
  assert.equal(calls[0], 'revise-1');
  assert.equal(state.p1Rounds.length, before);
  assert.equal(before, 1);
});

test('two resumes in a row produce two revisions, not two identical critiques', async () => {
  const { state } = await stalledPlan();

  const first: string[] = [];
  await assert.rejects(
    () =>
      orchestrate(
        state,
        config({ maxPlanRounds: 2 }),
        true,
        agents({ claude: () => planFixture(), codex: () => report(BLOCKING) }, first),
      ),
    Escalation,
  );
  assert.deepEqual(first, ['revise-1', 'critique-1']);

  const second: string[] = [];
  await assert.rejects(
    () =>
      orchestrate(
        state,
        config({ maxPlanRounds: 3 }),
        true,
        agents({ claude: () => planFixture(), codex: () => report(BLOCKING) }, second),
      ),
    Escalation,
  );
  assert.deepEqual(second, ['revise-2', 'critique-2']);

  assert.equal(state.planRound, 2);
  // Each stall left the *new* critique's findings behind, so the ratchet holds.
  assert.equal(state.pendingFindings?.phase, 'plan');
});

test('a revision that throws leaves the findings outstanding for the next resume', async () => {
  const { state } = await stalledPlan();

  await assert.rejects(
    () =>
      orchestrate(
        state,
        config({ maxPlanRounds: 5 }),
        true,
        agents(
          {
            claude: () => {
              throw new Error('the planner died mid-turn');
            },
          },
          [],
        ),
      ),
    /died mid-turn/,
  );

  assert.deepEqual(
    state.pendingFindings?.findings.map((f) => f.id),
    ['finding-one', 'finding-two'],
    'a failed revision has consumed nothing',
  );

  const calls: string[] = [];
  await orchestrate(
    state,
    config({ maxPlanRounds: 5 }),
    true,
    agents(
      {
        claude: () => planFixture(),
        codex: onceThenApprove(() => assert.fail('the critique was re-bought after a failed revision')),
      },
      calls,
    ),
  );

  // The round counter moved twice - the failed revision incremented it too - but
  // the findings were answered exactly once.
  assert.deepEqual(calls, ['revise-2', 'critique-2']);
  assert.equal(state.pendingFindings, null);
});

test('a stored state with no pendingFindings resumes exactly as it does today', async () => {
  const { state } = await stalledPlan();
  delete state.pendingFindings;

  const calls: string[] = [];
  await orchestrate(
    state,
    config({ maxPlanRounds: 5 }),
    true,
    agents({ claude: () => planFixture(), codex: () => report([]) }, calls),
  );

  // Today's behaviour, deliberately: absent means "nothing unconsumed", which is
  // exactly what a run recorded before this field existed meant.
  assert.deepEqual(calls, ['critique-0']);
});

test('junk in pendingFindings reads as absent rather than throwing', async () => {
  for (const junk of ['nope', 42, [], { phase: 'plan' }, { phase: 'plan', findings: [{}] }]) {
    const { state } = await stalledPlan();
    state.pendingFindings = junk as never;

    const calls: string[] = [];
    await orchestrate(
      state,
      config({ maxPlanRounds: 5 }),
      true,
      agents({ claude: () => planFixture(), codex: () => report([]) }, calls),
    );

    assert.deepEqual(calls, ['critique-0'], `junk ${JSON.stringify(junk)} must read as absent`);
  }
});

test('the phase tag keeps one loop from consuming the other loop s findings', () => {
  const state = freshRun();
  state.pendingFindings = { phase: 'review', findings: [...BLOCKING] };

  assert.equal(takePendingFindings(state, 'plan'), null);
  assert.equal(takePendingFindings(state, 'review')?.length, 2);

  state.pendingFindings = { phase: 'plan', findings: [...BLOCKING] };
  assert.equal(takePendingFindings(state, 'review'), null);
  assert.equal(takePendingFindings(state, 'plan')?.length, 2);
});

test('a plan run that does not stall records and consumes nothing new', async () => {
  const state = freshRun();
  state.plan = planFixture();

  const calls: string[] = [];
  await orchestrate(
    state,
    config(),
    true,
    agents({ codex: () => report([]) }, calls),
  );

  // The default path, untouched: one critique, no revision, no round record.
  assert.deepEqual(calls, ['critique-0']);
  assert.deepEqual(state.p1Rounds, []);
  assert.equal(state.planRound, 0);
  assert.equal(state.pendingFindings, null);
  assert.equal(existsSync(path.join(state.dir, 'PLAN.md')), true);
});

// ---- the review phase ------------------------------------------------------

test('a review stall leaves the findings it paid for recoverable', async () => {
  const { state, calls } = await stalledReview();

  assert.deepEqual(calls, ['review-0']);
  assert.equal(state.pendingFindings?.phase, 'review');
  assert.deepEqual(
    state.pendingFindings?.findings.map((f) => f.id),
    ['finding-one', 'finding-two'],
  );
  assert.equal(existsSync(path.join(state.dir, 'code-review-0.json')), true);
});

test('a resumed review run fixes the carried findings instead of re-reviewing', async () => {
  const { state } = await stalledReview();

  const calls: string[] = [];
  const turns = agents(
    {
      claude: (label) => {
        assert.equal(label, 'fix-1', 'the first turn of a resume must be the fix');
        return 'fixed it';
      },
      codex: onceThenApprove(() => assert.fail('the review was re-bought on resume')),
    },
    calls,
  );

  await orchestrate(state, config({ maxReviewRounds: 5 }), true, turns);

  assert.deepEqual(calls, ['fix-1', 'review-1']);
  assert.equal(state.pendingFindings, null);
  assert.equal(existsSync(path.join(state.dir, 'fix-report-1.md')), true);
});

test('the carried review iteration is not made to buy a verification run first', async () => {
  const { state } = await stalledReview();

  // A command that records each execution, so the gate's position in the loop is
  // observable rather than inferred.
  const marker = path.join(state.targetDir, 'gate-runs.txt');
  writeFileSync(
    path.join(state.targetDir, 'gate-marker.mjs'),
    "import { appendFileSync } from 'node:fs';\nappendFileSync('gate-runs.txt', 'ran\\n');\n",
    'utf8',
  );

  const calls: string[] = [];
  await orchestrate(
    state,
    config(
      { maxReviewRounds: 5 },
      {
        verify: {
          ...DEFAULTS.verify,
          enabled: true,
          command: 'node gate-marker.mjs',
          runs: 1,
          timeoutMs: 30_000,
        },
      },
    ),
    true,
    agents(
      {
        claude: () => 'fixed it',
        codex: onceThenApprove(() => assert.fail('the review was re-bought on resume')),
      },
      calls,
    ),
  );

  assert.deepEqual(calls, ['fix-1', 'review-1']);
  // Once, after the fix - not once before it and once after.
  const runs = readFileSync(marker, 'utf8').trim().split('\n');
  assert.equal(runs.length, 1, 'the gate ran before the carried findings were consumed');
});

test('a review run that does not stall records and consumes nothing new', async () => {
  const state = reviewingRun();

  const calls: string[] = [];
  await orchestrate(state, config(), true, agents({ codex: () => report([]) }, calls));

  assert.deepEqual(calls, ['review-0']);
  assert.deepEqual(state.p1Rounds, []);
  assert.equal(state.reviewRound, 0);
  assert.equal(state.pendingFindings, null);
});

test('OUTSTANDING.md is rewritten when the final fix round left without it', async () => {
  // What a process killed between the final fix turn and its artifact leaves
  // behind: the state says the round happened, and the file it promises is not
  // there. Nothing used to rewrite it, and the run finished clean pointing at a
  // missing file.
  const state = reviewingRun();
  state.finalFixDone = true;
  state.outstanding = [p1('carried-one')];

  const calls: string[] = [];
  await orchestrate(state, config(), true, agents({}, calls));

  const file = path.join(state.dir, 'OUTSTANDING.md');
  assert.equal(existsSync(file), true);
  assert.match(readFileSync(file, 'utf8'), /carried-one/);
  // And it cost nothing: no review, no fix, just the record.
  assert.deepEqual(calls, []);
});

test('an existing OUTSTANDING.md is never rewritten by the recovery', async () => {
  const state = reviewingRun();
  state.finalFixDone = true;
  state.outstanding = [p1('carried-one')];
  const file = path.join(state.dir, 'OUTSTANDING.md');
  writeFileSync(file, 'the original, written by the round that ran', 'utf8');

  await orchestrate(state, config(), true, agents({}, []));

  assert.equal(readFileSync(file, 'utf8'), 'the original, written by the round that ran');
});

test('the final fix round consumes its findings and leaves the record behind', async () => {
  // One P1 is within the default tolerance, so the review passes the gate and
  // the loop takes its final-fix branch. Every artifact that branch produces,
  // and nothing outstanding after it: a resume must have no reason to buy the
  // fix a second time.
  const state = reviewingRun();

  const calls: string[] = [];
  await orchestrate(
    state,
    config(),
    true,
    agents({ claude: () => 'fixed it', codex: () => report([p1('tolerated-one')]) }, calls),
  );

  assert.deepEqual(calls, ['review-0', 'final-fix-1']);
  assert.equal(state.pendingFindings, null);
  assert.equal(state.finalFixDone, true);
  assert.equal(existsSync(path.join(state.dir, 'fix-report-1.md')), true);
  assert.match(readFileSync(path.join(state.dir, 'OUTSTANDING.md'), 'utf8'), /tolerated-one/);
});

test('a half-finished final fix is completed before its record is written', async () => {
  // `finalFixDone` is persisted *before* the final fix turn, so this state is
  // what a process killed during that turn leaves: the round is claimed, the
  // work is not done, and the findings are still outstanding. The artifact says
  // the findings were addressed and verification still passed, so it must not
  // appear until both are true.
  const state = reviewingRun();
  state.finalFixDone = true;
  state.outstanding = [p1('carried-one')];
  state.pendingFindings = { phase: 'review', findings: [p1('carried-one')] };

  const file = path.join(state.dir, 'OUTSTANDING.md');
  const calls: string[] = [];
  await orchestrate(
    state,
    config(),
    true,
    agents(
      {
        claude: () => {
          assert.equal(
            existsSync(file),
            false,
            'the record was published before the fix it describes had run',
          );
          return 'fixed it';
        },
        codex: () => assert.fail('a finished final round must not be reviewed again'),
      },
      calls,
    ),
  );

  assert.deepEqual(calls, ['fix-1']);
  assert.equal(state.pendingFindings, null);
  assert.equal(existsSync(file), true);
  assert.match(readFileSync(file, 'utf8'), /carried-one/);
});

test('a failing verification gate leaves no record claiming it passed', async () => {
  const state = reviewingRun();
  state.finalFixDone = true;
  state.outstanding = [p1('carried-one')];
  writeFileSync(path.join(state.targetDir, 'gate-fail.mjs'), 'process.exit(1);\n', 'utf8');

  const calls: string[] = [];
  await assert.rejects(
    () =>
      orchestrate(
        state,
        config(
          { maxVerifyRounds: 1 },
          {
            verify: {
              ...DEFAULTS.verify,
              enabled: true,
              command: 'node gate-fail.mjs',
              runs: 1,
              timeoutMs: 30_000,
            },
          },
        ),
        true,
        agents({}, calls),
      ),
    Escalation,
  );

  // The suite does not pass, so nothing may assert that it does.
  assert.equal(existsSync(path.join(state.dir, 'OUTSTANDING.md')), false);
  assert.deepEqual(calls, []);
});
