import path from 'node:path';
import { applyCharge, chargeFailure, enforceCeilings, Escalation, EXIT, fmtTokens } from '@src/charge.js';
import { claudeTurn, parseStructured, RateLimitError } from '@src/claude.js';
import { codexTurn } from '@src/codex.js';
import type { CodexTurnOptions, CodexTurnResult } from '@src/codex.js';
import * as git from '@src/git.js';
import * as log from '@src/log.js';
import * as P from '@src/prompts.js';
import { PLAN_SCHEMA } from '@src/schemas.js';
import {
  claudePermission,
  codexSandbox,
  roleEnabled,
  ROLES,
  slotForRole,
  turnTimeoutMs,
} from '@src/roles.js';
import type { Access, Role, RoleTable } from '@src/roles.js';
import { ensureSlotId, markSlotStarted, slotHasMemory, slotId, slotResumeId } from '@src/slots.js';
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
  removeArtifact,
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

// The accounting vocabulary lives in @src/charge.js, a leaf: the session
// rotation in @src/context.js has to charge through the same `applyCharge` this
// module's adapters use, and this module already imports context.js - so
// leaving it here would be a cycle. Re-exported so callers and tests keep one
// import site.
export {
  applyCharge,
  attachSpend,
  chargeFailure,
  enforceCeilings,
  Escalation,
  EXIT,
  spendOf,
  takeSpend,
} from '@src/charge.js';
export type { ExitCode, TurnCharge, TurnSpend } from '@src/charge.js';

/** Read-only toolset for planning turns, alongside plan mode itself. */
const PLAN_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'] as const;

