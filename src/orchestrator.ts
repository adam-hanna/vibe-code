import path from 'node:path';
import { applyCharge, chargeFailure, enforceCeilings, Escalation, EXIT, fmtTokens } from '@src/charge.js';
import { claudeTurn, parseStructured, RateLimitError } from '@src/claude.js';
import { codexTurn } from '@src/codex.js';
import type { CodexTurnOptions, CodexTurnResult } from '@src/codex.js';
import { groundFindings } from '@src/evidence.js';
import * as git from '@src/git.js';
import * as log from '@src/log.js';
import type { PathStyle } from '@src/pathstyle.js';
import * as P from '@src/prompts.js';
import {
  claudePermission,
  codexSandbox,
  effortFor,
  GENERATIVE_ROLES,
  holderLabel,
  modelFor,
  modelSource,
  roleEnabled,
  rolesFor,
  slotForRole,
  turnTimeoutMs,
} from '@src/roles.js';
import type { Access, Role, RoleSpec, RoleTable } from '@src/roles.js';
import {
  ensureSlotId,
  markSlotStarted,
  recordSlotOccupancy,
  slotHasMemory,
  slotId,
  slotResumeId,
} from '@src/slots.js';
import {
  advancePhase,
  artifact,
  artifactDir,
  artifactText,
  assessConvergence,
  clearPendingFindings,
  hasArtifact,
  listRuns,
  measuredRatio,
  p1Signature,
  persistenceNotice,
  recordEvent,
  recordPendingFindings,
  recordRound,
  removeArtifact,
  resumePhase,
  saveState,
  takePendingFindings,
  verificationCaveat,
} from '@src/run.js';
import { hasFindingShape, isArtifactBasename } from '@src/stored.js';
import {
  blockers as blockingFindings,
  gate,
  parseAnswers,
  parseFindings,
  parsePlan,
  readEvidence,
} from '@src/validate.js';
import {
  markOccupancyWarned,
  occupancyWarning,
  withConcurrentCompaction,
  recordTurnContext,
  rotateSession,
  shouldRotate,
  turnOccupancy,
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
import { describeFailure, resolveGates, runGateCommand } from '@src/verify.js';
import type {
  Answer,
  ClaudeTurnResult,
  Config,
  Finding,
  FindingsReport,
  GateOutcome,
  OpenQuestion,
  RoundRecord,
  Plan,
  RunState,
  RunSummary,
  Severity,
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

/**
 * A write turn is about to start, so this run can no longer vouch for any
 * report (#50).
 *
 * Called before the turn and persisted immediately. Between here and
 * `recordReport` the run has an EARLIER turn's report artifact on disk and a
 * newer one possibly half-written, and there is no ordering of two separate
 * file writes that makes "the pointer names the newest report" true throughout.
 * So the window says "no report", and a resume that lands in it hands the
 * reviewer the explicit notice rather than a previous round's report dressed as
 * current - the same reason `runReview` removes `code-review-<n>.json` before
 * buying the round again.
 *
 * The invariant this buys: `state.lastReport`, when present, names the newest
 * report this run completed. It is never an earlier turn's report while a newer
 * turn is in flight or half-recorded.
 */
function beginReport(state: RunState): void {
  delete state.lastReport;
  saveState(state);
}

/**
 * That turn's report: on disk, and pointed at.
 *
 * One function for all four write sites - implement, verify-fix, review-fix,
 * final-fix - so a fifth cannot set the artifact and forget the pointer.
 */
function recordReport(state: RunState, name: string, text: string): void {
  artifact(state, name, text);
  state.lastReport = name;
  saveState(state);
}

/**
 * The last write turn's report, or null when this run has none it can vouch for.
 *
 * Null for four causes - no pointer at all, a pointer `beginReport` cleared for
 * a turn that never finished recording, a pointer this version will not join
 * onto a path, and a file that is missing, unreadable or blank - and every one
 * of them renders the same notice. What differs is the record: the first two
 * are silence, the other two are run events, because a pointer that does not
 * resolve is a fact about this run rather than about the reviewer's job (#50).
 */
function latestReport(state: RunState): string | null {
  const name = state.lastReport;
  if (name === undefined) return null;
  // The same predicate `validateStoredState` applies on the way in, asked again
  // here because this is the call that turns the value into a path.
  if (!isArtifactBasename(name)) {
    log.warn(`The recorded report name is not one vibe will read: ${name}`);
    recordEvent(state, 'report_unusable', { name });
    return null;
  }
  const text = artifactText(state, name);
  if (text === null || text.trim() === '') {
    log.warn(`The recorded report ${name} could not be read - the reviewer is told so`);
    recordEvent(state, 'report_unreadable', { name });
    return null;
  }
  return text;
}

export async function orchestrate(
  state: RunState,
  cfg: Config,
  resume: boolean,
  /**
   * The same seam `runTurn` has, hoisted to the entry point.
   *
   * The loop steps used to name `REAL_AGENTS` themselves, so nothing above the
   * single-turn dispatch could be driven without spawning a real `claude` and a
   * real `codex` - which meant the re-entry order of the two loops, the thing
   * this run's cost actually turns on, was untestable. Defaulted, so every
   * caller including `RunLoop` in cli.ts is unchanged.
   */
  turns: AgentTurns = REAL_AGENTS,
): Promise<RunState> {
  try {
    // Before any phase runs. On a fresh run `state.plan` is null and this does
    // nothing; on a resume it is the one point holding both the stored plan and
    // the artifact the previous process may have died between writing.
    reconcileFollowUps(state);
    return await runPhases(state, cfg, resume, turns);
  } finally {
    // A `finally`, not a tail call: the phases below return early at the
    // "already finished" check and at the plan-only exit, and a persistent
    // app-server child left running would outlive the run on exactly those
    // paths.
    closeCodexRateLimits();
  }
}

async function runPhases(
  state: RunState,
  cfg: Config,
  resume: boolean,
  turns: AgentTurns,
): Promise<RunState> {
  const cwd = state.targetDir;
  // Resolved once and threaded, so no step below can answer "who does this job"
  // from the module default while holding a config that says otherwise.
  const roles = rolesFor(cfg);

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
    plan = await planPhase(state, cfg, cwd, roles, turns);
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
    // Before the turn, not after it. See `beginReport`: a run killed inside this
    // turn must not leave the reviewer pointed at an earlier round's report.
    beginReport(state);

    log.heading('Implementing');
    const impl = await runTurn(
      state,
      cfg,
      {
        role: 'implementer',
        // Re-filtered rather than trusted, as `writeFollowUps` re-filters:
        // `validateStoredState` checks a stored finding's shape but not its
        // severity or its `defer`, and the section this feeds asserts in prose
        // that everything in it was agreed non-blocking.
        prompt: P.implementPrompt(
          plan.plan_md,
          state.carried ?? [],
          (state.declined ?? []).filter(isDeferrable),
          // The snapshot, never `plan.acceptance_criteria`: a criterion the
          // critic never saw is not an approved criterion.
          state.acceptanceCriteria,
        ),
        cwd,
        label: 'implement',
      },
      turns,
      roles,
    );
    recordReport(state, 'implementation-report.md', impl.text);

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

  await reviewPhase(state, cfg, cwd, plan, roles, turns);

  state.status = 'done';
  advancePhase(state, 'complete');
  return state;
}

/** Plan, resolve questions, and critique until the critic raises no P1s. */
async function planPhase(
  state: RunState,
  cfg: Config,
  cwd: string,
  roles: RoleTable,
  turns: AgentTurns,
): Promise<Plan> {
  let plan: Plan;
  if (state.plan) {
    plan = state.plan;
  } else {
    log.heading('Planning');
    plan = await runPlan(state, cfg, cwd, roles, turns);
  }

  // Answers supplied by a human in NEEDS-INPUT.md, picked up on resume.
  //
  // Deliberately does not clear `pendingFindings`: this revises with `answers`
  // *instead of* the findings, so it has not answered them, and treating a
  // human's reply as consuming them would discard work the run paid for. The
  // loop below consumes them next, which costs a second planner turn on the one
  // path where both are present.
  if (state.pendingAnswers && state.pendingAnswers.length > 0) {
    for (const a of state.pendingAnswers) markAnswered(state, a.question);
    plan = await revisePlan(state, cfg, cwd, { answers: state.pendingAnswers }, roles, turns);
    state.pendingAnswers = null;
    saveState(state);
  }

  // Only the first iteration can be a re-entry, and only a re-entry is worth
  // narrating: on every later round the branch below is just where this loop
  // revises.
  let firstPass = true;

  for (;;) {
    // Findings a previous process paid for and no revision answered. Consumed
    // before anything else in the loop, because everything else in the loop
    // spends: this is the re-entry point a stall leaves behind, and re-entering
    // at the critique instead is what cost 7.5M tokens to learn nothing.
    const carried = takePendingFindings(state, 'plan');
    if (carried !== null) {
      if (firstPass) {
        log.info(
          `Revising against ${carried.length} finding(s) carried across the stop - not re-critiquing.`,
        );
      }
      firstPass = false;
      // `revisePlan` consumes them itself, on the same state write that persists
      // the plan answering them - not here, where a second write would reopen a
      // window between the two. A revision that throws, is rate-limited or dies
      // mid-flight never reaches that write, so the findings stay outstanding.
      plan = await revisePlan(state, cfg, cwd, { findings: carried }, roles, turns);
      continue;
    }
    firstPass = false;

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

      const answers = await resolveQuestions(state, cfg, cwd, pending, plan, roles, turns);
      // The answerer may have declined every one; only revise if something came back.
      plan =
        answers.length > 0 ? await revisePlan(state, cfg, cwd, { answers }, roles, turns) : plan;
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
        const found = await runCritique(state, cfg, cwd, plan, roles, turns);
        artifact(state, `plan-critique-${state.planRound}.json`, found);
        collectDeferred(state, found.findings);
        writeFollowUps(state, plan);
        // In here for the same reason the artifact is: a budget escalation the
        // wrapper is holding must not cost the run the findings it just bought.
        // Cleared again below the moment the gate says there is nothing to
        // consume.
        recordPendingFindings(state, 'plan', found.findings);
        return found;
      },
      turns.claude,
      'critic',
      roles,
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
      // The one round whose findings reach nobody otherwise: a revising round
      // hands its deferrals to the planner through `pendingFindings`, and this
      // one is about to clear them. Recorded, not acted on - `defer` decides
      // what a later prompt is told, never whether a turn happens. Assigned
      // unconditionally so an approving round that declined nothing cannot
      // leave an earlier round's value standing, and written on the same state
      // save that clears the pending findings below.
      state.declined = critique.findings.filter(isDeferrable);
      // The bar, frozen at the instant it was approved. A copy, not a view:
      // replacing `state.plan` is not the only way its criteria can move - the
      // array and each criterion are mutable, and anything later holding the
      // same objects would edit an approved bar in place. Every field of a
      // criterion is a primitive, so a spread per entry is a full clone.
      //
      // `undefined` is preserved rather than collapsed to `[]`: a plan stored
      // before this field existed never stated a bar, and inventing an empty
      // one would put a claim in its mouth. Assigned unconditionally for the
      // reason `declined` is - an approving round must not leave an earlier
      // round's bar standing - and on the same state save.
      state.acceptanceCriteria = plan.acceptance_criteria?.map((c) => ({ ...c }));
      recordEvent(state, 'plan_approved', {
        findings: critique.findings.length,
        carried: decision.tolerated.map((f) => f.id),
        declined: state.declined.map((f) => f.id),
        // Present only when a bar was recorded. `?? []` here would log an
        // explicit empty bar for a legacy plan that never claimed one, which is
        // the absent-as-empty collapse the rest of this field refuses.
        ...(state.acceptanceCriteria === undefined
          ? {}
          : { criteria: state.acceptanceCriteria.map((c) => c.id) }),
      });
      // An approved plan has nothing outstanding: what the gate tolerated
      // travels on `state.carried` into implementation, and leaving these set
      // would have a resume revise a plan the critic just passed.
      clearPendingFindings(state);
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

    // Back to the top rather than revising here: the findings this round bought
    // are already on `state`, and the consume branch up there is the single
    // place that answers them - whether they were bought a second ago or by a
    // process that has since exited. The order of turns is unchanged.
    continue;
  }

  const planFile = artifact(state, 'PLAN.md', P.renderPlanDoc(plan));
  log.info(`Plan: ${path.relative(cwd, planFile)}`);
  const followUps = writeFollowUps(state, plan);
  if (followUps !== null) log.info(`Follow-ups: ${path.relative(cwd, followUps)}`);
  return plan;
}

/** Verify, then review, fixing each until both are clean. */
async function reviewPhase(
  state: RunState,
  cfg: Config,
  cwd: string,
  plan: Plan,
  roles: RoleTable,
  turns: AgentTurns,
): Promise<void> {
  // As in `planPhase`: only the first iteration can be a re-entry.
  let firstPass = true;

  for (;;) {
    // Findings a previous process paid for. Before `runGate`, deliberately:
    // consuming what the run already owns comes before buying anything, and a
    // full verification run is a purchase. The gate runs on the next iteration,
    // so the fix is still verified before anything else happens.
    const carried = takePendingFindings(state, 'review');
    if (carried !== null) {
      if (firstPass) {
        log.info(
          `Fixing ${carried.length} finding(s) carried across the stop - not re-reviewing.`,
        );
      }
      firstPass = false;
      await runFixRound(state, cfg, cwd, carried, roles, turns);
      // No OUTSTANDING.md here, even when these were the final round's
      // findings: the artifact says the fix ran *and verification still
      // passed*, and the gate has not run yet. It is written below, on the
      // other side of it.
      continue;
    }
    firstPass = false;

    // Does it run, before asking whether it reads well. A failing suite is an
    // unambiguous P1, and spending a reviewer turn on code that does not
    // execute buys an opinion about the wrong thing.
    const verified = await runGate(state, cfg, cwd);
    if (verified !== null) {
      // Before `guardProgress`, which can stop the run at its cap: a record this
      // process published before the gate ran must describe the gate's verdict
      // by the time anything can throw past it, or the run stops leaving a file
      // saying verification has not run when it has, and failed (#47).
      settlePendingOutstanding(state);
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
      beginReport(state);

      log.step('Fixing the verification failure');
      const repair = await runTurn(
        state,
        cfg,
        {
          role: 'implementer',
          prompt: P.fixPrompt(
            [verified],
            state.verifyRound,
            // The snapshot, never `plan.acceptance_criteria`: a criterion the
            // critic never saw is not an approved criterion. The fixer's report
            // is read by the reviewer exactly as the implementer's is, so it is
            // held to the same bar (#50).
            state.acceptanceCriteria,
          ),
          cwd,
          label: `verify-fix-${state.verifyRound}`,
        },
        turns,
        roles,
      );
      recordReport(state, `verify-fix-${state.verifyRound}.md`, repair.text);
      await maybeCommit(cfg, cwd, `vibe: fix verification failure (round ${state.verifyRound})`);
      continue;
    }

    // The carried findings have been addressed and the suite still passes.
    // Stop here rather than reviewing again: the point of the tolerance is to
    // end the argument, and a fresh review would reopen it.
    if (state.finalFixDone === true) {
      // The one place the artifact's own claim is true: the fix round is behind
      // us and `runGate` has just returned clean. Everything the final round
      // writes is a separate moment - the flags before its turn, the report
      // after it, the file after that - so a process killed anywhere in there
      // used to leave a run that finishes clean pointing at a file nobody
      // wrote. This rewrites it, and only from here, because from anywhere
      // earlier it would be asserting a fix or a passing suite that had not
      // happened.
      finaliseOutstanding(state, cwd);
      // The claim is only made when the gates support it. A required gate that
      // never ran, an optional one, or a disabled section each get said out loud
      // instead: the run may still finish, but not while asserting a pass
      // nobody observed (#47).
      const caveat = verificationCaveat(state);
      if (caveat === null) log.ok('Carried findings addressed and verification still passes.');
      else log.warn(`Carried findings addressed, but ${caveat}.`);
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
        const found = await runReview(state, cfg, cwd, plan, roles, turns);
        artifact(state, `code-review-${state.reviewRound}.json`, found);
        collectDeferred(state, found.findings);
        writeFollowUps(state, plan);
        // In here for the same reason as the artifact, and as in the plan
        // phase: what the run just paid 15M tokens for must survive a stop
        // between this turn and the fix that answers it.
        recordPendingFindings(state, 'review', found.findings);
        return found;
      },
      turns.claude,
      'reviewer',
      roles,
    );

    const decision = gate(review.findings, cfg.loop.p1Tolerance);
    const stoppers = blockingFindings(review.findings);
    if (decision.pass) {
      if (decision.tolerated.length === 0) {
        log.ok(`Review clean - ${review.findings.length} non-blocking finding(s)`);
        recordEvent(state, 'review_approved', { findings: review.findings.length });
        // Nothing blocking came back, so there is nothing for a resume to fix.
        clearPendingFindings(state);
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
      beginReport(state);

      log.step(
        `Incorporating ${decision.tolerated.length} carried P1(s), then finishing: ` +
          decision.tolerated.map((f) => f.id).join(', '),
      );
      for (const f of decision.tolerated) log.info(`  ~ ${f.title}`);

      const finalFix = await runTurn(
        state,
        cfg,
        {
          role: 'implementer',
          prompt: P.fixPrompt(review.findings, state.reviewRound, state.acceptanceCriteria),
          cwd,
          label: `final-fix-${state.reviewRound}`,
        },
        turns,
        roles,
      );
      recordReport(state, `fix-report-${state.reviewRound}.md`, finalFix.text);
      // The moment the fix stops being worth buying again, and therefore the
      // moment to drop the carry: the turn is done and its report is on disk.
      // Everything after this - the record, three git invocations - can fail
      // without making a second fix round useful, and the record is not lost by
      // going first: `recoverOutstanding` rebuilds it from `state.outstanding`
      // once the gate has passed. Same order as `runFixRound`.
      clearPendingFindings(state);

      // Written `pending`: the gate has not run yet at this point in the loop,
      // so the file cannot say how it went. `finaliseOutstanding` rewrites it
      // from the completion branch once it has.
      const file = artifact(
        state,
        'OUTSTANDING.md',
        renderOutstanding(state, decision.tolerated, 'pending'),
      );
      log.info(`Carried findings and what was done about them: ${path.relative(cwd, file)}`);

      await maybeCommit(cfg, cwd, `vibe: address carried review findings (final round)`);
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

    // Back to the top rather than fixing here, for the reason given in
    // `planPhase`: the findings are on `state`, and the consume branch is the
    // one place that answers them. Same turn, same label, same order.
    continue;
  }
}

/**
 * One fix round: the turn, its report, and the commit.
 *
 * A function rather than the tail of the review loop because the loop now
 * reaches it from two directions - the round that just bought the findings, and
 * a resume that inherited them - and a fix round that drifted between the two
 * would be a fix round the tests cannot pin.
 */
async function runFixRound(
  state: RunState,
  cfg: Config,
  cwd: string,
  findings: readonly Finding[],
  roles: RoleTable,
  turns: AgentTurns,
): Promise<void> {
  state.reviewRound += 1;
  saveState(state);
  beginReport(state);

  log.step(`Fixing ${blockingFindings(findings).length} blocking finding(s)`);
  const fix = await runTurn(
    state,
    cfg,
    {
      role: 'implementer',
      prompt: P.fixPrompt(findings, state.reviewRound, state.acceptanceCriteria),
      cwd,
      label: `fix-${state.reviewRound}`,
    },
    turns,
    roles,
  );
  recordReport(state, `fix-report-${state.reviewRound}.md`, fix.text);
  // Consumed once the turn's report is on disk, and before the commit: a commit
  // that fails must not buy this turn a second time. Everything before this
  // point leaves them outstanding, which is what makes a died-mid-turn resume
  // retry the fix rather than skip it.
  clearPendingFindings(state);
  await maybeCommit(cfg, cwd, `vibe: address review round ${state.reviewRound}`);
}

/**
 * Rewrite OUTSTANDING.md when the run says a final fix round happened and the
 * artifact is not there.
 *
 * The final round writes its state flags, its fix report and this file at three
 * different moments, and a process that dies between them leaves a run that
 * later finishes clean while pointing at a file that does not exist. Recovered
 * from `state.outstanding` rather than from the carried findings so it holds
 * however far that sequence got, and skipped when the file is already there so
 * a good artifact is never rewritten. `validateStoredState` now owns that
 * invariant on the way in; the shape check remains as defence in depth, because
 * this artifact makes claims about what is in it.
 *
 * Call it from ONE place, and only that one: after `runGate` has come back
 * clean, immediately before the completion branch. The document states that the
 * findings were worked on *and that verification still passed*, so calling it
 * on entry to the phase, or straight after a fix round, publishes both claims
 * before either is true - `finalFixDone` is persisted before the final fix turn
 * even starts, and a suite that fails afterwards would leave the file asserting
 * the opposite of what happened.
 */
function recoverOutstanding(state: RunState, cwd: string): void {
  if (state.finalFixDone !== true) return;
  if (hasArtifact(state, 'OUTSTANDING.md')) return;
  const outstanding = Array.isArray(state.outstanding)
    ? state.outstanding.filter(hasFindingShape)
    : [];
  if (outstanding.length === 0) return;

  const file = artifact(state, 'OUTSTANDING.md', renderOutstanding(state, outstanding, 'settled'));
  log.info(`Carried findings and what was done about them: ${path.relative(cwd, file)}`);
}

/**
 * The marker that says "vibe wrote this file, and may bring it up to date".
 *
 * On disk, not in memory, and in EVERY form the document takes rather than only
 * the pre-gate one. A process-local flag answers the question only for the
 * process that wrote the file: kill a run between the final fix and the gate,
 * resume it, and the resumed process knows nothing - `recoverOutstanding` finds
 * a file, skips it, and the run finishes clean while the artifact still says
 * verification has not run.
 *
 * It is ownership rather than pending-ness because the document settles more
 * than once: a gate can fail, be fixed, and pass, and each of those is a
 * different true sentence. A marker consumed by the first rewrite would freeze
 * the file at the failure. What the marker still protects is the rule
 * `recoverOutstanding` has always kept - an OUTSTANDING.md vibe did not write is
 * never touched.
 */
const OUTSTANDING_OWNED = '<!-- vibe:outstanding -->';

/**
 * Rewrite vibe's own OUTSTANDING.md to whatever the gates have just said. True
 * when there was one to correct.
 *
 * Called from BOTH sides of the gate's verdict, not only from completion. A run
 * does not finish over a failing gate, but it can stop over one - at
 * `maxVerifyRounds`, or on a ceiling - and the file published before the gate
 * ran would otherwise sit there saying verification has not run when it has, and
 * failed. `verificationCaveat` names the failing gate in that case.
 */
function settlePendingOutstanding(state: RunState): boolean {
  if (state.finalFixDone !== true) return false;
  const existing = artifactText(state, 'OUTSTANDING.md');
  if (existing === null || !existing.includes(OUTSTANDING_OWNED)) return false;

  const outstanding = Array.isArray(state.outstanding)
    ? state.outstanding.filter(hasFindingShape)
    : [];
  if (outstanding.length === 0) return false;
  artifact(state, 'OUTSTANDING.md', renderOutstanding(state, outstanding, 'settled'));
  return true;
}

/**
 * Settle the pre-gate OUTSTANDING.md at the end of a completing run.
 *
 * Falls back to `recoverOutstanding` when there is no pending file of ours,
 * which is the case a process killed before publishing anything leaves.
 */
function finaliseOutstanding(state: RunState, cwd: string): void {
  if (state.finalFixDone !== true) return;
  if (!settlePendingOutstanding(state)) recoverOutstanding(state, cwd);
}

/**
 * The findings the last fix round addressed without a reviewer confirming it.
 *
 * `stage` is which of the two moments this is being written at, because the
 * document's claim about verification is only true at one of them (#47). The
 * tolerance sentences are identical either way: what changes is the clause about
 * the gate, which used to assert a pass from a call site that ran *before* the
 * gate did - and stayed wrong afterwards when a gate turned out to be
 * unavailable or disabled.
 */
function renderOutstanding(
  state: RunState,
  findings: readonly Finding[],
  stage: 'pending' | 'settled',
): string {
  const body = findings
    .map(
      (f) =>
        `## ${f.title} \`${f.id}\`\n\n${f.detail}\n\n*Suggested fix:* ${f.suggested_fix}\n`,
    )
    .join('\n');

  const caveat = verificationCaveat(state);
  const verification =
    stage === 'pending'
      ? 'A final fix round addressed them. **Verification has not run yet at the time of ' +
        'writing**; the run only completes if the gates come back clean, and this file is ' +
        'rewritten with the outcome'
      : caveat === null
        ? 'A final fix round addressed them and verification still passed'
        : `A final fix round addressed them, but ${caveat}`;

  return (
    `# Carried findings\n\n` +
    // In every form, not just the pre-gate one: it says vibe wrote this file and
    // may bring it up to date, which stays true after the first rewrite.
    `${OUTSTANDING_OWNED}\n\n` +
    `**Run:** \`${state.id}\`\n` +
    `**Task:** ${state.task}\n\n` +
    `The last review raised ${findings.length} P1 finding(s), within \`loop.p1Tolerance\`. ` +
    `${verification}, but that round was ` +
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
 * Written against `unknown` on purpose. `validateStoredState` now owns this
 * invariant on the way in; the check remains as defence in depth, since the
 * field is also appended to mid-run from parsed model output.
 * Severity is checked as well as `defer`, even though `parseFindings` already
 * normalises, because the artifact this feeds asserts in prose that everything
 * in it was non-blocking - and an invariant a boundary states should be one the
 * boundary keeps. The string fields are checked - by `hasFindingShape`, which
 * the carried findings read through too, so the codebase holds one answer to
 * "is this stored object a finding" - because an entry missing one renders
 * `undefined` into a human-facing document.
 */
function isDeferrable(f: unknown): f is Finding {
  return hasFindingShape(f) && f.defer === true && (f.severity === 'P2' || f.severity === 'P3');
}

/**
 * The stored list, or null when the field is genuinely absent. Never throws.
 *
 * The `unknown` hop is defence in depth, kept now that `validateStoredState`
 * owns the invariant on the way in: a present non-array - `null`, a string, an
 * object - would make `.filter` throw inside the code resume calls before it can
 * reconcile anything. Such a value is dirty rather than absent, so it reads as
 * an empty list and gets replaced.
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
 * The empty collection is deliberate: the artifact asserts its own contents were
 * non-blocking, so it is sanitised before being rendered rather than after.
 * `validateStoredState` now owns the same invariant on the way in; this stays as
 * defence in depth.
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
 * Run the project's verification gates, in order.
 *
 * Returns a P0 finding for the FIRST gate that fails, or null when the code is
 * good to review. The finding is shaped like any other so it flows through the
 * existing fix loop, oscillation detection and round caps rather than needing
 * its own.
 *
 * Three rules that are easy to get backwards (#47):
 *
 * - A failure STOPS the sequence. Later gates are not run: the fixer is given
 *   one problem, and running a suite against code that does not typecheck buys
 *   an opinion about the wrong thing.
 * - An unavailable gate does NOT stop it. A `typecheck` gate nobody configured
 *   must not prevent `test` from running.
 * - `state.gateOutcomes` is RESET each call, so it always describes the most
 *   recent pass rather than accumulating history across fix rounds. Gates behind
 *   a failure get no entry at all: the vocabulary is what was observed.
 */
async function runGate(state: RunState, cfg: Config, cwd: string): Promise<Finding | null> {
  const gates = resolveGates(cfg.verify, cwd);
  const outcomes: GateOutcome[] = [];
  state.gateOutcomes = outcomes;

  if (!cfg.verify.enabled) {
    // Recorded rather than silent. "Verification is off" and "no gate ever ran"
    // are different facts, and before this the disabled path wrote nothing at
    // all - so a reader could not tell them apart.
    for (const gate of gates) {
      outcomes.push({
        name: gate.name,
        status: 'disabled',
        command: gate.command,
        runs: 0,
        required: gate.required,
      });
    }
    recordEvent(state, 'verify_disabled', { gates: gates.map((g) => g.name) });
    saveState(state);
    return null;
  }

  for (const gate of gates) {
    log.step(`Verifying: ${gate.name}`);
    const result = await runGateCommand(cwd, gate, cfg.toolchain);

    if (result.unavailable !== null) {
      // Say so rather than letting silence read as a pass - and carry on to the
      // next gate, which may well have a command.
      log.warn(`Gate ${gate.name} unavailable: ${result.unavailable}`);
      // Pushed before the event, which persists: the outcome and the event that
      // explains it then land in one write rather than two.
      outcomes.push({
        name: gate.name,
        status: 'unavailable',
        command: null,
        runs: 0,
        required: gate.required,
      });
      recordEvent(state, 'verify_unavailable', {
        gate: gate.name,
        reason: result.unavailable,
        required: gate.required,
      });
      continue;
    }

    // A command that never started cannot be fixed by editing source. Stopping
    // here costs one message; the alternative was observed burning two fix
    // rounds asking an agent to repair a mistyped command path.
    if (result.unlaunchable !== null) {
      artifact(state, `verify-unlaunchable-${state.reviewRound}.txt`, result.output);
      saveState(state);
      throw new Escalation(
        EXIT.PREFLIGHT,
        `The ${gate.name} gate's command could not run: ${result.unlaunchable}.\n` +
          `Command: ${result.command}\n` +
          'This is a configuration problem, not a defect in the code. Fix ' +
          `${cfg.verify.gates === null ? '--verify-command (or verify.command)' : `the ${gate.name} gate's command in verify.gates`}` +
          ', then resume.',
      );
    }

    if (result.ok) {
      log.ok(`Gate ${gate.name} passed: ${result.command} (${result.runs}x)`);
      outcomes.push({
        name: gate.name,
        status: 'passed',
        command: result.command,
        runs: result.runs,
        required: gate.required,
      });
      recordEvent(state, 'verify_passed', {
        gate: gate.name,
        command: result.command,
        runs: result.runs,
      });
      continue;
    }

    log.warn(
      `Gate ${gate.name} failed: ${result.command} (attempt ${result.failedRun} of ${result.runs})`,
    );
    outcomes.push({
      name: gate.name,
      status: 'failed',
      command: result.command,
      runs: result.runs,
      required: gate.required,
    });
    recordEvent(state, 'verify_failed', {
      gate: gate.name,
      command: result.command,
      failedRun: result.failedRun,
      exitCode: result.exitCode,
    });
    artifact(state, `verify-failure-${state.reviewRound}.txt`, result.output);

    return {
      // A stable id, and one PER GATE: an identical failure across rounds is what
      // oscillation detection needs to see to conclude the fixer is not making
      // progress, and a typecheck failure alternating with a test failure is
      // progress it could not see while both were filed as one id. A legacy
      // config synthesizes the gate named `verification`, so this is still
      // `verification-failing` for it - unchanged, with no special case.
      id: `${result.name}-failing`,
      // P0, so `loop.p1Tolerance` can never carry it. Every other finding is an
      // opinion about the code; this one is the code not working, and a run that
      // shipped past it would be reporting success over a failing suite.
      severity: 'P0',
      title: `${result.name}: ${result.command} does not pass`,
      // Constructed in code, not parsed from a model, so it never passes
      // through the grounding seam and can never be downgraded. Cited anyway,
      // and at the file written one line above: the artifact is uniform, and
      // the fixer is pointed at the output it has to read (#48).
      evidence: [{ kind: 'artifact', path: `verify-failure-${state.reviewRound}.txt` }],
      detail: describeFailure(result),
      suggested_fix:
        `Make the ${result.name} gate's command pass. If it fails only sometimes, the defect ` +
        'is a race - fix the underlying synchronisation rather than retrying or loosening ' +
        'the test.',
    };
  }

  saveState(state);
  return null;
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
  DEFAULT_ROLE_PROVIDERS,
  describedRole,
  effortFor,
  enabledRolesFor,
  GENERATIVE_ROLES,
  holderLabel,
  modelFor,
  modelSource,
  providerAccess,
  providersForRoles,
  READ_ONLY_TOOLS,
  roleEnabled,
  roleRefusals,
  ROLES,
  rolesFor,
  roleWarnings,
  ROTATING_ROLE,
  rotatesConcurrentlyWith,
  rotatingSlot,
  slotForRole,
  tableFor,
  turnTimeoutMs,
} from '@src/roles.js';
export type {
  Access,
  Role,
  RoleProviders,
  RoleSetting,
  RoleSpec,
  RoleTable,
  RoleValue,
} from '@src/roles.js';
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
  /** Claude: the result text. Codex: the raw last-message file. */
  text: string;
  /** Codex: its parsed structured output. Null for Claude, and for a turn with no schema. */
  structured: unknown;
}

/**
 * The turn's structured result, for a caller that needs one.
 *
 * Codex parses its own output file, so `structured` is already there; Claude's
 * arrives as text under `--json-schema`. Reading it here rather than at the seam
 * keeps the parse where the caller knows what the text was for - and keeps a
 * turn whose text is not JSON a *successful turn* that a caller then rejects,
 * which is exactly what `parsePlan(parseStructured(text))` has always done.
 */
export function readStructured(outcome: TurnOutcome): unknown {
  return outcome.structured ?? parseStructured(outcome.text);
}

/** A request with the role's own timeout already resolved onto it. */
type DispatchRequest = TurnRequest & { timeoutMs: number };

/** One turn by whichever provider this role belongs to. */
export function runTurn(
  state: RunState,
  cfg: Config,
  req: TurnRequest,
  turns: AgentTurns = REAL_AGENTS,
  /**
   * The same seam as `turns`, for the table rather than the providers. Defaulted
   * from the config rather than to `ROLES`: a config is in hand here, and
   * resolving the module constant instead would ignore the run's own assignment.
   */
  roles: RoleTable = rolesFor(cfg),
): Promise<TurnOutcome> {
  const spec = roles[req.role];
  const dispatch: DispatchRequest = {
    ...req,
    timeoutMs: req.timeoutMs ?? turnTimeoutMs(req.role, cfg, roles),
    // The schema and the tool list are the role's, and the request still wins
    // for a caller with a reason of its own. Both ride on the role for the same
    // reason the timeout does: they are facts about the job, and a Claude critic
    // needs the schema its Codex twin was always given.
    jsonSchema: req.jsonSchema ?? spec.schema,
    tools: req.tools ?? spec.tools,
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

/**
 * What a turn is told when its conversation carries nothing.
 *
 * Not conditional on there being a briefing: a rotation that could not summarise
 * the outgoing session still starts a fresh one, and the plan of record has to
 * travel with it either way - `revisePlanPrompt` and the fix prompts all assume
 * the plan is already in the conversation. The full plan document, not
 * `plan_md`: the boundary the plan drew is part of the plan of record, and a
 * session rehydrated without it can revise the plan into a different one without
 * ever being told it had a boundary.
 *
 * Shared by both dispatch paths, and scoped to the generative roles. A Codex
 * implementer must run with `--no-codex-session` (config refuses the pair), so
 * it has no thread memory at all - without this it would be asked to fix code
 * against a plan it cannot see. A judging role is excluded: its prompts restate
 * the plan themselves and take an explicit `hasMemory`, so today's first Codex
 * critique turn is unchanged, as is every Claude turn under the default table -
 * where Claude holds exactly the two generative roles.
 */
function freshConversationPrefix(state: RunState, role: Role, hasMemory: boolean): string {
  if (hasMemory || !GENERATIVE_ROLES.includes(role)) return '';
  return (
    P.handoffContext(state.handoff, planOfRecord(state, role), state.handoffStale === true) +
    rehydratedPriorRuns(state, role)
  );
}

/**
 * The past-run index, reattached once when a *planner* session is rehydrated
 * (#52).
 *
 * `handoffContext` carries the briefing and the plan of record; it has never
 * carried the plan prompt, so a rotation between the plan turn and a revise
 * turn would drop the archive with no sign that it had. An ordinary revise turn
 * reuses the session that already saw it and is not given it again.
 *
 * `state.plan !== null` is the discriminator, and it is exact rather than
 * approximate: the plan turn is the only planner turn that renders the section
 * in its own prompt, and it is dispatched while `state.plan` is still null -
 * `runPlan` assigns it only once the turn has returned. So a memoryless first
 * plan turn carries the section once, from `planPrompt`; every later memoryless
 * planner turn carries it once, from here; and no turn carries it twice.
 *
 * Planner-gated, which bounds *injection* and not *exposure*. Under the default
 * table the implementer shares Claude's single `main` conversation and inherits
 * the planner's history, this section included, until a rotation clears it.
 * That is already true of the whole plan prompt, is documented in README.md,
 * and predates this change; separate Claude sessions per generative role is the
 * only thing that would alter it, and that is a slot-ownership redesign rather
 * than this change.
 *
 * The Codex-seated roles - the critic, the answerer and the reviewer - never
 * see this section at all, under the default table or any other. They are
 * separate `codex exec` processes on their own threads, so there is no history
 * for them to inherit it through, and nothing here or in `prompts.ts` renders
 * it into a prompt they receive. That is deliberate: the critic's job is to
 * attack this plan against the code as it is now, and handing it the same
 * archive invites it to relitigate past runs instead. A plan that leans on a
 * past run cites the run id, and the critic reads the same repository (#52).
 */
function rehydratedPriorRuns(state: RunState, role: Role): string {
  if (role !== 'planner' || state.plan === null) return '';
  return P.priorRunsSection(priorRuns(state));
}

/**
 * The plan of record as a given role must read it.
 *
 * The acceptance bar is the one part that differs by reader, so the *same*
 * rendering cannot serve both generative roles. The planner is still revising
 * the plan and must see the plan's own three-state field - what it wrote, or
 * that it wrote nothing. The implementer is bound by the frozen snapshot, and
 * `implementPrompt` already hands it exactly that: rehydrating from
 * `state.plan` would put a bar the gate never approved - a later write, an
 * in-place edit, or the legacy claim the direct prompt suppresses - directly
 * above the approved one in the same turn, and a rotated implementer would be
 * reading two different definitions of done.
 */
function planOfRecord(state: RunState, role: Role): string | null {
  if (state.plan === null) return null;
  return role === 'implementer'
    ? P.renderPlanDoc(state.plan, { acceptanceCriteria: state.acceptanceCriteria })
    : P.renderPlanDoc(state.plan);
}

/**
 * Say which setting named this turn's model, on the way out of a failure.
 *
 * A user who set `roles.reviewer.model` and is shown `codex.model` edits the
 * wrong line - and since #60 the two keys can hold different strings, so the
 * provider key is no longer a safe thing to name. Nothing here classifies the
 * failure: the note states what the turn ran and where the name came from,
 * which is true of a timeout, a rate limit and an unknown model alike. There is
 * deliberately no retry and no fallback to the provider's model - a model the
 * user named and vibe silently replaced is the failure this key's design is
 * strict to prevent.
 *
 * Added only where the role named a model of its own, so no run that sets
 * nothing has its error text changed.
 *
 * The error object itself is rethrown, never wrapped: `charge.ts` keys a failed
 * turn's spend in a WeakMap on identity, the retry loop tests `instanceof
 * RateLimitError` and cli.ts tests `instanceof Escalation`. cli.ts prints
 * `err.stack ?? err.message`, so the stack's first line - which is the message
 * as it stood at construction - is amended alongside the message, or the note
 * never reaches the reported failure at all.
 *
 * Applied from a `try`/`catch` around the turn's existing `await` rather than
 * from a wrapper function, and that is not a style choice: a wrapper would put
 * one more promise between a provider's result and that turn's accounting, and
 * `turn-seam.test.ts` measures that distance in microtasks because a session
 * rotation running concurrently can land in the gap. A `catch` costs nothing on
 * the path that succeeds.
 */
function noteModelProvenance(err: unknown, role: Role, cfg: Config, roles: RoleTable): unknown {
  // The guard that keeps a run setting nothing byte-identical: no per-role
  // model, no note.
  if (roles[role].model === undefined) return err;
  const note = `[this turn ran ${modelSource(role, roles)} = "${modelFor(role, cfg, roles)}"]`;
  if (!(err instanceof Error) || err.message.includes(note)) return err;
  // Read before the message is changed, and this order is the whole of it: V8
  // builds `stack` lazily on first access, from the message as it stands at
  // that moment. Touching `message` first and `stack` second therefore appends
  // the note to a first line that already had it - which is exactly what a
  // throwaway script against dist/ showed, twice, before this was reordered.
  const stack = typeof err.stack === 'string' ? err.stack : null;
  err.message = `${err.message} ${note}`;
  if (stack !== null) {
    err.stack = stack.includes(note) ? stack : stack.replace(/^[^\n]*/, (first) => `${first} ${note}`);
  }
  return err;
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
  // The role's, falling back to the provider's - which is what every role on a
  // string value still gets, and what every site below used to read directly.
  // One resolution, used for the spawn, the measurement and the rotation
  // decision, so those three cannot disagree about which model this turn is.
  const model = modelFor(req.role, cfg, roles);

  // A rotation that could not be overlapped with Codex work happens here, at a
  // turn boundary - never mid-turn. Asked with *this* turn's model rather than
  // the rotating role's: the question is whether the conversation is too full
  // for the turn about to use it, and the reset that follows has to tag the
  // model the next measurement will be taken under. Where the planner and the
  // implementer name different models this is the boundary that fires once.
  if (shouldRotate(state, cfg, roles, model)) {
    await rotateSession(state, cfg, turn, roles, model);
  }

  const resume = slotHasMemory(state, cfg, slot);
  const prompt = freshConversationPrefix(state, req.role, resume) + req.prompt;

  // The `await` a plain assignment would have done, wrapped so a failure can say
  // which setting named the model it ran. Outside the retry, so a turn that is
  // waited out and retried is annotated once, when it finally gives up.
  let result: ClaudeTurnResult;
  try {
    result = await withRateLimitRetry(state, cfg, req.label, 'claude', () =>
      turn({
        prompt,
        sessionId: ensureSlotId(state, slot),
        resume,
        permissionMode: claudePermission(access),
        model,
        effort: effortFor(req.role, cfg, roles),
        cwd: req.cwd,
        jsonSchema: req.jsonSchema,
        tools: req.tools,
        timeoutMs: req.timeoutMs,
        progress: progressOptions(state, cfg, req.label, model),
      }),
    );
  } catch (err: unknown) {
    throw noteModelProvenance(err, req.role, cfg, roles);
  }

  // The slot's marker, not its id: this turn returning is the only evidence
  // that the conversation exists at all.
  markSlotStarted(state, cfg, slot, result.sessionId);
  // Tagged with the model that produced it: the ratio is a fraction of this
  // model's window and means nothing under another one. Through the shared seam
  // so the rotation turn in context.ts cannot drift out of step with this one.
  recordTurnContext(state, model, result.usage);

  const measured = measuredRatio(state, model);
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

/**
 * What previous runs on this repository decided, for the planner's index (#52).
 *
 * The filesystem read belongs here rather than in `prompts.ts`, which renders
 * and does not read. The current run is excluded because its own directory
 * exists before the planning turn is dispatched - `createRun` mkdirs and saves
 * state first - so without the filter the planner would be shown the run
 * reading the index, and a repo with no prior runs could never occur.
 *
 * `listRuns` already never throws, already lists an unreadable run rather than
 * dropping the listing, and already sorts newest-first. The catch is the last
 * line of the same rule: a run's own record must never be able to stop it
 * planning, so anything unexpected here is absence, not an error.
 */
function priorRuns(state: RunState): readonly RunSummary[] {
  try {
    return listRuns(state.targetDir, { exclude: state.id, limit: P.PRIOR_RUN_LIMIT });
  } catch {
    return [];
  }
}

async function runPlan(
  state: RunState,
  cfg: Config,
  cwd: string,
  roles: RoleTable,
  turns: AgentTurns,
): Promise<Plan> {
  log.step(`${holderLabel('planner', roles)} is planning (read-only)`);
  const outcome = await runTurn(
    state,
    cfg,
    {
      role: 'planner',
      prompt: P.planPrompt(
        state.task,
        state.extraContext,
        state.environment,
        roles,
        priorRuns(state),
      ),
      cwd,
      label: 'plan',
    },
    turns,
    roles,
  );

  const plan = parsePlan(readStructured(outcome));
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

async function revisePlan(
  state: RunState,
  cfg: Config,
  cwd: string,
  args: ReviseArgs,
  roles: RoleTable,
  turns: AgentTurns,
): Promise<Plan> {
  state.planRound += 1;
  saveState(state);
  log.step(`${holderLabel('planner', roles)} is revising the plan (round ${state.planRound})`);

  const outcome = await runTurn(
    state,
    cfg,
    {
      role: 'planner',
      prompt: P.revisePlanPrompt({
        findings: args.findings,
        answers: args.answers,
        // The plan of record's boundary, restated: a revision returns the whole
        // plan, and a session rotated concurrently with the critique would
        // otherwise re-derive `out_of_scope` from nothing.
        outOfScope: state.plan?.out_of_scope,
        // And the bar, for the same reason: a revision returns the whole plan,
        // so a bar it is not shown is a bar it re-derives or drops.
        acceptanceCriteria: state.plan?.acceptance_criteria,
        round: state.planRound,
      }),
      cwd,
      label: `revise-${state.planRound}`,
    },
    turns,
    roles,
  );

  const plan = parsePlan(readStructured(outcome));
  state.plan = plan;
  // Consumed by the same write that persists the plan answering them, which is
  // the earliest instant at which a second revision would be buying work the
  // run already has. Two artifact writes follow, and a failure in either used to
  // leave the findings outstanding beside the revision that answered them.
  //
  // Keyed on `args.findings`, so the answers path is untouched: it revises with
  // `answers` *instead of* the findings, and has therefore consumed nothing.
  // Assigned rather than routed through `clearPendingFindings` precisely so it
  // rides on this `saveState` and not a later one.
  if (args.findings !== undefined) state.pendingFindings = null;
  saveState(state);
  artifact(state, `plan-${state.planRound}.json`, plan);
  // With the new plan persisted, the follow-ups artifact is reconciled against
  // it immediately - including deleting it when this revision dropped the last
  // out-of-scope item and nothing has been deferred.
  writeFollowUps(state, plan);
  return plan;
}

/**
 * Every Codex call goes through here, so each Codex conversation is continued by
 * the turns that belong to it and by no others.
 *
 * Which conversation that is comes from the role's slot and nothing else, which
 * is what lets the critic and the reviewer hold separate threads (#45) without a
 * branch here. Continuity within a conversation matters for the oscillation
 * guard: a stateless reviewer re-derives a still-unresolved issue under a fresh
 * id each round, which reads as progress when it is actually the same objection.
 * Continuity *between* the two would be the defect - a reviewer that remembers
 * approving the plan is not reviewing the code independently of it.
 */
async function codexDispatch(
  state: RunState,
  cfg: Config,
  req: DispatchRequest,
  spec: Pick<RoleSpec, 'access' | 'schema'>,
  roles: RoleTable,
  turn: CodexTurnFn,
): Promise<TurnOutcome> {
  const slot = slotForRole(req.role, roles);
  const prompt = freshConversationPrefix(state, req.role, slotHasMemory(state, cfg, slot)) + req.prompt;

  // Through the same retry the Claude turns use, so a Codex rate limit gets the
  // wait, the maxWaitMinutes cap and the resumable exit that already exist
  // rather than a second implementation of all three.
  // As on the Claude side: the ordinary `await`, in a `try` so the failure can
  // name where this turn's model came from.
  let outcome: CodexTurnResult;
  try {
    outcome = await withRateLimitRetry(state, cfg, req.label, 'codex', async () => {
      await checkCodexLimits(state, cfg, req.cwd, req.label);
      return turn({
        prompt,
        schema: spec.schema,
        schemaName: req.label,
        artifactDir: artifactDir(state, 'codex'),
        // As with effort below: the role's where it named one, this provider's
        // otherwise (#60). The two Codex conversations are already separate
        // threads, so they can now run two different models - which is what
        // `roleWarnings` W5 says out loud when `codex.contextWindow` is set,
        // because one window cannot describe both.
        model: modelFor(req.role, cfg, roles),
        // As on the Claude side: the role's effort where it named one, and this
        // provider's otherwise. Two Codex roles can now differ, which is the
        // whole of #46 - the reviewer's thread and the judge's are already
        // separate conversations, and they no longer have to think alike.
        effort: effortFor(req.role, cfg, roles),
        sandbox: codexSandbox(spec.access, cfg),
        cwd: req.cwd,
        timeoutMs: req.timeoutMs,
        sessionId: slotResumeId(state, cfg, slot),
        // Deliberately unchanged: this resolves a *Claude* window for a Codex
        // turn, which predates #60 and is a separate defect. Handing it this
        // role's model would half-fix it - a Codex model has no entry in either
        // window source - so it is left exactly as wrong as it was.
        progress: progressOptions(state, cfg, req.label),
      });
    });
  } catch (err: unknown) {
    throw noteModelProvenance(err, req.role, cfg, roles);
  }
  const { structured, raw, sessionId, tokens } = outcome;

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

  // The last completed turn's prompt size IS the conversation's occupancy: on a
  // resumed thread `input_tokens` is the whole conversation going in, not the
  // increment (see extractTokens in codex.ts). What is reported comes from this
  // turn and nothing else - a turn that emitted no `turn.completed` usage block
  // measured nothing, so it says nothing rather than repeating an older figure.
  const occupancy = turnOccupancy(tokens.input, cfg, slot);
  // Stored against the thread the provider says this turn ran on, and only when
  // that is the conversation this slot holds. A run with codex.persistSession off
  // never adopts the returned id, so nothing is recorded and the id left behind by
  // an earlier persisted run keeps describing the thread it actually describes.
  recordSlotOccupancy(state, slot, tokens.input, sessionId ?? null);
  const warning = occupancy === null ? null : occupancyWarning(state, occupancy, cfg, slot);
  // Only where a window was configured. A percentage without a denominator vibe
  // can name is a fabricated figure with a convincing face, so a run that sets
  // nothing logs exactly the line it logs today.
  const ctx = occupancy?.ratio == null ? '' : `, ctx ${(occupancy.ratio * 100).toFixed(0)}%`;

  // Counted, but deliberately not costed: there is no USD figure to add, and
  // inventing one would make `costUsd` a number nobody could trace to a source.
  applyCharge(state, cfg, {
    costUsd: null,
    tokens: tokens.total,
    event: {
      type: 'codex_turn',
      data: {
        label: req.label,
        tokens: tokens.total,
        // What THIS turn measured: the numerator always, the ratio only when the
        // window is known. `costUsd` is absent from this event because Codex
        // reports no cost at all; the prompt size it does report is not withheld
        // for want of a denominator.
        ...(occupancy === null ? {} : { contextTokens: occupancy.tokens }),
        ...(occupancy?.ratio == null ? {} : { contextRatio: Number(occupancy.ratio.toFixed(3)) }),
      },
    },
    describe: () =>
      `${req.label}: ${fmtTokens(tokens.total)} tok, cost not reported ` +
      `(run ${fmtTokens(state.tokensUsed)} tok / ~$${state.costUsd.toFixed(2)} Claude-side${ctx})`,
    warnings: warning === null ? [] : [warning],
  });

  // After the emission, never before: `applyCharge` logs the warnings, and a
  // marker set ahead of it would silence the next turn on behalf of a line that
  // never printed. In memory only - a run that dies here warns again, which is
  // the safe direction for a condition nothing can clear.
  if (warning !== null) markOccupancyWarned(state);

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
function roleHasMemory(
  state: RunState,
  cfg: Config,
  role: Role,
  roles: RoleTable = rolesFor(cfg),
): boolean {
  return slotHasMemory(state, cfg, slotForRole(role, roles));
}

/**
 * The path convention the *reporting* agent's shell uses, or null when this run
 * has no probe to say.
 *
 * A citation comes back in the agent's own convention - `/c/repo/src/run.ts`
 * from Claude's Git Bash, `C:\repo\src\run.ts` from Codex's PowerShell - and
 * grounding has to open the file. Read from the role table rather than from the
 * provider name, so a config that seats the reviewer on Claude is asked about
 * Claude.
 */
function pathStyleFor(state: RunState, role: Role, roles: RoleTable): PathStyle | null {
  const provider = roles[role].provider;
  return state.environment?.agents.find((a) => a.provider === provider)?.pathStyle ?? null;
}

/**
 * The grounding seam: one place, both findings-producing turns.
 *
 * Here rather than at the call sites, because everything that reads a severity
 * happens after this - the artifact, `collectDeferred`, `recordPendingFindings`
 * and the gate - and a downgrade that landed later would be a downgrade a
 * resume could not see.
 *
 * `log.warn` as well as the event: this is the run telling the user that a
 * reviewer asserted something it could not point at, which is worth seeing at
 * the time and not only in a file (#48).
 */
function groundAndRecord(
  state: RunState,
  cwd: string,
  role: Role,
  roles: RoleTable,
  found: FindingsReport,
): FindingsReport {
  const { report, downgraded } = groundFindings(
    found,
    cwd,
    state.dir,
    pathStyleFor(state, role, roles),
  );
  for (const f of downgraded) {
    // Set by construction in `groundFindings`; narrowed rather than asserted.
    const d = f.downgraded;
    if (d === undefined) continue;
    log.warn(`Downgraded ${f.id} from ${d.from} to P2 - ${d.reason}`);
    recordEvent(state, 'finding_downgraded', {
      id: f.id,
      from: d.from,
      reason: d.reason,
      // The kinds it *offered*, which is the fact a human reads this for: a
      // blocker that rested only on `external` is visible for what it was.
      // Read through the same tolerant reader as everything else that meets an
      // unvalidated `evidence`, so an unusable entry is absent from the list
      // rather than an exception in the middle of recording the downgrade.
      kinds: [...new Set(readEvidence(f.evidence).map((e) => e.kind))],
    });
  }
  return report;
}

async function runCritique(
  state: RunState,
  cfg: Config,
  cwd: string,
  plan: Plan,
  roles: RoleTable,
  turns: AgentTurns,
): Promise<FindingsReport> {
  log.step(`${holderLabel('critic', roles)} is critiquing the plan`);
  const outcome = await runTurn(
    state,
    cfg,
    {
      role: 'critic',
      prompt: P.critiquePrompt(
        plan.plan_md,
        plan.assumptions,
        plan.out_of_scope,
        state.planRound + 1,
        roleHasMemory(state, cfg, 'critic', roles),
        state.environment,
        roles,
        // The plan's own bar, not a snapshot: this runs before the gate, and
        // the critic is what decides whether the bar is any good.
        plan.acceptance_criteria,
      ),
      cwd,
      label: `critique-${state.planRound}`,
    },
    turns,
    roles,
  );
  return groundAndRecord(state, cwd, 'critic', roles, parseFindings(readStructured(outcome)));
}

async function runReview(
  state: RunState,
  cfg: Config,
  cwd: string,
  plan: Plan,
  roles: RoleTable,
  turns: AgentTurns,
): Promise<FindingsReport> {
  log.step(`${holderLabel('reviewer', roles)} is reviewing the implementation`);
  const { chunks, files } = await git.diffChunks(cwd, state.baseSha);

  // The round's own report, before the round is bought again. A process that
  // died between the artifact write and `recordPendingFindings` leaves a
  // complete-looking `code-review-<n>.json` for a round the resume is about to
  // review from scratch, and with several turns in a round that window is
  // wider. The file is rewritten by the same code path on success (#49).
  removeArtifact(state, `code-review-${state.reviewRound}.json`);

  // Cleared, not written: a coverage record published before the first turn
  // would claim the reviewer saw every file the instant before that turn failed,
  // which is the shape of overclaim this field exists to prevent.
  state.reviewCoverage = undefined;
  saveState(state);

  // Read once, before the loop, and handed to EVERY part. Each part sees a
  // slice of the diff while the report describes the whole change, so a concern
  // about a file in part 3 is context a reviewer of part 1 may still need - and
  // a report is small next to a 400k-character diff (#49, #50).
  const report = latestReport(state);

  if (chunks.length > 1) {
    log.info(`Diff too large for one turn - reviewing ${files.length} file(s) in ${chunks.length} parts`);
    // How the round was SPLIT, which is true before any turn runs. What was
    // actually seen is `reviewCoverage`, recorded per completed part below.
    recordEvent(state, 'review_chunked', { chunks: chunks.length, files: files.length });
  }

  const reports: FindingsReport[] = [];
  // Accumulated here rather than read back off `state`: the record is what the
  // reviewer has been handed so far, and reading the field it was just cleared
  // to would make that a round trip through a value this function owns.
  const seen: string[] = [];
  const cut: string[] = [];
  for (const [i, chunk] of chunks.entries()) {
    // Read inside the loop: the slot is marked started by the turn that
    // succeeds, so with a persistent thread part 1 is memoryless and parts 2..n
    // continue the conversation without anything new (#45).
    const hasMemory = roleHasMemory(state, cfg, 'reviewer', roles);
    // And separately from it: lifetime memory is not this round's parts. Part 1
    // of a later round resumes a thread that has never seen the other parts of
    // *this* round, and telling it not to repeat findings for them would ask it
    // to stay quiet about a diff it was never shown.
    const carriesEarlierParts = i > 0 && hasMemory;
    const chunked = chunks.length > 1;
    const outcome = await runTurn(
      state,
      cfg,
      {
        role: 'reviewer',
        prompt: P.reviewPrompt(
          chunk.diff,
          chunk.files,
          plan.plan_md,
          plan.out_of_scope,
          state.reviewRound + 1,
          hasMemory,
          state.environment,
          roles,
          // The snapshot, and deliberately not `?? []`: the reviewer's rendering
          // is three-state, so collapsing an absent bar to an empty one would
          // have a legacy run claim done-ness is unobservable.
          state.acceptanceCriteria,
          // Absent for the ordinary round - one chunk, nothing cut - which is
          // what keeps that prompt byte-identical. Present when a file was cut
          // even in a single chunk, because that reviewer is the one that most
          // needs telling to go and read the rest.
          chunked || chunk.truncated.length > 0
            ? {
                index: i + 1,
                total: chunks.length,
                files: chunk.files,
                truncated: chunk.truncated,
                carriesEarlierParts,
              }
            : undefined,
          // Every part, deliberately - see where it is read above. Never
          // `undefined`: that is the "no caller statement" state which renders
          // nothing, and a real round must always say something about the
          // report, even when the thing it says is that there is none (#50).
          report,
        ),
        cwd,
        // Unchanged when there is one chunk: this string is Codex's output name
        // and the retry label, and a round that did not need splitting must look
        // exactly as it always did.
        label: chunked ? `review-${state.reviewRound}-part${i + 1}` : `review-${state.reviewRound}`,
      },
      turns,
      roles,
    );
    reports.push(
      groundAndRecord(state, cwd, 'reviewer', roles, parseFindings(readStructured(outcome))),
    );

    // After the turn, never before it: this says what the reviewer was actually
    // handed. A round that stops here leaves a record of the parts it got.
    seen.push(...chunk.files);
    cut.push(...chunk.truncated);
    state.reviewCoverage = {
      round: state.reviewRound + 1,
      chunks: i + 1,
      files: [...seen],
      truncated: [...cut],
    };
    saveState(state);
    for (const file of chunk.truncated) {
      log.warn(`${file} is larger than one review turn - the reviewer was shown a cut diff`);
      recordEvent(state, 'review_file_truncated', { file });
    }
  }

  const [only] = reports;
  if (reports.length === 1 && only !== undefined) return only;
  return mergeReviewReports(reports);
}

/** Most blocking first, so a later chunk can only ever raise a finding's severity. */
const SEVERITY_RANK = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
} satisfies Record<Severity, number>;

/**
 * Several parts of one round, read as one report.
 *
 * The rule is fail-closed and order-independent: the most blocking severity
 * wins, and a tie keeps the first occurrence - which is chunk order, which is
 * git's file order, so the same change merges the same way on every run.
 *
 * The `defer` invariant is re-applied afterwards because `parseFindings` can
 * only enforce it per chunk: a finding deferred at P2 in one part and raised at
 * P1 in another would otherwise arrive at P1 still carrying `defer: true`, an
 * invariant the boundary states and would then stop keeping.
 *
 * `verdict` is honest bookkeeping and nothing more. Nothing in this loop reads
 * it - the gate counts severities - so do not build anything on it.
 */
function mergeReviewReports(reports: readonly FindingsReport[]): FindingsReport {
  const merged = new Map<string, Finding>();
  for (const report of reports) {
    for (const finding of report.findings) {
      const seen = merged.get(finding.id);
      if (seen === undefined || SEVERITY_RANK[finding.severity] < SEVERITY_RANK[seen.severity]) {
        merged.set(finding.id, finding);
      }
    }
  }

  const findings = [...merged.values()].map((f) =>
    f.severity === 'P0' || f.severity === 'P1' ? { ...f, defer: false } : f,
  );

  const summary = reports
    .map((r, i) => (r.summary === '' ? '' : `Part ${i + 1}/${reports.length}: ${r.summary}`))
    .filter((s) => s !== '')
    .join('\n\n');

  return {
    verdict: reports.some((r) => r.verdict === 'REVISE') ? 'REVISE' : 'APPROVE',
    summary,
    findings,
  };
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
  roles: RoleTable,
  turns: AgentTurns,
): Promise<Answer[]> {
  const answerer = holderLabel('answerer', roles);
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

  log.step(`${answerer} is answering`);
  const outcome = await runTurn(
    state,
    cfg,
    {
      role: 'answerer',
      prompt: P.answerPrompt(questions, plan.plan_md),
      cwd,
      label: `answers-${state.planRound}`,
    },
    turns,
    roles,
  );

  const { answers } = parseAnswers(readStructured(outcome));
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
    const reason = refused.find((a) => matches(q, a))?.rationale ?? `${answerer} declined to answer.`;
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
      `${refusedBlocking.length} blocking question(s) need you - ${answerer} declined to guess at product intent.`,
      refusedBlocking,
    );
  }

  log.ok(`${answerer} answered ${usable.length} of ${questions.length} question(s)`);
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
