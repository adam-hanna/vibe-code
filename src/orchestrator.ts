import os from 'node:os';
import path from 'node:path';
import { applyCharge, chargeFailure, enforceCeilings, Escalation, EXIT, fmtTokens } from '@src/charge.js';
import {
  claudeTurn,
  failureSparedConversation,
  parseStructured,
  RateLimitError,
} from '@src/claude.js';
import { Cancelled, sleepUnlessCancelled, stopReason } from '@src/cancel.js';
import { codexTurn, OutputCutOffError } from '@src/codex.js';
import { cutOffNote } from '@src/cutoff.js';
import type { CodexTurnOptions, CodexTurnResult } from '@src/codex.js';
import { preserveGateArtifacts, sweepGateArtifacts } from '@src/artifacts.js';
import {
  applyReproducerOutcomes,
  applyVotes,
  downgradeInert,
  groundFindings,
  groundVoteEvidence,
  refusePlaceholderPlan,
} from '@src/evidence.js';
import { FIX_SCHEMA, PLAN_VOTE_SCHEMA, REVISE_SCHEMA, VOTE_SCHEMA } from '@src/schemas.js';
import { dispositionSummary, settleDispositions, settlePlanDispositions } from '@src/dispositions.js';
import { countBallot, describeVotes, failedBallot, tally } from '@src/vote.js';
import { describeOutcome, observe } from '@src/reproducer.js';
import { gateMode } from '@src/gates.js';
import { moveSection, raisePhase, raiseSection } from '@src/raise.js';
import * as git from '@src/git.js';
import { readDecision, readOrigin } from '@src/host.js';
import type { GateContext, Host } from '@src/host.js';
import * as log from '@src/log.js';
import type { PathStyle } from '@src/pathstyle.js';
import type { CheckpointBoundary } from '@src/types.js';
import * as P from '@src/prompts.js';
import {
  claudePermission,
  codexSandbox,
  effortFor,
  GENERATIVE_ROLES,
  holderLabel,
  mcpServersFor,
  modelFor,
  modelSource,
  roleEnabled,
  readFinders,
  readVerifiers,
  rolesFor,
  seatTable,
  slotForRole,
  turnTimeoutMs,
} from '@src/roles.js';
import type { Access, FinderEntry, Role, RoleSpec, RoleTable, VerifierEntry } from '@src/roles.js';
import { mergeAcrossFinders } from '@src/finder-merge.js';
import { runSeatGroup } from '@src/seat-group.js';
import type { FinderMerge, FinderReport } from '@src/finder-merge.js';
import { claudeMcpDefinitions, resolveClaudeGrants } from '@src/mcp.js';
import {
  clearSlotFork,
  ensureSlotId,
  markSlotStarted,
  noteSlotForkAttempt,
  noteSlotRegistered,
  perTurnSlot,
  recordSlotOccupancy,
  recoverDeadSlot,
  slotContinuity,
  slotForkParent,
  slotHasDeadTurn,
  slotHasMemory,
  slotId,
  slotResumeId,
} from '@src/slots.js';
import type { SlotName } from '@src/slots.js';
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
  pendingStepBack,
  persistenceNotice,
  planStall,
  readArtifact,
  recordAndSay,
  recordEvent,
  recordPendingFindings,
  recordRound,
  recycledLabelNotice,
  removeArtifact,
  stageEvent,
  resumePhase,
  saveState,
  stallAction,
  takePendingFindings,
  tryRecordEvent,
  verificationCaveat,
  writeCheckpoint,
} from '@src/run.js';
import {
  findRephrase,
  isSameQuestion,
  normalize,
  pairAnswers,
  reconcileQuestionRecords,
  recordSuppressed,
} from '@src/questions.js';
import {
  hasFindingShape,
  isDeferrable,
  isPlanToAddress,
  isReportBasename,
  isToAddress,
  isUnaddressed,
  movedByVote,
} from '@src/stored.js';
import {
  authorOf,
  blockers as blockingFindings,
  gate,
  parseAnswers,
  parseFindings,
  parseFixOutput,
  parsePlanDispositions,
  parseTestVerdicts,
  parsePlan,
  parseVote,
  readEvidence,
  reproducerOutcomesOf,
  reproductionAt,
  SEVERITY_RANK,
  severityChangesOf,
} from '@src/validate.js';
import type { FixOutput, SaidDisposition } from '@src/validate.js';
import {
  attachVerdicts,
  combineVerdicts,
  disagreements,
  judgeChanges,
  judgePatterns,
  recordedPatterns,
  testChangeCounts,
} from '@src/judge.js';
import type { RawVerdict, SeatJudgement } from '@src/judge.js';
import {
  markOccupancyWarned,
  occupancyWarning,
  withConcurrentCompaction,
  recordTurnContext,
  rotateSession,
  seedContextWindows,
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
import {
  describeFailure,
  excerpt,
  failedRuns,
  resolveGates,
  runGateCommand,
  suggestedFix,
  verdictOf,
} from '@src/verify.js';
import type { VerifyResult } from '@src/verify.js';
import type {
  Answer,
  Ballot,
  CheckpointCommitNote,
  ClaudeTurnResult,
  Config,
  Finding,
  FindingsReport,
  FileChange,
  FixDispositions,
  TestChanges,
  UnaddressedFinding,
  GateOutcome,
  OpenQuestion,
  ReproducerOutcome,
  RoundRecord,
  Plan,
  PlanStallEntry,
  RunStart,
  RunState,
  RunSummary,
  TurnActivity,
  UnconfirmedP0,
  Votes,
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

// Aliased on import, because `describeEnding` also names the *process*-ending
// renderer in @src/ending.js and the two answer different questions - "the
// child was killed by SIGKILL" against "this vibe process was sent SIGTERM".
// One name for both in the file that records the first would be the confusion
// the pair exists to remove (#131).
import { describeEnding as describeChildEnding, endingOf, isAbnormal } from '@src/proc.js';
import { reviewStandardsFor } from '@src/review-md.js';
import { workDirOf } from '@src/worktree.js';
import { formatWork, withWorkProgress, workData } from '@src/work.js';

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
 * A write turn, with the tree measured underneath it (#136).
 *
 * One function for the same four sites `recordReport` covers, and for a weaker
 * version of the same reason: a fifth that forgot this would run correctly and
 * only report less, where a fifth that forgot `recordReport` would point the
 * reviewer at the wrong round.
 *
 * `runTurn` is called through unchanged when progress is off, so a run with the
 * heartbeat disabled spawns no `git` and behaves exactly as it did. When it is
 * on, the sampler narrates readings during the turn and hands over the last one
 * for the single durable record - see `withWorkProgress` for why those are
 * different things.
 *
 * The plan comes from `state`, not from a parameter: it is the plan of record,
 * three of these four sites do not have the local variable in scope, and a
 * proxy measured against something other than the approved plan would be a
 * proxy over the wrong denominator.
 */
function writeTurn(
  state: RunState,
  cfg: Config,
  cwd: string,
  req: TurnRequest,
  turns: AgentTurns,
  roles: RoleTable,
): Promise<TurnOutcome> {
  if (!cfg.progress.enabled) return runTurn(state, cfg, req, turns, roles);
  return withWorkProgress(
    {
      cwd,
      baseSha: state.baseSha,
      plan: state.plan,
      label: req.label,
      intervalMs: cfg.progress.workIntervalMs,
      onReading: (work) => {
        const line = formatWork(work);
        // Once per write turn, where the samples during it were narration only.
        // This is the fact worth keeping: what that turn left in the tree.
        //
        // Recorded even when that is *nothing*, and said in those words. A
        // write turn that changed no file is the most interesting reading this
        // ever produces - the run has just paid for a turn that produced no
        // work - and it is the one case a "report only what there is to report"
        // rule would have thrown away.
        recordAndSay(
          state,
          'info',
          'work_measured',
          line === null ? `${req.label}: changed nothing in the tree` : `${req.label}: ${line}`,
          { label: req.label, ...workData(work) },
        );
      },
    },
    () => runTurn(state, cfg, req, turns, roles),
  );
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
 * A review fix turn's output, read once (#393): the report to record, and the
 * dispositions when they could be read.
 *
 * `readStructured` throws for a Claude turn whose text is not JSON, and for a
 * Codex writer turn #407 returned as `structured: null`; `parseFixOutput`
 * throws for JSON that is not `FIX_SCHEMA`'s shape. Every one of those is the
 * same outcome and none of them fails the turn - the fixer's edits are already
 * in the tree - so the text becomes the report exactly as it always did, and
 * the round records no dispositions at all.
 */
type FixRead = { report: string; parsed: FixOutput } | { report: string; parsed: null; error: string };

function readFixOutput(outcome: TurnOutcome): FixRead {
  try {
    const parsed = parseFixOutput(readStructured(outcome));
    return { report: parsed.report, parsed };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { report: outcome.text, parsed: null, error: message.split(/\r?\n/)[0] ?? '' };
  }
}

/**
 * The round's dispositions on disk and in the event log, or the warning that
 * there are none (#393).
 *
 * Called by both review fix sites after the report and *before*
 * `clearPendingFindings`, so a round is never consumed without its record. A
 * process that dies in between resumes the same round under the same label
 * (`fixInFlight`) and records it again. That retry is the round's record of
 * record: the artifact is rewritten, an unreadable retry removes the earlier
 * attempt's artifact, and the scorecard and the window read the last event per
 * round.
 *
 * Unreadable is never `not-addressed`. That would turn "this run could not read
 * the answer" into "the fixer ignored every finding", which is a number nobody
 * observed. It records its own event so the scorecard can count it.
 *
 * Returns what it recorded, or null for an unreadable round, so the final round
 * can say what it left of the non-blocking findings it carried (#425).
 */
function recordDispositions(
  state: RunState,
  read: FixRead,
  findings: readonly Finding[],
  label: string,
): FixDispositions | null {
  const round = state.reviewRound;
  const answers = round - 1;
  if (read.parsed === null) {
    recordAndSay(
      state,
      'warn',
      'fix_dispositions_unreadable',
      `${label}: the fixer's dispositions could not be read, so none are recorded for this round - ` +
        'its report is kept as written',
      { round, label, answers, reason: 'error' in read ? read.error : '' },
    );
    // A retried round whose earlier attempt was readable must not keep that
    // attempt's file beside this attempt's warning.
    removeArtifact(state, `fix-dispositions-${round}.json`);
    return null;
  }
  const settled = settleDispositions(findings, read.parsed.dispositions, {
    round,
    label,
    answers,
    reviewSeat: state.reviewSeat,
  });
  artifact(state, `fix-dispositions-${round}.json`, settled);
  recordAndSay(
    state,
    settled.dropped.length + settled.duplicates.length > 0 ? 'warn' : 'info',
    'fix_dispositions',
    dispositionSummary(settled),
    { ...settled },
  );
  return settled;
}

/**
 * A findings revision's dispositions, read from the same output its plan was
 * (#453): the list when `parsePlanDispositions` accepts it, or why not.
 *
 * Read after `parsePlan` has accepted the plan half, so an unreadable plan has
 * already failed the turn exactly as it always did; this only ever decides
 * whether a plan that stands carries a record.
 */
type PlanDispositionsRead = { parsed: SaidDisposition[] } | { parsed: null; error: string };

function readPlanDispositions(raw: unknown): PlanDispositionsRead {
  try {
    return { parsed: parsePlanDispositions(raw) };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { parsed: null, error: message.split(/\r?\n/)[0] ?? '' };
  }
}

/**
 * A findings revision's dispositions on disk and in the event log, or the
 * warning that there are none (#453). `recordDispositions` for the plan side,
 * and the same rules: unreadable is never `not-addressed`, and an unreadable
 * retry removes the earlier attempt's file.
 *
 * Called by `revisePlan` after the plan parses and before the state write that
 * persists the plan and consumes the findings it answers - record, then
 * consume, as both review fix sites do. A process that dies between the two
 * revises again and records again, and the scorecard reads the last event per
 * label. `round` is the revision's own, already advanced, and `answers` the
 * critique round before it: `revise-<n>` answers `plan-critique-<n-1>.json`.
 */
function recordPlanDispositions(
  state: RunState,
  read: PlanDispositionsRead,
  findings: readonly Finding[],
  label: string,
): void {
  const round = state.planRound;
  const answers = round - 1;
  const name = `plan-dispositions-${round}.json`;
  if (read.parsed === null) {
    recordAndSay(
      state,
      'warn',
      'plan_dispositions_unreadable',
      `${label}: the planner's dispositions could not be read, so none are recorded for this revision - ` +
        'the plan stands as written',
      { round, label, answers, reason: read.error },
    );
    removeArtifact(state, name);
    return;
  }
  const settled = settlePlanDispositions(findings, read.parsed, {
    round,
    label,
    answers,
    criticSeat: state.criticSeat,
  });
  artifact(state, name, settled);
  recordAndSay(
    state,
    settled.dropped.length + settled.duplicates.length > 0 ? 'warn' : 'info',
    'plan_dispositions',
    dispositionSummary(settled, 'planner'),
    { ...settled },
  );
}

/**
 * Which findings the planner rebutted in the revision this critique judged,
 * and which of them the critique raised again under the same id (#453).
 *
 * Read from `plan-dispositions-<round>.json`, the record of the revision that
 * wrote the plan this critique round judged; no file, an unreadable one, or no
 * rebuttal in it records nothing. Same id only: a finding raised again under a
 * new id - which a memoryless finder's `<id>-f<k>` always is - is not seen, so
 * this undercounts disagreement and never invents it. Recorded here rather than
 * on the next revision because a critique that approves has no next revision,
 * and that is exactly the case where the rebuttal stood.
 */
function recordRebuttalsRaisedAgain(state: RunState, findings: readonly Finding[]): void {
  if (state.planRound < 1) return;
  const text = artifactText(state, `plan-dispositions-${state.planRound}.json`);
  if (text === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) return;
  const list: unknown = (parsed as Record<string, unknown>)['dispositions'];
  if (!Array.isArray(list)) return;
  const rebutted: string[] = [];
  for (const d of list as unknown[]) {
    if (typeof d !== 'object' || d === null) continue;
    const { id, disposition } = d as Record<string, unknown>;
    if (typeof id === 'string' && disposition === 'rebutted' && !rebutted.includes(id)) rebutted.push(id);
  }
  if (rebutted.length === 0) return;
  const raised = new Set(findings.map((f) => f.id));
  const disputed = rebutted.filter((id) => raised.has(id));
  const notRaisedAgain = rebutted.filter((id) => !raised.has(id));
  recordAndSay(
    state,
    disputed.length > 0 ? 'warn' : 'info',
    'critique_rebuttal_disputed',
    `critique-${state.planRound}: ${String(disputed.length)} of ${String(rebutted.length)} finding(s) ` +
      'rebutted by the planner raised again under the same id' +
      (disputed.length > 0 ? `: ${disputed.join(', ')}` : ' - none raised again'),
    { round: state.planRound, rebutted, disputed, notRaisedAgain },
  );
}

/**
 * The last write turn's report, or null when this run has none it can vouch for.
 *
 * Null for five causes - no pointer at all, a pointer `beginReport` cleared for
 * a turn that never finished recording, a pointer this version will not join
 * onto a path, a file that is a link out of the archive, and a file that is
 * missing, unreadable or blank - and every one of them renders the same notice.
 * What differs is the record: the first two are silence, the other three are run
 * events, because a pointer that does not resolve is a fact about this run
 * rather than about the reviewer's job (#50).
 *
 * **The link is degraded, not fatal** (#129), and that is the choice the issue
 * asks for rather than a detail. `planFork` can refuse outright because nothing
 * has run; this is called mid-run with a prompt half-built, and ending an
 * otherwise healthy run over one artifact would cost more than the artifact is
 * worth. Option 2 of the three, and it has a precedent rather than being
 * invented here: the reviewer is *told* there is no report, and told explicitly
 * that this is not a statement that there were no concerns. What it must not do
 * is share `report_unreadable`, which says a file was opened and could not be
 * used - the one thing that is not true of a file vibe refused to open.
 */
function latestReport(state: RunState): string | null {
  const name = state.lastReport;
  if (name === undefined) return null;
  // The same predicate `validateStoredState` applies on the way in, asked again
  // here because this is the call that turns the value into a path.
  if (!isReportBasename(name)) {
    recordAndSay(
      state,
      'warn',
      'report_unusable',
      `The recorded report name is not one vibe will read: ${name}`,
      { name },
    );
    return null;
  }
  const read = readArtifact(state, name);
  if (read.kind === 'linked') {
    recordAndSay(state, 'warn', 'report_linked', `The recorded report ${read.reason}`, { name });
    return null;
  }
  if (read.kind === 'absent' || read.text.trim() === '') {
    recordAndSay(
      state,
      'warn',
      'report_unreadable',
      `The recorded report ${name} could not be read - the reviewer is told so`,
      { name },
    );
    return null;
  }
  return read.text;
}

/**
 * Hold at a boundary and ask the host what to do next.
 *
 * **Called after the checkpoint, never before.** That ordering is the whole
 * promise: `CheckpointBoundary` names the points at which the work of a round is
 * recorded and the next has not begun, so a gate that fires there can say
 * "nothing is lost" and mean it. A gate before the write could not.
 *
 * With no host this returns immediately and the run behaves exactly as it always
 * has - which is what makes this shippable as groundwork.
 *
 * **The await is the pause.** Nothing here spins, polls or sets a timer: a host
 * that has not answered yet simply has not resolved its promise, the process
 * stays alive, and the agent sessions stay warm. That is the property the app
 * exists to buy, and it costs no machinery at all.
 *
 * Which boundaries hold, and how, is `cfg.gates` since #140 - see `src/gates.ts`
 * for the table and for the two boundaries that have no row.
 */
async function holdAt(
  state: RunState,
  cfg: Config,
  host: Host | undefined,
  boundary: CheckpointBoundary,
  /**
   * What a person would have to answer if they stopped here, or none.
   *
   * **Only `question-round` has any**, and it is the boundary where stopping is
   * most obviously a decision to answer something yourself - so it was the one
   * boundary where stopping produced a `NEEDS-INPUT.md` with no questions in it.
   * `writeEscalation` renders a *Your answer:* block per question and the resume
   * parses them back; with the list empty it wrote the section not at all, and
   * the only thing a person could actually do was press continue.
   *
   * Not invented for this: `resolveQuestions` already throws
   * `new Escalation(EXIT.NEEDS_HUMAN, ..., [...blockers])` when the answerer is
   * off, and the defer path does the same. This carries the same list through
   * the same field on the gate's own stop, so both ways of stopping at a
   * question round hand back the same document.
   */
  questions: readonly OpenQuestion[] = [],
): Promise<void> {
  const mode = gateMode(cfg.gates, boundary);

  // A pause asked for mid-run (#210). Taken before the mode is acted on, and
  // taken *whatever* the mode is, so the request is consumed exactly once - a
  // boundary that read it, ran through on `auto`, and left it armed would hold
  // at some later boundary nobody was looking at.
  //
  // It only changes an `auto` row. A `step` row is already holding and a `stop`
  // row is already ending, so on those this is a request the loop was about to
  // honour anyway.
  const paused = host?.takePause?.() === true;
  if (mode === 'auto' && !paused) return;

  // `stop` asks nobody. That is what makes it mean the same thing in both front
  // ends: the CLI has no host and never will - a promise is not answerable from
  // a prompt - so a mode that consulted one would be a setting that worked in
  // the app and did nothing in a terminal. The run ends here on the exit-
  // resumable path the round caps already use.
  if (mode === 'stop') {
    const why = 'the gate matrix stops the run at this boundary';
    recordAndSay(state, 'warn', 'gate_stopped', `Stopped at ${boundary} - ${why}`, {
      boundary,
      reason: why,
      // Named, and not left absent: nobody shaped this decision at the time, so
      // "who released this" has an answer and it is the configuration. An
      // absent origin here would read as an operator whose identity was lost.
      origin: 'gates',
    });
    throw new Escalation(EXIT.NEEDS_HUMAN, `Stopped at the ${boundary} boundary. ${why}`, [
      ...questions,
    ]);
  }

  // `step` holds and asks, and asking needs somebody who can answer. A terminal
  // cannot, so from the CLI this runs through - the mode's definition rather
  // than a failure of it, and `vibe doctor` prints it per row so it is not
  // something you discover by not seeing it.
  if (host === undefined) return;

  const ctx: GateContext = {
    boundary,
    // Absent rather than guessed. `validateStoredState` turns an unrecognised
    // phase into ABSENCE, and a host told 'planning' about a run whose phase
    // nobody could read would be told something no writer ever wrote.
    phase: state.phase ?? null,
    planRound: state.planRound,
    // Beside the other three since #140, which is what let `question-round`
    // become gateable: a host asked to hold at the second of three question
    // rounds was previously told everything except which round it was, and that
    // is the only number the decision turns on.
    questionRound: state.questionRound,
    reviewRound: state.reviewRound,
    verifyRound: state.verifyRound,
  };

  // Narrated with an id, and deliberately NOT recorded. By the durability rule
  // in `recordAndSay`: a gate that is waiting is not a transition - nothing
  // resumes from "was waiting", and nothing judges the run by it. #133 named
  // `gate_waiting` as exactly this case when it asked for stable ids.
  // `requested` says which of the two reasons this hold has: the matrix, or a
  // person who pressed pause. A window that could not tell them apart would show
  // an armed pause as a gate the user configured and never say the pause was
  // honoured (#210).
  log.step(`Holding at ${boundary} - waiting on you`, {
    id: 'gate_waiting',
    data: { ...ctx, requested: paused },
  });

  // Two readings of one answer, because they are two facts. `readDecision` says
  // what to do and fails closed to `stop`; `readOrigin` says who shaped it and
  // fails to absent. Neither can make the other's mistake.
  const answer = await host.decide(ctx);
  const decision = readDecision(answer);
  const origin = readOrigin(answer);

  if (decision.kind === 'continue') {
    // A released gate is not a transition and leaves no row - the durability
    // rule in `recordAndSay`, and #133 named `gate_released` as exactly this
    // case. It becomes one the moment something other than the operator shaped
    // it (#144): "who released this gate" is a question a later reader has, and
    // an unattributed release cannot answer it while an attributed one can.
    //
    // So the carve-out is precisely the attribution and nothing else. A person
    // pressing continue in the window still records nothing, which is what
    // keeps `state.events` from becoming the transcript #133 forbids.
    if (origin === null) {
      log.ok(`Released at ${boundary}`, { id: 'gate_released', data: { boundary } });
    } else {
      recordAndSay(state, 'ok', 'gate_released', `Released at ${boundary} - ${origin}`, {
        boundary,
        origin,
      });
    }
    return;
  }

  // A stop IS a transition - the run ends here and a later process has to know
  // why - so this one is recorded as well as said.
  const why = decision.reason ?? 'the host stopped the run at this boundary';
  recordAndSay(state, 'warn', 'gate_stopped', `Stopped at ${boundary} - ${why}`, {
    boundary,
    reason: decision.reason,
    origin,
  });
  // The exit-resumable path the round caps already use: `writeEscalation` ->
  // `status: 'needs-input'` -> `vibe resume`. A CLI run has no host to ask, so
  // it never reaches here; an app that stops gets the same durable outcome its
  // user would get from the terminal.
  //
  // The questions ride along for the reason the parameter documents: stopping at
  // a question round is a person saying they will answer these, and the document
  // they get has to contain them.
  throw new Escalation(EXIT.NEEDS_HUMAN, `Stopped at the ${boundary} boundary. ${why}`, [
    ...questions,
  ]);
}

export async function orchestrate(
  state: RunState,
  cfg: Config,
  /**
   * Whether this is a resume.
   *
   * It no longer decides *whether* `prepareGit` runs - since #78 that happens on
   * every pass, because a forked run is always started by `vibe resume` and has
   * to be put on its branch, and because a resume whose stored branch is not
   * checked out must be refused rather than allowed to commit elsewhere. It
   * still decides what `prepareGit` may *do*: creating a branch is a fresh-run
   * act, and a resume must not gain one it never had.
   */
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
  /**
   * Something outside the loop that may hold it at a boundary (#134).
   *
   * Trailing and optional for the reason `turns` is: every existing caller,
   * `RunLoop` in `cli.ts` included, compiles and behaves unchanged. The CLI
   * passes none and never will - it has no host to ask, and a terminal cannot
   * answer a promise.
   */
  host?: Host,
): Promise<RunState> {
  try {
    // Before any phase runs. On a fresh run `state.plan` is null and this does
    // nothing; on a resume it is the one point holding both the stored plan and
    // the artifact the previous process may have died between writing.
    reconcileFollowUps(state);
    // Beside it, for the same reason and against the same hazard: the record of
    // a suppressed re-ask or a disposed-of deferral lives in `state.json`, and
    // the file that reports it is a second write a kill can land between. A
    // fork is the same shape - the child inherits the state and none of the
    // parent's artifacts - and a forked run is always started by `vibe resume`,
    // so this pass is where it gets its copy (#65).
    reconcileQuestionRecords(state);
    // Beside them, and for the same shape of reason: a process killed inside
    // `preserveGateArtifacts` leaves a staging tree that only the next preserve
    // FOR THAT GATE AND ROUND would have cleared, so a run that resumes and
    // never fails that gate again keeps a full copy of what the gate produced
    // for ever. Here rather than in `createRun`/`loadRun` because that would put
    // `run.ts` in a cycle with this module's - `artifacts.ts` imports it (#111).
    sweepArtifacts(state);
    // Before the first turn, because the turn it exists for is the first one:
    // the context window arrives on a turn's result envelope, so the planner has
    // never had one to report a `ctx%` against. This borrows the denominator
    // from the newest archived run that measured it under the same model, and
    // supplies nothing at all when no such run exists.
    seedContextWindows(state);
    return await runPhases(state, cfg, resume, turns, host);
  } finally {
    // A `finally`, not a tail call: the phases below return early at the
    // "already finished" check and at the plan-only exit, and a persistent
    // app-server child left running would outlive the run on exactly those
    // paths.
    closeCodexRateLimits();
  }
}

/**
 * Tidy the gate-artifact scratch, and say so only when there was something to
 * say (#111).
 *
 * Silent and eventless on a run with nothing stranded, which is every ordinary
 * run: a pass that removed nothing must leave the record byte-identical to what
 * it was before this existed. What it did remove is named rather than counted -
 * these are potentially the largest objects in `.vibe/`, and "swept 2 entries"
 * is not something a user can check.
 */
function sweepArtifacts(state: RunState): void {
  const sweep = sweepGateArtifacts(state);
  if (sweep.removed.length > 0) {
    log.info(
      `Removed ${sweep.removed.length} leftover artifact staging entr` +
        `${sweep.removed.length === 1 ? 'y' : 'ies'} from an interrupted preservation: ` +
        sweep.removed.join(', '),
    );
  }
  for (const kept of sweep.kept) {
    log.warn(`Left in place: ${kept.at} ${kept.why}`);
  }
  if (sweep.removed.length === 0 && sweep.kept.length === 0) return;
  recordEvent(state, 'artifact_staging_swept', {
    removed: sweep.removed,
    kept: sweep.kept.map((k) => k.at),
  });
}

async function runPhases(
  state: RunState,
  cfg: Config,
  resume: boolean,
  turns: AgentTurns,
  host?: Host,
): Promise<RunState> {
  // **Where the work happens, which is not necessarily the run's home** (#223).
  // `state.targetDir` is the repository the archive and the lock live in;
  // `workDirOf` is the tree this run writes in, and they differ when the run has
  // a worktree of its own. Resolved once and threaded, so no step below can
  // answer "which tree" from a different field while holding a state that says
  // otherwise - which is the same reason `roles` is resolved here.
  const cwd = workDirOf(state);
  // Resolved once and threaded, so no step below can answer "who does this job"
  // from the module default while holding a config that says otherwise.
  const roles = rolesFor(cfg);

  // On every pass, not only a fresh one (#78). A forked run is always started by
  // `vibe resume`, and it is `prepareGit` that puts it on the branch `vibe fork`
  // created; the same call is what stops a resumed run committing to a branch it
  // never claimed. It decides what this pass needs - see `prepareGit`.
  await prepareGit(state, cfg, cwd, resume);

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
    plan = await planPhase(state, cfg, cwd, roles, turns, host);
    if (state.planOnly) {
      state.status = 'planned';
      advancePhase(state, 'complete');
      writeCheckpoint(state, 'complete', NO_COMMIT);
      // Narrated with an id since #223, and it is the promotion AGENTS.md keeps
      // describing: `planOnly` is a fact the run has held since `createRun` and
      // never said, so a window could not tell a plan-only run that FINISHED
      // from any other run that finished - and the two want opposite next
      // actions. Without it the only way back to this plan was a new run that
      // re-derives it, which is what *"it kicked off another run from scratch"*
      // cost. Narration only: `planOnly` is already durable, so recording it
      // would store one fact twice.
      log.ok('Plan-only run: stopping before implementation.', {
        id: 'plan_only_stopped',
        // What the plan is carrying, so the offer to implement it can say so.
        // A count of what the tolerance let through, not a judgement about it.
        data: { carried: (state.carried ?? []).length },
      });
      return state;
    }
    advancePhase(state, 'implementing');
    writeCheckpoint(state, 'plan-approved', NO_COMMIT);
    await holdAt(state, cfg, host, 'plan-approved');
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

    // The base travels with the phase that establishes it (#223, `1d`). It is
    // the commit every diff in this run is taken against, and a window has no
    // other way to learn it - `state.baseSha` is run state, and the wire carries
    // no run state by design. Null when the repository had nothing to mark, which
    // is a real state and not a missing field.
    log.heading('Implementing', {
      id: 'phase_started',
      data: { phase: 'implementing', baseSha: state.baseSha },
    });
    // **The turn the window could not see** (#223). Every other turn in the loop
    // announces itself - plan, revise, critique, answer, review, and all three
    // fix kinds - and the implement turn, which `charge.ts` calls "the single
    // most expensive step in a run", did not. `reduce` builds a `Turn` and sets
    // `run.running` from this id and from nothing else, so without it the
    // cockpit drew `IDLE - no turn is open` for the whole of it, the CODE group
    // had no row, and - worst - **every heartbeat was dropped**, because a beat
    // with no turn open cannot be attributed and is discarded by the reducer.
    //
    // Measured on a run of 2026-09-16: the terminal printed `implement: 14m30s ·
    // 63 tool uses · Write …TodoToggle… · 13.7M tok · ctx 25%` every thirty
    // seconds while the window showed an idle run, so the turn was stopped by
    // somebody who reasonably concluded it had hung. 14.2M tokens and 50 files
    // of finished work, killed because the product said nothing was happening.
    // That is "one channel, two renderers" breaking in the one place it costs
    // the most.
    //
    // `round` is the review round for the reason the fix kinds use it: the CODE
    // group re-opens on every fix, and the round is what tells one pass through
    // it from the next.
    log.step(`${holderLabel('implementer', roles)} is implementing the plan`, {
      id: 'turn_started',
      data: { role: 'implementer', kind: 'implement', round: state.reviewRound },
    });
    const impl = await writeTurn(
      state,
      cfg,
      cwd,
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
          plan.out_of_scope,
          // Re-filtered for the reason `declined` is, and gated on the effective
          // config rather than on what was stored (#425): a resume layers the
          // project file over the run's settings, so a run approved with the
          // setting on and resumed with it off must get the old prompt.
          planToAddress(cfg, state.planNonBlocking ?? []),
          // An approved plan can predate the answers to its advisory questions
          // (#277); the implementer is told them, and that they win.
        ) + P.advisoryAnswers(state.advisoryAnswers, 'implementer'),
        planInPrompt: true,
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
    const committed = await maybeCommit(cfg, cwd, 'vibe: implement approved plan');

    // Reset only on a fresh implementation. Resuming mid-review must keep the
    // histories, or the convergence assessment loses the evidence it is built
    // on and a stalled loop reads as a healthy one.
    state.p1Rounds = [];
    state.verifyRounds = [];
    // With `p1Rounds`, because its positions point into it (#394); and the
    // answer marker with them, because it only ever describes the plan loop.
    delete state.planStalls;
    delete state.planRevisedByAnswer;
    // Below the resets, and deliberately: a snapshot taken above them carries
    // the PLANNING critique history into a state whose phase is already
    // `reviewing`, so a fork resuming there would feed planning rounds to the
    // review convergence assessment. The status is set here for the same reason
    // - the snapshot has to be internally coherent - and the existing assignment
    // below the block stays where it is.
    state.status = 'reviewing';
    saveState(state);
    writeCheckpoint(state, 'implemented', committed);
    await holdAt(state, cfg, host, 'implemented');
  }

  // ---- Review --------------------------------------------------------------
  state.status = 'reviewing';
  saveState(state);

  await reviewPhase(state, cfg, cwd, plan, roles, turns, host);

  state.status = 'done';
  advancePhase(state, 'complete');
  writeCheckpoint(state, 'complete', NO_COMMIT);
  return state;
}

/**
 * Say what a round's findings were and what the gate made of them (#223).
 *
 * **Narration, and deliberately not an event.** `recordAndSay`'s durability rule
 * is that narration never creates one, and every fact here is already durable
 * somewhere better: the findings are in the round's own `code-review-N.json`,
 * and the decision is in `plan_approved` / `review_approved` or in the
 * escalation that follows. This is the same census at the density a window can
 * draw, on the precedent `questions_opened` set - an id with data and no entry
 * in `state.events`.
 *
 * It is what makes the gate decision legible rather than merely announced. `1e`
 * asks for severity counters *against the tolerance*, because the question a
 * person actually has at a review boundary is not "how many findings" but "why
 * did the loop choose to fix again rather than finish", and that is a
 * four-number comparison nothing on the wire could previously supply.
 *
 * **Zeros are sent.** The four-chip form in the design shows them on purpose -
 * where a gate decision is being made, an absence is information - so a count of
 * zero is a measurement here and is not omitted the way an unmeasured field is.
 */
function sayFindings(
  phase: 'plan' | 'review',
  findings: readonly Finding[],
  decision: ReturnType<typeof gate>,
  tolerance: number,
): void {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const f of findings) counts[f.severity] += 1;
  log.info(
    `${phase === 'plan' ? 'Critique' : 'Review'}: ` +
      `${String(counts.P0)} P0 · ${String(counts.P1)} P1 · ` +
      `${String(counts.P2)} P2 · ${String(counts.P3)} P3 ` +
      `(tolerance ${String(tolerance)} P1)`,
    {
      id: 'findings_reported',
      data: {
        phase,
        counts,
        tolerance,
        pass: decision.pass,
        // Null rather than absent when the gate passed: "the loop may proceed"
        // is the answer, not a missing one.
        reason: decision.reason,
        tolerated: decision.tolerated.map((f) => f.id),
        // Enough to draw `1e` and open `4c`, and no more. The detail and the
        // suggested fix are in the artifact, which is where a pane deep enough
        // to want them should read them from - a frame carrying every finding in
        // full would put a review's whole prose on the wire every round.
        findings: findings.map((f) => ({
          id: f.id,
          severity: f.severity,
          title: f.title,
          // Absent stays absent (#141): a renderer that cannot name the author
          // names nobody, and `authorOf` returns null rather than guessing.
          raisedBy: authorOf(f),
          // Whether the claim points anywhere, which is what `4c` flags as
          // **ungrounded**. A count rather than the entries: the pane needs to
          // know there is nothing to open, not what would have been in it.
          evidence: f.evidence?.length ?? 0,
          // Both severity histories, kept apart exactly as #142 keeps them: a
          // guard's downgrade is not a person's restore, and one field serving
          // both is how they come to disagree.
          downgraded: f.downgraded ?? null,
          severityChanges: f.severityChanges ?? null,
          // What the reviewer's own test observed, if it wrote one (#113,
          // #223). Hi-fi 9's third case is the one this supplies: a finding that
          // is grounded and still **uncheckable**, which is a different state
          // from grounded-and-proved and from ungrounded, and the pane could not
          // draw it because the verdict never left the archive.
          //
          // The whole list, not the latest: the same reproducer is run at
          // `review` and again after the final fix, and they answer two
          // different questions - does the defect happen at all, and is it gone.
          // Collapsing them would throw away the second, which is the only
          // evidence OUTSTANDING.md has ever had for closing a carried finding.
          reproducer:
            f.reproducerOutcomes?.map((o) => ({
              verdict: o.verdict,
              at: o.at,
              // Why it could not tell, which is most of the value of `unproven`.
              // Null on the two verdicts that observed a run.
              reason: o.reason,
            })) ?? null,
          // The reviewer declining to have it fixed *here*: real, worth doing,
          // separate work. This is the one field where absent and false say the
          // same thing to a reader - a report from before the field existed had
          // no third option to take - so they collapse rather than becoming a
          // named absence nobody could act on.
          deferred: f.defer === true,
        })),
      },
    },
  );
}

/**
 * Approve the plan of record, on the gate's decision over `findings`.
 *
 * The one approval path (#394): the critique that passes the gate and the
 * resume on which a person demoted enough findings to pass it both come here,
 * so an accepted plan carries, declines and freezes its bar exactly as a passed
 * one does. Moved out of `planPhase` unchanged; `extra` is spread last into the
 * `plan_approved` data and the gate pass passes none. #425's hand-off of the
 * non-blocking findings to the implementer lives here for the same reason, so
 * an acceptance hands them on exactly as a pass does.
 */
function approvePlan(
  state: RunState,
  cfg: Config,
  plan: Plan,
  findings: readonly Finding[],
  decision: ReturnType<typeof gate>,
  extra: Record<string, unknown> = {},
): void {
  // Carried, not forgiven. The implementation is told about these so the
  // phase that can actually settle them does.
  if (decision.tolerated.length > 0) state.carried = decision.tolerated;
  // The rest of what the critic raised that is still work (#425): every P2
  // and P3 that is not deferrable, handed to the implementer rather than to
  // a further revision - the owner's decision, so the plan loop's round count
  // does not move. No turn is bought here, so P3s ride along with P2s.
  //
  // On a person's acceptance (#394) this includes the P1s they demoted: each
  // is now a P2 with a `by: 'human'` move and no guard's `downgraded`, so it is
  // treated as any approved P2 is. Accepting a plan says the finding need not
  // block it, not that it is no longer work.
  //
  // A P1 the critique vote moved goes too (#405): it is a P2 now, and an
  // unconfirmed claim is still one the implementer can settle.
  const nonBlocking = planToAddress(cfg, findings);
  // The sentence, chosen before it is said, because since #223 saying it and
  // recording it are one call and the call sits below the two assignments
  // its data reads. The two branches and their wording are unchanged, and so
  // is the order they reach a terminal in: this line, then the `~` list.
  // With findings to hand on, each says how many go to the implementer.
  const approved =
    decision.tolerated.length > 0
      ? `Plan accepted with ${decision.tolerated.length} P1(s) carried into implementation - ` +
        decision.tolerated.map((f) => f.id).join(', ') +
        (nonBlocking.length > 0
          ? `; ${nonBlocking.length} non-blocking finding(s) go to the implementer`
          : '')
      : `Plan approved - ${findings.length} non-blocking finding(s)` +
        (nonBlocking.length > 0 ? `; ${nonBlocking.length} go to the implementer` : '');
  // The one round whose findings reach nobody otherwise: a revising round
  // hands its deferrals to the planner through `pendingFindings`, and this
  // one is about to clear them. Recorded, not acted on - `defer` decides
  // what a later prompt is told, never whether a turn happens. Assigned
  // unconditionally so an approving round that declined nothing cannot
  // leave an earlier round's value standing, and written on the same state
  // save that clears the pending findings below.
  // Not a vote-moved finding (#405): `declined` tells the implementer a
  // finding is real and agreed to belong elsewhere, and an unconfirmed claim is
  // neither. It goes to FOLLOW-UPS.md as unconfirmed by vote regardless.
  state.declined = findings.filter((f) => isDeferrable(f) && !movedByVote(f));
  // For the same reason and on the same save (#425): an approving round with
  // nothing to hand on removes the field rather than leaving an earlier
  // round's standing - and removes rather than empties it, so a run with
  // `loop.fixNonBlocking` off writes the state.json it always did.
  if (nonBlocking.length > 0) state.planNonBlocking = nonBlocking;
  else delete state.planNonBlocking;
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
  recordAndSay(state, 'ok', 'plan_approved', approved, {
    findings: findings.length,
    carried: decision.tolerated.map((f) => f.id),
    declined: state.declined.map((f) => f.id),
    // Present only when there is something to hand on, so a plan approved
    // with nothing to address records the data it always did (#425).
    ...(nonBlocking.length === 0 ? {} : { nonBlocking: nonBlocking.map((f) => f.id) }),
    // Present only when a bar was recorded. `?? []` here would log an
    // explicit empty bar for a legacy plan that never claimed one, which is
    // the absent-as-empty collapse the rest of this field refuses.
    ...(state.acceptanceCriteria === undefined
      ? {}
      : { criteria: state.acceptanceCriteria.map((c) => c.id) }),
    ...extra,
  });
  for (const f of decision.tolerated) log.info(`  ~ ${f.title}`);
  // An approved plan has nothing outstanding: what the gate tolerated
  // travels on `state.carried` into implementation, and leaving these set
  // would have a resume revise a plan the critic just passed.
  clearPendingFindings(state);
}

/** Plan, resolve questions, and critique until the critic raises no P1s. */
async function planPhase(
  state: RunState,
  cfg: Config,
  cwd: string,
  roles: RoleTable,
  turns: AgentTurns,
  host?: Host,
): Promise<Plan> {
  let plan: Plan;
  /**
   * What the plan turn *this process ran* did, or absent (#63).
   *
   * Reassigned by every turn that produces a plan, so the critique below is told
   * about the turn that wrote the plan it is critiquing and never about an
   * earlier one. A plan restored from `state.plan` on a resume leaves this
   * absent: no turn ran here, so there is nothing to say about one, and absent
   * is what "unmeasured" has always meant.
   */
  let planActivity: TurnActivity | undefined;
  if (state.plan) {
    plan = state.plan;
  } else {
    // The round travels, exactly as the critique heading below carries it, and
    // for the same reason: this phase writes `plan-${state.planRound}.json`, so
    // the number is what correlates a card with the file behind it. It was the
    // one `phase_started` in the plan cycle that carried none, which left the
    // first row of the loop column unnumbered beside numbered siblings.
    log.heading('Planning', {
      id: 'phase_started',
      data: { phase: 'planning', round: state.planRound },
    });
    ({ plan, activity: planActivity } = await runPlan(state, cfg, cwd, roles, turns));
  }

  // Answers a previous process held and no revision consumed, picked up on
  // resume. Since #169 there are two writers: a human in NEEDS-INPUT.md (merged
  // over the answerer's, the person winning - `mergeHumanAnswers`), and
  // `resolveQuestions` itself, which persists the answerer's usable answers on
  // the write that marks their questions answered. Either way this block is the
  // one road back in, so a stop between the answerer and the revision costs a
  // planner turn and never the answers.
  //
  // `markAnswered` no longer saves; the keys land on `revisePlan`'s opening
  // `saveState`, and the answers are consumed on its plan write - not on a
  // second write after it, which was a window where a stop bought the revision
  // again.
  //
  // Deliberately does not clear `pendingFindings`: this revises with `answers`
  // *instead of* the findings, so it has not answered them, and treating a
  // human's reply as consuming them would discard work the run paid for. The
  // loop below consumes them next, which costs a second planner turn on the one
  // path where both are present.
  if (state.pendingAnswers && state.pendingAnswers.length > 0) {
    for (const a of state.pendingAnswers) markAnswered(state, a.question);
    ({ plan, activity: planActivity } = await revisePlan(
      state,
      cfg,
      cwd,
      { answers: state.pendingAnswers },
      roles,
      turns,
      host,
    ));
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
      // Accepting on a person's demotion (#394). A pending plan finding whose
      // severity a person moved means a move since the last critique - each
      // critique replaces these - and the real gate over what is now pending
      // decides, so a tolerated P1 is carried exactly as on any approval. Read
      // from state, never from what this process remembers, so a death between
      // the move and here changes nothing. A plain resume moves nothing and
      // revises as it always did.
      const moved = carried.some((f) => severityChangesOf(f).some((c) => c.by === 'human'));
      if (moved && state.planRevisedByAnswer === true) {
        // An answer wins: approving now would approve a plan revised against
        // it that no critic has read. Said whether or not the gate would have
        // passed, because the person who demoted and also answered is owed the
        // sentence either way - a partial demotion with an answer is the same
        // combination, and staying silent there left them guessing (review of
        // #394 part 2).
        log.info(
          'Your severity changes were not taken as accepting the plan, because an answer was ' +
            'also given - revising against the answer and the findings, then critiquing.',
        );
      } else if (moved) {
        const accepted = gate(carried, cfg.loop.p1Tolerance);
        if (accepted.pass) {
          log.info(
            'A person changed a severity since the last critique and the gate now passes - ' +
              'approving the plan without another critique.',
          );
          approvePlan(state, cfg, plan, carried, accepted, { byPerson: true });
          break;
        }
      }
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
      ({ plan, activity: planActivity } = await revisePlan(
        state,
        cfg,
        cwd,
        { findings: carried },
        roles,
        turns,
        host,
      ));
      continue;
    }
    firstPass = false;

    // A question already put to Codex never comes back, however the revised plan
    // rephrases it - otherwise an insistent planner loops the run forever.
    //
    // "However it rephrases it" used to mean "however it repunctuates it": the
    // guard was exact equality over `normalize`, and a genuine rewording walked
    // straight past it. Four wordings of one question cost the #47 run three
    // extra answer turns and drove it into `loop.maxQuestionRounds`. So the
    // filter is now exact-then-fuzzy, and the two halves cost different things:
    // an exact repeat is dropped in silence, exactly as it always was, while a
    // rephrasing is recorded with what it matched and its score before it is
    // dropped. See `src/questions.ts` for the threshold and its measurement.
    const askable = plan.open_questions.filter(
      (q) => q.blocking || cfg.questions.answerNonBlocking,
    );
    const pending: OpenQuestion[] = [];
    for (const q of askable) {
      if (isAnswered(state, q.question)) continue;
      const near = findRephrase(q.question, state.answeredQuestions);
      if (near === null) {
        pending.push(q);
        continue;
      }
      recordSuppressed(state, q.question, near);
      log.warn(
        `Not asking again - this is the same question as one already put to the answerer ` +
          `(${near.score.toFixed(2)}): ${q.question}`,
      );
      log.info('  See REPHRASED.md. If those are two different questions, that is a defect.');
    }
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
      // The snapshot for this round, taken here and in both branches below (#139).
      //
      // Here rather than inside the `answers.length > 0` branch, because *this*
      // is the point the round's work is recorded and the next has not begun:
      // the answerer's turn is charged, `answers-<n>.json` is on disk and every
      // question asked is marked answered. The declined-everything path used to
      // reach `continue` having written no snapshot at all - the one round in the
      // loop that left none - so a fork of that run had to go back to the plan
      // round before it and buy the answerer turn again.
      //
      // And it is `question-round`, not `plan-round`, because that is what this
      // is: a plan revised because the critic objected and a plan revised
      // because it answered its own questions are different diagnoses, and they
      // used to share a name.
      //
      // They no longer share a counter either. `revisePlan` writes a second
      // `question-round` checkpoint a moment later on the revising branch and
      // advances nothing, so this whole round leaves `state.planRound` where it
      // found it - see `advancesRound`.
      writeCheckpoint(state, 'question-round', NO_COMMIT);
      // Gateable since #140, which is when `GateContext` gained the counter that
      // makes the decision answerable: this is the round of `maxQuestionRounds`
      // a planner is spending on questions it raised itself, and a run doing
      // that for a third time is the one an operator most wants to stop.
      // The round's own questions travel with the hold, so a stop here writes a
      // `NEEDS-INPUT.md` a person can actually answer. `pending` rather than the
      // ones the answerer declined: at this boundary the answerer has already
      // taken its turn, and someone who stops is overriding what it produced -
      // narrowing the list to the declines would decide for them which answers
      // were worth revisiting.
      await holdAt(state, cfg, host, 'question-round', pending);
      // **Every question advisory: no revision** (#277). The planner said none
      // of them changes what the plan does, so the answers go to the critic with
      // this plan instead of buying a planner turn first; one that does change
      // something comes back as a finding, and that revision folds them all in.
      // Moved out of `pendingAnswers` on this one write, because that field is
      // the resume's road into a revision and would buy the skipped turn back.
      if (answers.length > 0 && pending.every((q) => !q.blocking)) {
        state.advisoryAnswers = [...(state.advisoryAnswers ?? []), ...answers];
        state.pendingAnswers = null;
        saveState(state);
        log.info(
          `Not revising the plan for ${answers.length} advisory answer(s) - the critic reads them with the plan.`,
          { id: 'revision_skipped', data: { answers: answers.length, round: state.questionRound } },
        );
        continue;
      }
      // The answerer may have declined every one; only revise if something came
      // back - and when nothing did, the plan and the turn that wrote it are
      // both still the ones already in hand.
      if (answers.length > 0) {
        ({ plan, activity: planActivity } = await revisePlan(
          state,
          cfg,
          cwd,
          { answers },
          roles,
          turns,
          host,
        ));
      }
      continue;
    }

    log.heading(`Plan critique (round ${state.planRound + 1})`, {
      id: 'phase_started',
      // The RAW round, not the `+ 1` the sentence shows. The artifact this round
      // writes is `plan-critique-${state.planRound}.json`, so this is the number
      // that correlates a card with the file behind it; the display adds one
      // because humans count from one and the archive does not.
      data: { phase: 'critique', round: state.planRound },
    });
    // The record of the turn is written by the callback, not after the wrapper
    // returns: a concurrent rotation can now raise a budget escalation, and
    // `withConcurrentCompaction` surfaces it once `work` has resolved. Anything
    // left outside the callback would be skipped for a critique the run has
    // already paid for.
    const { found: critique, held } = await withConcurrentCompaction(
      state,
      cfg,
      async () => {
        const critiqued = await runCritique(state, cfg, cwd, plan, roles, turns, planActivity);
        // The critique's finders and its vote (#405), in that order and before
        // everything below, so the artifact, the deferrals, the pending
        // findings and the gate all read one report: merged, voted, with
        // `foundBy` and `votes`. With both lists empty, exactly the critic's
        // report: no turn, no key, no event. None of these turns is a plan
        // round - `planRound` moves only with a revision.
        const finders = readFinders(cfg, 'critique');
        const merged =
          finders.length === 0
            ? critiqued
            : (
                await runFinderSeats(
                  state,
                  cfg,
                  cwd,
                  roles,
                  turns,
                  critiqueFinderPhase(state, cfg, plan, roles, planActivity),
                  finders,
                  critiqued,
                )
              ).report;
        const verifiers = readVerifiers(cfg, 'critique');
        const voted =
          verifiers.length === 0
            ? { report: merged, held: [] }
            : await runVoteSeats(
                state,
                cfg,
                cwd,
                turns,
                critiqueVotePhase(state, cfg, plan, roles, await reviewStandardsFor(state, cwd)),
                verifiers,
                merged,
              );
        // Before the artifact and before `recordPendingFindings`, so the round's
        // record shows what the run refused on and the next revision is told
        // about it. A mechanical fact about the artifact on disk, added to the
        // critic's judgement rather than replacing it (#108).
        const planFile = `plan-${state.planRound}.json`;
        const { report: found, raised } = refusePlaceholderPlan(voted.report, plan.plan_md, planFile);
        if (raised !== null) {
          recordAndSay(
            state,
            'error',
            'plan_placeholder_refused',
            `${planFile} holds a pointer, not a plan - refusing to implement it.`,
            { artifact: planFile, id: raised.id },
          );
        }
        artifact(state, `plan-critique-${state.planRound}.json`, found);
        // Who took this round's own turn (#453), saved by
        // `recordPendingFindings` below: the revision answering this round
        // credits its findings to this seat, and a resume may move
        // `roles.critic` in between. `state.reviewSeat`'s pattern.
        state.criticSeat = {
          round: state.planRound,
          provider: roles.critic.provider,
          model: roles.critic.model ?? 'default',
        };
        recordRebuttalsRaisedAgain(state, found.findings);
        collectDeferred(state, found.findings);
        writeFollowUps(state, plan);
        // In here for the same reason the artifact is: a budget escalation the
        // wrapper is holding must not cost the run the findings it just bought.
        // Cleared again below the moment the gate says there is nothing to
        // consume.
        recordPendingFindings(state, 'plan', found.findings);
        return { found, held: voted.held };
      },
      turns.claude,
      'critic',
      roles,
    );

    const decision = gate(critique.findings, cfg.loop.p1Tolerance);
    const stoppers = blockingFindings(critique.findings);
    // Before the branch, so the census is the same shape whichever way the gate
    // goes. A window drawing it only on a failure would have four counts while
    // the news was bad and nothing while it was good.
    sayFindings('plan', critique.findings, decision, cfg.loop.p1Tolerance);
    // `critique.unconfirmedP0: "halt"` (#405), the review's stop for the plan:
    // after the artifact and the pending findings, because the stop is about a
    // record that has to exist. The P0 is not moved. A resume with no answer
    // takes the pending findings to the revision, blocking, and casts no vote
    // again; one whose person demoted it takes #394's acceptance above.
    if (held.length > 0) {
      throw new Escalation(
        EXIT.NEEDS_HUMAN,
        `The critique verifiers did not confirm ${held.length} P0 finding(s), and ` +
          'critique.unconfirmedP0 is "halt". Each is still P0. Leave it alone and it keeps blocking: ' +
          'the resume sends it to the plan revision. To demote one, fill in its block under ' +
          '"Change a severity" below, then resume.',
        null,
        held,
      );
    }
    if (decision.pass) {
      approvePlan(state, cfg, plan, critique.findings, decision);
      break;
    }

    log.warn(`${decision.reason}: ${stoppers.map((f) => f.id).join(', ')}`);
    for (const f of stoppers) log.info(`  - [${f.severity}] ${f.title}`);

    guardPlanBudget(state, cfg, stoppers);
    // Ids a person raised, from this critique and from what the run carries.
    // Empty in the plan loop today (`raise.ts`, decision 4); passed anyway so
    // the stall rule's exclusion holds where it is stated (#394).
    const human = new Set(
      [...critique.findings, ...(takePendingFindings(state, 'plan') ?? [])]
        .filter((f) => authorOf(f) === 'human')
        .map((f) => f.id),
    );
    guardProgress(cfg, state.p1Rounds, critique.findings, stoppers, {
      cap: cfg.loop.maxPlanRounds,
      round: state.planRound + 1,
      capName: 'maxPlanRounds',
      deadlockMsg: 'the planner and reviewer are deadlocked',
      stall: { state, human },
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
  host?: Host,
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
      // A final fix round that died inside its turn is resumed as itself.
      const inFlight = state.fixInFlight;
      if (inFlight?.final === true && inFlight.round === state.reviewRound) {
        const tolerated = Array.isArray(state.outstanding) ? state.outstanding.filter(hasFindingShape) : [];
        // From the ids the attempt persisted, not from today's config: this is
        // that round, already started and paid for, resumed as itself (#425).
        const ids = new Set(Array.isArray(state.finalFixNonBlocking) ? state.finalFixNonBlocking : []);
        const nonBlocking = carried.filter((f) => ids.has(f.id));
        await runFinalFix(state, cfg, cwd, plan, carried, tolerated, nonBlocking, roles, turns, true);
        continue;
      }
      await runFixRound(state, cfg, cwd, carried, roles, turns, host);
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

      log.step('Fixing the verification failure', {
        id: 'turn_started',
        data: { role: 'implementer', kind: 'verify-fix', round: state.verifyRound },
      });
      const repair = await writeTurn(
        state,
        cfg,
        cwd,
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
            plan,
          ),
          planInPrompt: true,
          cwd,
          label: `verify-fix-${state.verifyRound}`,
        },
        turns,
        roles,
      );
      recordReport(state, `verify-fix-${state.verifyRound}.md`, repair.text);
      writeCheckpoint(
        state,
        'verify-round',
        await maybeCommit(cfg, cwd, `vibe: fix verification failure (round ${state.verifyRound})`),
      );
      await holdAt(state, cfg, host, 'verify-round');
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
      // Says what the round worked on when it carried non-blocking findings
      // (#425); a round for tolerated P1s alone keeps its sentence.
      const nb = Array.isArray(state.finalFixNonBlocking) ? state.finalFixNonBlocking : [];
      if (nb.length === 0) {
        if (caveat === null) log.ok('Carried findings addressed and verification still passes.');
        else log.warn(`Carried findings addressed, but ${caveat}.`);
      } else {
        const p1s = Array.isArray(state.outstanding) ? state.outstanding.filter(hasFindingShape).length : 0;
        const what =
          `The final fix round worked on ${p1s > 0 ? `${p1s} carried P1(s) and ` : ''}` +
          `${nb.length} non-blocking finding(s)`;
        if (caveat === null) log.ok(`${what}, and verification still passes.`);
        else log.warn(`${what}, but ${caveat}.`);
      }
      break;
    }

    log.heading(`Code review (round ${state.reviewRound + 1})`, {
      id: 'phase_started',
      // Raw, for the reason the critique heading above gives: this round writes
      // `code-review-${state.reviewRound}.json`.
      data: { phase: 'review', round: state.reviewRound },
    });
    // Inside the callback, for the reason given at the critique call site: a
    // held budget escalation must not cost the run the record of the review it
    // paid for.
    const { found: review, unconfirmedP0 } = await withConcurrentCompaction(
      state,
      cfg,
      async () => {
        const { report: found, unconfirmedP0 } = await runReview(state, cfg, cwd, plan, roles, turns);
        artifact(state, `code-review-${state.reviewRound}.json`, found);
        // Who took this round's own turn, saved by `recordPendingFindings`
        // below (#393). The fix that answers this round credits its findings
        // to this seat, and a resume may change `roles.reviewer` in between.
        state.reviewSeat = {
          round: state.reviewRound,
          provider: roles.reviewer.provider,
          model: roles.reviewer.model ?? 'default',
        };
        collectDeferred(state, found.findings);
        writeFollowUps(state, plan);
        // In here for the same reason as the artifact, and as in the plan
        // phase: what the run just paid 15M tokens for must survive a stop
        // between this turn and the fix that answers it.
        recordPendingFindings(state, 'review', found.findings);
        return { found, unconfirmedP0 };
      },
      turns.claude,
      'reviewer',
      roles,
    );

    const decision = gate(review.findings, cfg.loop.p1Tolerance);
    const stoppers = blockingFindings(review.findings);
    sayFindings('review', review.findings, decision, cfg.loop.p1Tolerance);
    // `review.unconfirmedP0: "halt"` (#388 Part C): after the artifact and the
    // pending findings are written, never before - the stop is about a record
    // that has to exist. The P0 is not moved. A resume with no answer carries it
    // to the fix round, blocking, and casts no vote again: the votes in the
    // artifact are the record. A person who disagrees moves it with the #142
    // block NEEDS-INPUT.md already renders for every carried finding.
    if (unconfirmedP0.length > 0) {
      throw new Escalation(
        EXIT.NEEDS_HUMAN,
        `The review verifiers did not confirm ${unconfirmedP0.length} P0 finding(s), and ` +
          'review.unconfirmedP0 is "halt". Each is still P0. Leave it alone and it keeps blocking: ' +
          'the resume sends it to the fix round. To demote one, fill in its block under ' +
          '"Change a severity" below, then resume.',
        null,
        unconfirmedP0,
      );
    }
    if (decision.pass) {
      // What the gate let through that is still work (#425). Run 20261022-224848
      // said "Review clean" over a REVISE verdict naming two P2s in the task's
      // own files, and nothing ever read them again.
      const nonBlocking = toAddress(cfg, review.findings);
      if (decision.tolerated.length === 0 && !nonBlocking.some((f) => f.severity === 'P2')) {
        if (nonBlocking.length === 0) {
          recordAndSay(
            state,
            'ok',
            'review_approved',
            `Review clean - ${review.findings.length} non-blocking finding(s)`,
            { findings: review.findings.length },
          );
        } else {
          // P3s only. No turn is bought for them: the fix prompt tells the fixer
          // to skip P3s unless incidental to required work, and there is none.
          // So they are recorded, and the sentence no longer says clean.
          //
          // The findings are consumed on the SAME write that records them, and
          // before the approval is said: a stop between the approval and a later
          // clear would leave them pending, and the resume would hand them to
          // `runFixRound` - a write turn this branch exists not to buy.
          state.unaddressed = nonBlocking.map((f) => ({
            finding: f,
            outcome: 'not-attempted',
            reason: '',
          }));
          state.pendingFindings = null;
          saveState(state);
          writeFollowUps(state, plan);
          recordAndSay(
            state,
            'ok',
            'review_approved',
            `Review approved - ${nonBlocking.length} P3 finding(s) recorded in FOLLOW-UPS.md, ` +
              'no fix round run',
            { findings: review.findings.length, followUps: nonBlocking.map((f) => f.id) },
          );
        }
        // Nothing blocking came back, so there is nothing for a resume to fix.
        // (Already cleared above on the P3-only road; clearing again is a no-op.)
        clearPendingFindings(state);
        break;
      }

      // Tolerating a finding means stopping the argument, not abandoning the
      // work. The loop ends after one more fix that incorporates what the
      // reviewer found - the alternative was to finish with a known defect
      // untouched, which is not what "move on" should buy.
      //
      // Since #425 a P2 to address buys the same round, and tolerated P1s plus
      // P2s are still one round, not two. The fixer judges each finding under
      // #228's scope rule in `fixPrompt`, unchanged; what it leaves goes to
      // FOLLOW-UPS.md rather than being forced.
      //
      // The result is deliberately not re-reviewed: that is what bounds this.
      // Another review round could raise something new and the loop would never
      // end, which is the situation the tolerance exists to escape.
      await runFinalFix(
        state,
        cfg,
        cwd,
        plan,
        review.findings,
        decision.tolerated,
        nonBlocking,
        roles,
        turns,
        false,
      );
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
 * A fix round is a code round, and it says so before its turn starts (#280).
 *
 * The first implement turn opens the code group with `phase_started`; the fix
 * kinds said only `turn_started`, and `reduce` files a turn under the most
 * recently opened group - which is the review it answers. So a run that went
 * review, fix, review drew `review round 0 → review round 1` with the fix as a
 * row inside the first, and read as a loop that had skipped the code entirely.
 * The replay already files `fix-N` and `final-fix-N` under `implementing`
 * (`seatOf`), so the live column and the same run opened from the archive drew
 * two different shapes.
 *
 * `round` is the review round the fix produces, the number its turn and label
 * already carry, and it is what keeps `reEntered` from folding this into the
 * first code group: that one carries no round, and a review sits between them
 * anyway. The base rides along because every `implementing` carries it.
 *
 * `verify-fix` deliberately does not announce. A failed gate is inside the code
 * group that ran it, so its repair belongs in that group too - and there always
 * is one open, because the gate runs only after an implement or fix turn.
 */
function announceFixRound(state: RunState): void {
  log.heading(`Implementing (fix round ${state.reviewRound})`, {
    id: 'phase_started',
    data: { phase: 'implementing', round: state.reviewRound, baseSha: state.baseSha },
  });
}

/**
 * The carried-P1 final fix round: the turn, its record, the reproducers run
 * once more, OUTSTANDING.md, and the commit.
 *
 * A function rather than the tail of the review branch because the loop now
 * reaches it from two directions, as `runFixRound` is reached: the review that
 * tolerated the findings, and a resume whose process died inside this round
 * (#393). Before that second road existed, such a resume took the ordinary fix
 * path - a new round number, a `fix-<n>` label, no `confirmFixed` - so the round
 * the loop never reviews again lost the one check that replaces "nobody has
 * confirmed they are gone" with a fact.
 *
 * `resumed` is that second road: the round, `finalFixDone` and
 * `state.outstanding` were already persisted by the attempt that died, so they
 * are reused rather than bought again.
 */
async function runFinalFix(
  state: RunState,
  cfg: Config,
  cwd: string,
  plan: Plan,
  findings: readonly Finding[],
  tolerated: readonly Finding[],
  nonBlocking: readonly Finding[],
  roles: RoleTable,
  turns: AgentTurns,
  resumed: boolean,
): Promise<void> {
  if (!resumed) {
    state.reviewRound += 1;
    state.finalFixDone = true;
    state.outstanding = [...tolerated];
    // The second witness, persisted with the first (#425). Absent for a round
    // carried for P1s alone, so that round's state is what it always was.
    if (nonBlocking.length > 0) state.finalFixNonBlocking = nonBlocking.map((f) => f.id);
    else delete state.finalFixNonBlocking;
  }
  // Before the turn, so a process that dies inside it resumes this round as
  // itself rather than as the next ordinary fix (#393). See `fixInFlight`.
  state.fixInFlight = { round: state.reviewRound, final: true };
  saveState(state);
  beginReport(state);

  announceFixRound(state);
  // Says what it carries and counts each (#425). `carried` keeps meaning the
  // P1s; a round for P1s alone keeps its line and data byte for byte.
  log.step(
    nonBlocking.length === 0
      ? `Incorporating ${tolerated.length} carried P1(s), then finishing: ` +
          tolerated.map((f) => f.id).join(', ')
      : `Incorporating ${tolerated.length > 0 ? `${tolerated.length} carried P1(s) and ` : ''}` +
          `${nonBlocking.length} non-blocking finding(s), then finishing: ` +
          [...tolerated, ...nonBlocking].map((f) => f.id).join(', '),
    {
      id: 'turn_started',
      data: {
        role: 'implementer',
        kind: 'final-fix',
        carried: tolerated.map((f) => f.id),
        ...(nonBlocking.length === 0 ? {} : { nonBlocking: nonBlocking.map((f) => f.id) }),
      },
    },
  );
  for (const f of [...tolerated, ...nonBlocking]) log.info(`  ~ ${f.title}`);

  const finalFix = await writeTurn(
    state,
    cfg,
    cwd,
    {
      role: 'implementer',
      prompt: P.fixPrompt(findings, state.reviewRound, state.acceptanceCriteria, plan, true),
      planInPrompt: true,
      cwd,
      label: `final-fix-${state.reviewRound}`,
      jsonSchema: FIX_SCHEMA,
    },
    turns,
    roles,
  );
  const finalRead = readFixOutput(finalFix);
  recordReport(state, `fix-report-${state.reviewRound}.md`, finalRead.report);
  // The moment the fix stops being worth buying again, and therefore the
  // moment to drop the carry: the turn is done and its report is on disk.
  // Everything after this - the record, three git invocations - can fail
  // without making a second fix round useful, and the record is not lost by
  // going first: `recoverOutstanding` rebuilds it from `state.outstanding`
  // once the gate has passed. Same order as `runFixRound`.
  // Before the findings are consumed, as in `runFixRound`, and before
  // `confirmFixed`, so the carried P1s' `at: 'final-fix'` verdict lands on
  // `state.outstanding` beside a record that already exists.
  const dispositions = recordDispositions(state, finalRead, findings, `final-fix-${state.reviewRound}`);
  // What the round left of the non-blocking findings it carried, recorded
  // beside the dispositions and before the findings are consumed, so a stop
  // after the turn still leaves it and a resumed round writes it again (#425).
  // Everything the fixer did not mark `fixed` goes in, with its reason, so a
  // rebuttal can be judged by a person; an unreadable answer puts every one in
  // as unreadable, never as not addressed.
  const left = leftBy(nonBlocking, dispositions);
  if (nonBlocking.length > 0) {
    state.unaddressed = left;
    saveState(state);
    writeFollowUps(state, plan);
  }
  delete state.fixInFlight;
  clearPendingFindings(state);

  // After the fix and before the artifact that describes it. This is the
  // round the loop deliberately never reviews again, so OUTSTANDING.md has
  // always had to say the findings were "worked on, and nobody has confirmed
  // they are gone" - and for a finding that carried a reproducer, running it
  // once more is the only thing that has ever been able to replace that
  // sentence with a fact (#113).
  // Over the tolerated P1s only: the non-blocking findings are recorded through
  // `recordDispositions` above, and with no P1s this runs nothing (#425).
  const settled = await confirmFixed(state, cfg, cwd, roles, tolerated);
  state.outstanding = settled;
  saveState(state);

  // Written `pending`: the gate has not run yet at this point in the loop,
  // so the file cannot say how it went. `finaliseOutstanding` rewrites it
  // from the completion branch once it has.
  //
  // Only when P1s were carried (#425): the document says the review raised P1s
  // within `loop.p1Tolerance`, and a round run for P2s alone would have it say
  // "raised 0 P1 finding(s)". The gate-time rewrites already do nothing on an
  // empty `outstanding`.
  if (tolerated.length > 0) {
    const file = artifact(state, 'OUTSTANDING.md', renderOutstanding(state, settled, 'pending'));
    log.info(`Carried findings and what was done about them: ${path.relative(cwd, file)}`);
  }

  writeCheckpoint(
    state,
    'final-fix',
    await maybeCommit(cfg, cwd, `vibe: address carried review findings (final round)`),
  );
  // No hold here, and it is the one boundary that lost one (#140). The
  // checkpoint stays - a fork of this point is worth having - but `final-fix`
  // has no row in the matrix, so `holdAt` could only ever have returned. Two
  // lines below is `continue`, which takes the loop back to the top so the
  // verification gate proves this fix broke nothing; stopping in between is
  // the same decision with less information behind it. See `UNGATEABLE`.
  // Said as well as recorded (#223). The clean branch above has announced
  // itself since #133 and this one never did, so the two ways a review can
  // approve looked different to a window for no reason anybody chose: one
  // arrived as `review_approved`, the other as silence.
  if (nonBlocking.length === 0) {
    recordAndSay(
      state,
      'ok',
      'review_approved',
      `Review approved with ${tolerated.length} carried finding(s) fixed - ` +
        tolerated.map((f) => f.id).join(', '),
      {
        findings: findings.length,
        carriedAndFixed: tolerated.map((f) => f.id),
      },
    );
    return;
  }
  // The one `review_approved` of a round that also carried non-blocking
  // findings (#425): the pass branch did not say one, because the cockpit reads
  // it as the run ending. Counted from the dispositions record, and it names
  // FOLLOW-UPS.md only when something was put there.
  const fixed = dispositions === null ? [] : nonBlocking.filter((f) => !left.some((l) => l.finding.id === f.id));
  const parts = [
    ...(tolerated.length > 0
      ? [`${tolerated.length} carried P1(s) fixed - ${tolerated.map((f) => f.id).join(', ')}`]
      : []),
    dispositions === null
      ? `the fixer's answer about ${nonBlocking.length} non-blocking finding(s) could not be read`
      : `${fixed.length} of ${nonBlocking.length} non-blocking finding(s) fixed`,
    ...(left.length > 0 ? [`${left.length} recorded in FOLLOW-UPS.md`] : []),
  ];
  recordAndSay(
    state,
    'ok',
    'review_approved',
    `Review approved after a final fix round - ${parts.join(', ')}`,
    {
      findings: findings.length,
      carriedAndFixed: tolerated.map((f) => f.id),
      nonBlocking: nonBlocking.map((f) => f.id),
      nonBlockingFixed: fixed.map((f) => f.id),
      followUps: left.map((l) => l.finding.id),
    },
  );
}

/**
 * What a final round left of the non-blocking findings it carried (#425).
 *
 * Every one the fixer did not mark `fixed`, with its disposition and reason. A
 * round whose dispositions could not be read (`null`) leaves every one, marked
 * unreadable: that fails closed without claiming the fixer ignored them, which
 * `recordDispositions` forbids. A finding the readable answer left out is
 * already `not-addressed` there, which is a fact rather than a guess.
 */
function leftBy(
  nonBlocking: readonly Finding[],
  dispositions: FixDispositions | null,
): UnaddressedFinding[] {
  if (dispositions === null) {
    return nonBlocking.map((f) => ({ finding: f, outcome: 'unreadable', reason: '' }));
  }
  const left: UnaddressedFinding[] = [];
  for (const f of nonBlocking) {
    const d = dispositions.dispositions.find((x) => x.id === f.id);
    const disposition = d?.disposition ?? 'not-addressed';
    if (disposition === 'fixed') continue;
    left.push({ finding: f, outcome: disposition, reason: d?.reason ?? '' });
  }
  return left;
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
  host?: Host,
): Promise<void> {
  // A process that died inside this round's turn persisted the increment and
  // the marker, and resumes the same round rather than numbering a new one:
  // a renumbered round would answer the wrong review and credit no seat (#393).
  if (!(state.fixInFlight?.final === false && state.fixInFlight.round === state.reviewRound)) {
    state.reviewRound += 1;
  }
  state.fixInFlight = { round: state.reviewRound, final: false };
  saveState(state);
  beginReport(state);

  announceFixRound(state);
  log.step(`Fixing ${blockingFindings(findings).length} blocking finding(s)`, {
    id: 'turn_started',
    data: {
      role: 'implementer',
      kind: 'review-fix',
      round: state.reviewRound,
      blocking: blockingFindings(findings).length,
    },
  });
  const fix = await writeTurn(
    state,
    cfg,
    cwd,
    {
      role: 'implementer',
      prompt: P.fixPrompt(findings, state.reviewRound, state.acceptanceCriteria, state.plan, true),
      planInPrompt: state.plan !== null,
      cwd,
      label: `fix-${state.reviewRound}`,
      jsonSchema: FIX_SCHEMA,
    },
    turns,
    roles,
  );
  const read = readFixOutput(fix);
  recordReport(state, `fix-report-${state.reviewRound}.md`, read.report);
  // Consumed once the turn's report is on disk, and before the commit: a commit
  // that fails must not buy this turn a second time. Everything before this
  // point leaves them outstanding, which is what makes a died-mid-turn resume
  // retry the fix rather than skip it.
  // The record before the consumption, so no stop can leave a consumed round
  // without one: a resume finds the findings still pending and `fixInFlight`
  // still set, and redoes this same round and label, record included (#393).
  recordDispositions(state, read, findings, `fix-${state.reviewRound}`);
  delete state.fixInFlight;
  clearPendingFindings(state);
  writeCheckpoint(
    state,
    'review-round',
    await maybeCommit(cfg, cwd, `vibe: address review round ${state.reviewRound}`),
  );
  await holdAt(state, cfg, host, 'review-round');
}

/**
 * Run the carried findings' reproducers once more, after the round nothing
 * reviews (#113).
 *
 * The prize the issue names, and the one weakness in the loop it can actually
 * remove: a tolerated P1 is fixed in a round that is *by design* not re-reviewed,
 * so OUTSTANDING.md has never been able to say more than that somebody worked on
 * it. A test that failed before the fix and passes after it says the rest.
 *
 * **Only the findings whose reproducer reproduced.** A finding whose test passed
 * against the unfixed code was downgraded to P2 and is not in `tolerated` at all;
 * one that was `unproven` had nothing observed to confirm, and running it again
 * would produce another unattributable result at the same price. This is the
 * question "is the thing we saw still there", and it is only a question for the
 * findings something was seen for.
 *
 * **The baseline is deliberately empty here**, and that is why a failure comes
 * back `unproven` rather than as "still broken". `state.gateOutcomes` names the
 * gates that passed *before* the review, and the fix round has changed the tree
 * since - so a failing gate now could be this finding or could be the fix having
 * broken something else. The very next thing the loop does is run the gates for
 * real, and `verificationCaveat` is what reports that. A pass needs no baseline,
 * for the reason `observe` gives, so the answer this exists to get is the one it
 * can still give honestly.
 */
async function confirmFixed(
  state: RunState,
  cfg: Config,
  cwd: string,
  roles: RoleTable,
  carried: readonly Finding[],
): Promise<Finding[]> {
  if (!cfg.verify.reproducers || !cfg.verify.enabled) return [...carried];

  const gates = resolveGates(cfg.verify, cwd);
  const settled: Finding[] = [];
  for (const f of carried) {
    const reproducer = f.reproducer;
    if (reproducer === undefined || reproductionAt(f, 'review')?.verdict !== 'reproduced') {
      settled.push(f);
      continue;
    }

    log.step(`Re-running the reproducer for ${f.id} after the fix`, {
      id: 'reproducer_started',
      data: { id: f.id, path: reproducer.path, gate: reproducer.gate ?? null },
    });
    const outcome = await observe(f, reproducer, {
      cwd,
      runDir: state.dir,
      gates,
      contract: cfg.toolchain,
      style: pathStyleFor(state, 'reviewer', roles),
      // See the header: the tree has changed since the last observed gate pass.
      passedGates: new Set<string>(),
      at: 'final-fix',
    });
    recordAndSay(
      state,
      outcome.verdict === 'did-not-reproduce' ? 'ok' : 'warn',
      'reproducer_observed',
      `Reproducer for ${f.id} after the fix: ${outcome.verdict} - ${describeOutcome(outcome)}`,
      {
        id: f.id,
        verdict: outcome.verdict,
        at: outcome.at,
        gate: outcome.gate,
        command: outcome.command,
        exitCode: outcome.exitCode ?? null,
        baseline: outcome.baseline,
        reason: outcome.reason,
        archived: outcome.archived,
      },
    );
    // Appended to the finding, not through `applyReproducerOutcomes`: that
    // function's job is the severity, and there is no severity left to move -
    // the run ends after this and the finding is a record rather than an input.
    settled.push({ ...f, reproducerOutcomes: [...reproducerOutcomesOf(f), outcome] });
  }
  return settled;
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
    .map((f) => {
      // Only the observation from *after* the fix. The review-time one says the
      // defect was real, which the finding above already says; this section is
      // answering "and is it gone" (#113).
      const after = reproductionAt(f, 'final-fix');
      const proof = after === null ? '' : `\n*Reproducer:* ${describeOutcome(after)}\n`;
      return `## ${f.title} \`${f.id}\`\n\n${f.detail}\n\n*Suggested fix:* ${f.suggested_fix}\n${proof}`;
    })
    .join('\n');

  // "Nobody has confirmed they are gone" is the whole point of this document and
  // it stops being true the moment a reproducer passes after the fix. Counted
  // rather than assumed, and the sentence names the split: a run where one of
  // three carried findings closed by evidence must not read as though all three
  // did, and must not read as though none did either.
  const closed = findings.filter(
    (f) => reproductionAt(f, 'final-fix')?.verdict === 'did-not-reproduce',
  ).length;
  const confirmation =
    closed === 0
      ? 'So these were worked on, and nobody has confirmed they are gone.'
      : closed === findings.length
        ? 'Every one of them carried a test the reviewer wrote to make it fail, and every one of ' +
          'those tests passes now. That is an observation rather than an assertion, and it is ' +
          'what closes them - not a second opinion about the fix.'
        : `${closed} of them carried a test the reviewer wrote to make it fail, and those tests ` +
          'pass now, which closes them by evidence. The rest were worked on and nobody has ' +
          'confirmed they are gone.';

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
    `exists to close. ${confirmation}\n\n` +
    `Worth a human eye. Set \`loop.p1Tolerance\` to 0 to require a spotless review instead, ` +
    `at the cost of runs that cannot converge.\n\n` +
    body
  );
}

/**
 * The findings a passing round still has work for (#425), or none when
 * `loop.fixNonBlocking` is off - the one switch every new decision reads, so
 * `false` takes the paths that existed before it.
 */
function toAddress(cfg: Config, findings: readonly unknown[]): Finding[] {
  return cfg.loop.fixNonBlocking ? findings.filter(isToAddress) : [];
}

/**
 * `toAddress` for an approved plan (#405): the same switch, and a P2 the
 * critique vote moved goes to the implementer too (`isPlanToAddress`). Equal to
 * `toAddress` on every run without critique verifiers, which is every run that
 * has no vote-moved plan finding.
 */
function planToAddress(cfg: Config, findings: readonly unknown[]): Finding[] {
  return cfg.loop.fixNonBlocking ? findings.filter(isPlanToAddress) : [];
}

/** How FOLLOW-UPS.md names each `UnaddressedFinding` outcome (#425). */
const UNADDRESSED_LABEL: Record<UnaddressedFinding['outcome'], string> = {
  'not-addressed': 'not addressed',
  deferred: 'deferred by the fixer',
  rebutted: 'rebutted',
  unreadable: "the fixer's answer could not be read",
  'not-attempted': 'not attempted: P3s only',
};

/**
 * The findings FOLLOW-UPS.md lists as unconfirmed by vote (#436), in its order.
 *
 * The same filter and the same last-wins dedupe `writeFollowUps` applies, so
 * the end-of-run summary names exactly the entries the file it points to holds
 * under `*Unconfirmed by vote:*` - never a second opinion about which they are.
 */
export function voteMovedFollowUps(state: RunState): Finding[] {
  if (!Array.isArray(state.deferred)) return [];
  return [...new Map(state.deferred.filter(isDeferrable).map((f) => [f.id, f])).values()].filter(movedByVote);
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
  // What a passing review left of its non-blocking findings (#425). Guarded and
  // deduped here for the reason `deferred` is; `isUnaddressed` refuses a P1 and
  // a deferrable finding, so the header's non-blocking claim stays true and
  // nothing is listed under two headings.
  const left = Array.isArray(state.unaddressed)
    ? [...new Map(state.unaddressed.filter(isUnaddressed).map((u) => [u.finding.id, u])).values()]
    : [];

  if (deferred.length === 0 && scope.length === 0 && left.length === 0) {
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
              (movedByVote(f) && f.downgraded !== undefined
                ? `*Unconfirmed by vote:* ${f.downgraded.reason}\n\n`
                : '') +
              `${f.detail}\n\n*Suggested fix:* ${f.suggested_fix}\n`,
          )
          .join('\n'),
    );
  }
  if (left.length > 0) {
    sections.push(
      '## Left by the final fix round\n\n' +
        left
          .map(
            ({ finding: f, outcome, reason }) =>
              `### ${f.title} \`${f.id}\`\n\n*Severity:* ${f.severity}\n\n` +
              `*Fixer's disposition:* ${UNADDRESSED_LABEL[outcome]}${reason === '' ? '' : ` - ${reason}`}\n\n` +
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
      `below the loop gate, which stops only on a P0 ` +
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
  // A repaired `unaddressed` is not a record to render from (#425): the loader
  // replaced or dropped what it could not read, and re-rendering would delete
  // or shorten the one place a passing review's leftovers were written down.
  // So an existing file is kept as it is - unknown beats a false "nothing
  // left". Only this resume-time pass needs it: `unaddressed` is written at the
  // end of a review, after which the only other writer is a resumed final
  // round, whose fresh record is trustworthy and is rendered as usual.
  const repaired = state.events.some(
    (e) => e.type === 'state_repaired' && e['field'] === 'unaddressed',
  );
  if (repaired && hasArtifact(state, 'FOLLOW-UPS.md')) return path.join(state.dir, 'FOLLOW-UPS.md');
  return writeFollowUps(state, plan);
}

// ---------------------------------------------------------------------------

interface GuardArgs {
  cap: number;
  round: number;
  capName: string;
  deadlockMsg: string;
  /**
   * What the plan loop's stall check needs (#394). Passed by the plan caller
   * only, and its presence is the whole gate: the review and verify loops pass
   * nothing and never consult `planStall`.
   */
  stall?: { state: RunState; human: ReadonlySet<string> };
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

/** The `plan_stalled` sentence: what was counted, and what happens next. */
function stallSentence(entry: PlanStallEntry): string {
  const blocking = entry.counts.reduce((a, b) => a + b, 0);
  const fresh = entry.fresh.reduce((a, b) => a + b, 0);
  const head =
    `The last ${entry.counts.length} critiques kept finding new blocking problems ` +
    `(${entry.counts.join(', ')} blocking; ${fresh} of ${blocking} new)`;
  return entry.action === 'step-back'
    ? `${head}. Asking the planner to step back.`
    : `${head} - still not converging after a step-back. Asking you.`;
}

/** The question a second stall asks. The first `OpenQuestion` vibe writes itself. */
export const STALL_QUESTION: OpenQuestion = {
  question:
    'The plan has stopped converging even after the planner was asked to step back. ' +
    'Narrow the brief, accept the plan with its remaining P1s, or continue? ' +
    "To accept them, demote each under 'Change a severity' below and leave this answer empty, then resume.",
  options: ['narrow the brief', 'accept the remaining P1s', 'continue'],
  // No default, deliberately: which of the three is right is the person's call,
  // and `writeEscalation` prints no default line for an empty one.
  recommended: '',
  kind: 'product',
  blocking: true,
};

/**
 * The stop a second stall makes (#394): exit 2, one question, the blockers.
 *
 * The counts are per critique record from the step-back it followed, counted
 * the way `planStall` counts - each record's distinct ids, minus any a person
 * raised - so the message and the detector cannot disagree.
 */
function stallEscalation(
  state: RunState,
  history: readonly RoundRecord[],
  blockers: readonly Finding[],
  human: ReadonlySet<string>,
): Escalation {
  const stalls = state.planStalls ?? [];
  // The latest step-back before the entry just recorded, which is this one.
  const steppedBack = stalls
    .slice(0, -1)
    .filter((s) => s.action === 'step-back')
    .pop();
  const from = steppedBack?.position ?? Math.max(0, history.length - 3);
  const counts = history
    .slice(from)
    .map((r) => [...new Set(r.ids ?? [])].filter((id) => !human.has(id)).length);
  const message =
    `The plan loop stopped converging again after the planner was asked to step back at ` +
    `critique record ${from}. Blocking findings per critique record since then ` +
    `(excluding any a person raised): ${counts.join(', ')}.`;
  return new Escalation(EXIT.NEEDS_HUMAN, message, [{ ...STALL_QUESTION }], [...blockers]);
}

/** Exported for tests: appends to `history`, may log, and may throw `Escalation`. */
export function guardProgress(
  cfg: Config,
  history: RoundRecord[],
  all: readonly Finding[],
  blockers: readonly Finding[],
  { cap, round, capName, deadlockMsg, stall }: GuardArgs,
): void {
  recordRound(
    history,
    p1Signature(all),
    blockers.length,
    blockers.map((f) => f.id),
    // The claim, not only the label. `ids` and `signature` are still written for
    // a process that reads this history on an older build, and are what the
    // guards fall back to for a round recorded before this existed (#116).
    blockers.map((f) => ({ id: f.id, title: f.title })),
  );

  // The plan loop's stall check, before `assessConvergence` so a stall wins
  // when both would fire on the same round (#394). Recorded through
  // `recordAndSay`, whose save is also the one that persists the round just
  // appended and the new `planStalls` entry - so the three land together.
  let stalled: PlanStallEntry | null = null;
  if (stall !== undefined) {
    const { lastStall, action } = stallAction(stall.state.planStalls ?? []);
    const found = planStall(history, {
      stallAfter: cfg.loop.stallAfter,
      lastStall,
      human: stall.human,
    });
    if (found !== null) {
      stalled = { position: history.length - 1, action, counts: found.counts, fresh: found.fresh };
      (stall.state.planStalls ??= []).push(stalled);
      recordAndSay(stall.state, 'warn', 'plan_stalled', stallSentence(stalled), {
        position: stalled.position,
        counts: stalled.counts,
        fresh: stalled.fresh,
        action,
      });
    }
  }
  const escalation =
    stall !== undefined && stalled?.action === 'escalated'
      ? stallEscalation(stall.state, history, blockers, stall.human)
      : null;

  if (stalled === null) {
    const trend = assessConvergence(history, {
      repeatThreshold: cfg.loop.oscillationThreshold,
      window: cfg.loop.convergenceWindow,
      cap,
      round,
    });
    if (trend !== null) {
      throw new Escalation(
        EXIT.NO_CONVERGENCE,
        `Stopping early: ${trend} - ${deadlockMsg}.`,
        null,
        [...blockers],
      );
    }
  }
  // The cap stays the hard ceiling, stall or no stall (#394). A step-back on the
  // cap round is already saved, so a resume with a raised cap sends its block;
  // an escalation on it rides along, question and all, so the person who has to
  // raise the cap is also asked the question the stall would have asked.
  if (round >= cap) {
    throw new Escalation(
      EXIT.NO_CONVERGENCE,
      `Hit ${capName} (${cap}) with ${blockers.length} blocking finding(s) outstanding.` +
        (escalation === null ? '' : ` ${escalation.message}`),
      escalation?.questions ?? null,
      [...blockers],
    );
  }
  if (escalation !== null) throw escalation;

  // Beside the persistence notice and for the same reason - the run is
  // continuing, and every stop above has declined to fire. This one reports a
  // brake that did NOT fire because the claims under a repeated set of ids had
  // changed. It is the mitigation for the one thing the title census could not
  // measure, and it is the same answer `REPHRASED.md` gives for questions: a
  // loosened brake costs a visible line rather than a silent omission (#116).
  const recycled = recycledLabelNotice(history, cfg.loop.oscillationThreshold);
  if (recycled !== null) log.warn(recycled);

  // Last, deliberately: the notice tells the user the run is continuing, which
  // is only true once every stop above has declined to fire. Emitted earlier it
  // said "continuing" on the same round the cap or the trend guard ended the
  // run.
  const notice = persistenceWarning(cfg, history, { cap, capName });
  if (notice !== null) log.warn(notice);
}

/**
 * Put the run on the branch it belongs on, whatever kind of pass this is.
 *
 * Called on every pass since #78, not only on a fresh run, and it decides what a
 * pass needs rather than the call site deciding for it. There are three jobs
 * here and they used to be one:
 *
 * 1. **A fresh run** creates and checks out its branch - unchanged.
 * 2. **A forked run** has a branch ref `vibe fork` created without checking out
 *    (it must not touch the user's tree), flagged by `branchPending`. This is
 *    where it is actually checked out, before any turn is dispatched, because
 *    this is the first moment vibe needs the tree.
 * 3. **Any run whose stored branch exists while HEAD is somewhere else refuses.**
 *    Job 2 leaves HEAD on the fork's branch, so resuming the *parent* afterwards
 *    would commit the parent's work onto the child's branch - silently, and
 *    unrecoverably by reading the log. It is a refusal rather than a warning for
 *    that reason, with `git checkout` and `--no-branch` both named.
 */
/**
 * Say so when a killed turn's work is sitting in a git stash (#96).
 *
 * #77 made a killed run recover its accounting. Nothing recovers its working
 * tree, and an implementer that stashes to get a clean test run defeats every
 * guard at once: `maybeCommit` runs at round boundaries and a turn killed
 * mid-round has committed nothing, `state.baseSha` is correct and says nothing
 * about where the work went, `inFlight` is accounting and deliberately records
 * only what a turn spent, and `prepareGit` checks the branch, not the tree - a
 * stashed tree is CLEAN, so `isDirty` is false. The #87 run left 11.3M tokens of
 * implementation in a stash while every guard reported healthy; it was recovered
 * by hand.
 *
 * Notice, not recover and not refuse. Recovering means popping, a pop can
 * conflict, and a run that pops a stash a human made for their own reasons has
 * taken something that was not its. Refusing is heavier than the problem: the
 * work is safe where it is, and the only thing missing is that anyone knows.
 * This turns a silent loss into a line of output, cannot itself destroy
 * anything, and composes with either of the others later.
 *
 * Fires only where `state.branch` is set, which is what makes it inert on a
 * fresh run without a second fact to store: the branch is created a few lines
 * below, so a run in its first process has none to match against - and a branch
 * this process did not create is exactly a resume or a fork. The match is on the
 * branch name git itself wrote into the entry, so a stash belonging to somebody
 * else is left alone by construction rather than by a heuristic.
 *
 * Not prompted against, either: the implementer was doing the right thing.
 * Establishing whether a flaky test predates your change means testing without
 * your change, and `git stash` is the obvious way. Two runs in this repo have
 * needed the manoeuvre.
 */
async function noticeStrandedWork(state: RunState, cwd: string): Promise<void> {
  const branch = state.branch;
  if (branch === null) return;

  const stashes = await git.stashesFor(cwd, branch);
  if (stashes.length === 0) return;

  log.warn(
    `git stash holds ${stashes.length} entr${stashes.length === 1 ? 'y' : 'ies'} made on this ` +
      `run's branch "${branch}". A turn killed between "git stash push" and "git stash pop" ` +
      'leaves its work there, where nothing else in this run can see it: the tree reads clean ' +
      'and there are no commits, while the accounting says the turn ran.',
  );
  for (const entry of stashes) {
    log.warn(`  ${entry.ref}  ${entry.subject}`);
    // The stat is the evidence that makes this worth acting on - "7 files
    // changed, 319 insertions" is what says a turn's output is in there. Where
    // there is none, the command is named rather than an emptiness asserted.
    log.warn(
      entry.stat === null
        ? `    contents not summarised - run: git stash show -p ${entry.ref}`
        : entry.stat
            .split('\n')
            .map((l) => `    ${l.trim()}`)
            .join('\n'),
    );
  }
  log.warn(
    'Check it before this run does more work. Nothing has been popped - vibe does not touch ' +
      'the stash.',
  );

  recordEvent(state, 'stash_noticed', {
    branch,
    refs: stashes.map((e) => e.ref),
  });
}

/**
 * Which branch this run's commits will land on, said out loud (#223, hi-fi 1).
 *
 * **A promotion, not an invention.** `state.branch` has been durable since the
 * field existed and `prepareGit` has always known which of its six outcomes it
 * took; what it never did was say so on a channel a host can read, so the window
 * could not put the branch in the loop column's identity header the way every
 * frame of the design draws it.
 *
 * Narration with no event, on the `findings_reported` precedent: `state.branch`
 * is already in `state.json`, a resume re-reads it from there, and recording it
 * again would be a second copy of one fact.
 *
 * **`null` is a real answer and is not "unknown".** Branch isolation off,
 * `--no-branch`, or a directory that is not a repository all mean the same
 * thing to a reader — commits land on whatever is checked out — so they collapse
 * honestly, and `why` carries which of them it was.
 *
 * The four sites that already printed keep their level and their wording, so
 * the terminal does not change on any path that was already saying something.
 * The three that said nothing take `detail`: a run whose branch isolation is
 * off does not want a fresh sentence about it every pass, and dim is how this
 * codebase says *restating what you already know*.
 */
function sayBranch(
  branch: string | null,
  why: string | null,
  start?: RunStart,
): { id: string; data: Record<string, unknown> } {
  // The base only when a fresh run just took its branch (#249). Every other path
  // passes none, so a resume and the no-branch paths carry neither field rather
  // than one guessed after the fact.
  return {
    id: 'run_branch',
    data: start === undefined ? { branch, why } : { branch, why, startSha: start.sha, startRef: start.ref },
  };
}

/**
 * The commit the preflight gate resolved `git.baseRef` to, for the run it was
 * resolved for (#249).
 *
 * **A module latch rather than a field**, and it is the only honest place for
 * it. The base is resolved ONCE, in preflight, before anything is spent - and
 * the branch of a run with no worktree is made later, by `prepareGit`. Reading
 * the ref again there would be a second resolution, and a fetch in between would
 * start the branch at a commit the dirty-tree check never looked at. A state
 * field would be durable, and preflight deliberately writes nothing durable
 * about the branch: a run stopped between the two must not come back holding a
 * base for a branch it never took. Safe for `cancel.ts`'s reason - one run per
 * process - and keyed by run id so a value from another run is never read.
 */
let chosenBase: { runId: string; sha: string } | null = null;

/** Set by the preflight gate; null clears it. `execute` clears it on the way in. */
export function chooseBase(runId: string, sha: string | null): void {
  chosenBase = sha === null ? null : { runId, sha };
}

/**
 * Exported for `worktree.test.ts` only (#223): the case that a branch made as a
 * ref before a worktree script ran is adopted rather than re-created needs the
 * function itself, and the whole loop is a heavy way to reach one branch.
 */
export async function prepareGit(
  state: RunState,
  cfg: Config,
  cwd: string,
  resume: boolean,
): Promise<void> {
  // A fork that has not yet been put on its branch. Checked before anything
  // else, because every early return below would otherwise let its first turn
  // run - and commit - on whatever happens to be checked out.
  const owed = cfg.git.useBranch && state.branchPending === true;

  // `repoStatus`, so a git binary that cannot be resolved or spawned is an
  // answer here rather than a throw. `isRepo` only tolerates a git that RAN and
  // exited nonzero; a missing `VIBE_GIT_BIN` made this line take down a
  // plan-only run - which needs nothing from git at all - with a generic error
  // before the first planning turn (#71, review round 2). The work that reaches
  // this function without a repository is precisely the work that does not need
  // one: a full run has already been refused by `gitPrecondition` in the
  // preflight gate, and a finished run returns a few lines below without
  // dispatching a phase.
  const { isRepo, error } = await git.repoStatus(cwd);
  if (!isRepo) {
    if (owed) {
      // Still a refusal, and for the same reason: a fork that cannot be put on
      // its branch would otherwise run - and commit - on whatever is checked
      // out. Only the cause differs, so only the cause is reworded.
      throw new Escalation(
        EXIT.ERROR,
        `Run ${state.id} was forked onto branch "${String(state.branch)}", but ` +
          (error === null
            ? `${cwd} is not a git repository`
            : `git could not be run against ${cwd} (${error})`) +
          ', so it cannot be put on it. Nothing has run. Point the run at the repository it ' +
          'was forked in, or resume with --no-branch to run here anyway.',
      );
    }
    // Only on a fresh run, as before: a resume said this once already, and
    // repeating it every pass would be new output for an unchanged situation.
    //
    // Since #71 only a plan-only or already-finished run reaches this line: a
    // full run is refused by `gitPrecondition` before the loop starts, because
    // its review phase would have died on `git diff --cached` an hour later.
    // The not-a-repository wording is unchanged because it stays true of the
    // runs that still get here - they do run, and they do so without branch
    // isolation or commits. The broken-binary case is named rather than folded
    // into it: "not a git repository" would be a false statement about a
    // directory that may well be one.
    if (!resume) {
      log.warn(
        error === null
          ? 'Not a git repository - running without branch isolation or commits.'
          : `git could not be run (${error}) - running without branch isolation or commits.`,
        sayBranch(null, error === null ? 'not a git repository' : `git could not be run: ${error}`),
      );
    } else {
      // A resume said this once already and repeating it would be new output for
      // an unchanged situation - but a window that connected on this pass has
      // never been told, so the fact travels at `detail`.
      log.detail(
        'Running without branch isolation or commits.',
        sayBranch(null, error === null ? 'not a git repository' : `git could not be run: ${error}`),
      );
    }
    return;
  }
  // Fresh runs only, and not merely to keep the output identical: "they will be
  // swept into the first commit" is a claim about a run that has not committed
  // yet, and it is false on a resume.
  if (!resume && (await git.isDirty(cwd))) {
    log.warn('Working tree has uncommitted changes; they will be swept into the first commit.');
  }
  // Before the branch work below, and before `useBranch` can return: a run
  // resumed with `--no-branch` to escape the refusal is one whose stranded work
  // is if anything more likely to be missed.
  await noticeStrandedWork(state, cwd);

  // With branch isolation off nothing below runs, which is also what makes
  // `vibe resume <id> --no-branch` the documented escape from the refusal.
  if (!cfg.git.useBranch) {
    log.detail(
      'Branch isolation is off; commits land on whatever is checked out.',
      sayBranch(null, 'branch isolation is off'),
    );
    return;
  }

  if (state.branch === null) {
    // A run that has no branch is one that never got one - it was started with
    // `--no-branch`, or outside a repository, or before this field existed.
    // Creating one now would move HEAD on a run that has already done work
    // somewhere else, which is a bigger change than the wrong-branch refusal
    // this function exists to make. Branch creation stays a fresh-run act.
    if (resume) {
      log.detail(
        'This run never had a branch of its own; commits land on whatever is checked out.',
        sayBranch(null, 'this run never had a branch'),
      );
      return;
    }
    const branch = git.runBranch(cfg, state) ?? `${cfg.git.branchPrefix}${state.id}`;
    // **It may already exist**, and only for one reason (#223): a run with a
    // worktree has its branch created as a ref before the setup script runs, so
    // the script can be told `VIBE_BRANCH` and put the worktree on it. Adopt it
    // rather than `checkout -b` it again, which would fail on a branch that is
    // there. Run ids are unique, so nothing else leaves one of these behind -
    // and a name `--branch` chose is refused by `cmdRun` and again by the
    // preflight gate when it already exists (#356), so the one this adopts is
    // still only ever the ref the worktree site made for this run.
    if (await git.branchExists(cwd, branch)) {
      if ((await git.currentBranch(cwd)) !== branch) {
        // **Never move a worktree silently** (#249). A checkout that moves
        // nothing is the default path - the tree was detached at the branch's
        // own commit - and is allowed. One that would move it is the #169
        // defect: the setup script chose a commit, this checkout replaced it
        // with HEAD's, and the run started from a base nobody chose. So it is
        // refused, naming both commits, before anything is spent - whether or
        // not `git.baseRef` is set.
        const here = await git.resolveCommit(cwd, 'HEAD');
        const tip = await git.resolveCommit(cwd, `refs/heads/${branch}`);
        if (here !== tip) {
          throw new Escalation(
            EXIT.ERROR,
            `Run ${state.id}'s ${state.worktree === true ? 'worktree' : 'checkout'} is at ` +
              `${here ?? 'no commit'}, but its branch "${branch}" is at ${String(tip)}. vibe will ` +
              'not move it there silently (#249) - that is how a run starts from a base nobody ' +
              'chose. Nothing has run and no turn was dispatched.\n' +
              'The worktree setup command should check the branch out rather than choose a ' +
              'commit: git worktree add "$VIBE_WORKTREE" "$VIBE_BRANCH". To choose where runs ' +
              'start, set git.baseRef.',
          );
        }
        const result = await git.checkoutBranch(cwd, branch);
        if (!result.ok) {
          throw new Escalation(
            EXIT.ERROR,
            `Run ${state.id} could not be put on its branch "${branch}": ${result.error}\n` +
              'Nothing has run and no turn was dispatched. If the worktree setup command checked ' +
              'it out somewhere else, check it out in the worktree instead (git worktree add ' +
              '"$VIBE_WORKTREE" "$VIBE_BRANCH"), then resume.',
          );
        }
      }
    } else {
      // At the commit the preflight gate resolved `git.baseRef` to, when it is
      // set (#249) - the exact sha, handed over rather than read again. With no
      // worktree the branch is made here and nowhere else, so a run stopped
      // before this line leaves the repository untouched. A base that is set and
      // was never resolved is refused rather than guessed: a gate that did not
      // run is not permission to start from HEAD.
      let at: string | undefined;
      if (cfg.git.baseRef !== null) {
        if (chosenBase === null || chosenBase.runId !== state.id) {
          throw new Escalation(
            EXIT.ERROR,
            `git.baseRef is "${cfg.git.baseRef}", but this run's preflight never resolved it, so ` +
              `there is no commit to start branch "${branch}" at. Nothing has run.`,
          );
        }
        at = chosenBase.sha;
      }
      await git.createBranch(cwd, branch, at);
    }
    // The branch and where it started, in ONE save (#249), so neither is ever on
    // disk without the other. The tip is read rather than assumed: nothing has
    // committed on the branch yet, so it is the commit the run starts from. A
    // repository with no commits has no tip and records no start.
    const tip = await git.resolveCommit(cwd, `refs/heads/${branch}`);
    state.branch = branch;
    if (tip !== null) state.start = { sha: tip, ref: cfg.git.baseRef };
    saveState(state);
    const from =
      state.start === undefined
        ? ''
        : ` from ${state.start.ref ?? 'HEAD'} (${state.start.sha.slice(0, 7)})`;
    log.ok(`Isolated on branch ${branch}${from}`, sayBranch(branch, null, state.start));
    return;
  }

  const branch = state.branch;
  const exists = await git.branchExists(cwd, branch);

  if (!exists) {
    // Nothing to check out, and recreating it at HEAD would fabricate a base the
    // run never had. A fork whose ref was deleted is the stronger case: it has
    // never been on that branch, so continuing would run it somewhere it never
    // claimed.
    if (owed) {
      throw new Escalation(
        EXIT.ERROR,
        `Run ${state.id} was forked onto branch "${branch}", which no longer exists. ` +
          'Nothing has run. Fork again, or resume with --no-branch to run on whatever is ' +
          'checked out.',
      );
    }
    log.warn(
      `The branch this run recorded ("${branch}") no longer exists - continuing on HEAD.`,
      sayBranch(null, `the recorded branch "${branch}" no longer exists`),
    );
    return;
  }

  const head = await git.currentBranch(cwd);
  if (head === branch) {
    // Already there. A fork resumed twice takes this path the second time.
    if (owed) {
      delete state.branchPending;
      saveState(state);
    }
    log.detail(`On branch ${branch}`, sayBranch(branch, null));
    return;
  }

  if (owed) {
    const result = await git.checkoutBranch(cwd, branch);
    if (!result.ok) {
      throw new Escalation(
        EXIT.ERROR,
        `Run ${state.id} could not be put on its branch "${branch}": ${result.error}\n` +
          'Nothing has run and no turn was dispatched. Commit or stash the changes in the way, ' +
          'then resume.',
      );
    }
    delete state.branchPending;
    saveState(state);
    log.ok(`On branch ${branch}`, sayBranch(branch, null));
    return;
  }

  // The stored branch exists and HEAD is elsewhere - including a detached HEAD,
  // which `currentBranch` reports as "HEAD". Committing here would put this
  // run's work on a branch it never claimed, which no amount of reading the log
  // afterwards can undo.
  throw new Escalation(
    EXIT.ERROR,
    `Run ${state.id} records branch "${branch}", but ${head === 'HEAD' ? 'HEAD is detached' : `"${String(head)}" is checked out`}. ` +
      'Its commits would land on the wrong branch, so nothing has run.\n' +
      `  git checkout ${branch}\n` +
      'then resume - or resume with --no-branch to run on what is checked out.',
  );
}

/**
 * Commit the round, and say honestly what happened.
 *
 * The sha used to be discarded and `null` meant both "nothing was staged" and
 * "the commit failed"; a checkpoint has to record which, and has to record a
 * *full* id, because it is read months later.
 */
async function maybeCommit(
  cfg: Config,
  cwd: string,
  message: string,
): Promise<{ sha: string | null; note: CheckpointCommitNote }> {
  if (!cfg.git.commitEachRound) return { sha: null, note: 'commits-disabled' };
  if (!(await git.isRepo(cwd))) return { sha: null, note: 'not-a-repo' };
  // **Read before the commit, because that is the only moment it is knowable.**
  // A round's diff is `what HEAD was`..`what HEAD became`, and once the commit
  // has landed the first half is gone unless something wrote it down. The
  // alternative a host would be left with is pairing consecutive commits in
  // narration order - which is a derivation, and one that silently produces a
  // cumulative diff labelled as a single round the first time a run is resumed
  // and the earlier commits were narrated to a process that has exited.
  //
  // `markBase` rather than a second `rev-parse` spelled out here: it already
  // answers null in a repository with no commits yet, which is the greenfield
  // first round and a real state rather than a failure.
  const since = await git.markBase(cwd);
  const result = await git.commitAll(cwd, message);
  if (result.sha === null) {
    return { sha: null, note: result.why === 'failed' ? 'commit-failed' : 'nothing-to-commit' };
  }
  // A commit that succeeded but whose id is not a 40-hex object id records the
  // absence and why, rather than a string no later reader could resolve.
  if (!git.isFullSha(result.sha)) {
    log.warn(`git named the new commit "${result.sha}", which is not an object id - not recorded`);
    return { sha: null, note: 'sha-unusable' };
  }
  /*
   * What this round put in the history, and the range that is (#223).
   *
   * **Narration with no event, on the `recordAndSay` rule**: it is already
   * durable, twice over - the commit is in git, and the checkpoint this becomes
   * records the sha in its own meta. What was missing was any way for something
   * watching the run to learn it *while the run was going*, which is what the
   * Code tab is: a run can be committing every round for ninety minutes and a
   * host could not show one of them.
   *
   * `since` travels with it because a range with one end is not a range. Null is
   * a real answer here - a first commit in a repository that had none - and the
   * honest reading of it is "everything up to this commit", which is exactly
   * what `git diff` does with an empty tree on the left.
   */
  log.ok(`Committed ${result.sha.slice(0, 7)}`, {
    id: 'round_committed',
    data: { sha: result.sha, since, message },
  });
  return { sha: result.sha, note: 'committed' };
}

/** A boundary that never commits: the checkpoint says so rather than implying a failure. */
const NO_COMMIT = { sha: null, note: 'no-commit-in-round' } as const;

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
    // Said as well as recorded (#223). This is the one promoted site that adds a
    // line a terminal did not print before, and it is the one that most needed
    // it: a run with verification off looked exactly like a run whose gate had
    // not come round yet, in the terminal and on the wire both.
    recordAndSay(
      state,
      'info',
      'verify_disabled',
      `Verification is disabled - ${String(gates.length)} gate(s) will not run`,
      { gates: gates.map((g) => g.name), round: state.reviewRound },
    );
    return null;
  }

  for (const gate of gates) {
    // The round travels with every verify frame (#223). `state.gateOutcomes` is
    // reset on each pass, so a window watching the stream has no other way to
    // tell the second gate of one pass from the first gate of the next - and
    // `5d`'s failed-runs trend is a comparison ACROSS passes, which needs them
    // separated. `reviewRound` rather than `verifyRound` because that is what
    // the verify artifacts are keyed by, and a pane numbering them differently
    // would not match the filenames.
    log.step(`Verifying: ${gate.name}`, {
      id: 'verify_started',
      data: { gate: gate.name, round: state.reviewRound },
    });
    const result = await runGateCommand(cwd, gate, cfg.toolchain);

    if (result.unavailable !== null) {
      // Pushed before the event, which persists: the outcome and the event that
      // explains it then land in one write rather than two.
      outcomes.push({
        name: gate.name,
        status: 'unavailable',
        command: null,
        runs: 0,
        required: gate.required,
      });
      // Say so rather than letting silence read as a pass - and carry on to the
      // next gate, which may well have a command. One call rather than two since
      // #223: the same sentence at the same level, now carrying the id.
      recordAndSay(
        state,
        'warn',
        'verify_unavailable',
        `Gate ${gate.name} unavailable: ${result.unavailable}`,
        { gate: gate.name, reason: result.unavailable, required: gate.required, round: state.reviewRound },
      );
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
      outcomes.push({
        name: gate.name,
        status: 'passed',
        command: result.command,
        runs: result.runs,
        required: gate.required,
      });
      recordAndSay(
        state,
        'ok',
        'verify_passed',
        `Gate ${gate.name} passed: ${result.command} (${result.runs}x)`,
        {
          gate: gate.name,
          command: result.command,
          runs: result.runs,
          round: state.reviewRound,
          attempts: result.attempts,
        },
      );
      continue;
    }

    // "failed 1 of 3 runs" rather than "attempt 1 of 3" (#135). The old line was
    // read as a fraction and was not one: the loop returned on the first
    // non-zero exit, so `runs` was the attempt that failed and the sentence said
    // "attempt 1 of 1" for every failure of a three-run gate.
    const flaky = verdictOf(result) === 'flaky';

    // Every attempt's whole output, as a file of its own (#248). Passing attempts
    // of a flaky gate included: the difference between the run that passed and
    // the one that failed is the evidence a race leaves. Keyed by the review
    // round, the verify round (before the caller increments it), the gate and the
    // attempt, so neither the other gate nor the next verify-fix pass under the
    // same review round can overwrite it. Uncapped, because it is a file and the
    // excerpt below is what is bounded. Gate names pass `GATE_NAME_RE`, so the
    // name is always an artifact basename.
    const logs = result.attempts.map((a, i) => {
      const name = `verify-${state.reviewRound}-${state.verifyRound}-${gate.name}-${a.run}.log`;
      return { run: a.run, ok: a.ok, name, path: path.resolve(artifact(state, name, result.outputs[i] ?? '')) };
    });
    const firstLog = logs.find((l) => l.run === result.failedRun) ?? null;
    const firstIndex = firstLog === null ? -1 : logs.indexOf(firstLog);
    // The excerpt the fixer reads and `verify-failure-<n>.txt` holds, naming the
    // attempt whose output it cuts. Built here rather than in `runGateCommand`
    // because only this site has written the file the marker points at.
    const shown: VerifyResult = {
      ...result,
      output: excerpt(result.outputs[firstIndex] ?? result.output, firstLog?.path ?? null),
    };
    const failedLogs = logs.filter((l) => !l.ok).map((l) => ({ run: l.run, path: l.path }));

    const failed: GateOutcome = {
      name: gate.name,
      status: 'failed',
      command: result.command,
      runs: result.runs,
      failed: failedRuns(result),
      required: gate.required,
    };
    outcomes.push(failed);
    recordAndSay(
      state,
      'warn',
      'verify_failed',
      `Gate ${gate.name} failed ${failedRuns(result)} of ${result.runs} run(s): ${result.command}` +
        (flaky ? ' - it is not deterministic' : ''),
      {
        gate: gate.name,
        command: result.command,
        failedRun: result.failedRun,
        exitCode: result.exitCode,
        // The fraction, on the durable record: a reader of the archive asking
        // "was this suite ever noisy" has no other way to find out, and the
        // preserved output is one run's.
        runs: result.runs,
        failed: failedRuns(result),
        verdict: verdictOf(result),
        round: state.reviewRound,
        // What every attempt did, in order (#135's own field). `failedRun` says
        // which one failed and this says what the others did, which is the whole
        // difference between "this suite is broken" and "this suite is not
        // deterministic" - and `5d` draws a card per attempt from it rather than
        // placing one failure among N slots and guessing at the rest.
        //
        // On the durable record as well, which the fraction beside it already
        // argued for: a reader of the archive asking "was this suite ever noisy"
        // has no other way to find out, and three small objects on the gates
        // that failed is not what #133 was protecting `state.events` from.
        //
        // Each carries `log`, the basename of that attempt's full output (#248).
        // The window opens what it is told and never composes `verify-…log` from
        // the rounds it already has: that would be the loop's naming convention
        // copied into a process that cannot be kept in step with it. The OUTPUT
        // is deliberately not here - it is in the file, which is #133's line.
        attempts: result.attempts.map((a, i) => ({ ...a, log: logs[i]?.name ?? null })),
      },
    );
    artifact(state, `verify-failure-${state.reviewRound}.txt`, shown.output);

    // What the failing command PRODUCED, on the failing branch only (#62). Not
    // on the unavailable or unlaunchable paths above: nothing ran there, so
    // there is nothing the command produced. `verifyRound + 1` because the
    // counter is incremented after this function returns, which makes this the
    // same number as the `verify-fix-<n>.md` report that answers this failure.
    if (gate.artifacts.length > 0) {
      const preserved = preserveGateArtifacts(
        state,
        cwd,
        gate.name,
        state.verifyRound + 1,
        gate.artifacts,
        cfg.verify.artifactMaxBytes,
      );
      failed.artifacts = preserved;
      const copied = preserved.entries.filter((e) => e.status === 'copied').length;
      const links = preserved.entries.reduce((n, e) => n + (e.skippedLinks?.length ?? 0), 0);
      // The size is reported whether or not a ceiling is set: copying a report
      // into the user's repository is never silent.
      log.info(
        `Gate ${gate.name}: kept ${copied} of ${preserved.entries.length} artifact paths ` +
          `(${preserved.bytes} bytes) under ${preserved.dir}` +
          (links > 0 ? `; ${links} link${links === 1 ? '' : 's'} refused` : ''),
      );
      // tryRecordEvent, never recordEvent: `saveState` rethrows, and a throw
      // here would replace a gate failure the loop knows how to fix with
      // EXIT.ERROR - the audit trail of a side effect destroying the thing it is
      // about. `verify_failed` above is already persisted, so the exit rule's
      // input is safe whatever this write does.
      tryRecordEvent(state, 'gate_artifacts', {
        gate: gate.name,
        round: state.verifyRound + 1,
        dir: preserved.dir,
        bytes: preserved.bytes,
        entries: preserved.entries,
      });
    }

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
      detail: describeFailure(shown, failedLogs),
      // Beside `describeFailure` in `verify.ts` rather than written here (#135).
      // The two sentences have to agree about which kind of failure this is -
      // a detail that says "not deterministic" over a fix that says "make it
      // pass" is worse than either alone - and they cannot disagree if one
      // module owns both.
      suggested_fix: suggestedFix(shown),
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
  /** The builder already supplied the plan; a fresh session need not repeat it. */
  planInPrompt?: boolean | undefined;
  cwd: string;
  /** The retry label, the progress label, and - for Codex - the output name. */
  label: string;
  /**
   * Omitted at every call site in this file: how long a turn gets is a property
   * of the role, and `turnTimeoutMs` reads it off the same table this dispatch
   * does. Still accepted, for a caller that has a reason of its own.
   */
  timeoutMs?: number | undefined;
  /**
   * The response schema the turn is constrained to, on either provider, or
   * absent for the role's own (`RoleSpec.schema`). The two review fix turns
   * set `FIX_SCHEMA` (#393); a writer given one gets its output back as text
   * when it does not parse - see `CodexTurnOptions.unparseable`.
   */
  jsonSchema?: object | undefined;
  /** Claude only: the tools the turn may use. */
  tools?: readonly string[] | undefined;
  /**
   * The config path of the review seat taking this turn - `review.finders[0]`,
   * `review.verifiers[1]` - or absent for a role's own turn (#388 Part C).
   *
   * Read only by the sentences that name a setting a user would edit: a seat's
   * model, timeout or MCP grant that fails mid-turn names the seat's line rather
   * than `roles.reviewer`, which it did not come from. Absent, every one of
   * those sentences is byte-identical to what it was.
   */
  seatPath?: string | undefined;
}

export interface TurnOutcome {
  /** Claude: the result text. Codex: the raw last-message file. */
  text: string;
  /** Codex: its parsed structured output. Null for Claude, and for a turn with no schema. */
  structured: unknown;
  /**
   * What the turn did, from its heartbeat, or absent when nothing measured it.
   *
   * Carried out of the dispatch rather than read from state, because the caller
   * that has to act on it - `groundAndRecord` - is judging *this* turn and a
   * later reader could not tell which turn a stored figure belonged to (#66).
   */
  activity?: TurnActivity | undefined;
}

/**
 * What a turn event says about the turn's activity, or nothing at all (#66).
 *
 * Two fields rather than the nested object: `items` is the kinds and `toolItems`
 * the count the rule reads, and an event log a human greps is better served by
 * a flat key than by `activity.tool`. Both omitted together when the turn was
 * unmeasured - never `toolItems: 0`, which would assert an idle turn where
 * there was only an unobserved one.
 */
function activityEvent(activity: TurnActivity | undefined): Record<string, unknown> {
  return activity === undefined ? {} : { items: activity.items, toolItems: activity.tool };
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
    // Restate the immutable brief for every role, including continuing judges.
    // The initial planning builder already renders it; user decisions still
    // travel separately so a model's recommendations cannot acquire authority.
    prompt:
      (req.role === 'planner' && req.label === 'plan'
        ? ''
        : P.taskContext(state.task, state.extraContext)) +
      P.userDecisions(state.humanAnswers) + req.prompt,
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
 * travel with it either way. Revision and fix builders now restate the plan on
 * every turn; `planInPrompt` avoids duplicating it in the fresh-session prefix.
 * Other callers retain the restoration fallback. The full plan document, not
 * `plan_md`: the boundary the plan drew is part of the plan of record, and a
 * session rehydrated without it can revise the plan into a different one without
 * ever being told it had a boundary.
 *
 * Shared by both dispatch paths, and scoped to the generative roles. A Codex
 * implementer must run with `--no-codex-session` (config refuses the pair), so
 * it has no thread memory at all - without this it would be asked to fix code
 * against a plan it cannot see. A judging role is excluded: its prompts restate
 * the plan themselves and take an explicit `hasMemory`.
 */
function freshConversationPrefix(
  state: RunState,
  role: Role,
  hasMemory: boolean,
  planInPrompt = false,
): string {
  if (hasMemory || !GENERATIVE_ROLES.includes(role)) return '';
  return (
    P.handoffContext(
      state.handoff,
      planInPrompt ? null : planOfRecord(state, role),
      state.handoffStale === true,
    ) +
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
 * Say which of the role's own settings this turn ran under, on the way out of a
 * failure.
 *
 * A user who set `roles.reviewer.model` and is shown `codex.model` edits the
 * wrong line - and since #60 the two keys can hold different strings, so the
 * provider key is no longer a safe thing to name. Nothing here classifies the
 * failure: the note states what the turn ran and where the value came from,
 * which is true of a timeout, a rate limit and an unknown model alike. There is
 * deliberately no retry and no fallback to the provider's model - a model the
 * user named and vibe silently replaced is the failure this key's design is
 * strict to prevent.
 *
 * The timeout is the second fact it states (#84), which is why this is no longer
 * called `noteModelProvenance`. It is the same failure by another route: four
 * provider keys can set a turn's timeout and `proc.ts` reports the figure and
 * never the key, so a user raises the wrong one. One function rather than two,
 * because the `stack`-before-`message` order below has to happen exactly once
 * per error however many notes are owed.
 *
 * Added only where the role named a setting of its own, so no run that sets
 * nothing has its error text changed - and a run that names only a model gets
 * exactly the one note it got before.
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
function noteRoleProvenance(
  err: unknown,
  role: Role,
  cfg: Config,
  roles: RoleTable,
  /** The figure this turn actually ran with - `DispatchRequest.timeoutMs`. */
  timeoutMs: number,
  /** The review seat's path, when a seat took the turn - see `TurnRequest.seatPath`. */
  seatPath?: string,
): unknown {
  const spec = roles[role];
  // The guard that keeps a run setting nothing byte-identical: no per-role
  // setting, no note.
  const notes: string[] = [];
  if (spec.model !== undefined) {
    notes.push(`[this turn ran ${modelSource(role, roles, seatPath)} = "${modelFor(role, cfg, roles)}"]`);
  }
  // A bare number, no unit: the key names the unit, and `proc.ts`'s own "timed
  // out after 5400000ms" is already in the same message.
  //
  // Only where the role's figure is the one the turn ran under. A caller that
  // passed an explicit `timeoutMs` overrode the table, and a note naming a key
  // that did not apply sends the user to edit the wrong line - which is the
  // failure this whole mechanism exists to prevent, committed by the mechanism
  // itself. No orchestrator call site does that today; the tests do, and a
  // future one that starts to gets silence rather than a false statement.
  if (spec.timeoutMs !== undefined && spec.timeoutMs === timeoutMs) {
    notes.push(`[this turn ran ${seatPath ?? `roles.${role}`}.timeoutMs = ${spec.timeoutMs}]`);
  }
  if (notes.length === 0 || !(err instanceof Error)) return err;
  // Per note, so an error that has already been through here once - and there is
  // no such path today - gains only what it is missing.
  const fresh = notes.filter((each) => !err.message.includes(each));
  if (fresh.length === 0) return err;
  const note = fresh.join(' ');
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

/**
 * What this turn must know before it is spawned: the parent conversation it owes
 * a fork of, or null - and, on the way past, that the slot's id is about to be
 * handed to the provider.
 *
 * ONE write, and it happens *before* the turn. Both facts are pre-turn for the
 * same reason: they are the facts that matter precisely when no result ever
 * arrives. The counter and the disclosure it justifies land together, so no
 * interruption can leave a state carrying `attempts: 2` without the
 * `fork_retried` event beside it, or the event without the counter.
 *
 * The counter is not decoration. A Codex thread id is provider-minted, so a
 * process that dies between the provider returning and the accounting write
 * loses the id and the next pass forks again - leaving one orphaned thread on
 * the provider's side. That is bounded and it is disclosed here, rather than
 * being made invisible.
 *
 * The registration is #74: `claude --session-id` spends the id on attempt, so a
 * state that has not recorded the handover before the spawn cannot tell a killed
 * turn from one that never ran, and re-issues an id the CLI refuses. It costs
 * one extra write per Claude session - the first turn, and the first turn after
 * each rotation - and none at all on the Codex path, where the provider mints
 * the id and there is nothing to hand over (D7).
 */
function noteSpawn(state: RunState, cfg: Config, slot: SlotName): string | null {
  const forkFrom = slotForkParent(state, cfg, slot);
  if (forkFrom !== null) {
    const attempt = noteSlotForkAttempt(state, slot);
    if (attempt > 1) stageEvent(state, 'fork_retried', { slot, parentId: forkFrom, attempt });
  }
  const registered = noteSlotRegistered(state, slot);
  // Only where something changed, so a run that owes no fork and has already
  // registered writes exactly as often as it did before this existed.
  if (forkFrom !== null || registered) saveState(state);
  return forkFrom;
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
  // The MCP servers this role was granted, as the definitions `--mcp-config`
  // re-supplies under `--strict-mcp-config` (#138). Resolved once, outside the
  // retry, because no attempt changes the files it reads. Preflight has already
  // refused a name that does not resolve; this throws the same sentence for a
  // run that skipped it or a file that changed since. `repoDir` because a
  // worktree's cwd is not where the repository's `.mcp.json` lives.
  const granted = mcpServersFor(req.role, roles);
  const mcpServers =
    granted.length === 0
      ? {}
      : resolveClaudeGrants(
          req.role,
          granted,
          claudeMcpDefinitions({
            cwd: req.cwd,
            repoDir: state.targetDir,
            home: os.homedir(),
            configDir: process.env['CLAUDE_CONFIG_DIR'],
          }),
          req.seatPath ?? `roles.${req.role}`,
        );

  // A rotation that could not be overlapped with Codex work happens here, at a
  // turn boundary - never mid-turn. Asked with *this* turn's model rather than
  // the rotating role's: the question is whether the conversation is too full
  // for the turn about to use it, and the reset that follows has to tag the
  // model the next measurement will be taken under. Where the planner and the
  // implementer name different models this is the boundary that fires once.
  //
  // Never for a turn on a slot that holds no conversation of the run (#388
  // Part B). A finder on `fresh-claude` is not about to use `main`, and asked
  // under its own model - one `main` was never measured under - `shouldRotate`
  // answers "unmeasured, so rotate", which would compact the implementer's
  // session in the middle of a review it takes no part in.
  const perTurn = perTurnSlot(slot);
  if (!perTurn && shouldRotate(state, cfg, roles, model)) {
    await rotateSession(state, cfg, turn, roles, model);
  }

  // The `await` a plain assignment would have done, wrapped so a failure can say
  // which setting named the model it ran. Outside the retry, so a turn that is
  // waited out and retried is annotated once, when it finally gives up.
  let result: ClaudeTurnResult;
  try {
    result = await withRateLimitRetry(
      state,
      cfg,
      req.label,
      'claude',
      () => {
        // Everything a spawn depends on is asked PER ATTEMPT (#74). It used to
        // be computed once outside this closure while the id was read inside it,
        // so a turn that hit a rate limit, waited, and retried re-issued
        // `--session-id` against an id its own first attempt had already spent -
        // and the wait bought nothing, because "already in use" is not a rate
        // limit and is not retried.
        //
        // Ordering: `dead` and the prompt are both read BEFORE `noteSpawn` marks
        // this slot registered, or a genuinely fresh first attempt would see its
        // own registration and mistake itself for a session that died mid-turn.
        //
        // Synchronous, and returning the provider's promise unawaited: this is
        // the seam `turn-seam.test.ts` measures in microtasks, and an `async`
        // wrapper here puts one more await between a provider result and its
        // accounting.
        const dead = slotHasDeadTurn(state, slot);
        // Continuity, not `resume`: a forked conversation arrives holding the
        // parent's context, and so does a resumed dead one, so greeting either
        // as fresh would be false. Rebuilt per attempt because a reset between
        // two of them turns a continuing conversation into a genuinely fresh
        // one, and a retry carrying the first attempt's prefix would start that
        // fresh session without the handoff or the plan of record.
        const prompt =
          freshConversationPrefix(
            state, req.role, slotContinuity(state, cfg, slot), req.planInPrompt,
          ) + req.prompt;
        // A registered id with no successful turn means an attempt was made here
        // and never returned: a previous process died on it, or - since #91 - an
        // earlier attempt of this very turn was rate limited. A failure that left
        // the conversation unusable resets the slot, so it cannot mean anything
        // else. Both readings want the same thing and that is why one rule
        // serves them: the session is resumable and holds the attempt's work; and
        // where a fork was owed, the child already holds the parent's whole
        // history, because `--fork-session` copies at session creation rather
        // than at turn completion. So the fork is already made: resume it, and
        // do NOT fork again.
        const forkFrom = dead ? null : noteSpawn(state, cfg, slot);
        // A fork is not a resume: `--fork-session` copies the parent into a new
        // session rather than continuing one, so `--resume` alone would continue
        // the parent's own conversation and put two runs in it.
        const resume = dead || (forkFrom === null && slotHasMemory(state, cfg, slot));
        return turn({
          prompt,
          sessionId: ensureSlotId(state, slot),
          resume,
          ...(forkFrom === null ? {} : { forkFrom }),
          permissionMode: claudePermission(access),
          model,
          effort: effortFor(req.role, cfg, roles),
          cwd: req.cwd,
          jsonSchema: req.jsonSchema,
          tools: req.tools,
          timeoutMs: req.timeoutMs,
          mcpServers,
          progress: progressOptions(state, cfg, req.label, model, 'claude'),
        });
      },
      // Every observed failure that left the conversation UNUSABLE (#91).
      //
      // #74 reset on every observed failure, full stop, which bought the
      // dispatch rule its unambiguity - a slot still registered-and-unstarted
      // could then only be one a killed process left behind - at the price of
      // discarding a session on the one failure class that is known not to have
      // damaged it. That price is highest exactly where it is paid most often:
      // the first Claude turn of a run is the plan turn, and a rate limit there
      // made the run wait as much as `budget.maxWaitMinutes` and then REDO the
      // work in a fresh conversation instead of resuming the one it had paid
      // for. `failureSparedConversation` is where that class is named, on the
      // error's type rather than on its text.
      //
      // Gated here rather than moved to the outer catch, which is the shape that
      // looks right and is not: past the wait cap the loop THROWS, so a reset in
      // the catch would give up an intact session at the exact moment the run is
      // exiting resumable on it - throwing away the work a later `vibe resume`
      // would have recovered. "Escapes the loop" is the wrong predicate; "left
      // the conversation unusable" is the right one, and it holds on both paths.
      //
      // Exactly registered-and-unstarted: an id never handed over has no
      // evidence of having been spent.
      //
      // Passed to the retry loop rather than wrapped around the turn, so the
      // path that succeeds gains no await at all.
      (err: unknown) => {
        if (failureSparedConversation(err)) {
          // Said out loud, because it is the whole point and it is otherwise
          // invisible: the run is about to wait, possibly for hours, and what it
          // will resume is the conversation this attempt already paid for. Only
          // where there is something to keep - a slot that never registered had
          // nothing at stake.
          const kept = slotHasDeadTurn(state, slot) ? slotId(state, slot) : null;
          if (kept !== null) {
            log.detail(
              `"${req.label}" was rate limited on session ${kept}; the conversation is intact ` +
                'and the retry resumes it rather than starting over.',
            );
          }
          return;
        }
        const discarded = recoverDeadSlot(state, slot);
        if (discarded !== null) {
          log.warn(
            `"${req.label}" failed on session ${discarded} before any turn succeeded; ` +
              'starting a fresh conversation rather than re-using a spent id.',
          );
        }
      },
    );
  } catch (err: unknown) {
    throw noteRoleProvenance(err, req.role, cfg, roles, req.timeoutMs, req.seatPath);
  }

  // Asked before `markSlotStarted`, which is what makes `slotForkParent` answer
  // null. True both for a fork this turn made and for one a dead turn had
  // already made and this turn only resumed - the copy exists either way, so
  // both owe the same clear.
  const owedFork = slotForkParent(state, cfg, slot) !== null;
  // The slot's marker, not its id: this turn returning is the only evidence
  // that the conversation exists at all.
  markSlotStarted(state, cfg, slot, result.sessionId);
  // Staged, NOT persisted here - see `clearSlotFork` and `applyCharge` below.
  if (owedFork) clearSlotFork(state, slot);
  // Tagged with the model that produced it: the ratio is a fraction of this
  // model's window and means nothing under another one. Through the shared seam
  // so the rotation turn in context.ts cannot drift out of step with this one.
  //
  // Not for a per-turn slot: `contextModel` / `contextRatio` are the record of
  // how full `main` is, which rotation and every `ctx%` read, and a fresh
  // finder's occupancy written there would replace the implementer's (#388).
  if (!perTurn) recordTurnContext(state, model, result.usage);

  // A per-turn slot's figure is its own measurement or nothing - never the
  // stored one, which is `main`'s and would be reported as this turn's whenever
  // the two share a model.
  const measured = perTurn ? (result.usage?.ratio ?? null) : measuredRatio(state, model);
  const ctx = result.usage ? `, ctx ${(result.usage.ratio * 100).toFixed(0)}%` : '';
  applyCharge(state, cfg, {
    costUsd: result.costUsd,
    tokens: result.tokens.total,
    provider: 'claude',
    label: req.label,
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
        // What the turn did, for every role on both providers (#66) - point 2
        // of the issue, and worth having on its own: three of its four data
        // points had to be recovered by grepping a transcript. Omitted
        // ENTIRELY when the turn was unmeasured, because a zero standing in for
        // an absence is the one thing this repo never records.
        ...activityEvent(result.activity),
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

  return {
    text: result.text,
    structured: null,
    ...(result.activity === undefined ? {} : { activity: result.activity }),
  };
}

/**
 * Wait out a subscription rate limit rather than losing the run to it.
 *
 * This is the ceiling that actually stops long unattended runs on a plan with
 * overage disabled - no charge accrues, requests simply start failing. The wait
 * is capped so a weekly-cap reset cannot hang the process for days; past the cap
 * the run exits resumable.
 *
 * `onFailure` runs once per failed attempt, before the charge and before the
 * decision to wait, and it is where a caller repairs whatever that attempt spoiled
 * (#74: a Claude session id spent by an attempt that then failed). It is handed
 * the error, because what an attempt spoiled depends on how it failed and the
 * caller is the only one that knows what it has at stake (#91). It mutates
 * state in memory only, so the charge below persists the repair in the same write
 * as the account of what the failure cost. A callback rather than a wrapper around
 * `work`, because the path that succeeds must not gain an await - see
 * `applyCharge` and `turn-seam.test.ts`.
 */
async function withRateLimitRetry<T>(
  state: RunState,
  cfg: Config,
  label: string,
  provider: 'claude' | 'codex',
  work: () => Promise<T>,
  onFailure?: (err: unknown) => void,
  /**
   * Asked after each failed attempt is charged: the work to run instead, for a
   * failure the caller retries, or null. Only `cutOffRetry` passes one (#416).
   */
  retry?: (err: unknown) => (() => Promise<T>) | null,
): Promise<T> {
  for (;;) {
    try {
      return await work();
    } catch (err) {
      onFailure?.(err);
      // How the child ended, before the charge and independent of it (#131).
      //
      // Not folded into `turn_failed`: `chargeFailure` returns early without an
      // event when the attempt spent nothing, and a turn killed in its first
      // seconds is exactly the case that spends nothing AND is exactly the case
      // whose ending a reader most wants. Tying the record of *how* to the
      // record of *how much* would have lost it precisely there.
      //
      // Silent when the failure carried no ending, because most do not: a rate
      // limit detected mid-stream and a schema the adapter refused are not
      // children ending, and reporting `exit 0` for them would put an ending on
      // every failure in the run and make the real ones unfindable.
      const ending = endingOf(err);
      if (ending !== null && isAbnormal(ending)) {
        recordAndSay(
          state,
          'warn',
          'child_ended',
          `The ${provider} process for "${label}" ${describeChildEnding(ending)}.`,
          { label, provider, code: ending.code, signal: ending.signal },
        );
      }
      // What this attempt spent, whether or not it is retryable, and per attempt
      // rather than per turn: a turn that burns tokens, fails, waits and burns
      // them again used to have nothing consulted between the two. Any ceiling
      // the charge crosses is held rather than thrown - it must not displace
      // `err`, which has to reach cli.ts as the type it already is - and the
      // totals it updated are what the check below reads.
      chargeFailure(state, cfg, err, { label, provider });

      const again = retry?.(err) ?? null;
      if (again !== null) {
        work = again;
        continue;
      }

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
      // One call rather than two since #223, same sentence at the same level.
      // `7e` is drawn on this and on `rate_limit_resumed` below, and the pair is
      // why the design can call this **waiting** rather than halted: a window
      // told when the wait began and when it ended needs no decision from a
      // person in between, and must not look as though it does.
      recordAndSay(
        state,
        'warn',
        'rate_limited',
        `Rate limited during "${label}". ${describeReset(err)} Waiting ${minutes} min.`,
        {
          label,
          waitMs,
          resetsAt: err.resetsAt?.toISOString() ?? null,
          // The provider, so a window can say which account is out of headroom
          // and leave the other one's work alone. Already in hand at this site
          // and previously dropped, which made "run this phase on the other
          // agent" un-offerable without the window guessing who "the other" was.
          provider,
        },
      );
      // **Interruptible since #223.** This used to be a bare `setTimeout`, which
      // is the one place a run spends real time with nothing to kill - so `stop`
      // did nothing for the length of the window, and because `serve.ts` holds
      // the one-at-a-time gate for the whole of `main()`, neither could anything
      // else be started. A fifteen-minute wait locked the window for fifteen
      // minutes: *"I ended a run, and now I can't create a new one."*
      const slept = await sleepUnlessCancelled(waitMs);
      if (!slept) {
        // Woken by a cancel. Thrown here rather than letting the next turn's
        // refusal do it, for two reasons: the loop would otherwise narrate
        // `rate_limit_resumed` on a wait that did not resume, and it would
        // announce a turn it is about to refuse to start.
        // `stopReason`: a seat's wait may have been cut short by its group (#403).
        throw new Cancelled(stopReason() ?? 'the run was stopped during a rate-limit wait');
      }
      log.step(`Resuming "${label}" after rate-limit wait`, {
        id: 'rate_limit_resumed',
        data: { label },
      });
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

/**
 * A plan, and what the turn that wrote it did.
 *
 * The activity is carried out of the turn rather than read back from state, for
 * the reason `TurnOutcome.activity` gives: the caller that acts on it is judging
 * *this* turn, and a later reader could not tell which turn a stored figure
 * belonged to (#66). Absent when nothing measured the turn, and absent for a
 * plan that came from `state.plan` on a resume - this process ran no plan turn,
 * so it has nothing to say about one (#63).
 */
interface PlannedTurn {
  plan: Plan;
  activity?: TurnActivity | undefined;
}

async function runPlan(
  state: RunState,
  cfg: Config,
  cwd: string,
  roles: RoleTable,
  turns: AgentTurns,
): Promise<PlannedTurn> {
  log.step(`${holderLabel('planner', roles)} is planning (read-only)`, {
    id: 'turn_started',
    data: { role: 'planner', kind: 'plan' },
  });
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
  return { plan, ...(outcome.activity === undefined ? {} : { activity: outcome.activity }) };
}

interface ReviseArgs {
  findings?: readonly Finding[] | undefined;
  answers?: readonly Answer[] | undefined;
}

/**
 * Whether this revision is a new plan round, or the same one revised.
 *
 * **A plan round is the pair — the planner produces a version, the critic judges
 * it — and only one of the two things that reach here is half of that pair.**
 * A revision answering the critic's findings is the producer's side of the next
 * round: something judged version N and this is version N+1, which is exactly
 * what `maxPlanRounds` counts and what `plan-<n>.json` is numbered by.
 *
 * A revision answering the planner's *own* questions is not. Nothing judged
 * anything: the planner asked, the answerer replied, and the plan was rewritten
 * before it was ever shown to the critic. The loop column has said so in as many
 * words since the question group was drawn — *"a question round produces no
 * critique, so it cannot advance the plan round"* — and the core disagreed with
 * its own screen, which is how a run came to read *"plan round 0 has a critique,
 * then plan round 1 asked questions, and when those questions were answered it
 * moved to plan round 2"*.
 *
 * It was not only a renumbering. `guardProgress` measures `state.planRound`
 * against `loop.maxPlanRounds`, so every question round spent one of the rounds
 * the run had for *disagreeing with the critic* — a run allowed five plan rounds
 * and asking three rounds of questions had two critiques left, and nothing said
 * so. `loop.maxQuestionRounds` already caps the question loop, and it is the cap
 * that should.
 */
function advancesRound(args: ReviseArgs): boolean {
  return args.findings !== undefined;
}

/**
 * The answers a revision is given: its own, plus - on a findings revision - the
 * advisory answers no revision has folded in yet (#277). Returns `args.answers`
 * itself when there is nothing to add, which is how the caller tells whether
 * this revision took them.
 */
function withAdvisory(
  args: ReviseArgs,
  advisory: readonly Answer[] | undefined,
): readonly Answer[] | undefined {
  if (args.findings === undefined || advisory === undefined || advisory.length === 0) return args.answers;
  return [...(args.answers ?? []), ...advisory];
}

async function revisePlan(
  state: RunState,
  cfg: Config,
  cwd: string,
  args: ReviseArgs,
  roles: RoleTable,
  turns: AgentTurns,
  host?: Host,
): Promise<PlannedTurn> {
  const advancing = advancesRound(args);
  if (advancing) state.planRound += 1;
  saveState(state);
  /*
   * A revision opens a new plan round, and until now it said so to nobody.
   *
   * `revisePlan` emitted a `turn_started` and no `phase_started`, so the turn
   * that produces the *next* version of the plan landed inside whichever phase
   * group was still open — the **critique that caused it**. The loop column drew
   * a planner turn under a heading that says `critique`, which is the producer
   * of round 2 filed under round 1's judge.
   *
   * `planning`, not a phase of its own, because it is the same phase: the
   * planner producing a version of the plan. On the advancing path the round has
   * just been incremented, so this group and the critique that follows it carry
   * the same number — which is what lets a reader (and `rounds()`) pair them. On
   * the non-advancing path it carries the round it is still in, which is the
   * whole point: the answered revision is drawn under the round that raised the
   * questions rather than opening one beside it.
   *
   * The heading is deliberately still `log.step` below rather than being folded
   * into this: a `log.heading` here would change what the terminal prints for
   * every revision, and this is a frame for a host, not a new section for a
   * person. `phase_started` has never required a heading beside it.
   */
  // Counted from one in the sentence, as `Plan critique (round N)` counts the
  // same round, and raw in the frame, which names `plan-${planRound}.json`
  // (#428). The sentence printed the raw round, so `Plan round 1` was followed
  // by `Plan critique (round 2)` for one and the same round.
  log.info(
    advancing
      ? `Plan round ${state.planRound + 1}`
      : `Revising plan ${state.planRound + 1} against the answers`,
    {
      id: 'phase_started',
      data: { phase: 'planning', round: state.planRound },
    },
  );
  // The label names the round the turn belongs to, and for a non-advancing
  // revision that is the QUESTION round: `planRound` no longer moves, so two
  // question rounds under one plan round would otherwise charge two turns under
  // one label and the archive could not tell them apart.
  const label = advancing
    ? `revise-${state.planRound}`
    : `revise-q${state.questionRound}`;
  log.step(
    advancing
      ? `${holderLabel('planner', roles)} is revising the plan (round ${state.planRound + 1})`
      : `${holderLabel('planner', roles)} is revising the plan against the answers`,
    {
      id: 'turn_started',
      data: { role: 'planner', kind: 'revise', round: state.planRound },
    },
  );

  // The step-back a stall left for this revision, read from state so a resume
  // re-entering here sends it too (#394). A findings revision only: answers are
  // the person's steer, not the critic's churn.
  const stepBack = args.findings !== undefined ? pendingStepBack(state.planStalls ?? []) : null;
  const outcome = await runTurn(
    state,
    cfg,
    {
      role: 'planner',
      prompt: P.revisePlanPrompt({
        planMd: state.plan?.plan_md,
        findings: args.findings,
        // A findings revision also folds in the advisory answers no revision has
        // taken yet (#277), which is the turn the skipped one was waiting for.
        answers: withAdvisory(args, state.advisoryAnswers),
        // The plan of record's boundary, restated: a revision returns the whole
        // plan, and a session rotated concurrently with the critique would
        // otherwise re-derive `out_of_scope` from nothing.
        outOfScope: state.plan?.out_of_scope,
        // And the bar, for the same reason: a revision returns the whole plan,
        // so a bar it is not shown is a bar it re-derives or drops.
        acceptanceCriteria: state.plan?.acceptance_criteria,
        round: state.planRound,
        stall: stepBack === null ? undefined : { counts: stepBack.counts, fresh: stepBack.fresh },
      }),
      planInPrompt: state.plan !== null,
      cwd,
      label,
      // The plan and a disposition per finding (#453), on the revision that
      // answers a critique only: every other planner turn sends the role's own
      // schema exactly as before.
      ...(args.findings === undefined ? {} : { jsonSchema: REVISE_SCHEMA }),
    },
    turns,
    roles,
  );

  const raw = readStructured(outcome);
  // An unreadable plan fails the turn here, exactly as it always did. The
  // dispositions are split off the same output and never reach the plan.
  const plan = parsePlan(raw);
  // Before the write below that persists the plan and consumes the findings it
  // answers, so a revision is never consumed without its record (#453).
  if (args.findings !== undefined) recordPlanDispositions(state, readPlanDispositions(raw), args.findings, label);
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
  //
  // The answers are consumed here for the same reason (#169). They are durable
  // in `pendingAnswers` from the moment the answerer's turn is recorded, so
  // clearing them anywhere later leaves a window in which the plan answering
  // them is on disk and a resume revises against them again.
  // The answer-wins marker (#394), on this same write for the reason the two
  // consumptions below are on it: a revision against answers that leaves plan
  // findings pending is followed by a findings revision and a critique, and a
  // process that died between them must not come back and approve a plan no
  // critic has read on the strength of a demotion. Read before the findings are
  // consumed, and cleared by the findings revision that follows.
  if (args.findings === undefined && args.answers !== undefined && takePendingFindings(state, 'plan') !== null) {
    state.planRevisedByAnswer = true;
  }
  if (args.findings !== undefined) {
    state.pendingFindings = null;
    delete state.planRevisedByAnswer;
  }
  if (args.answers !== undefined) state.pendingAnswers = null;
  // Marked sent on the write that persists the plan it shaped, so a stop before
  // it sends the block again and a stop after it does not (#394).
  if (stepBack !== null) stepBack.sent = true;
  // Folded in by this revision whenever it took them, on the same write (#277).
  if (withAdvisory(args, state.advisoryAnswers) !== args.answers) delete state.advisoryAnswers;
  saveState(state);
  // **`plan-<n>.json` is the plan of record for round n, which is the version
  // the critic will judge** - so a non-advancing revision replaces it rather
  // than writing beside it, and `refusePlaceholderPlan` goes on citing a file
  // whose contents are the ones it read. What that costs is the draft that
  // raised the questions, and the cost is accepted rather than hidden: the
  // questions and the answers that changed it are both durable, in
  // `answers-<question-round>.json`, which is the half a reader is actually
  // asking about when a plan changed between two critiques.
  artifact(state, `plan-${state.planRound}.json`, plan);
  // With the new plan persisted, the follow-ups artifact is reconciled against
  // it immediately - including deleting it when this revision dropped the last
  // out-of-scope item and nothing has been deferred.
  writeFollowUps(state, plan);
  // After the artifact and its save, so the snapshot describes a round whose
  // record is complete. No commit here: the planning phase does not touch the
  // tree, and the note says that rather than implying a failure.
  //
  // **The boundary is the one this revision actually crossed.** A findings-driven
  // revision closes a plan round and takes `plan-round`, exactly as it always
  // has. An answers-driven one closes nothing of the sort, and writing a
  // `plan-round` checkpoint for it would put a plan round in the record that
  // `state.planRound` says did not happen — the two halves of #139's own
  // complaint, which is that a plan revised because the critic objected and a
  // plan revised because it answered its own questions are different diagnoses
  // that used to share a name.
  //
  // It does not hold. The caller inside the question loop has already held at
  // `question-round` a moment ago, with this round's questions attached, so a
  // second hold here would stop the same round twice for one decision. The one
  // caller that reaches this without a hold in front of it is the resume
  // consuming `NEEDS-INPUT.md`, and a resume that halts again before running
  // anything is a resume that did not resume.
  if (advancing) {
    writeCheckpoint(state, 'plan-round', NO_COMMIT);
    await holdAt(state, cfg, host, 'plan-round');
  } else {
    writeCheckpoint(state, 'question-round', NO_COMMIT);
  }
  return { plan, ...(outcome.activity === undefined ? {} : { activity: outcome.activity }) };
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
  // The role's, falling back to the provider's, resolved once: the spawn and the
  // progress window below both read it, and they must not be able to disagree
  // about which model this turn is. As on the Claude side (`claudeDispatch`),
  // and outside the retry for the same reason - it is a pure resolution over
  // inputs no attempt changes.
  const model = modelFor(req.role, cfg, roles);
  const forkFrom = noteSpawn(state, cfg, slot);
  const prompt =
    freshConversationPrefix(state, req.role, slotContinuity(state, cfg, slot), req.planInPrompt) +
    req.prompt;

  // Through the same retry the Claude turns use, so a Codex rate limit gets the
  // wait, the maxWaitMinutes cap and the resumable exit that already exist
  // rather than a second implementation of all three.
  // As on the Claude side: the ordinary `await`, in a `try` so the failure can
  // name where this turn's model came from.
  let outcome: CodexTurnResult;
  // One attempt, with the prompt it is given: the retry of a cut-off turn adds a
  // note to the end and changes nothing else - the same thread, the same fork
  // owed, the same seat (#416).
  const attempt =
    (attemptPrompt: string): (() => Promise<CodexTurnResult>) =>
    async () => {
      await checkCodexLimits(state, cfg, req.cwd, req.label);
      return turn({
        prompt: attemptPrompt,
        // The request's, which `runTurn` has already resolved to the role's
        // where the caller named none - so a role turn sends exactly what it
        // always did, and a caller with a per-turn schema reaches Codex as it
        // already reached Claude (#393). Reading `spec.schema` here dropped it.
        schema: req.jsonSchema ?? spec.schema,
        // Stated here rather than inferred in the adapter: a writer's edits are
        // made before its last message is read, so output that does not parse
        // comes back as text; every read-only seat keeps failing the turn.
        unparseable: spec.access === 'write' ? 'raw' : 'throw',
        schemaName: req.label,
        artifactDir: artifactDir(state, 'codex'),
        // As with effort below: the role's where it named one, this provider's
        // otherwise (#60). The two Codex conversations are already separate
        // threads, so they can now run two different models - which is what
        // `roleWarnings` W5 says out loud when `codex.contextWindow` is set,
        // because one window cannot describe both.
        model,
        // As on the Claude side: the role's effort where it named one, and this
        // provider's otherwise. Two Codex roles can now differ, which is the
        // whole of #46 - the reviewer's thread and the judge's are already
        // separate conversations, and they no longer have to think alike.
        effort: effortFor(req.role, cfg, roles),
        sandbox: codexSandbox(spec.access, cfg),
        // The servers this role may keep; every other listed one is disabled
        // by name in the adapter (#138).
        mcpServers: mcpServersFor(req.role, roles),
        cwd: req.cwd,
        timeoutMs: req.timeoutMs,
        // One or the other, never both: a fork owed outranks a resume, and a
        // slot owing a fork has never started, so it has no id to resume.
        ...(forkFrom === null
          ? { sessionId: slotResumeId(state, cfg, slot) }
          : { forkFrom }),
        // This role's own model, on this role's own provider's conversation -
        // the same two facts the Claude path names. It resolves to no window at
        // all, because no Codex conversation has ever reported one: both
        // sources are written by completed Claude turns. Naming the model alone
        // would not have been enough, because both are keyed by a bare model
        // name and `claude.model` may legally equal a Codex role's model - a
        // shared name would then have handed this turn Claude's window (#86).
        //
        // The defect this closes was latent, not live. Across the 15 archived
        // runs (census 2026-08-27) there are 1,270 Codex heartbeat lines and not
        // one carries a `ctx%` segment: `formatHeartbeat` gates that segment on
        // `promptTokens > 0`, `parseCodexLine` never sets it, and Codex reports
        // usage only at `turn.completed`, which is the end of the turn. So the
        // wrong denominator was delivered on every Codex turn and would have
        // rendered - `ctx 210%` on a real critique turn - the moment a numerator
        // existed. Fixed before the numerator, rather than after.
        progress: progressOptions(state, cfg, req.label, model, 'codex'),
      });
    };
  try {
    outcome = await withRateLimitRetry(
      state,
      cfg,
      req.label,
      'codex',
      attempt(prompt),
      undefined,
      cutOffRetry(state, cfg, req.label, spec.access, req.jsonSchema ?? spec.schema, prompt, attempt),
    );
  } catch (err: unknown) {
    throw noteRoleProvenance(err, req.role, cfg, roles, req.timeoutMs, req.seatPath);
  }
  const { structured, raw, sessionId, tokens, activity } = outcome;

  // The marker is set whatever the run does with the id: a turn either succeeded
  // or it did not. `idChanged` is false when this run is not carrying the
  // thread, when the provider named no usable id, and when it named the one
  // already stored - so the write and the line below happen exactly where they
  // always did.
  const { idChanged, first } = markSlotStarted(state, cfg, slot, sessionId ?? null);
  // Staged, NOT persisted here. `applyCharge` below makes one write carrying the
  // started marker, this clear, the in-flight disposal, the totals and the turn
  // event - so a kill cannot leave the fork durably done while the turn it paid
  // for is uncharged, which #77 established cannot be reconstructed for Codex.
  if (forkFrom !== null) clearSlotFork(state, slot);
  if (idChanged) {
    // Suppressed on the fork path for the same reason: the provider-minted id
    // rides the accounting write rather than a save of its own.
    if (forkFrom === null) saveState(state);
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
    provider: 'codex',
    label: req.label,
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
        // See the same spread on `claude_turn`: recorded for every role, absent
        // rather than zeroed for a turn nothing measured (#66).
        ...activityEvent(activity),
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

  return {
    text: raw,
    structured,
    ...(activity === undefined ? {} : { activity }),
  };
}

/**
 * The one retry a read-only Codex seat gets when its answer was cut off at its
 * output limit (#416), as a `withRateLimitRetry` retry: the next attempt's work,
 * or null for a failure it does not retry.
 *
 * Inside that loop rather than around it, because the path that succeeds must
 * not gain an await (`turn-seam.test.ts`): a wrapper awaiting the loop put one
 * more microtask between a Codex result and its accounting, which is where a
 * concurrent rotation can land.
 *
 * **Read-only seats only.** A writer may already have edited the tree, and
 * running it again would edit it again; its cut-off fails the turn as before.
 * **Once.** The cut-off is a wobble the reordered schema should all but remove,
 * so a second one says something about this turn, and it ends the turn as a
 * single cut-off always did, naming both attempts.
 *
 * The loop has charged the attempt by the time this is asked, so the ceilings
 * are checked before spending again: one that is reached escalates instead of
 * retrying. The retry runs on the same conversation - a resuming seat on its
 * thread, a fresh one fresh - because the #389 thread kept its cut-off answer
 * and the next two turns on it still worked, while a fresh thread would cost
 * the critic its memory of earlier rounds.
 *
 * The cut-off answer is never the outcome. What it had written in full goes to
 * the retry as unverified, and the retry's answer, or its failure, is what the
 * loop acts on.
 */
function cutOffRetry(
  state: RunState,
  cfg: Config,
  label: string,
  access: RoleSpec['access'],
  /** The schema the turn was sent with, which is what the note is worded for (#429). */
  schema: object | undefined,
  prompt: string,
  attempt: (prompt: string) => () => Promise<CodexTurnResult>,
): (err: unknown) => (() => Promise<CodexTurnResult>) | null {
  let first: OutputCutOffError | null = null;
  return (err) => {
    if (!(err instanceof OutputCutOffError) || access === 'write') return null;
    if (first !== null) {
      // Both records, because each attempt kept its own (`cutOffRecordPath`).
      const kept = [first.keptAt, err.keptAt].filter((p): p is string => p !== null);
      throw new OutputCutOffError(
        `${label} was cut off at its output limit on both attempts.\n` +
          `First attempt: ${first.message.split(/\r?\n/)[0] ?? ''}\nRetry: ${err.message}` +
          (kept.length === 0 ? '' : `\nWhat each attempt wrote is kept in ${kept.join(' and ')}.`),
        err,
      );
    }
    first = err;
    // Codex turns charge no cost, so only the token ceiling applies here. Held
    // rather than thrown at once: the cut-off is said first, so a run the
    // ceiling ends still records why its last turn failed. The escalation, and
    // the exit code it carries, are the ones `enforceCeilings` threw.
    let ceiling: unknown = null;
    try {
      enforceCeilings(state, cfg, false);
    } catch (reached: unknown) {
      ceiling = reached;
    }
    const n = err.findings.length;
    const counted =
      err.chars === null || err.blankChars === null
        ? ' before its final message arrived.'
        : ` after ${(err.chars - err.blankChars).toLocaleString('en-US')} characters, followed by ` +
          `${err.blankChars.toLocaleString('en-US')} characters of blank space.`;
    recordAndSay(
      state,
      'warn',
      'codex_cut_off',
      `Codex's answer to ${label} was cut off at its output limit${counted} ` +
        (ceiling === null
          ? 'Trying the turn again (1 retry).' +
            (n === 0 ? '' : ` It had written ${n} finding(s) in full; the retry is asked to check them again.`)
          : 'Not tried again: the run has reached its token ceiling.' +
            (n === 0
              ? ''
              : ` It had written ${n} finding(s) in full` +
                (err.keptAt === null ? '.' : `, kept in ${err.keptAt}.`))) +
        (err.reported ? '' : ' Codex did not report what the cut-off attempt used.'),
      { label, chars: err.chars, blankChars: err.blankChars, findings: n, reported: err.reported },
    );
    if (ceiling !== null) throw ceiling;
    recordEvent(state, 'turn_retried', { label, reason: 'max_output_tokens', attempt: 2 });
    return attempt(`${prompt}\n\n${cutOffNote(err.findings, schema)}`);
  };
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
 * `slotContinuity`, NOT `slotHasMemory` (#78). The two answer different
 * questions and only one of them is the prompt's: `slotHasMemory` decides
 * whether to send a resume flag, and a slot that still owes a fork has no
 * successful turn on it, so it answers false. But the conversation the fork is
 * about to create really does hold the parent's history - so telling the critic
 * or the reviewer it has never seen this run makes it re-derive findings it
 * already made, under new ids, which reads as churn rather than as the
 * repetition it is.
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
  return slotContinuity(state, cfg, slotForRole(role, roles));
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
 * The downgrade seam: one place, both findings-producing turns.
 *
 * Here rather than at the call sites, because everything that reads a severity
 * happens after this - the artifact, `collectDeferred`, `recordPendingFindings`
 * and the gate - and a downgrade that landed later would be a downgrade a
 * resume could not see.
 *
 * `log.warn` as well as the event: this is the run telling the user that a
 * reviewer asserted something it could not point at, which is worth seeing at
 * the time and not only in a file (#48).
 *
 * Two rules now, and the order matters. Grounding runs first and inertness only
 * over the survivors, so a finding that cited nothing AND came from a turn that
 * ran nothing is downgraded once, by grounding - which keeps `downgraded.from`
 * naming the severity the model actually gave it, and keeps the recorded reason
 * the more specific of the two.
 *
 * The inertness rule is the **reviewer's alone** (#66). The critic must not be
 * held to it: it critiques a *plan*, before any code exists, reading the plan is
 * in its prompt, and a plan critique that runs no shell has not failed to gather
 * evidence. The census supports keeping it out rather than assuming - 2 of 65
 * critique turns ran zero commands, and nothing in the archive says either was
 * wrong. The *tally* is recorded for every role either way, so the question can
 * be reopened later on evidence the runs themselves recorded.
 */
/**
 * Stamp a finding with the role that produced it (#141).
 *
 * Here rather than in `parseFindings`, because the parser reads a report and has
 * no idea who wrote it - this function is the single point both writers pass
 * through, and it is already given the role. A finding that arrives already
 * attributed keeps what it has: nothing produces one today, and the rule that
 * matters is that this never overwrites an author with a different one.
 *
 * **Fail closed on an unattributable role.** Only `critic` and `reviewer` can
 * produce a report; anything else leaves the field off rather than claiming a
 * position that does not raise findings. Absent already means "nothing here says
 * who", which is true, where `planner` would be a fabrication.
 */
function attribute(f: Finding, role: Role): Finding {
  if (f.raisedBy !== undefined) return f;
  if (role !== 'critic' && role !== 'reviewer') return f;
  return { ...f, raisedBy: role };
}

function groundAndRecord(
  state: RunState,
  cwd: string,
  role: Role,
  roles: RoleTable,
  found: FindingsReport,
  /** What the turn that produced `found` did. Absent when nothing measured it. */
  activity: TurnActivity | undefined,
): FindingsReport {
  const attributed = { ...found, findings: found.findings.map((f) => attribute(f, role)) };
  const grounded = groundFindings(attributed, cwd, state.dir, pathStyleFor(state, role, roles));
  const inert =
    role === 'reviewer'
      ? downgradeInert(grounded.report, activity)
      : { report: grounded.report, downgraded: [] as Finding[] };
  const report = inert.report;
  recordDowngrades(state, [...grounded.downgraded, ...inert.downgraded]);
  return report;
}

/**
 * Say and record that a guard moved a severity - one sentence, whichever guard
 * fired.
 *
 * Its own function since #113 added a fourth guard that runs *after*
 * `groundAndRecord` rather than inside it: the reproducer cannot be observed
 * until the whole round's findings are merged, because a chunked review produces
 * the same id in two parts. Two copies of this loop would be two wordings for
 * one event, and `finding_downgraded` is what a reader greps for.
 */
function recordDowngrades(state: RunState, downgraded: readonly Finding[]): void {
  for (const f of downgraded) {
    // Set by construction in `groundFindings`; narrowed rather than asserted.
    const d = f.downgraded;
    if (d === undefined) continue;
    recordAndSay(state, 'warn', 'finding_downgraded', `Downgraded ${f.id} from ${d.from} to P2 - ${d.reason}`, {
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
}

/**
 * The critique prompt for this round: what the critic is sent, and what every
 * additional critique finder is sent with `hasMemory` false (#405). One
 * builder, so the critic's prompt and a finder's cannot come to differ in
 * anything but the memory note and a finder's focus.
 */
function critiquePromptFor(
  state: RunState,
  plan: Plan,
  roles: RoleTable,
  planActivity: TurnActivity | undefined,
  hasMemory: boolean,
): string {
  return (
    P.critiquePrompt(
      plan.plan_md,
      plan.assumptions,
      plan.out_of_scope,
      state.planRound + 1,
      hasMemory,
      state.environment,
      roles,
      // The plan's own bar, not a snapshot: this runs before the gate, and
      // the critic is what decides whether the bar is any good.
      plan.acceptance_criteria,
      planActivity,
      // Answers no revision has folded in yet (#277). Empty on every run that
      // skipped no revision, so this prompt is byte-identical there.
    ) + P.advisoryAnswers(state.advisoryAnswers, 'critic')
  );
}

async function runCritique(
  state: RunState,
  cfg: Config,
  cwd: string,
  plan: Plan,
  roles: RoleTable,
  turns: AgentTurns,
  /**
   * What the turn that wrote `plan` did, or absent when nothing measured it, or
   * when this process did not run one. Named in the prompt only when it inspected
   * nothing, so every other run's prompt is byte-identical to before (#63).
   */
  planActivity?: TurnActivity | undefined,
): Promise<FindingsReport> {
  log.step(`${holderLabel('critic', roles)} is critiquing the plan`, {
    id: 'turn_started',
    data: { role: 'critic', kind: 'critique', round: state.planRound },
  });
  const outcome = await runTurn(
    state,
    cfg,
    {
      role: 'critic',
      prompt: critiquePromptFor(state, plan, roles, planActivity, roleHasMemory(state, cfg, 'critic', roles)),
      cwd,
      label: `critique-${state.planRound}`,
    },
    turns,
    roles,
  );
  // The activity is passed for the record, not for a rule: `groundAndRecord`
  // applies the inertness rule to the reviewer only. See its header.
  return groundAndRecord(
    state,
    cwd,
    'critic',
    roles,
    parseFindings(readStructured(outcome)),
    outcome.activity,
  );
}

/**
 * What a phase hands the shared finder and vote runners (#452).
 *
 * The review (#388) and the plan critique (#405) run one mechanism: finders
 * after the first, merged by claim in config order, then every blocking finding
 * to every verifier, tallied in (finding, verifier) order - up to the section's
 * own `maxParallel` at once, as one `runSeatGroup` (#403). A phase supplies only
 * what differs, as data and small callbacks, so `runFinderSeats` and
 * `runVoteSeats` never ask which phase they are running for, and each phase
 * keeps its own labels, prompts, events and sentences byte for byte.
 */
interface SeatPhase {
  /** The role every seat plays. `roles[role]` is the first finder, `foundBy` seat `roles.<role>`. */
  role: 'reviewer' | 'critic';
  /** The archive's round: `state.reviewRound`, or `state.planRound`. */
  round: number;
  /** The section's own bound, and the setting it was read from, for the backstop's sentence. */
  maxParallel: number;
  setting: 'review.maxParallel' | 'critique.maxParallel';
}

/** An event the runner records and narrates, in the phase's own words and keys. */
interface SeatEvent {
  id: string;
  message: string;
  data: Record<string, unknown>;
}

interface FinderPhase<T = never> extends SeatPhase {
  /** The `kind` on a finder's `turn_started` and `turn_finished`. */
  kind: 'review' | 'critique';
  /** The step line's verb: `<holder> <doing> (finder <k>)`. */
  doing: string;
  table: (f: FinderEntry) => RoleTable;
  /**
   * The finder's turns, in order: one per diff part for the review, the one for
   * the critique. More than one is merged by `mergeReviewReports`, as a chunked
   * reviewer's are; one is taken as it came.
   */
  parts: (f: FinderEntry) => readonly { label: string; prompt: string }[];
  /** The event a failed finder records, and the noun its sentence opens with. */
  failed: { id: string; noun: string };
  merged: (m: { seats: number; reported: number; raised: number; merge: FinderMerge }) => SeatEvent;
  /**
   * A phase's own reading of each part's output, kept per part in the finder's
   * slot (#404). The runner never interprets it: the review reads a finder's
   * test verdicts through this and combines them itself; the critique sets none.
   */
  extra?: (structured: unknown) => T;
}

/** A reporting finder's slot: its report, and the phase's `extra` for each part, in part order (#404). */
type FinderSlot<T> = FinderReport & { extras: T[] };

/** What a round's vote came to, for the phase's tally sentence. */
interface VoteTotals {
  findings: number;
  verifiers: number;
  votes: number;
  confirmed: number;
  unconfirmed: number;
  moved: number;
  held: number;
  undecided: number;
  /** Blocking findings the phase exempted from the vote, counted rather than voted on. */
  exempt: number;
  /** `confirmed … undecided (still blocking)`: the part of the sentence both phases share. */
  said: string;
}

interface VotePhase extends SeatPhase {
  /** A P0 or P1 the vote leaves alone: one that reproduced, or one deferred. */
  exempt: (f: Finding) => boolean;
  /** One finding's ballot prompt, the same for every verifier. */
  prompt: (f: Finding) => string;
  table: (v: VerifierEntry) => RoleTable;
  /** A ballot's label, from the finding's 1-based place in the report (`n`) and the verifier's number (`k`). */
  label: (n: number, k: number) => string;
  quorum: number | null;
  unconfirmedP0: UnconfirmedP0;
  tallied: (t: VoteTotals) => SeatEvent;
}

/**
 * A seat turn, told as finished when seat turns may overlap (#403).
 *
 * Only then do their `turn_started` frames carry the label and a
 * `turn_finished` follow: a window keeps several turns live by label, and needs
 * to be told when each one ends. At 1 the turns cannot overlap, and the
 * narration is exactly what it was.
 */
async function seatFinishing<T>(
  phase: SeatPhase,
  label: string,
  kind: string,
  work: () => Promise<T>,
): Promise<T> {
  if (phase.maxParallel <= 1) return work();
  try {
    return await work();
  } finally {
    log.detail(`${label} finished`, {
      id: 'turn_finished',
      data: { label, role: phase.role, kind, round: phase.round },
    });
  }
}

/**
 * The additional finders (#388 Part B, #405), after the first, and the merge
 * across all of them.
 *
 * Each finder is the phase's role on a swapped seat (`phase.table`): the same
 * `runTurn`, so its timeout, charge, heartbeat and path style follow the seat.
 * A finder never sees another's findings: every one is handed the prompt the
 * first was, memoryless, plus its focus.
 *
 * Up to `phase.maxParallel` finders at once (#403), as one `runSeatGroup`;
 * `1`, the default, is one after another exactly as before. A finder's own
 * parts stay in sequence, so a finder that fails stops at its first failed
 * part. Each writes its report into its own slot, and the merge reads the slots
 * in config order, so `foundBy`, the merged findings and the renamed `-f<k>`
 * ids are the same whichever finder finished first.
 */
async function runFinderSeats<T = never>(
  state: RunState,
  cfg: Config,
  cwd: string,
  roles: RoleTable,
  turns: AgentTurns,
  phase: FinderPhase<T>,
  entries: readonly FinderEntry[],
  first: FindingsReport,
): Promise<{ report: FindingsReport; slots: FinderSlot<T>[] }> {
  const parallel = phase.maxParallel > 1;
  const reported: (FinderSlot<T> | undefined)[] = entries.map(() => undefined);
  const tasks = entries.map((f, j) => async (): Promise<void> => {
    const table = phase.table(f);
    const reports: FindingsReport[] = [];
    const extras: T[] = [];
    let label = '';
    try {
      for (const part of phase.parts(f)) {
        label = part.label;
        log.step(`${holderLabel(phase.role, table)} ${phase.doing} (finder ${f.k})`, {
          id: 'turn_started',
          data: {
            role: phase.role,
            kind: phase.kind,
            round: phase.round,
            finder: f.k,
            seat: f.path,
            ...(parallel ? { label } : {}),
          },
        });
        const outcome = await seatFinishing(phase, label, phase.kind, () =>
          runTurn(
            state,
            cfg,
            { role: phase.role, prompt: part.prompt, cwd, label: part.label, seatPath: f.path },
            turns,
            table,
          ),
        );
        // Judged by what this turn did, attributed to the role it played. What
        // else the phase reads from the turn - a review finder's test verdicts
        // - is kept beside the report, per part, and combined by the phase
        // itself (#404). The first finder still owns `reviewCoverage`.
        const structured = readStructured(outcome);
        reports.push(
          groundAndRecord(
            state,
            cwd,
            phase.role,
            table,
            parseFindings(structured),
            outcome.activity,
          ),
        );
        if (phase.extra !== undefined) extras.push(phase.extra(structured));
      }
    } catch (err: unknown) {
      // A stop, a ceiling, a rate limit waited out past its cap: the round
      // ends exactly as it would for the first finder.
      if (err instanceof Escalation || err instanceof Cancelled) throw err;
      // And a ceiling this failure itself crossed. `chargeFailure` charged it
      // and *returned* the ceiling rather than throwing it, so that a role's
      // failure reaches cli.ts as itself - but a seat's failure is about to be
      // absorbed here, and absorbing it must not absorb the brake with it.
      enforceCeilings(state, cfg, f.setting.provider === 'claude');
      // Anything else costs this finder only. Losing an extra seat can only
      // leave out what that seat alone would have raised, so the round falls
      // back to what a default config does - and the record says so.
      const message = err instanceof Error ? err.message : String(err);
      const error = message.split(/\r?\n/)[0] ?? '';
      const provider = f.setting.provider;
      const model = f.setting.model ?? 'default';
      recordAndSay(
        state,
        'warn',
        phase.failed.id,
        `${phase.failed.noun} finder ${f.k} (${f.path}, ${provider}/${model}) failed on ${label}: ${error}`,
        { round: phase.round, finder: f.k, seat: f.path, label, error },
      );
      return;
    }
    const [single] = reports;
    reported[j] = {
      k: f.k,
      seat: f.path,
      provider: f.setting.provider,
      model: f.setting.model ?? 'default',
      report: reports.length === 1 && single !== undefined ? single : mergeReviewReports(reports),
      extras,
    };
  });
  await runSeatGroup(state, phase.maxParallel, tasks, phase.setting);

  const holder = roles[phase.role];
  // Config order, whatever order they finished in (#403 decision 3).
  const slots = reported.filter((r): r is FinderSlot<T> => r !== undefined);
  const all: FinderReport[] = [
    { k: 0, seat: `roles.${phase.role}`, provider: holder.provider, model: holder.model ?? 'default', report: first },
    ...slots,
  ];
  const merge = mergeAcrossFinders(all);
  const seats = entries.length + 1;
  const raised = all.reduce((n, r) => n + r.report.findings.length, 0);
  // Recorded, not narration only: this is the one account of how many finders
  // reported in the attempt that wrote this round's artifact. A resumed round
  // is bought again from scratch, so a failure from an attempt that never got
  // here leaves no merge event behind - the summary and the window read this,
  // never a tally of failures.
  const said = phase.merged({ seats, reported: all.length, raised, merge });
  recordAndSay(state, 'info', said.id, said.message, said.data);
  return { report: merge.report, slots };
}

/**
 * The vote on every blocking finding the phase does not exempt (#388 Part C,
 * #405), after the merge and before the gate.
 *
 * Each eligible finding goes to every verifier, every ballot of the round in
 * one `runSeatGroup` of up to `phase.maxParallel` at once (#403) - `1`, the
 * default, is every vote on finding 1, then every vote on finding 2, as before.
 * Each ballot is written into its (finding, verifier) slot and tallied from the
 * slots in that order, so `votes` and the ballot order are the same whichever
 * verifier answered first. A verifier is the phase's role on a swapped seat
 * whose job is a vote (`phase.table`): the same `runTurn`, so its timeout,
 * charge, heartbeat and path style follow the seat. It is shown the claim and
 * nothing about who made it, and never another verifier's vote.
 *
 * Not voted on: a P2 or P3, which includes everything a guard already moved;
 * and a finding `phase.exempt` names - one whose own reproducer reproduced, an
 * observation the vote has nothing to add to, or a plan finding marked
 * `defer: true`. Each round's vote stands alone: a finding raised again next
 * round is voted on again, by fresh turns that know no earlier tally.
 */
async function runVoteSeats(
  state: RunState,
  cfg: Config,
  cwd: string,
  turns: AgentTurns,
  phase: VotePhase,
  verifiers: readonly VerifierEntry[],
  report: FindingsReport,
): Promise<{ report: FindingsReport; held: Finding[] }> {
  const parallel = phase.maxParallel > 1;
  const blocking = (f: Finding): boolean => f.severity === 'P0' || f.severity === 'P1';
  // 1-based in the report as voted on: the `<n>` of the label.
  const eligible = report.findings
    .map((f, i) => ({ f, n: i + 1 }))
    .filter(({ f }) => blocking(f) && !phase.exempt(f));
  const exempt = report.findings.filter((f) => blocking(f) && phase.exempt(f)).length;

  const votes = new Map<string, Votes>();
  let cast = 0;
  const slots: Ballot[][] = eligible.map(() => []);
  const tasks: (() => Promise<void>)[] = [];
  for (const [i, { f, n }] of eligible.entries()) {
    const prompt = phase.prompt(f);
    const ballots: Ballot[] = slots[i] ?? [];
    for (const [j, v] of verifiers.entries()) {
      tasks.push(async (): Promise<void> => {
        const table = phase.table(v);
        const req: TurnRequest = { role: phase.role, prompt, cwd, label: phase.label(n, v.k), seatPath: v.path };
        log.step(`${holderLabel(phase.role, table)} is checking ${f.id} (verifier ${v.k})`, {
          id: 'turn_started',
          data: {
            role: phase.role,
            kind: 'vote',
            round: phase.round,
            verifier: v.k,
            seat: v.path,
            finding: f.id,
            ...(parallel ? { label: req.label } : {}),
          },
        });
        cast += 1;
        try {
          const outcome = await seatFinishing(phase, req.label, 'vote', () => runTurn(state, cfg, req, turns, table));
          const said = parseVote(readStructured(outcome));
          // The verifier's own path convention, because it typed the paths -
          // the read `groundAndRecord` makes for a finder.
          const grounded = groundVoteEvidence(said.evidence, cwd, state.dir, pathStyleFor(state, phase.role, table));
          const counted = countBallot(said.vote, grounded.unresolved);
          ballots[j] = {
            seat: v.path,
            provider: v.setting.provider,
            model: v.setting.model ?? 'default',
            vote: said.vote,
            counted: counted.counted,
            reason: said.reason,
            evidence: grounded.evidence,
            ...(counted.countedReason === undefined ? {} : { countedReason: counted.countedReason }),
          };
        } catch (err: unknown) {
          // A stop, a ceiling, a rate limit waited out past its cap: not a vote.
          if (err instanceof Escalation || err instanceof Cancelled) throw err;
          // Nor a ceiling this failed turn itself crossed: `chargeFailure` has
          // already charged it and held the ceiling rather than throwing it, and
          // counting the failure as a ballot would go on to buy the next vote
          // over the budget. Cost only for a Claude seat, `applyCharge`'s rule.
          enforceCeilings(state, cfg, v.setting.provider === 'claude');
          // Anything else is a vote not cast, and counts as one: `cannot-tell`,
          // which can only keep the finding blocking. Too few usable votes must
          // never let a finding through.
          const ballot = failedBallot(v, err);
          ballots[j] = ballot;
          log.warn(`Verifier ${v.k} (${v.path}) failed on ${req.label}, counted as cannot-tell: ${ballot.reason}`);
        }
      });
    }
  }
  await runSeatGroup(state, phase.maxParallel, tasks, phase.setting);
  // Tallied in (finding, verifier) order once every ballot is in, never as
  // they arrive (#403 decision 3). A group that threw never gets here, so no
  // partial vote is ever recorded.
  for (const [i, { f }] of eligible.entries()) {
    votes.set(f.id, tally(slots[i] ?? [], phase.quorum));
  }

  const applied = applyVotes(report, votes, phase.unconfirmedP0);
  recordDowngrades(state, applied.downgraded);

  const outcomes = [...votes.values()];
  const count = (o: Votes['outcome']): number => outcomes.filter((v) => v.outcome === o).length;
  const confirmed = count('confirmed');
  const unconfirmed = count('unconfirmed');
  const undecided = count('undecided');
  const moved = applied.downgraded.length;
  const held = applied.held.length;
  const kept = unconfirmed - moved - held;
  const fate = [
    moved > 0 ? `${moved} moved to P2` : '',
    kept > 0 ? `${kept} still blocking` : '',
    held > 0 ? `${held} held for you` : '',
  ].filter((s) => s !== '');
  // Recorded, not narration only: the summary and the window read the last of
  // these for the round, never a tally of failed turns - a resumed round that
  // never reached here leaves none behind (Part B's rule for finders).
  const said = phase.tallied({
    findings: eligible.length,
    verifiers: verifiers.length,
    votes: cast,
    confirmed,
    unconfirmed,
    moved,
    held,
    undecided,
    exempt,
    said:
      `${eligible.length} findings to vote × ${verifiers.length} verifiers, ${cast} votes; ` +
      `${confirmed} confirmed, ${unconfirmed} unconfirmed` +
      `${fate.length > 0 ? ` (${fate.join(', ')})` : ''}, ${undecided} undecided (still blocking)`,
  });
  recordAndSay(state, 'info', said.id, said.message, said.data);
  return { report: applied.report, held: applied.held };
}

/**
 * The plan critique's finders (#405), for `runFinderSeats`.
 *
 * A plan is never split, so each finder is one turn per plan round. Each is a
 * critic whose seat was swapped (`seatTable` on the critic's row): read-only, a
 * fresh conversation every turn, handed the critic's prompt for this round with
 * no memory - the no-memory `continuityNote` from round 2 on, the #435
 * asymmetry - plus its focus. Up to `critique.maxParallel` at once (#452), its
 * own bound rather than the review's.
 */
function critiqueFinderPhase(
  state: RunState,
  cfg: Config,
  plan: Plan,
  roles: RoleTable,
  planActivity: TurnActivity | undefined,
): FinderPhase {
  const round = state.planRound;
  return {
    role: 'critic',
    kind: 'critique',
    round,
    maxParallel: cfg.critique.maxParallel,
    setting: 'critique.maxParallel',
    doing: 'is critiquing the plan',
    table: (f) => seatTable(roles, f.setting, undefined, 'critic'),
    parts: (f) => [
      {
        label: `critique-${round}-f${f.k}`,
        prompt: P.withFocus(critiquePromptFor(state, plan, roles, planActivity, false), f.focus),
      },
    ],
    failed: { id: 'critique_finder_failed', noun: 'Critique' },
    merged: ({ seats, reported, raised, merge }) => ({
      id: 'critique_finders_merged',
      message:
        `plan critique round ${round + 1}: ${seats} finders, ${reported} of ${seats} reported, ` +
        `${raised} findings → ${merge.report.findings.length} after merge ` +
        `(${merge.byCitation} merged by citation, ${merge.byTitle} by title)`,
      data: {
        round,
        finders: seats,
        reported,
        findings: raised,
        merged: merge.report.findings.length,
        byCitation: merge.byCitation,
        byTitle: merge.byTitle,
      },
    }),
  };
}

/**
 * The plan critique's vote (#405), for `runVoteSeats`.
 *
 * The critique has no reproducer, so nothing is exempt for having reproduced.
 * Exempt instead is a finding marked `defer: true`, though `parseFindings`
 * clears `defer` on every P0 and P1 a turn returns, so today that is only a
 * finding stored that way. A verifier is a critic whose seat was swapped and
 * whose job is a vote (`seatTable` with `PLAN_VOTE_SCHEMA` on the critic's
 * row), shown the claim, the task, the plan and REVIEW.md, and never the id,
 * the severity, who raised it or another ballot.
 */
function critiqueVotePhase(
  state: RunState,
  cfg: Config,
  plan: Plan,
  roles: RoleTable,
  reviewMd: Awaited<ReturnType<typeof reviewStandardsFor>>,
): VotePhase {
  const round = state.planRound;
  return {
    role: 'critic',
    round,
    maxParallel: cfg.critique.maxParallel,
    setting: 'critique.maxParallel',
    exempt: (f) => f.defer === true,
    prompt: (f) =>
      P.critiqueVotePrompt(
        {
          title: f.title,
          detail: f.detail,
          suggested_fix: f.suggested_fix,
          ...(f.evidence === undefined ? {} : { evidence: f.evidence }),
        },
        state.task,
        plan,
        state.environment,
        roles,
        reviewMd,
        // The artifact this round's plan was written to, which a `not-real`
        // pointing at the plan can cite and have resolve.
        `plan-${round}.json`,
      ),
    table: (v) => seatTable(roles, v.setting, PLAN_VOTE_SCHEMA, 'critic'),
    label: (n, k) => `critique-${round}-vote-${n}-v${k}`,
    quorum: cfg.critique.quorum,
    unconfirmedP0: cfg.critique.unconfirmedP0,
    tallied: (t) => ({
      id: 'critique_votes_tallied',
      message: `plan critique round ${round + 1}: ${t.said}${t.exempt > 0 ? `; ${t.exempt} deferred, not voted` : ''}`,
      data: {
        round,
        findings: t.findings,
        verifiers: t.verifiers,
        votes: t.votes,
        confirmed: t.confirmed,
        unconfirmed: t.unconfirmed,
        moved: t.moved,
        held: t.held,
        undecided: t.undecided,
        deferred: t.exempt,
      },
    }),
  };
}

async function runReview(
  state: RunState,
  cfg: Config,
  cwd: string,
  plan: Plan,
  roles: RoleTable,
  turns: AgentTurns,
): Promise<{
  report: FindingsReport & { testChanges?: TestChanges };
  /**
   * The P0s the vote did not confirm, under `review.unconfirmedP0: "halt"` -
   * empty otherwise (#388 Part C). Handed back rather than thrown here because
   * the caller writes `code-review-<n>.json`, and the stop has to come after
   * the record of what it stopped for.
   */
  unconfirmedP0: Finding[];
}> {
  // Before `log.step`, so the run never claims a reviewer started on a diff it
  // could not read. The decision that a gitless run is refused rather than
  // degraded is NOT made here - it is made by `gitPrecondition` in the preflight
  // gate, before anything is spent. This covers only what that gate cannot see:
  // a resume, a hand-edited state, or a repository that stopped being one
  // mid-run. `isRepo` and not `hasCommits` for the reason recorded there - a
  // repository with no commits reviews fine (measured 2026-08-27, #71).
  //
  // Without it, `diffChunks` runs `git diff --cached`, which outside a
  // repository falls back to `--no-index` mode and dies with `unknown option
  // 'cached'` - a git usage message about a flag vibe passed, naming nothing a
  // user could act on.
  // `repoStatus` rather than `isRepo` for the same reason the gate uses it: a
  // git that cannot be resolved or spawned makes `isRepo` throw, and an
  // unhandled throw here is a generic run error rather than the named refusal.
  const repo = await git.repoStatus(cwd);
  if (!repo.isRepo) {
    throw new Escalation(
      EXIT.PREFLIGHT,
      (repo.error === null
        ? `${cwd} is not a git repository`
        : `git could not be run against ${cwd} (${repo.error})`) +
        ", so the review phase cannot run: the reviewer's only input is a diff produced by " +
        'git, and there is no second source for it. ' +
        (repo.error === null
          ? 'Point the run at the repository, or `git init` here, and resume.'
          : 'Repair the git binary - VIBE_GIT_BIN, or git on PATH - and resume.'),
    );
  }

  log.step(`${holderLabel('reviewer', roles)} is reviewing the implementation`, {
    id: 'turn_started',
    data: { role: 'reviewer', kind: 'review', round: state.reviewRound },
  });
  const { chunks, files, changes } = await git.diffChunks(cwd, state.baseSha);
  // From the same read as the diff, so the files the reviewer is asked to judge
  // are the files it is shown (#112).
  const patterns = judgePatterns(cfg.verify);
  const judged = judgeChanges(changes, patterns);

  // **An empty diff is refused, not reviewed.** There was a guard for a diff too
  // BIG for one turn and none at all for one with nothing in it, and
  // `diffChunks` answers the empty case with a perfectly well-formed result -
  // one chunk, no files, an empty string - so nothing downstream could tell
  // "here is the change" from "there is no change to read". The reviewer was
  // spawned with a prompt that said *here is the diff* followed by nothing.
  //
  // Measured on a run of 2026-09-15: it improvised, ran 32 shell commands in
  // five minutes looking for the change by hand, went silent, and was killed 39
  // minutes later at the Codex turn ceiling. The run ended `status: error` on a
  // tree whose implementation was complete and whose verification gate had just
  // passed three times out of three.
  //
  // This is the rule the file above already applies to a directory that is not a
  // repository, in almost the same words, and it is the same refusal: the
  // reviewer's only input is a diff produced by git, and there is no second
  // source for it. `EXIT.PREFLIGHT` because that code is documented for exactly
  // this - *"the target directory cannot host those phases at all ... whose
  // review phase has no diff to read"* - and it is resumable, so the round is
  // still there once the cause is fixed.
  if (files.length === 0 && chunks.every((c) => c.diff === '')) {
    throw new Escalation(
      EXIT.PREFLIGHT,
      `The review phase has no diff to read: git reported no change ${
        state.baseSha === null
          ? 'in this repository at all'
          : `since ${state.baseSha.slice(0, 7)}`
      }. The reviewer's only input is a diff, and there is no second source for ` +
        'it, so no review turn was started and nothing was spent. Either the implement phase ' +
        'wrote nothing, or its work is somewhere this range cannot see it.',
    );
  }

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
  // The judge record goes with it, for the same reason: a verdict carried over
  // from the previous round would be a verdict on a diff nobody showed (#112).
  state.testChanges = undefined;
  saveState(state);

  // Read once, before the loop, and handed to EVERY part. Each part sees a
  // slice of the diff while the report describes the whole change, so a concern
  // about a file in part 3 is context a reviewer of part 1 may still need - and
  // a report is small next to a 400k-character diff (#49, #50).
  const report = latestReport(state);

  // The repository's REVIEW.md, from the commit the run started at - never the
  // working tree, so an edit this run made reaches the NEXT run's review, not
  // this one (#389). Settled once per run per process and handed to every part,
  // every finder (through `reviewPromptFor`) and every verifier alike.
  const reviewMd = await reviewStandardsFor(state, cwd);

  if (chunks.length > 1) {
    // How the round was SPLIT, which is true before any turn runs. What was
    // actually seen is `reviewCoverage`, recorded per completed part below.
    recordAndSay(
      state,
      'info',
      'review_chunked',
      `Diff too large for one turn - reviewing ${files.length} file(s) in ${chunks.length} parts`,
      { chunks: chunks.length, files: files.length },
    );
  }

  const reports: FindingsReport[] = [];
  // Accumulated here rather than read back off `state`: the record is what the
  // reviewer has been handed so far, and reading the field it was just cleared
  // to would make that a round trip through a value this function owns.
  const seen: string[] = [];
  const cut: string[] = [];
  // Per part, because a verdict only counts from the part that listed the file.
  const listedPerPart: FileChange[][] = [];
  const verdictsPerPart: RawVerdict[][] = [];
  const chunked = chunks.length > 1;
  // Only a part's judge files. A rename is listed wherever either of its
  // paths is shown, since `chunk.files` names both sides (`--no-renames`).
  const listedFor = (chunk: (typeof chunks)[number]): FileChange[] =>
    judged.filter(
      (c) =>
        chunk.files.includes(c.path) || (c.oldPath !== null && chunk.files.includes(c.oldPath)),
    );
  // One part's review prompt. The first finder and every additional finder are
  // handed the same arguments (#388 Part B): an additional finder differs only
  // in having no memory, which a memoryless reviewer already renders.
  const reviewPromptFor = (i: number, hasMemory: boolean, carriesEarlierParts: boolean): string => {
    const chunk = chunks[i];
    if (chunk === undefined) throw new Error(`review part ${i + 1} does not exist`);
    const listed = listedFor(chunk);
    return P.reviewPrompt(
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
      // Absent unless this run would actually place and run one, which is
      // what keeps a `verify.reproducers: false` review byte-identical to
      // the one before #113. Only gates with a command: a gate the run
      // cannot execute is not a choice the reviewer has.
      reproducerGates(cfg, cwd),
      // Absent unless this part shows a judge file, which is what keeps every
      // other round's prompt byte-identical (#112).
      listed.length > 0 ? listed : undefined,
      // Absent when the repository has none, or it was refused or unreadable,
      // which keeps that prompt byte-identical too (#389).
      reviewMd,
    );
  };
  for (const [i, chunk] of chunks.entries()) {
    const listed = listedFor(chunk);
    // Read inside the loop: the slot is marked started by the turn that
    // succeeds, so with a persistent thread part 1 is memoryless and parts 2..n
    // continue the conversation without anything new (#45).
    const hasMemory = roleHasMemory(state, cfg, 'reviewer', roles);
    // And separately from it: lifetime memory is not this round's parts. Part 1
    // of a later round resumes a thread that has never seen the other parts of
    // *this* round, and telling it not to repeat findings for them would ask it
    // to stay quiet about a diff it was never shown.
    const carriesEarlierParts = i > 0 && hasMemory;
    const outcome = await runTurn(
      state,
      cfg,
      {
        role: 'reviewer',
        prompt: reviewPromptFor(i, hasMemory, carriesEarlierParts),
        cwd,
        // Unchanged when there is one chunk: this string is Codex's output name
        // and the retry label, and a round that did not need splitting must look
        // exactly as it always did.
        label: chunked ? `review-${state.reviewRound}-part${i + 1}` : `review-${state.reviewRound}`,
      },
      turns,
      roles,
    );
    const structured = readStructured(outcome);
    reports.push(
      // Per chunk turn, deliberately: a chunked round is several reviewer turns,
      // and each one's findings are judged against what that turn did rather
      // than against the round as a whole (#66).
      groundAndRecord(
        state,
        cwd,
        'reviewer',
        roles,
        parseFindings(structured),
        outcome.activity,
      ),
    );
    listedPerPart.push(listed);
    verdictsPerPart.push(parseTestVerdicts(structured));

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
    // After the turn, like the coverage above: a verdict is recorded only once
    // the turn that gave it has returned. Nothing at all until a part has
    // listed a judge file - a round that touches none records no field (#112).
    if (listedPerPart.some((l) => l.length > 0)) {
      state.testChanges = {
        round: state.reviewRound + 1,
        patterns: recordedPatterns(patterns),
        files: attachVerdicts(listedPerPart, verdictsPerPart),
      };
    }
    saveState(state);
    for (const file of chunk.truncated) {
      recordAndSay(
        state,
        'warn',
        'review_file_truncated',
        `${file} is larger than one review turn - the reviewer was shown a cut diff`,
        { file },
      );
    }
  }

  // Narration with no event, under `recordAndSay`'s rule: the fact is already
  // durable in `state.testChanges` and in the round's artifact, and a census of
  // a round is exactly what that rule keeps out of `state.events`. Warn only
  // when something was not judged justified - a round that only added tests
  // the reviewer accepted is information, not a caveat (#112). `seated` only
  // for a round with finders, whose record is every reporting seat's (#404).
  const sayTestChanges = (tc: TestChanges, seated?: { seats: number; disagreed: number }): void => {
    const counts = testChangeCounts(tc.files);
    const say = counts.notJustified + counts.unjudged > 0 ? log.warn : log.info;
    say(
      `Review round ${tc.round}: ${counts.files} change(s) to the judge - ` +
        `${counts.justified} justified, ${counts.notJustified} not justified, ` +
        `${counts.unjudged} unjudged` +
        (seated === undefined ? '' : `; ${seated.seats} seat(s), ${seated.disagreed} disagreed`),
      { id: 'test_changes_judged', data: { round: tc.round, ...counts, ...(seated ?? {}) } },
    );
  };
  // With no additional finder, exactly the report of every round before #388:
  // no extra turn, no `foundBy`, no event - and the judge record is the
  // reviewer's, said here as it always was.
  const finders = readFinders(cfg);
  if (finders.length === 0 && state.testChanges !== undefined) sayTestChanges(state.testChanges);

  const [only] = reports;
  const first = reports.length === 1 && only !== undefined ? only : mergeReviewReports(reports);
  const round = state.reviewRound;
  const finderRun =
    finders.length === 0
      ? undefined
      : await runFinderSeats<RawVerdict[]>(
          state,
          cfg,
          cwd,
          roles,
          turns,
          {
            role: 'reviewer',
            kind: 'review',
            round,
            maxParallel: cfg.review.maxParallel,
            setting: 'review.maxParallel',
            doing: 'is reviewing the implementation',
            table: (f) => seatTable(roles, f.setting),
            // Every part of the diff, as the first finder reviewed it, each
            // handed the same arguments the first was (#388 Part B): a finder
            // differs only in having no memory, which a memoryless reviewer
            // already renders.
            parts: (f) =>
              [...chunks.keys()].map((i) => ({
                label: chunked ? `review-${round}-f${f.k}-part${i + 1}` : `review-${round}-f${f.k}`,
                prompt: P.withFocus(reviewPromptFor(i, false, false), f.focus),
              })),
            failed: { id: 'review_finder_failed', noun: 'Review' },
            // Each part's test verdicts, combined below with the reviewer's (#404).
            extra: parseTestVerdicts,
            merged: ({ seats, reported, raised, merge }) => ({
              id: 'review_finders_merged',
              message:
                `review round ${round + 1}: ${seats} finders × ${chunks.length} part(s), ` +
                `${reported} of ${seats} reported, ${raised} findings → ${merge.report.findings.length} ` +
                `after merge (${merge.byCitation} merged by citation, ${merge.byTitle} by title)`,
              data: {
                round,
                finders: seats,
                parts: chunks.length,
                reported,
                findings: raised,
                merged: merge.report.findings.length,
                byCitation: merge.byCitation,
                byTitle: merge.byTitle,
              },
            }),
          },
          finders,
          first,
        );
  const merged = finderRun === undefined ? first : finderRun.report;
  // Every reporting seat's verdicts, combined failing closed, and only then
  // said (#404). Written after the finders: until here the record is the
  // reviewer's own, from the loop above, so a stop during the finders leaves
  // what a round without them would have. A finder that failed has no slot and
  // contributes nothing. Each seat is attached from the reviewer's listed files
  // part by part, since a finder was shown the same parts.
  if (finderRun !== undefined && state.testChanges !== undefined) {
    const judgements: SeatJudgement[] = [
      {
        seat: 'roles.reviewer',
        provider: roles.reviewer.provider,
        model: roles.reviewer.model ?? 'default',
        files: attachVerdicts(listedPerPart, verdictsPerPart),
      },
      ...finderRun.slots.map((s) => ({
        seat: s.seat,
        provider: s.provider,
        model: s.model,
        files: attachVerdicts(listedPerPart, s.extras),
      })),
    ];
    const combined = combineVerdicts(judgements);
    state.testChanges = { ...state.testChanges, files: combined };
    saveState(state);
    sayTestChanges(state.testChanges, { seats: judgements.length, disagreed: disagreements(combined) });
  }
  // Inside `runReview` and after the merge, which are two separate decisions
  // (#113).
  //
  // After the merge, because a chunked round is several turns and the same id
  // can come back from two of them - `mergeReviewReports` picks the most
  // blocking, and running a reproducer per part would place the same file twice
  // and observe a severity the round did not end up with.
  //
  // Inside `runReview` rather than beside it in `reviewPhase`, because the
  // caller writes `code-review-<n>.json` and `recordPendingFindings` from what
  // this returns. Doing it outside would mean either a record written before the
  // observations - which a resume could not see - or rewriting the round's own
  // artifact afterwards, which #142 settled against for the reason that applies
  // here too: that file is the record of what the reviewer produced. Written
  // once, containing what the reviewer said and what vibe observed about it, is
  // exactly what it already does for `downgraded`.
  const proven = await proveFindings(state, cfg, cwd, roles, merged);
  // Into the round's `code-review-<n>.json`, which the caller writes once from
  // this. Absent rather than empty when no judge file was touched, so that
  // artifact is byte-for-byte what it was before (#112).
  //
  // The vote comes after the reproducers and inside this function for the same
  // two reasons (#388 Part C): it is a decision about the merged round, and its
  // record belongs in the one artifact the caller writes. With no verifier,
  // exactly the report of every round before it: no turn, no `votes`, no event.
  const verifiers = readVerifiers(cfg);
  const voted =
    verifiers.length === 0
      ? { report: proven, held: [] }
      : await runVoteSeats(
          state,
          cfg,
          cwd,
          turns,
          {
            role: 'reviewer',
            round,
            maxParallel: cfg.review.maxParallel,
            setting: 'review.maxParallel',
            // A finding whose own reproducer reproduced is an observation the
            // vote has nothing to add to - it blocks, whatever `unconfirmedP0`
            // says.
            exempt: (f) => reproducerOutcomesOf(f).some((o) => o.verdict === 'reproduced'),
            prompt: (f) => {
              // The diff parts its evidence cites, or every part when it cites
              // none of them: a claim about a file the diff never touched is
              // still a claim about this change, and the verifier can read the
              // rest of the tree.
              const cited = new Set(
                readEvidence(f.evidence).flatMap((e) => (typeof e.path === 'string' ? [e.path] : [])),
              );
              const touching = chunks.filter((c) => c.files.some((file) => cited.has(file)));
              const shown = touching.length > 0 ? touching : chunks;
              return P.votePrompt(
                {
                  title: f.title,
                  detail: f.detail,
                  suggested_fix: f.suggested_fix,
                  ...(f.evidence === undefined ? {} : { evidence: f.evidence }),
                },
                shown.flatMap((c) => c.files),
                shown.map((c) => c.diff).join('\n'),
                plan.plan_md,
                plan.out_of_scope,
                state.environment,
                roles,
                reviewMd,
              );
            },
            table: (v) => seatTable(roles, v.setting, VOTE_SCHEMA),
            label: (n, k) => `vote-${round}-${n}-v${k}`,
            quorum: cfg.review.quorum,
            unconfirmedP0: cfg.review.unconfirmedP0,
            tallied: (t) => ({
              id: 'review_votes_tallied',
              message: `review round ${round + 1}: ${t.said}; ${t.exempt} reproduced, not voted`,
              data: {
                round,
                findings: t.findings,
                verifiers: t.verifiers,
                votes: t.votes,
                confirmed: t.confirmed,
                unconfirmed: t.unconfirmed,
                moved: t.moved,
                held: t.held,
                undecided: t.undecided,
                reproduced: t.exempt,
              },
            }),
          },
          verifiers,
          proven,
        );
  // Read here, after the finders, so the artifact carries the record
  // `state.json` does - with finders, the combined one (#404).
  const testChanges = state.testChanges;
  return {
    report: testChanges === undefined ? voted.report : { ...voted.report, testChanges },
    unconfirmedP0: voted.held,
  };
}

/**
 * The gate names a reproducer could be run by, or undefined when none could
 * (#113).
 *
 * Undefined and not `[]`, because the two are different instructions to
 * `reviewPrompt`: undefined renders no section at all, which is what a run with
 * the feature off has to produce. It also collapses to undefined for a config
 * with no runnable gate, since offering a reviewer a choice between nothing is
 * how a field gets filled in with an invented name.
 */
function reproducerGates(cfg: Config, cwd: string): readonly string[] | undefined {
  if (!cfg.verify.reproducers || !cfg.verify.enabled) return undefined;
  const names = resolveGates(cfg.verify, cwd)
    .filter((g) => g.command !== null)
    .map((g) => g.name);
  return names.length > 0 ? names : undefined;
}

/**
 * Run every blocking finding's reproducer, attach what was observed, and
 * downgrade the ones whose own test passed (#113).
 *
 * ## Which findings, and why not all of them
 *
 * Blocking only - P0 and P1. A reproducer's whole effect is on whether a finding
 * blocks, so running one for a P3 buys a gate execution to change nothing. This
 * is also the issue's open question *"which severities require one"*, answered
 * in the direction that costs nothing: none of them require one. A reviewer that
 * cannot express a defect as a failing test keeps its finding and is judged as
 * findings have always been judged, and the schema says so.
 *
 * ## The cost, stated rather than capped
 *
 * One gate execution per blocking finding that carries a reproducer, at that
 * gate's own timeout, on a tree the gate just passed on. There is deliberately
 * no cap: a number here would be invented, and against the alternative - the
 * measured case is a false P1 that bought a ~1.3M-token fix round editing
 * working code - a 90-second suite run is not a close call. `verify.reproducers:
 * false` is the off switch, and it is one setting rather than a ceiling because
 * a ceiling would silently drop the reproducers past it.
 *
 * ## The baseline
 *
 * `state.gateOutcomes` is reset by every `runGate` call and this runs after the
 * one that just came back clean, so it names the gates observed to pass on this
 * exact tree. Nothing else in this function assumes a baseline: a gate that was
 * disabled, unavailable, or simply not in that list produces `unproven` on a
 * failure rather than a proof.
 */
async function proveFindings(
  state: RunState,
  cfg: Config,
  cwd: string,
  roles: RoleTable,
  report: FindingsReport,
): Promise<FindingsReport> {
  if (!cfg.verify.reproducers || !cfg.verify.enabled) return report;

  const pending = report.findings.filter(
    (f) => (f.severity === 'P0' || f.severity === 'P1') && f.reproducer !== undefined,
  );
  if (pending.length === 0) return report;

  const gates = resolveGates(cfg.verify, cwd);
  const passed = new Set(
    (state.gateOutcomes ?? []).filter((o) => o.status === 'passed').map((o) => o.name),
  );
  const outcomes = new Map<string, ReproducerOutcome>();

  for (const f of pending) {
    const reproducer = f.reproducer;
    if (reproducer === undefined) continue;
    log.step(`Running the reproducer for ${f.id}`, {
      id: 'reproducer_started',
      data: { id: f.id, path: reproducer.path, gate: reproducer.gate ?? null },
    });
    const outcome = await observe(f, reproducer, {
      cwd,
      runDir: state.dir,
      gates,
      contract: cfg.toolchain,
      // The *reviewer's* convention, because the reviewer typed the path - the
      // same read `groundAndRecord` makes for the same reason.
      style: pathStyleFor(state, 'reviewer', roles),
      passedGates: passed,
      at: 'review',
    });
    outcomes.set(f.id, outcome);
    recordAndSay(
      state,
      outcome.verdict === 'unproven' ? 'warn' : 'info',
      'reproducer_observed',
      `Reproducer for ${f.id}: ${outcome.verdict} - ${describeOutcome(outcome)}`,
      {
        id: f.id,
        verdict: outcome.verdict,
        at: outcome.at,
        gate: outcome.gate,
        command: outcome.command,
        exitCode: outcome.exitCode ?? null,
        baseline: outcome.baseline,
        reason: outcome.reason,
        archived: outcome.archived,
      },
    );
  }

  const applied = applyReproducerOutcomes(report, outcomes);
  recordDowngrades(state, applied.downgraded);
  return applied.report;
}

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
    {
      id: 'questions_opened',
      data: {
        total: questions.length,
        blocking: blockingCount,
        // Hi-fi 14 draws the question loop as a nested group with **its own
        // counter and its own cap** - `round 2/3` sitting inside `round 1/5` -
        // and the frame carried neither, so the group could not say where in
        // its own loop it was. Both, because a position with no cap is a number
        // and a position in something is a fact somebody can act on: `at the
        // cap` is the state the frame's whole escalation is about.
        round: state.questionRound,
        cap: cfg.loop.maxQuestionRounds,
        // The questions themselves, carried on the frame that already announces
        // them (#223). `1f` is an inbox and cannot be one over two counts - and
        // the alternative was for a window to scrape the `- [kind] text` lines
        // printed immediately below, which is the English-matching #133 exists
        // to prevent. Nothing a terminal prints changes: this is data on a
        // narration id, and narration ids carry no entry in `state.events`.
        questions: questions.map((q) => ({
          kind: q.kind,
          question: q.question,
          blocking: q.blocking,
        })),
      },
    },
  );
  for (const q of questions) log.info(`- [${q.kind}${q.blocking ? ', blocking' : ''}] ${q.question}`);

  // Asked of the role, not of the provider: the key is provider-named for
  // history, but what it gates is whether the answerer takes a turn at all.
  if (!roleEnabled('answerer', cfg)) {
    const blockers = questions.filter((q) => q.blocking);
    if (blockers.length === 0) return [];
    throw new Escalation(EXIT.NEEDS_HUMAN, 'Blocking questions need answers.', [...blockers]);
  }

  log.step(`${answerer} is answering`, {
    id: 'turn_started',
    data: { role: 'answerer', kind: 'answer', questions: questions.length },
  });
  const outcome = await runTurn(
    state,
    cfg,
    {
      role: 'answerer',
      prompt: P.answerPrompt(questions, P.renderPlanDoc(plan)),
      cwd,
      // **The question round, not the plan round.** These were keyed by
      // `planRound` and could be because every question round used to advance it
      // - which is the defect above, and this is the collision that fell out of
      // fixing it: two question rounds under one plan round both wrote
      // `answers-0.json`, and the second silently replaced the first. The
      // question round is the counting this turn actually belongs to, it is
      // monotonic for the whole run, and `state.questionRound` was incremented
      // by the caller before this was reached - so the first is `answers-1`.
      label: `answers-${state.questionRound}`,
    },
    turns,
    roles,
  );

  const { answers } = parseAnswers(readStructured(outcome));
  artifact(state, `answers-${state.questionRound}.json`, answers);

  // Every question asked is marked answered regardless of outcome, so a
  // rephrased repeat in the next revision cannot re-enter this branch.
  for (const q of questions) markAnswered(state, q.question);
  for (const a of answers) markAnswered(state, a.question);

  const declined = (a: Answer): boolean =>
    (cfg.questions.escalateOnDefer && a.defer_to_human) ||
    (cfg.questions.escalateOnLowConfidence && a.confidence === 'low');

  const usable = answers.filter((a) => !declined(a));
  const refused = answers.filter(declined);

  // **The marks and the answers they stand for land on one write** (#169).
  //
  // Marking stays here, before the revision, and that order is #65's: a stop
  // after this turn and before the mark would put the same question to the
  // answerer again. But a mark is a promise that the answer reaches a plan, and
  // until #169 the answers lived only in this function's return value - so
  // every way of stopping before `revisePlan` persisted the plan kept the marks
  // and lost the answers, and the resumed loop critiqued a plan whose questions
  // `isAnswered` now suppressed and nothing had resolved. Four exits did it: a
  // kill, the declined-blocking escalation below, and a `stop` gate or a
  // stopped `step` hold at `question-round`.
  //
  // So the usable answers ride on the same `saveState` as the keys, before any
  // of those exits can be reached, and `planPhase`'s re-entry block - the
  // resume path NEEDS-INPUT already used - revises against them. The whole
  // usable list, unpaired answers included, because that is what the revision
  // would have been given; declined answers never reached a revision and do
  // not here either. A consequence that is intended: the post-answerer
  // `question-round` checkpoint (#139) now carries them, so a fork from it
  // revises against what this turn bought instead of losing it.
  state.pendingAnswers = usable.length > 0 ? [...usable] : null;
  saveState(state);

  // **The pairing, and it is no longer string equality** (#211). The answerer is
  // asked to echo the question and echoes what it was shown, which
  // `formatQuestion` renders with the kind and the blocking tag after it - so a
  // real run produced `"...untested? *(technical, advisory)*"` against a question
  // ending at the question mark, and every pair failed. That was not only a pane
  // drawing "No answer yet" over answered questions: `refusedBlocking` came back
  // empty, so a declined blocking question would have been counted as answered
  // and `escalateOnDefer` could not fire.
  //
  // `pairAnswers` is the module that already owns "when are two wordings one
  // question", using the same normalize and the same threshold as the re-ask
  // guard rather than a second rule that would drift from it.
  const pairing = pairAnswers(
    questions,
    refused,
    (q) => q.question,
    (a) => a.question,
  );
  const answerFor = (q: OpenQuestion): Answer | undefined =>
    pairing.paired.find((p) => p.question === q)?.answer;
  const refusedBlocking = questions.filter((q) => q.blocking && answerFor(q) !== undefined);
  const refusedAdvisory = questions.filter((q) => !q.blocking && answerFor(q) !== undefined);

  // A decline that paired with nothing. Named rather than dropped and never
  // attached to the nearest question: this is the answerer refusing to guess,
  // and losing it in silence is the failure this whole change is about. It does
  // not escalate, because nothing here can say which question it was about, and
  // stopping a run over a question nobody can name is worse than saying so.
  for (const a of pairing.unpaired) {
    log.warn(`${answerer} declined an answer that matches no question asked: ${a.question}`);
  }

  for (const q of refusedAdvisory) {
    const reason = answerFor(q)?.rationale ?? `${answerer} declined to answer.`;
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

  /**
   * Answers as rows keyed by the question the *planner* wrote.
   *
   * The join happens here because this is the only side that has both the
   * questions and `similarity`. An answer that paired with nothing keeps its own
   * wording and travels anyway - dropping it would hide what the answerer said,
   * and attaching it to the nearest question would state that it was about a
   * question nobody has established it was about.
   */
  const asked = (
    list: readonly Answer[],
  ): {
    question: string;
    answer: string;
    confidence: string;
    rationale: string;
    deferToHuman: boolean;
  }[] => {
    const pairs = pairAnswers(
      questions,
      list,
      (q) => q.question,
      (a) => a.question,
    );
    const row = (question: string, a: Answer) => ({
      question,
      answer: a.answer,
      confidence: a.confidence,
      rationale: a.rationale,
      deferToHuman: a.defer_to_human,
    });
    return [
      ...pairs.paired.map((p) => row(p.question.question, p.answer)),
      ...pairs.unpaired.map((a) => row(a.question, a)),
    ];
  };

  log.ok(`${answerer} answered ${usable.length} of ${questions.length} question(s)`, {
    // The other half of `1f` (#223). The pane is an inbox of open questions with
    // **the adversary's draft and its confidence** beside each, and until now
    // the questions reached the wire without the answers - so a window could
    // show what was asked and never what came back.
    //
    // A narration id with no event, like `questions_opened`, and the same
    // sentence at the same level: `answers-N.json` is where this is durable.
    id: 'questions_answered',
    data: {
      answered: usable.length,
      total: questions.length,
      // Both, and labelled, because they are different outcomes rather than a
      // count and a remainder: a declined answer is the answerer refusing to
      // guess at product intent, which `escalateOnDefer` then acts on.
      //
      // **Keyed by the question as the PLANNER wrote it**, not as the answerer
      // echoed it (#211). A window joins these back onto `questions_opened` and
      // the only string that appears on both frames has to be one string - the
      // echo is the rendered form, tag and all, and joining on it drew "No
      // answer yet" over two answered questions. Doing the pairing here rather
      // than in the window is also what keeps *one* definition of it: the
      // window has no `similarity`, and a second matcher over there would drift
      // from this one on the first wording either side did not expect.
      answers: asked(usable),
      declined: asked(refused).map((row) => ({
        question: row.question,
        confidence: row.confidence,
        rationale: row.rationale,
        deferToHuman: row.deferToHuman,
      })),
    },
  });
  return usable;
}

/**
 * Every question actually put to the answerer, and every answer that came back.
 *
 * That is the whole meaning of the list, and #65 left it there: a re-ask the
 * guard suppresses was never sent, so it is not marked here. The cost is that a
 * suppressed wording recurring in a later round is caught by the fuzzy scan
 * against the original rather than by the exact path below - which is what the
 * scores in `src/questions.ts` leave room for.
 *
 * **It does not save** (#169). A key on disk is a promise that the answer
 * reaches a plan, so the caller persists the marks on the same write as the
 * answers they stand for - one `saveState` per batch, never one per key with a
 * window after the last of them.
 */
function markAnswered(state: RunState, question: string): void {
  const key = normalize(question);
  if (key && !state.answeredQuestions.includes(key)) state.answeredQuestions.push(key);
}

function isAnswered(state: RunState, question: string): boolean {
  return state.answeredQuestions.some((key) => isSameQuestion(key, question));
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
      // No line for no default (#394): the stall question has none on purpose,
      // and an empty default line would read as one.
      if (q.recommended.trim() !== '') lines.push(`*Claude would default to:* ${q.recommended}`);
      lines.push('\n**Your answer:**\n\n> \n');
    });
  }

  if (escalation.findings && escalation.findings.length > 0) {
    // A stop for the vote (#388 Part C) lists what the verifiers said, each
    // ballot with its reason; every other stop renders exactly as it did.
    const voted = escalation.findings.every((f) => f.severity === 'P0' && f.votes?.outcome === 'unconfirmed');
    lines.push(voted ? '## Unconfirmed P0 findings\n' : '## Outstanding P1 findings\n');
    for (const f of escalation.findings) {
      lines.push(`### ${f.title} \`${f.id}\`\n${f.detail}\n\n*Suggested fix:* ${f.suggested_fix}\n`);
      if (voted && f.votes !== undefined) lines.push(`${describeVotes(f.votes).join('\n')}\n`);
    }
  }

  // Before the raise block, because it is the cheaper decision of the two: a
  // person who disagrees with a finding's severity does not have to write one
  // (#142). Rendered from what the run is actually carrying rather than from
  // `escalation.findings`, which is a message about the stop - a severity moved
  // on a finding nothing will read changes nothing, and the two lists differ on
  // every stop that reported questions.
  const carry = raisePhase(resumePhase(state));
  const carried = carry === null ? null : takePendingFindings(state, carry);
  if (carried !== null) lines.push(moveSection(carried));

  // Last, and on every stop rather than only on the ones that asked something
  // (#141). The thing a person most wants to raise a finding about is the diff,
  // which exists at every stop after the plan - and a stop that reported
  // findings rather than questions is exactly the moment somebody has read them
  // and disagrees. Left untouched it parses to nothing.
  lines.push(raiseSection(state.id));

  return artifact(state, 'NEEDS-INPUT.md', lines.join('\n'));
}