export async function orchestrate(state: RunState, cfg: Config, resume: boolean): Promise<RunState> {
  try {
    // Before any phase runs. On a fresh run `state.plan` is null and this does
    // nothing; on a resume it is the one point holding both the stored plan and
    // the artifact the previous process may have died between writing.
    reconcileFollowUps(state);
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
    // The record of the turn is written by the callback, not after the wrapper
    // returns: a concurrent rotation can now raise a budget escalation, and
    // `withConcurrentCompaction` surfaces it once `work` has resolved. Anything
    // left outside the callback would be skipped for a critique the run has
    // already paid for.
    const critique = await withConcurrentCompaction(
      state,
      cfg,
      async () => {
        const found = await runCritique(state, cfg, cwd, plan);
        artifact(state, `plan-critique-${state.planRound}.json`, found);
        collectDeferred(state, found.findings);
        writeFollowUps(state, plan);
        return found;
      },
      undefined,
      'critic',
    );

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

  const planFile = artifact(state, 'PLAN.md', P.renderPlanDoc(plan));
  log.info(`Plan: ${path.relative(cwd, planFile)}`);
  const followUps = writeFollowUps(state, plan);
  if (followUps !== null) log.info(`Follow-ups: ${path.relative(cwd, followUps)}`);
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
    // Inside the callback, for the reason given at the critique call site: a
    // held budget escalation must not cost the run the record of the review it
    // paid for.
    const review = await withConcurrentCompaction(
      state,
      cfg,
      async () => {
        const found = await runReview(state, cfg, cwd, plan);
        artifact(state, `code-review-${state.reviewRound}.json`, found);
        collectDeferred(state, found.findings);
        writeFollowUps(state, plan);
        return found;
      },
      undefined,
      'reviewer',
    );

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

/**
 * What may appear in FOLLOW-UPS.md.
 *
 * Written against `unknown` on purpose: `loadRun` casts stored JSON with no
 * validation, so an entry in `state.deferred` is a `Finding` by assertion only.
 * Severity is checked as well as `defer`, even though `parseFindings` already
 * normalises, because the artifact this feeds asserts in prose that everything
 * in it was non-blocking - and an invariant a boundary states should be one the
 * boundary keeps. The string fields are checked because an entry missing one
 * renders `undefined` into a human-facing document.
 */
function isDeferrable(f: unknown): f is Finding {
  if (typeof f !== 'object' || f === null) return false;
  const r = f as Record<string, unknown>;
  return (
    r['defer'] === true &&
    (r['severity'] === 'P2' || r['severity'] === 'P3') &&
    typeof r['id'] === 'string' &&
    r['id'].length > 0 &&
    typeof r['title'] === 'string' &&
    typeof r['detail'] === 'string' &&
    typeof r['suggested_fix'] === 'string'
  );
}

/**
 * The stored list, or null when the field is genuinely absent. Never throws.
 *
 * The `unknown` hop is the point: the declared `Finding[]` is an assertion over
 * stored JSON, and a present non-array - `null`, a string, an object - would
 * make `.filter` throw inside the code resume calls before it can reconcile
 * anything. Such a value is dirty rather than absent, so it reads as an empty
 * list and gets replaced.
 */
function storedDeferred(state: RunState): readonly unknown[] | null {
  const raw: unknown = state.deferred;
  if (raw === undefined) return null;
  return Array.isArray(raw) ? (raw as readonly unknown[]) : [];
}

/**
 * Merge this round's deferred findings into the run's list, newest id wins,
 * sanitising what it inherits on the way through.
 *
 * The inherited list gets the same predicate as the fresh one: this helper is
 * exported and callable directly, and stored state has never been validated, so
 * a blocking or malformed entry that got in once would otherwise survive every
 * later collection and be rendered under a header claiming the opposite.
 *
 * For the same reason a round that defers nothing is no longer a plain early
 * return - it is the only code that would remove a bad entry, and skipping the
 * write is how such an entry outlives the run. The write is skipped only when
 * there is genuinely nothing to add and nothing to fix, which also leaves
 * `deferred` absent on a run that has never deferred anything.
 *
 * An id a later round re-raises as a blocker is deliberately not pruned.
 * Reconciling a human record against the live blocking set would couple it to
 * the review loop, so the artifact time-qualifies its own claims instead.
 */
export function collectDeferred(state: RunState, findings: readonly Finding[]): void {
  const fresh = findings.filter(isDeferrable);
  const stored = storedDeferred(state);
  const inherited = stored === null ? [] : stored.filter(isDeferrable);
  // Clean: a well-formed array from which nothing was dropped, and which
  // already holds the deduped-by-id shape `RunState` documents. Duplicates
  // count as dirty even though every entry is individually valid - the early
  // return skips the `Map` merge that is the only thing enforcing that
  // contract, and `writeFollowUps` filters without deduping, so a stored pair
  // sharing an id would render the same follow-up twice.
  const uniqueIds = new Set(inherited.map((f) => f.id)).size;
  const clean =
    stored !== null &&
    Array.isArray(state.deferred) &&
    inherited.length === stored.length &&
    uniqueIds === inherited.length;

  if (fresh.length === 0 && (stored === null || clean)) return;

  const merged = new Map<string, Finding>();
  for (const f of inherited) merged.set(f.id, f);
  // Later round wins: the same finding restated is usually better stated.
  for (const f of fresh) merged.set(f.id, f);

  // Written even when this leaves the list empty, or replaces a non-array with
  // one: a rejected entry must not outlive the code that rejected it.
  state.deferred = [...merged.values()];
  saveState(state);
}

/**
 * Write FOLLOW-UPS.md, or return null when there is nothing to say - deleting a
 * stale one an earlier round wrote.
 *
 * Called after every plan write and every review round rather than once at the
 * end. Every stall this project has had produced findings that survived only
 * because a human copied them out by hand, and a run can stop at a budget
 * ceiling, a rate limit or a guard long before any tidy finish. Deleting on the
 * way down matters for the same reason: a revision that drops its last
 * out-of-scope item persists a plan the old artifact contradicts, and the next
 * critique that would have rewritten the file may never run.
 */
export function writeFollowUps(state: RunState, plan: Plan): string | null {
  // Guarded, filtered and deduped here too, not only in `collectDeferred`:
  // this is the function whose output makes the non-blocking claim, and it is
  // exported, so it can be reached with stored state no collection has passed
  // over. Deduping last-wins matches the merge order in `collectDeferred`, so
  // reaching this directly renders what collecting first would have.
  const deferred = Array.isArray(state.deferred)
    ? [...new Map(state.deferred.filter(isDeferrable).map((f) => [f.id, f])).values()]
    : [];
  // The one place absent and empty are treated alike: neither has anything to
  // report, so neither gets a section.
  const scope = plan.out_of_scope ?? [];

  if (deferred.length === 0 && scope.length === 0) {
    removeArtifact(state, 'FOLLOW-UPS.md');
    return null;
  }

  const sections: string[] = [];
  if (scope.length > 0) {
    sections.push(
      '## Declared out of scope by the plan\n\n' +
        scope.map((s) => `### ${s.item}\n\n${s.why}\n`).join('\n'),
    );
  }
  if (deferred.length > 0) {
    sections.push(
      '## Deferred by review\n\n' +
        deferred
          .map(
            (f) =>
              `### ${f.title} \`${f.id}\`\n\n*Severity when deferred:* ${f.severity}\n\n` +
              `${f.detail}\n\n*Suggested fix:* ${f.suggested_fix}\n`,
          )
          .join('\n'),
    );
  }

  return artifact(
    state,
    'FOLLOW-UPS.md',
    `# Follow-ups\n\n` +
      `**Run:** \`${state.id}\`\n` +
      `**Task:** ${state.task}\n\n` +
      `Work this run identified and deliberately did not do, as of the latest round.\n\n` +
      `Each finding below was **non-blocking at the moment it was deferred** - P2 or P3, ` +
      `below both the reviewer's APPROVE rule and the loop gate, which stops only on a P0 ` +
      `or on more P1s than \`loop.p1Tolerance\`. A later round may have re-raised the same ` +
      `id at a blocking severity; the severity shown is the one it carried when it was ` +
      `deferred, so check the \`plan-critique-*.json\` and \`code-review-*.json\` artifacts ` +
      `before assuming an item is still just a follow-up. The out-of-scope list is the ` +
      `plan's own stated boundary.\n\n` +
      `Raw material for the next issue, not a defect report.\n\n` +
      sections.join('\n'),
  );
}

/**
 * Reconcile FOLLOW-UPS.md against the stored plan. Returns the artifact path,
 * or null when no plan is stored yet or there is nothing to say.
 *
 * `runPlan` and `revisePlan` persist the plan and then write the artifact, so a
 * kill or a filesystem error between the two leaves an artifact describing a
 * plan that is no longer stored. Nothing rewrote it until the next critique,
 * which may be rate-limited or may never run. `writeFollowUps` already deletes
 * on the way down for exactly this reason; this is the same thought applied to
 * the one place a run starts from stored state.
 *
 * The empty collection is deliberate: stored state is unvalidated and the
 * artifact asserts its own contents were non-blocking, so it is sanitised
 * before being rendered rather than after.
 */
export function reconcileFollowUps(state: RunState): string | null {
  const plan = state.plan;
  if (plan === null || plan === undefined) return null;
  collectDeferred(state, []);
  return writeFollowUps(state, plan);
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

// The role vocabulary lives in @src/roles.js, and the slot lifecycle in
// @src/slots.js - both leaves, for the same reason: preflight needs the Access
// notion to decide what to enforce, and importing this module would pull the
// whole run loop - claude, codex, git, context, ratelimits, verify - into `vibe
// doctor`'s probe path. Re-exported so the seam's callers and tests keep one
// import site; leaf modules import them directly, which is what keeps the
// dependency pointing one way.
export {
  claudePermission,
  codexProbeSandbox,
  codexSandbox,
  describedRole,
  providerAccess,
  providersForRoles,
  roleEnabled,
  ROLES,
  ROTATING_ROLE,
  rotatesConcurrentlyWith,
  rotatingSlot,
  slotForRole,
  turnTimeoutMs,
} from '@src/roles.js';
export type { Access, Role, RoleSpec, RoleTable } from '@src/roles.js';
export {
  SLOTS,
  slotHasMemory,
  slotId,
  slotResumeId,
  slotRotatable,
  slotStarted,
} from '@src/slots.js';
export type { IdOrigin, SlotName, SlotSpec } from '@src/slots.js';

export interface TurnRequest {
  role: Role;
  prompt: string;
  cwd: string;
  /** The retry label, the progress label, and - for Codex - the output name. */
  label: string;
  /**
   * Omitted at every call site in this file: how long a turn gets is a property
   * of the role, and `turnTimeoutMs` reads it off the same table this dispatch
   * does. Still accepted, for a caller that has a reason of its own.
   */
  timeoutMs?: number | undefined;
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

/** A request with the role's own timeout already resolved onto it. */
type DispatchRequest = TurnRequest & { timeoutMs: number };

/** One turn by whichever provider this role belongs to. */
export function runTurn(
  state: RunState,
  cfg: Config,
  req: TurnRequest,
  turns: AgentTurns = REAL_AGENTS,
  /** The same seam as `turns`, for the table rather than the providers. */
  roles: RoleTable = ROLES,
): Promise<TurnOutcome> {
  const spec = roles[req.role];
  const dispatch: DispatchRequest = {
    ...req,
    timeoutMs: req.timeoutMs ?? turnTimeoutMs(req.role, cfg, roles),
  };
  // Returned, not awaited: `runTurn` adds no continuation of its own between a
  // provider finishing and its charge being applied. See `applyCharge`.
  // The table rather than a resolved slot: `claudeDispatch` needs two of them -
  // the conversation its own turn talks through, and the one it may compact
  // first - and resolving the second against the module default while the first
  // came from an injected table is how the two fall out of step.
  return spec.provider === 'claude'
    ? claudeDispatch(state, cfg, dispatch, spec.access, roles, turns.claude)
    : codexDispatch(state, cfg, dispatch, spec, roles, turns.codex);
}

async function claudeDispatch(
  state: RunState,
  cfg: Config,
  req: DispatchRequest,
  access: Access,
  roles: RoleTable,
  turn: ClaudeTurnFn,
): Promise<TurnOutcome> {
  const slot = slotForRole(req.role, roles);

  // A rotation that could not be overlapped with Codex work happens here, at a
  // turn boundary - never mid-turn.
  if (shouldRotate(state, cfg, roles)) await rotateSession(state, cfg, turn, roles);

  const resume = slotHasMemory(state, cfg, slot);
  // Not conditional on there being a briefing: a rotation that could not
  // summarise the outgoing session still starts a fresh one, and the plan of
  // record has to travel with it either way - revisePlanPrompt and the fix
  // prompts all assume the plan is already in the conversation.
  // The full plan document, not `plan_md`: the boundary the plan drew is part
  // of the plan of record, and a session rehydrated without it can revise the
  // plan into a different one without ever being told it had a boundary.
  const prompt = resume
    ? req.prompt
    : P.handoffContext(
        state.handoff,
        state.plan === null ? null : P.renderPlanDoc(state.plan),
        state.handoffStale === true,
      ) + req.prompt;

  const result = await withRateLimitRetry(state, cfg, req.label, 'claude', () =>
    turn({
      prompt,
      sessionId: ensureSlotId(state, slot),
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

  // The slot's marker, not its id: this turn returning is the only evidence
  // that the conversation exists at all.
  markSlotStarted(state, cfg, slot, result.sessionId);
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
  provider: 'claude' | 'codex',
  work: () => Promise<T>,
): Promise<T> {
  for (;;) {
    try {
      return await work();
    } catch (err) {
      // What this attempt spent, whether or not it is retryable, and per attempt
      // rather than per turn: a turn that burns tokens, fails, waits and burns
      // them again used to have nothing consulted between the two. Any ceiling
      // the charge crosses is held rather than thrown - it must not displace
      // `err`, which has to reach cli.ts as the type it already is - and the
      // totals it updated are what the check below reads.
      chargeFailure(state, cfg, err, { label, provider });

      if (!(err instanceof RateLimitError)) throw err;

      // Before the wait, not after it, and this is the one place a failed turn's
      // charge is allowed to end the run: a run already over its ceiling must
      // not sit out a reset and then spend again. Cost is Claude-only here for
      // the reason applyCharge records - `state.costUsd` can rise during a Codex
      // turn from a concurrent rotation.
      enforceCeilings(state, cfg, provider === 'claude');

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
    label: 'plan',
  });

  const plan = parsePlan(parseStructured(text));
  state.plan = plan;
  saveState(state);
  artifact(state, `plan-${state.planRound}.json`, plan);
  // Reconciled here, not only at the round boundaries: this and `revisePlan`
  // are the only places `state.plan` is persisted, and an artifact that
  // disagrees with the stored plan is exactly what a run dying before the next
  // critique would leave behind.
  writeFollowUps(state, plan);
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
      // The plan of record's boundary, restated: a revision returns the whole
      // plan, and a session rotated concurrently with the critique would
      // otherwise re-derive `out_of_scope` from nothing.
      outOfScope: state.plan?.out_of_scope,
      round: state.planRound,
    }),
    cwd,
    tools: PLAN_TOOLS,
    jsonSchema: PLAN_SCHEMA,
    label: `revise-${state.planRound}`,
  });

  const plan = parsePlan(parseStructured(text));
  state.plan = plan;
  saveState(state);
  artifact(state, `plan-${state.planRound}.json`, plan);
  // With the new plan persisted, the follow-ups artifact is reconciled against
  // it immediately - including deleting it when this revision dropped the last
  // out-of-scope item and nothing has been deferred.
  writeFollowUps(state, plan);
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
  req: DispatchRequest,
  spec: { access: Access; schema: object },
  roles: RoleTable,
  turn: CodexTurnFn,
): Promise<TurnOutcome> {
  const slot = slotForRole(req.role, roles);

  // Through the same retry the Claude turns use, so a Codex rate limit gets the
  // wait, the maxWaitMinutes cap and the resumable exit that already exist
  // rather than a second implementation of all three.
  const { structured, raw, sessionId, tokens } = await withRateLimitRetry(
    state,
    cfg,
    req.label,
    'codex',
    async () => {
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
        sessionId: slotResumeId(state, cfg, slot),
        progress: progressOptions(state, cfg, req.label),
      });
    },
  );

  // The marker is set whatever the run does with the id: a turn either succeeded
  // or it did not. `idChanged` is false when this run is not carrying the
  // thread, when the provider named no usable id, and when it named the one
  // already stored - so the write and the line below happen exactly where they
  // always did.
  const { idChanged, first } = markSlotStarted(state, cfg, slot, sessionId ?? null);
  if (idChanged) {
    saveState(state);
    if (first) log.detail(`codex thread ${slotId(state, slot) ?? ''}`);
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

/**
 * Whether the conversation this role talks through already carries the run.
 *
 * The `roles` parameter is defaulted rather than absent so this cannot become a
 * second site that ignores an injected table; the two call sites are top-level
 * loop steps, which are never handed one.
 */
function roleHasMemory(state: RunState, cfg: Config, role: Role, roles: RoleTable = ROLES): boolean {
  return slotHasMemory(state, cfg, slotForRole(role, roles));
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
      plan.out_of_scope,
      state.planRound + 1,
      roleHasMemory(state, cfg, 'critic'),
      state.environment,
    ),
    cwd,
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
      plan.out_of_scope,
      state.reviewRound + 1,
      roleHasMemory(state, cfg, 'reviewer'),
      state.environment,
    ),
    cwd,
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

  // Asked of the role, not of the provider: the key is provider-named for
  // history, but what it gates is whether the answerer takes a turn at all.
  if (!roleEnabled('answerer', cfg)) {
    const blockers = questions.filter((q) => q.blocking);
    if (blockers.length === 0) return [];
    throw new Escalation(EXIT.NEEDS_HUMAN, 'Blocking questions need answers.', [...blockers]);
  }

  log.step('Codex is answering');
  const { structured } = await runTurn(state, cfg, {
    role: 'answerer',
    prompt: P.answerPrompt(questions, plan.plan_md),
    cwd,
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
