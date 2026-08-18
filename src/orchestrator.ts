import path from 'node:path';
import { claudeTurn, parseStructured, RateLimitError } from '@src/claude.js';
import { codexTurn } from '@src/codex.js';
import type { CodexTurnOptions, CodexTurnResult } from '@src/codex.js';
import * as git from '@src/git.js';
import * as log from '@src/log.js';
import * as P from '@src/prompts.js';
import { PLAN_SCHEMA } from '@src/schemas.js';
import { claudePermission, codexSandbox, ROLES } from '@src/roles.js';
import type { Access, Role } from '@src/roles.js';
import {
  advancePhase,
  artifact,
  artifactDir,
  assessConvergence,
  measuredRatio,
  p1Signature,
  persistenceNotice,
  recordEvent,
  recordRound,
  resumePhase,
  saveState,
} from '@src/run.js';
import {
  blockers as blockingFindings,
  gate,
  parseAnswers,
  parseFindings,
  parsePlan,
} from '@src/validate.js';
import {
  withConcurrentCompaction,
  recordTurnContext,
  rotateSession,
  shouldRotate,
} from '@src/context.js';
import type { ClaudeTurnFn } from '@src/context.js';
import { progressOptions } from '@src/progress.js';
import {
  closeCodexRateLimits,
  decideCodexLimit,
  describeLimits,
  invalidateCodexRateLimits,
  readCodexRateLimits,
  recordLimits,
} from '@src/ratelimits.js';
import { describeFailure, runVerification } from '@src/verify.js';
import type {
  Answer,
  Config,
  Finding,
  FindingsReport,
  OpenQuestion,
  RoundRecord,
  Plan,
  RunState,
} from '@src/types.js';

export const EXIT = {
  OK: 0,
  ERROR: 1,
  NEEDS_HUMAN: 2,
  NO_CONVERGENCE: 3,
  BUDGET: 4,
  RATE_LIMITED: 5,
  /** The agents' execution environments do not satisfy the toolchain contract. */
  PREFLIGHT: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class Escalation extends Error {
  constructor(
    readonly code: ExitCode,
    message: string,
    readonly questions: OpenQuestion[] | null = null,
    readonly findings: Finding[] | null = null,
  ) {
    super(message);
    this.name = 'Escalation';
  }
}

/** Read-only toolset for planning turns, alongside plan mode itself. */
const PLAN_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'] as const;

export async function orchestrate(state: RunState, cfg: Config, resume: boolean): Promise<RunState> {
  try {
    return await runPhases(state, cfg, resume);
  } finally {
    // A `finally`, not a tail call: the phases below return early at the
    // "already finished" check and at the plan-only exit, and a persistent
    // app-server child left running would outlive the run on exactly those
    // paths.
    closeCodexRateLimits();
  }
}

async function runPhases(state: RunState, cfg: Config, resume: boolean): Promise<RunState> {
  const cwd = state.targetDir;

  if (!resume) await prepareGit(state, cfg, cwd);

  const phase = resumePhase(state);
  if (phase === 'complete') {
    log.ok('This run already finished - there is nothing to resume.');
    return state;
  }

  // ---- Planning ------------------------------------------------------------
  // Skipped outright once the plan has been approved. Re-running it is not just
  // wasted spend: the critique is made against a tree that now holds the
  // implementation, so it reliably produces findings about the resume rather
  // than about the task.
  let plan: Plan;
  if (phase === 'planning') {
    plan = await planPhase(state, cfg, cwd);
    if (state.planOnly) {
      state.status = 'planned';
      advancePhase(state, 'complete');
      log.ok('Plan-only run: stopping before implementation.');
      return state;
    }
    advancePhase(state, 'implementing');
  } else {
    const approved = state.plan;
    if (approved === null) {
      throw new Error(`Run ${state.id} is at the ${phase} phase but stored no plan.`);
    }
    plan = approved;
    log.info(`Resuming at the ${phase} phase - the plan is already approved.`);
  }

  // ---- Implementation ------------------------------------------------------
  if (phase !== 'reviewing') {
    state.status = 'implementing';
    state.baseSha = await git.markBase(cwd);
    saveState(state);

    log.heading('Implementing');
    const impl = await runTurn(state, cfg, {
      role: 'implementer',
      prompt: P.implementPrompt(plan.plan_md, state.carried ?? []),
      cwd,
      timeoutMs: cfg.claude.implementTimeoutMs,
      label: 'implement',
    });
    artifact(state, 'implementation-report.md', impl.text);

    // Advanced before the commit, not after. The implementation turn is the
    // single most expensive step in a run, and a failure while committing it
    // must not charge for it twice - which is exactly what happened when a
    // `git add` error came back as a bare 'error' status.
    advancePhase(state, 'reviewing');
    await maybeCommit(cfg, cwd, 'vibe: implement approved plan');

    // Reset only on a fresh implementation. Resuming mid-review must keep the
    // histories, or the convergence assessment loses the evidence it is built
    // on and a stalled loop reads as a healthy one.
    state.p1Rounds = [];
    state.verifyRounds = [];
  }

  // ---- Review --------------------------------------------------------------
  state.status = 'reviewing';
  saveState(state);

  await reviewPhase(state, cfg, cwd, plan);

  state.status = 'done';
  advancePhase(state, 'complete');
  return state;
}

/** Plan, resolve questions, and critique until Codex raises no P1s. */
async function planPhase(state: RunState, cfg: Config, cwd: string): Promise<Plan> {
  let plan: Plan;
  if (state.plan) {
    plan = state.plan;
  } else {
    log.heading('Planning');
    plan = await runPlan(state, cfg, cwd);
  }

  // Answers supplied by a human in NEEDS-INPUT.md, picked up on resume.
  if (state.pendingAnswers && state.pendingAnswers.length > 0) {
    for (const a of state.pendingAnswers) markAnswered(state, a.question);
    plan = await revisePlan(state, cfg, cwd, { answers: state.pendingAnswers });
    state.pendingAnswers = null;
    saveState(state);
  }

  for (;;) {
    // A question already put to Codex never comes back, however the revised plan
    // rephrases it - otherwise an insistent planner loops the run forever.
    const pending = plan.open_questions.filter(
      (q) => (q.blocking || cfg.questions.answerNonBlocking) && !isAnswered(state, q.question),
    );
    if (pending.length > 0) {
      // The planner gets a bounded number of goes at resolving its own
      // questions. Without this the path re-plans forever on newly-invented
      // questions, since it never reaches the round cap below.
      if (state.questionRound >= cfg.loop.maxQuestionRounds) {
        throw new Escalation(
          EXIT.NEEDS_HUMAN,
          `The planner is still raising questions after ${cfg.loop.maxQuestionRounds} ` +
            'rounds of answering its own. Answer these directly, or raise ' +
            'loop.maxQuestionRounds.',
          [...pending],
        );
      }
      state.questionRound += 1;
      saveState(state);

      const answers = await resolveQuestions(state, cfg, cwd, pending, plan);
      // Codex may have declined every one; only revise if something came back.
      plan = answers.length > 0 ? await revisePlan(state, cfg, cwd, { answers }) : plan;
      continue;
    }

    log.heading(`Plan critique (round ${state.planRound + 1})`);
    const critique = await withConcurrentCompaction(state, cfg, () => runCritique(state, cfg, cwd, plan));
    artifact(state, `plan-critique-${state.planRound}.json`, critique);

    const decision = gate(critique.findings, cfg.loop.p1Tolerance);
    const stoppers = blockingFindings(critique.findings);
    if (decision.pass) {
      if (decision.tolerated.length > 0) {
        // Carried, not forgiven. The implementation is told about these so the
        // phase that can actually settle them does.
        state.carried = decision.tolerated;
        log.ok(
          `Plan accepted with ${decision.tolerated.length} P1(s) carried into implementation - ` +
            decision.tolerated.map((f) => f.id).join(', '),
        );
        for (const f of decision.tolerated) log.info(`  ~ ${f.title}`);
      } else {
        log.ok(`Plan approved - ${critique.findings.length} non-blocking finding(s)`);
      }
      recordEvent(state, 'plan_approved', {
        findings: critique.findings.length,
        carried: decision.tolerated.map((f) => f.id),
      });
      break;
    }

    log.warn(`${decision.reason}: ${stoppers.map((f) => f.id).join(', ')}`);
    for (const f of stoppers) log.info(`  - [${f.severity}] ${f.title}`);

    guardPlanBudget(state, cfg, stoppers);
    guardProgress(cfg, state.p1Rounds, critique.findings, stoppers, {
      cap: cfg.loop.maxPlanRounds,
      round: state.planRound + 1,
      capName: 'maxPlanRounds',
      deadlockMsg: 'the planner and reviewer are deadlocked',
    });

    plan = await revisePlan(state, cfg, cwd, { findings: critique.findings });
  }

  const planFile = artifact(state, 'PLAN.md', plan.plan_md);
  log.info(`Plan: ${path.relative(cwd, planFile)}`);
  return plan;
}

/** Verify, then review, fixing each until both are clean. */
async function reviewPhase(state: RunState, cfg: Config, cwd: string, plan: Plan): Promise<void> {
  for (;;) {
    // Does it run, before asking whether it reads well. A failing suite is an
    // unambiguous P1, and spending a reviewer turn on code that does not
    // execute buys an opinion about the wrong thing.
    const verified = await runGate(state, cfg, cwd);
    if (verified !== null) {
      // Its own counter and its own history: making the suite pass and
      // satisfying the reviewer are separate problems that converge
      // separately, and sharing a budget starved whichever came second.
      guardProgress(cfg, state.verifyRounds, [verified], [verified], {
        cap: cfg.loop.maxVerifyRounds,
        round: state.verifyRound + 1,
        capName: 'maxVerifyRounds',
        deadlockMsg: 'verification keeps failing after fixes',
      });

      state.verifyRound += 1;
      saveState(state);

      log.step('Fixing the verification failure');
      const repair = await runTurn(state, cfg, {
        role: 'implementer',
        prompt: P.fixPrompt([verified], state.verifyRound),
        cwd,
        timeoutMs: cfg.claude.implementTimeoutMs,
        label: `verify-fix-${state.verifyRound}`,
      });
      artifact(state, `verify-fix-${state.verifyRound}.md`, repair.text);
      await maybeCommit(cfg, cwd, `vibe: fix verification failure (round ${state.verifyRound})`);
      continue;
    }

    // The carried findings have been addressed and the suite still passes.
    // Stop here rather than reviewing again: the point of the tolerance is to
    // end the argument, and a fresh review would reopen it.
    if (state.finalFixDone === true) {
      log.ok('Carried findings addressed and verification still passes.');
      break;
    }

    log.heading(`Code review (round ${state.reviewRound + 1})`);
    const review = await withConcurrentCompaction(state, cfg, () => runReview(state, cfg, cwd, plan));
    artifact(state, `code-review-${state.reviewRound}.json`, review);

    const decision = gate(review.findings, cfg.loop.p1Tolerance);
    const stoppers = blockingFindings(review.findings);
    if (decision.pass) {
      if (decision.tolerated.length === 0) {
        log.ok(`Review clean - ${review.findings.length} non-blocking finding(s)`);
        recordEvent(state, 'review_approved', { findings: review.findings.length });
        break;
      }

      // Tolerating a finding means stopping the argument, not abandoning the
      // work. The loop ends after one more fix that incorporates what the
      // reviewer found - the alternative was to finish with a known defect
      // untouched, which is not what "move on" should buy.
      //
      // The result is deliberately not re-reviewed: that is what bounds this.
      // Another review round could raise something new and the loop would never
      // end, which is the situation the tolerance exists to escape.
      state.reviewRound += 1;
      state.finalFixDone = true;
      state.outstanding = decision.tolerated;
      saveState(state);

      log.step(
        `Incorporating ${decision.tolerated.length} carried P1(s), then finishing: ` +
          decision.tolerated.map((f) => f.id).join(', '),
      );
      for (const f of decision.tolerated) log.info(`  ~ ${f.title}`);

      const finalFix = await runTurn(state, cfg, {
        role: 'implementer',
        prompt: P.fixPrompt(review.findings, state.reviewRound),
        cwd,
        timeoutMs: cfg.claude.implementTimeoutMs,
        label: `final-fix-${state.reviewRound}`,
      });
      artifact(state, `fix-report-${state.reviewRound}.md`, finalFix.text);
      await maybeCommit(cfg, cwd, `vibe: address carried review findings (final round)`);

      const file = artifact(state, 'OUTSTANDING.md', renderOutstanding(state, decision.tolerated));
      log.info(`Carried findings and what was done about them: ${path.relative(cwd, file)}`);
      recordEvent(state, 'review_approved', {
        findings: review.findings.length,
        carriedAndFixed: decision.tolerated.map((f) => f.id),
      });
      // Back to the top once, so the gate proves the final fix broke nothing.
      continue;
    }

    log.warn(`${decision.reason}: ${stoppers.map((f) => f.id).join(', ')}`);
    for (const f of stoppers) log.info(`  - [${f.severity}] ${f.title}`);

    guardProgress(cfg, state.p1Rounds, review.findings, stoppers, {
      cap: cfg.loop.maxReviewRounds,
      round: state.reviewRound + 1,
      capName: 'maxReviewRounds',
      deadlockMsg: 'the fixer and reviewer are deadlocked',
    });

    state.reviewRound += 1;
    saveState(state);

    log.step(`Fixing ${stoppers.length} blocking finding(s)`);
    const fix = await runTurn(state, cfg, {
      role: 'implementer',
      prompt: P.fixPrompt(review.findings, state.reviewRound),
      cwd,
      timeoutMs: cfg.claude.implementTimeoutMs,
      label: `fix-${state.reviewRound}`,
    });
    artifact(state, `fix-report-${state.reviewRound}.md`, fix.text);
    await maybeCommit(cfg, cwd, `vibe: address review round ${state.reviewRound}`);
  }
}

/** The findings the last fix round addressed without a reviewer confirming it. */
function renderOutstanding(state: RunState, findings: readonly Finding[]): string {
  const body = findings
    .map(
      (f) =>
        `## ${f.title} \`${f.id}\`\n\n${f.detail}\n\n*Suggested fix:* ${f.suggested_fix}\n`,
    )
    .join('\n');
  return (
    `# Carried findings\n\n` +
    `**Run:** \`${state.id}\`\n` +
    `**Task:** ${state.task}\n\n` +
    `The last review raised ${findings.length} P1 finding(s), within \`loop.p1Tolerance\`. ` +
    `A final fix round addressed them and verification still passed, but that round was ` +
    `deliberately **not reviewed again** - re-reviewing would reopen the loop the tolerance ` +
    `exists to close. So these were worked on, and nobody has confirmed they are gone.\n\n` +
    `Worth a human eye. Set \`loop.p1Tolerance\` to 0 to require a spotless review instead, ` +
    `at the cost of runs that cannot converge.\n\n` +
    body
  );
}

// ---------------------------------------------------------------------------

interface GuardArgs {
  cap: number;
  round: number;
  capName: string;
  deadlockMsg: string;
}

/** Both brakes that stop a loop from running forever on the same disagreement. */
/**
 * Stop planning that has spent more than its share of the ceiling.
 *
 * Everything charged so far belongs to the plan phase - this runs before any
 * implementation turn - so the run's own totals are the plan's totals. The
 * round counter cannot see this: rounds can be cheap or enormous, and the run
 * that motivated this had single revisions costing 12.7M tokens.
 */
export function guardPlanBudget(state: RunState, cfg: Config, blockers: readonly Finding[]): void {
  const share = cfg.budget.planShare;
  if (share <= 0) return;

  const costCap = cfg.budget.maxCostUsd * share;
  const tokenCap = cfg.budget.maxTokens > 0 ? cfg.budget.maxTokens * share : 0;
  const overCost = state.costUsd > costCap;
  const overTokens = tokenCap > 0 && state.tokensUsed > tokenCap;
  if (!overCost && !overTokens) return;

  const spent = overCost
    ? `~$${state.costUsd.toFixed(2)} of the $${cfg.budget.maxCostUsd} ceiling`
    : `${fmtTokens(state.tokensUsed)} of the ${fmtTokens(cfg.budget.maxTokens)} token ceiling`;

  throw new Escalation(
    EXIT.BUDGET,
    `Planning has used ${spent} (${(share * 100).toFixed(0)}% cap) with ` +
      `${blockers.length} P1(s) still open, and has not reached implementation. ` +
      'Narrow the task or raise budget.planShare.',
    null,
    [...blockers],
  );
}

/**
 * The whole-run budget ceilings that are currently armed, worded for a user.
 *
 * NOT a list of everything that can stop a run: budget.planShare stops the plan
 * loop before this guard is reached, maxQuestionRounds bounds the question
 * cycle, and a rate-limit or maxWaitMinutes exit can end any turn. Callers must
 * present these as examples. maxTokens is omitted when 0 disables it - naming a
 * ceiling that is not enforced would send the user to raise the wrong setting.
 * maxCostUsd is always armed (validation forbids <= 0) but is Claude-side only,
 * which the wording says so it does not overstate coverage.
 */
export function budgetCeilings(cfg: Config): string[] {
  const ceilings = [`budget.maxCostUsd ($${cfg.budget.maxCostUsd}, Claude only)`];
  if (cfg.budget.maxTokens > 0) ceilings.push(`budget.maxTokens (${fmtTokens(cfg.budget.maxTokens)})`);
  return ceilings;
}

/** The persistence line for this round, or null when there is nothing to report. */
export function persistenceWarning(
  cfg: Config,
  history: readonly RoundRecord[],
  args: { cap: number; capName: string },
): string | null {
  return persistenceNotice(history, {
    // The threshold that used to end the run now only speaks.
    minRounds: cfg.loop.oscillationThreshold + 1,
    capLimit: `${args.capName} (${args.cap})`,
    ceilings: budgetCeilings(cfg),
  });
}

/** Exported for tests: appends to `history`, may log, and may throw `Escalation`. */
export function guardProgress(
  cfg: Config,
  history: RoundRecord[],
  all: readonly Finding[],
  blockers: readonly Finding[],
  { cap, round, capName, deadlockMsg }: GuardArgs,
): void {
  recordRound(
    history,
    p1Signature(all),
    blockers.length,
    blockers.map((f) => f.id),
  );

  const stall = assessConvergence(history, {
    repeatThreshold: cfg.loop.oscillationThreshold,
    window: cfg.loop.convergenceWindow,
    cap,
    round,
  });
  if (stall !== null) {
    throw new Escalation(
      EXIT.NO_CONVERGENCE,
      `Stopping early: ${stall} - ${deadlockMsg}.`,
      null,
      [...blockers],
    );
  }
  if (round >= cap) {
    throw new Escalation(
      EXIT.NO_CONVERGENCE,
      `Hit ${capName} (${cap}) with ${blockers.length} blocking finding(s) outstanding.`,
      null,
      [...blockers],
    );
  }

  // Last, deliberately: the notice tells the user the run is continuing, which
  // is only true once every stop above has declined to fire. Emitted earlier it
  // said "continuing" on the same round the cap or the trend guard ended the
  // run.
  const notice = persistenceWarning(cfg, history, { cap, capName });
  if (notice !== null) log.warn(notice);
}

async function prepareGit(state: RunState, cfg: Config, cwd: string): Promise<void> {
  if (!(await git.isRepo(cwd))) {
    log.warn('Not a git repository - running without branch isolation or commits.');
    return;
  }
  if (await git.isDirty(cwd)) {
    log.warn('Working tree has uncommitted changes; they will be swept into the first commit.');
  }
  if (cfg.git.useBranch) {
    const branch = `${cfg.git.branchPrefix}${state.id}`;
    await git.createBranch(cwd, branch);
    state.branch = branch;
    saveState(state);
    log.ok(`Isolated on branch ${branch}`);
  }
}

async function maybeCommit(cfg: Config, cwd: string, message: string): Promise<void> {
  if (!cfg.git.commitEachRound) return;
  if (!(await git.isRepo(cwd))) return;
  const sha = await git.commitAll(cwd, message);
  if (sha) log.ok(`Committed ${sha}`);
}

/**
 * Run the project's verification command.
 *
 * Returns a P0 finding when it fails, or null when the code is good to review.
 * The finding is shaped like any other so it flows through the existing fix
 * loop, oscillation detection and round caps rather than needing its own.
 */
async function runGate(state: RunState, cfg: Config, cwd: string): Promise<Finding | null> {
  if (!cfg.verify.enabled) return null;

  log.step('Verifying');
  const result = await runVerification(cwd, cfg.verify, cfg.toolchain);

  if (result.skipped !== null) {
    // Say so rather than letting silence read as a pass.
    log.warn(`Verification skipped: ${result.skipped}`);
    recordEvent(state, 'verify_skipped', { reason: result.skipped });
    return null;
  }

  if (result.ok) {
    log.ok(`Verification passed: ${result.command} (${result.runs}x)`);
    recordEvent(state, 'verify_passed', { command: result.command, runs: result.runs });
    return null;
  }

  // A command that never started cannot be fixed by editing source. Stopping
  // here costs one message; the alternative was observed burning two fix
  // rounds asking an agent to repair a mistyped command path.
  if (result.unlaunchable !== null) {
    artifact(state, `verify-unlaunchable-${state.reviewRound}.txt`, result.output);
    throw new Escalation(
      EXIT.PREFLIGHT,
      `The verification command could not run: ${result.unlaunchable}.\n` +
        `Command: ${result.command}\n` +
        'This is a configuration problem, not a defect in the code. Fix ' +
        '--verify-command (or verify.command), then resume.',
    );
  }

  log.warn(`Verification failed: ${result.command} (attempt ${result.failedRun} of ${result.runs})`);
  recordEvent(state, 'verify_failed', {
    command: result.command,
    failedRun: result.failedRun,
    exitCode: result.exitCode,
  });
  artifact(state, `verify-failure-${state.reviewRound}.txt`, result.output);

  return {
    // A stable id: an identical failure across rounds is what oscillation
    // detection needs to see to conclude the fixer is not making progress.
    id: 'verification-failing',
    // P0, so `loop.p1Tolerance` can never carry it. Every other finding is an
    // opinion about the code; this one is the code not working, and a run that
    // shipped past it would be reporting success over a failing suite.
    severity: 'P0',
    title: `${result.command} does not pass`,
    detail: describeFailure(result),
    suggested_fix:
      'Make the verification command pass. If it fails only sometimes, the defect is a race - ' +
      'fix the underlying synchronisation rather than retrying or loosening the test.',
  };
}

// ---------------------------------------------------------------------------
// The agent seam.
//
// One dispatch taking a role and routing it to a provider, replacing the two
// parallel `claudeStep` / `runCodex` paths. The providers disagree about how to
// say "this turn may write" - Claude spells it `--permission-mode`, Codex spells
// it `-s` - so the role carries the intent and each adapter translates it.
// ---------------------------------------------------------------------------

/**
 * Injectable for the seam tests, which must not spawn a real `codex`.
 *
 * Mirrors `ClaudeTurnFn` in context.ts, which is declared beside its own
 * injection point for the same reason. One convention, not two.
 */
export type CodexTurnFn = (options: CodexTurnOptions) => Promise<CodexTurnResult>;

export interface AgentTurns {
  claude: ClaudeTurnFn;
  codex: CodexTurnFn;
}

/** What a run actually dispatches to. Tests substitute fakes for both. */
export const REAL_AGENTS: AgentTurns = { claude: claudeTurn, codex: codexTurn };

// The role vocabulary lives in @src/roles.js, a leaf: preflight needs the same
// Access notion to decide what to enforce, and importing this module would pull
// the whole run loop - claude, codex, git, context, ratelimits, verify - into
// `vibe doctor`'s probe path. Re-exported so the seam's callers and tests keep
// one import site.
export { claudePermission, codexSandbox, providerAccess, ROLES } from '@src/roles.js';
export type { Access, Role } from '@src/roles.js';

export interface TurnRequest {
  role: Role;
  prompt: string;
  cwd: string;
  /** The retry label, the progress label, and - for Codex - the output name. */
  label: string;
  timeoutMs: number;
  /** Claude only: the response schema the turn is constrained to. */
  jsonSchema?: object | undefined;
  /** Claude only: the tools the turn may use. */
  tools?: readonly string[] | undefined;
}

export interface TurnOutcome {
  /** Claude: the result text. Codex: the raw structured-output file. */
  text: string;
  /** Codex: its parsed structured output. Null for Claude, whose callers parse `text`. */
  structured: unknown;
}

/**
 * What one turn cost the run, in the shape the shared accounting needs.
 *
 * `costUsd` is null where the provider reports no cost. Codex reports none, and
 * inventing a figure would make `state.costUsd` a number nobody could trace to
 * a source.
 */
export interface TurnCharge {
  costUsd: number | null;
  tokens: number;
  event: { type: string; data: Record<string, unknown> };
  /** Built after the totals are updated, so the line can quote the run total. */
  describe: () => string;
  /** Emitted after the detail line and before the ceilings, as both paths did. */
  warnings: readonly string[];
}

/**
 * The per-turn accounting both providers share.
 *
 * Deliberately synchronous, and deliberately called by each adapter in the same
 * continuation as its provider result rather than by `runTurn` after another
 * `await`. Critique and review run under `withConcurrentCompaction`, so a
 * rotation is completing on another promise chain while a Codex turn finishes;
 * an extra await boundary here would let `session_rotated` and its handoff cost
 * land between the Codex result and the Codex turn's own event and log line,
 * reordering the run record against what the two separate paths produced.
 */
export function applyCharge(state: RunState, cfg: Config, charge: TurnCharge): void {
  state.tokensUsed += charge.tokens;
  if (charge.costUsd === null) {
    state.codexTokens = (state.codexTokens ?? 0) + charge.tokens;
  } else {
    state.costUsd = Number((state.costUsd + charge.costUsd).toFixed(4));
  }

  recordEvent(state, charge.event.type, charge.event.data);
  log.detail(charge.describe());
  for (const warning of charge.warnings) log.warn(warning);

  enforceTokenCeiling(state, cfg);
  // Only where the provider reported a cost. The check has always lived on the
  // Claude path alone, and `state.costUsd` can rise during a Codex turn from a
  // concurrent rotation - so running it here unconditionally would end the run
  // one turn earlier than it does today, before the critique or review artifact
  // that turn just paid for had been written.
  if (charge.costUsd !== null) enforceCostCeiling(state, cfg);
}

/** One turn by whichever provider this role belongs to. */
export function runTurn(
  state: RunState,
  cfg: Config,
  req: TurnRequest,
  turns: AgentTurns = REAL_AGENTS,
): Promise<TurnOutcome> {
  const spec = ROLES[req.role];
  // Returned, not awaited: `runTurn` adds no continuation of its own between a
  // provider finishing and its charge being applied. See `applyCharge`.
  return spec.provider === 'claude'
    ? claudeDispatch(state, cfg, req, spec.access, turns.claude)
    : codexDispatch(state, cfg, req, spec, turns.codex);
}

async function claudeDispatch(
  state: RunState,
  cfg: Config,
  req: TurnRequest,
  access: Access,
  turn: ClaudeTurnFn,
): Promise<TurnOutcome> {
  // A rotation that could not be overlapped with Codex work happens here, at a
  // turn boundary - never mid-turn.
  if (shouldRotate(state, cfg)) await rotateSession(state, cfg, turn);

  const resume = state.sessionStarted;
  // Not conditional on there being a briefing: a rotation that could not
  // summarise the outgoing session still starts a fresh one, and the plan of
  // record has to travel with it either way - revisePlanPrompt and the fix
  // prompts all assume the plan is already in the conversation.
  const prompt = resume
    ? req.prompt
    : P.handoffContext(state.handoff, state.plan?.plan_md ?? null, state.handoffStale === true) +
      req.prompt;

  const result = await withRateLimitRetry(state, cfg, req.label, () =>
    turn({
      prompt,
      sessionId: state.sessionId,
      resume,
      permissionMode: claudePermission(access),
      model: cfg.claude.model,
      effort: cfg.claude.effort,
      cwd: req.cwd,
      jsonSchema: req.jsonSchema,
      tools: req.tools,
      timeoutMs: req.timeoutMs,
      progress: progressOptions(state, cfg, req.label),
    }),
  );

  state.sessionStarted = true;
  // Tagged with the model that produced it: the ratio is a fraction of this
  // model's window and means nothing under another one. Through the shared seam
  // so the rotation turn in context.ts cannot drift out of step with this one.
  recordTurnContext(state, cfg.claude.model, result.usage);

  const measured = measuredRatio(state, cfg.claude.model);
  const ctx = result.usage ? `, ctx ${(result.usage.ratio * 100).toFixed(0)}%` : '';
  applyCharge(state, cfg, {
    costUsd: result.costUsd,
    tokens: result.tokens.total,
    event: {
      type: 'claude_turn',
      data: {
        label: req.label,
        costUsd: result.costUsd,
        tokens: result.tokens.total,
        turns: result.numTurns,
        // null rather than the stored figure when this turn reported no usage
        // and the last measurement belongs to another model: the event log is
        // the record of what a run did, and a ratio against the wrong window is
        // not it.
        contextRatio: measured === null ? null : Number(measured.toFixed(3)),
      },
    },
    describe: () =>
      `${req.label}: ${fmtTokens(result.tokens.total)} tok, ~$${result.costUsd.toFixed(3)} ` +
      `(run ${fmtTokens(state.tokensUsed)} tok / ~$${state.costUsd.toFixed(2)}${ctx})`,
    warnings:
      result.denials.length > 0
        ? [`${result.denials.length} permission denial(s) in ${req.label}`]
        : [],
  });

  return { text: result.text, structured: null };
}

/**
 * The one ceiling both agents answer to.
 *
 * Shared rather than duplicated per adapter because the Codex side has no cost
 * figure to fall back on: if this check were only wired into the Claude path,
 * a run whose expensive work sat with Codex would have no working brake at all.
 */
function enforceTokenCeiling(state: RunState, cfg: Config): void {
  if (cfg.budget.maxTokens <= 0 || state.tokensUsed <= cfg.budget.maxTokens) return;
  throw new Escalation(
    EXIT.BUDGET,
    `Token ceiling exceeded: ${fmtTokens(state.tokensUsed)} > ${fmtTokens(cfg.budget.maxTokens)}. ` +
      'Raise budget.maxTokens to continue.',
  );
}

/** The Claude-side ceiling. Codex reports no cost, so it can never trip this. */
function enforceCostCeiling(state: RunState, cfg: Config): void {
  if (state.costUsd <= cfg.budget.maxCostUsd) return;
  throw new Escalation(
    EXIT.BUDGET,
    `Work ceiling reached: ~$${state.costUsd.toFixed(2)} API-equivalent > $${cfg.budget.maxCostUsd}. ` +
      'On a subscription this is a volume brake, not a bill. Raise budget.maxCostUsd to continue.',
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * Wait out a subscription rate limit rather than losing the run to it.
 *
 * This is the ceiling that actually stops long unattended runs on a plan with
 * overage disabled - no charge accrues, requests simply start failing. The wait
 * is capped so a weekly-cap reset cannot hang the process for days; past the cap
 * the run exits resumable.
 */
async function withRateLimitRetry<T>(
  state: RunState,
  cfg: Config,
  label: string,
  work: () => Promise<T>,
): Promise<T> {
  for (;;) {
    try {
      return await work();
    } catch (err) {
      if (!(err instanceof RateLimitError)) throw err;

      const waitMs = plannedWait(err, cfg);
      const minutes = Math.ceil(waitMs / 60_000);

      if (!cfg.budget.waitOnRateLimit || waitMs <= 0) {
        throw new Escalation(
          EXIT.RATE_LIMITED,
          `Rate limit hit during "${label}". ${describeReset(err)} ` +
            'Resume this run once the window resets.',
        );
      }
      if (waitMs > cfg.budget.maxWaitMinutes * 60_000) {
        throw new Escalation(
          EXIT.RATE_LIMITED,
          `Rate limit hit during "${label}" and the reset is ${minutes} min away, ` +
            `beyond budget.maxWaitMinutes (${cfg.budget.maxWaitMinutes}). Resume when it clears.`,
        );
      }

      state.rateLimitWaits += 1;
      recordEvent(state, 'rate_limited', { label, waitMs, resetsAt: err.resetsAt?.toISOString() ?? null });
      log.warn(`Rate limited during "${label}". ${describeReset(err)} Waiting ${minutes} min.`);
      await sleep(waitMs);
      log.step(`Resuming "${label}" after rate-limit wait`);
    }
  }
}

function plannedWait(err: RateLimitError, cfg: Config): number {
  if (err.resetsAt) {
    // A minute of slack: resuming exactly on the boundary tends to fail again.
    const ms = err.resetsAt.getTime() - Date.now() + 60_000;
    return ms > 0 ? ms : 60_000;
  }
  // No reset advertised: back off a fixed step rather than hammering.
  return Math.min(15 * 60_000, cfg.budget.maxWaitMinutes * 60_000);
}

function describeReset(err: RateLimitError): string {
  return err.resetsAt ? `Resets at ${err.resetsAt.toLocaleString()}.` : 'No reset time reported.';
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function runPlan(state: RunState, cfg: Config, cwd: string): Promise<Plan> {
  log.step('Claude is planning (read-only)');
  const { text } = await runTurn(state, cfg, {
    role: 'planner',
    prompt: P.planPrompt(state.task, state.extraContext, state.environment),
    cwd,
    tools: PLAN_TOOLS,
    jsonSchema: PLAN_SCHEMA,
    timeoutMs: cfg.claude.planTimeoutMs,
    label: 'plan',
  });

  const plan = parsePlan(parseStructured(text));
  state.plan = plan;
  saveState(state);
  artifact(state, `plan-${state.planRound}.json`, plan);
  log.ok(
    `Plan drafted - ${plan.assumptions.length} assumption(s), ${plan.open_questions.length} open question(s)`,
  );
  return plan;
}

interface ReviseArgs {
  findings?: readonly Finding[] | undefined;
  answers?: readonly Answer[] | undefined;
}

async function revisePlan(state: RunState, cfg: Config, cwd: string, args: ReviseArgs): Promise<Plan> {
  state.planRound += 1;
  saveState(state);
  log.step(`Claude is revising the plan (round ${state.planRound})`);

  const { text } = await runTurn(state, cfg, {
    role: 'planner',
    prompt: P.revisePlanPrompt({
      findings: args.findings,
      answers: args.answers,
      round: state.planRound,
    }),
    cwd,
    tools: PLAN_TOOLS,
    jsonSchema: PLAN_SCHEMA,
    timeoutMs: cfg.claude.planTimeoutMs,
    label: `revise-${state.planRound}`,
  });

  const plan = parsePlan(parseStructured(text));
  state.plan = plan;
  saveState(state);
  artifact(state, `plan-${state.planRound}.json`, plan);
  return plan;
}

/**
 * Every Codex call goes through here so the run keeps a single Codex thread.
 * Continuity matters for the oscillation guard: a stateless reviewer re-derives
 * a still-unresolved issue under a fresh id each round, which reads as progress
 * when it is actually the same objection.
 */
async function codexDispatch(
  state: RunState,
  cfg: Config,
  req: TurnRequest,
  spec: { access: Access; schema: object },
  turn: CodexTurnFn,
): Promise<TurnOutcome> {
  // Through the same retry the Claude turns use, so a Codex rate limit gets the
  // wait, the maxWaitMinutes cap and the resumable exit that already exist
  // rather than a second implementation of all three.
  const { structured, raw, sessionId, tokens } = await withRateLimitRetry(state, cfg, req.label, async () => {
    await checkCodexLimits(state, cfg, req.cwd, req.label);
    return turn({
      prompt: req.prompt,
      schema: spec.schema,
      schemaName: req.label,
      artifactDir: artifactDir(state, 'codex'),
      model: cfg.codex.model,
      effort: cfg.codex.effort,
      sandbox: codexSandbox(spec.access, cfg),
      cwd: req.cwd,
      timeoutMs: req.timeoutMs,
      sessionId: cfg.codex.persistSession ? state.codexSessionId : null,
      progress: progressOptions(state, cfg, req.label),
    });
  });

  if (cfg.codex.persistSession && sessionId && sessionId !== state.codexSessionId) {
    const isFirst = state.codexSessionId === null;
    state.codexSessionId = sessionId;
    saveState(state);
    if (isFirst) log.detail(`codex thread ${sessionId}`);
  }

  // Counted, but deliberately not costed: there is no USD figure to add, and
  // inventing one would make `costUsd` a number nobody could trace to a source.
  applyCharge(state, cfg, {
    costUsd: null,
    tokens: tokens.total,
    event: { type: 'codex_turn', data: { label: req.label, tokens: tokens.total } },
    describe: () =>
      `${req.label}: ${fmtTokens(tokens.total)} tok, cost not reported ` +
      `(run ${fmtTokens(state.tokensUsed)} tok / ~$${state.costUsd.toFixed(2)} Claude-side)`,
    warnings: [],
  });

  return { text: raw, structured };
}

/**
 * Read Codex's rate-limit window before spending a turn against it.
 *
 * The Codex side previously had no equivalent of the Claude rate-limit brake at
 * all: on a subscription the window, not cost, is what ends a long unattended
 * run, and a turn started against an exhausted window dies partway through
 * having spent the tokens anyway. Every failure to read is a no-op - the signal
 * is optional and `readCodexRateLimits` never throws.
 */
async function checkCodexLimits(
  state: RunState,
  cfg: Config,
  cwd: string,
  label: string,
): Promise<void> {
  const limits = await readCodexRateLimits(cfg, cwd);
  if (limits === null) return;

  const decision = decideCodexLimit(limits, cfg.budget.codexLimitPercent);
  // recordLimits does the fallback rather than this call site: `wait` carries no
  // window when the server named a reached type this version does not know, and
  // `proceed` carries none at all.
  const chosen = decision.action === 'proceed' ? null : decision.window;
  state.codexRateLimit = recordLimits(limits, chosen);
  recordEvent(state, 'codex_rate_limit', {
    label,
    action: decision.action,
    usedPercent: limits.usedPercent,
    reachedType: limits.reachedType,
  });
  log.detail(describeLimits(limits));

  if (decision.action === 'wait') {
    // The cached reading must not survive the wait. budget.maxWaitMinutes may
    // legally be under a minute, and plannedWait's no-reset branch honours it,
    // so a retry inside the snapshot TTL would keep re-reading the same
    // "reached" answer and never see the window clear.
    invalidateCodexRateLimits();
    throw new RateLimitError(decision.reason, decision.resetsAt);
  }
  if (decision.action === 'stop') {
    saveState(state);
    throw new Escalation(EXIT.RATE_LIMITED, decision.reason);
  }
}

function codexHasMemory(state: RunState, cfg: Config): boolean {
  return cfg.codex.persistSession && state.codexSessionId !== null;
}

async function runCritique(
  state: RunState,
  cfg: Config,
  cwd: string,
  plan: Plan,
): Promise<FindingsReport> {
  log.step('Codex is critiquing the plan');
  const { structured } = await runTurn(state, cfg, {
    role: 'critic',
    prompt: P.critiquePrompt(
      plan.plan_md,
      plan.assumptions,
      state.planRound + 1,
      codexHasMemory(state, cfg),
      state.environment,
    ),
    cwd,
    timeoutMs: cfg.codex.timeoutMs,
    label: `critique-${state.planRound}`,
  });
  return parseFindings(structured);
}

async function runReview(
  state: RunState,
  cfg: Config,
  cwd: string,
  plan: Plan,
): Promise<FindingsReport> {
  log.step('Codex is reviewing the implementation');
  const diff = await git.diffSince(cwd, state.baseSha);
  const files = await git.changedFiles(cwd, state.baseSha);

  const { structured } = await runTurn(state, cfg, {
    role: 'reviewer',
    prompt: P.reviewPrompt(
      diff,
      files,
      plan.plan_md,
      state.reviewRound + 1,
      codexHasMemory(state, cfg),
      state.environment,
    ),
    cwd,
    timeoutMs: cfg.codex.timeoutMs,
    label: `review-${state.reviewRound}`,
  });
  return parseFindings(structured);
}

/**
 * Codex answers every open question, blocking or not - a considered answer beats
 * the planner's own fallback even where the fallback was survivable.
 *
 * What Codex declines to answer is handled by whether the question actually
 * blocks. These are deliberately separate rules: *who answers* is one decision,
 * *what stops the run* is another. A declined *blocking* question escalates,
 * because building on a guess about product intent is expensive to undo. A
 * declined *non-blocking* question does not - the planner already said its
 * fallback was survivable, and halting on it would trade an unattended run for
 * a question the planner was willing to answer itself. Those are recorded and
 * surfaced at the end instead.
 */
async function resolveQuestions(
  state: RunState,
  cfg: Config,
  cwd: string,
  questions: readonly OpenQuestion[],
  plan: Plan,
): Promise<Answer[]> {
  const blockingCount = questions.filter((q) => q.blocking).length;
  log.heading(
    `${questions.length} open question(s) - ${blockingCount} blocking, ${questions.length - blockingCount} advisory`,
  );
  for (const q of questions) log.info(`- [${q.kind}${q.blocking ? ', blocking' : ''}] ${q.question}`);

  if (!cfg.questions.askCodex) {
    const blockers = questions.filter((q) => q.blocking);
    if (blockers.length === 0) return [];
    throw new Escalation(EXIT.NEEDS_HUMAN, 'Blocking questions need answers.', [...blockers]);
  }

  log.step('Codex is answering');
  const { structured } = await runTurn(state, cfg, {
    role: 'answerer',
    prompt: P.answerPrompt(questions, plan.plan_md),
    cwd,
    timeoutMs: cfg.codex.timeoutMs,
    label: `answers-${state.planRound}`,
  });

  const { answers } = parseAnswers(structured);
  artifact(state, `answers-${state.planRound}.json`, answers);

  // Every question asked is marked answered regardless of outcome, so a
  // rephrased repeat in the next revision cannot re-enter this branch.
  for (const q of questions) markAnswered(state, q.question);
  for (const a of answers) markAnswered(state, a.question);

  const declined = (a: Answer): boolean =>
    (cfg.questions.escalateOnDefer && a.defer_to_human) ||
    (cfg.questions.escalateOnLowConfidence && a.confidence === 'low');

  const usable = answers.filter((a) => !declined(a));
  const refused = answers.filter(declined);

  const matches = (q: OpenQuestion, a: Answer): boolean => a.question.trim() === q.question.trim();
  const refusedBlocking = questions.filter((q) => q.blocking && refused.some((a) => matches(q, a)));
  const refusedAdvisory = questions.filter((q) => !q.blocking && refused.some((a) => matches(q, a)));

  for (const q of refusedAdvisory) {
    const reason = refused.find((a) => matches(q, a))?.rationale ?? 'Codex declined to answer.';
    state.deferredQuestions.push({
      question: q.question,
      kind: q.kind,
      recommended: q.recommended,
      reason,
    });
    log.warn(`Advisory question left on the planner's default: ${q.question}`);
    log.info(`  proceeding with: ${q.recommended}`);
  }
  if (refusedAdvisory.length > 0) saveState(state);

  if (refusedBlocking.length > 0) {
    throw new Escalation(
      EXIT.NEEDS_HUMAN,
      `${refusedBlocking.length} blocking question(s) need you - Codex declined to guess at product intent.`,
      refusedBlocking,
    );
  }

  log.ok(`Codex answered ${usable.length} of ${questions.length} question(s)`);
  return usable;
}

const normalize = (s: string): string => s.toLowerCase().replace(/\W+/g, ' ').trim();

function markAnswered(state: RunState, question: string): void {
  const key = normalize(question);
  if (key && !state.answeredQuestions.includes(key)) state.answeredQuestions.push(key);
  saveState(state);
}

function isAnswered(state: RunState, question: string): boolean {
  return state.answeredQuestions.includes(normalize(question));
}

/** Human-facing handoff written whenever a run stops for input. */
export function writeEscalation(state: RunState, escalation: Escalation): string {
  const lines: string[] = [
    '# Needs your input\n',
    `**Run:** \`${state.id}\``,
    `**Task:** ${state.task}`,
    '',
    `## Why the run stopped\n\n${escalation.message}\n`,
  ];

  if (escalation.questions && escalation.questions.length > 0) {
    lines.push('## Questions\n');
    lines.push('Answer inline under each question, then resume with:\n');
    lines.push(`\`\`\`\nvibe resume ${state.id}\n\`\`\`\n`);
    escalation.questions.forEach((q, i) => {
      lines.push(`### ${i + 1}. ${q.question}`);
      lines.push(`*Kind:* ${q.kind}`);
      if (q.options.length > 0) lines.push(`*Options:* ${q.options.join(' | ')}`);
      lines.push(`*Claude would default to:* ${q.recommended}`);
      lines.push('\n**Your answer:**\n\n> \n');
    });
  }

  if (escalation.findings && escalation.findings.length > 0) {
    lines.push('## Outstanding P1 findings\n');
    for (const f of escalation.findings) {
      lines.push(`### ${f.title} \`${f.id}\`\n${f.detail}\n\n*Suggested fix:* ${f.suggested_fix}\n`);
    }
  }

  return artifact(state, 'NEEDS-INPUT.md', lines.join('\n'));
}
