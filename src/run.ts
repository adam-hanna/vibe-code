import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ActivityObservation } from '@src/progress.js';
import { initialSlotFields } from '@src/slots.js';
import type {
  Finding,
  PendingFindings,
  RoundRecord,
  RunPhase,
  RunState,
  RunSummary,
} from '@src/types.js';

const RUNS_DIR = path.join('.vibe', 'runs');

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'run'
  );
}

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Make `.vibe` ignore itself.
 *
 * The run directory lives inside the target repo so artifacts sit next to the
 * work they describe, but plans, schemas and Codex transcripts must never land
 * in the user's history. A self-ignoring directory is the only mechanism that
 * holds regardless of what the target repo's own .gitignore says: excluding it
 * by pathspec breaks when the user also ignores `.vibe`, and relying on the
 * user's .gitignore breaks when they do not.
 *
 * Written, never overwritten - a user who has deliberately changed it keeps
 * their version.
 */
export function ensureVibeIgnored(targetDir: string): void {
  const dir = path.join(targetDir, '.vibe');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.gitignore');
  if (!existsSync(file)) writeFileSync(file, '*\n', 'utf8');
}

export function createRun(targetDir: string, task: string, planOnly: boolean): RunState {
  const id = `${stamp()}-${slugify(task)}`;
  const dir = path.join(targetDir, RUNS_DIR, id);
  mkdirSync(dir, { recursive: true });
  ensureVibeIgnored(targetDir);

  const state: RunState = {
    id,
    dir,
    targetDir,
    task,
    // Every managed conversation's starting state, stated where the lifecycle
    // is rather than as three literals here.
    ...initialSlotFields(),
    createdAt: new Date().toISOString(),
    status: 'planning',
    phase: 'planning',
    planRound: 0,
    reviewRound: 0,
    costUsd: 0,
    tokensUsed: 0,
    rateLimitWaits: 0,
    baseSha: null,
    branch: null,
    p1Rounds: [],
    verifyRounds: [],
    verifyRound: 0,
    questionRound: 0,
    events: [],
    planOnly,
    answeredQuestions: [],
    deferredQuestions: [],
    sessionRotations: 0,
    handoff: null,
    contextRatio: 0,
    plan: null,
    pendingAnswers: null,
    extraContext: null,
  };
  saveState(state);
  return state;
}

export function loadRun(targetDir: string, id: string): RunState {
  const dir = path.join(targetDir, RUNS_DIR, id);
  const file = path.join(dir, 'state.json');
  if (!existsSync(file)) throw new Error(`No run "${id}" under ${RUNS_DIR}`);

  const parsed = JSON.parse(readFileSync(file, 'utf8')) as RunState;
  // Also on resume: a run created before this existed still needs the guard.
  ensureVibeIgnored(targetDir);
  // Paths are re-derived so a run directory stays valid if the repo moves.
  return { ...parsed, dir, targetDir };
}

export function listRuns(targetDir: string): RunSummary[] {
  const root = path.join(targetDir, RUNS_DIR);
  if (!existsSync(root)) return [];

  return readdirSync(root)
    .filter((d) => existsSync(path.join(root, d, 'state.json')))
    .sort()
    .reverse()
    .map((d): RunSummary => {
      try {
        const s = JSON.parse(readFileSync(path.join(root, d, 'state.json'), 'utf8')) as Partial<RunState>;
        return {
          id: d,
          status: s.status ?? 'unknown',
          task: s.task ?? '',
          costUsd: typeof s.costUsd === 'number' ? s.costUsd : 0,
        };
      } catch {
        return { id: d, status: 'unreadable', task: '', costUsd: 0 };
      }
    });
}

/**
 * Record how far the run has got, and persist it immediately.
 *
 * Called at the point the work of a phase is *finished*, not when the next one
 * starts, so a failure in between does not repeat it.
 */
export function advancePhase(state: RunState, phase: RunPhase): void {
  state.phase = phase;
  saveState(state);
}

/**
 * Where to resume, for a run recorded before `phase` existed.
 *
 * `status` is the only evidence available, and it is only conclusive while the
 * run is mid-flight: a terminal status has already overwritten the phase. Those
 * fall back to 'planning', which is what such a run did before this existed -
 * wasteful, but never wrong in the dangerous direction of skipping work that
 * was never done.
 */
export function resumePhase(state: RunState): RunPhase {
  if (state.phase !== undefined) return state.phase;
  switch (state.status) {
    case 'implementing':
      return 'implementing';
    case 'reviewing':
      return 'reviewing';
    case 'done':
    case 'planned':
      return 'complete';
    default:
      return 'planning';
  }
}

/**
 * The stored context ratio, but only when it provably describes `model`.
 *
 * null is "unknown", which is a different claim from a number: the measurement
 * is a fraction of the measuring model's window, so under any other model it
 * describes nothing. Callers must decide what unknown means rather than falling
 * back to the raw field.
 */
export function measuredRatio(state: RunState, model: string): number | null {
  return state.contextModel === model ? state.contextRatio : null;
}

/** The stored context window, only when it provably describes `model`. */
export function measuredWindow(state: RunState, model: string): number | undefined {
  return state.contextModel === model ? state.contextWindow : undefined;
}

/**
 * The window alone, for a turn whose ratio describes a session being abandoned.
 *
 * A rotation's handoff turn measures a real window but its occupancy belongs to
 * the conversation being discarded, so only the window survives. Guarded on
 * `contextModel` because the handoff may have run under the outgoing model: a
 * window that model measured says nothing about the incoming one, and storing it
 * anyway is the misattribution `resetContextMeasurement` exists to prevent.
 */
export function recordMeasuredWindow(state: RunState, model: string, contextWindow: number): void {
  if (contextWindow > 0 && state.contextModel === model) state.contextWindow = contextWindow;
}

/** Record a measurement together with the model that produced it. */
export function recordContextMeasurement(
  state: RunState,
  model: string,
  ratio: number,
  contextWindow: number,
): void {
  state.contextModel = model;
  state.contextRatio = ratio;
  state.contextWindow = contextWindow;
}

/**
 * A fresh session under `model`: nothing has been measured on it yet.
 *
 * Ratio and window are different kinds of fact, and the reset treats them
 * differently. The ratio is occupancy of the session just abandoned, so it goes
 * to zero. The window is metadata about `model` itself, and it is deleted here
 * because a rotation may be the very point at which the model changed -
 * reporting the outgoing model's window against the incoming one is the same
 * unattributed number this exists to remove. A same-model measurement may put it
 * back afterwards via `recordMeasuredWindow`, which is why a zero ratio beside a
 * present window is a valid state. Tagging the reset with `model` is also what
 * stops an unknown-provenance rotation asking for another rotation at the next
 * turn boundary.
 */
export function resetContextMeasurement(state: RunState, model: string): void {
  state.contextModel = model;
  state.contextRatio = 0;
  delete state.contextWindow;
}

export function saveState(state: RunState): void {
  writeFileSync(path.join(state.dir, 'state.json'), JSON.stringify(state, null, 2), 'utf8');
}

/**
 * How often a heartbeat may rewrite state.json. The file carries the whole
 * event log, so a turn emitting thousands of stream events must not write it
 * per event. The end-of-turn flush is exempt: it is the only chance to persist
 * a line that arrived inside the window.
 */
const ACTIVITY_WRITE_MS = 5_000;

/** Boundary sources, which say something the write throttle must not swallow. */
const UNTHROTTLED: readonly ActivityObservation['source'][] = ['start', 'end', 'final'];

/**
 * Record that the current turn is alive, for a watcher reading state.json from
 * another shell rather than from the process table.
 *
 * `turnStartedAt` and `lastOutputAt` describe the turn - or, under
 * `withConcurrentCompaction`, the two turns - vibe is running right now, never
 * the run as a whole. They are therefore written from the observation exactly as
 * given, including downwards: the heartbeat layer recomputes them across the
 * live turns, and a turn ending has to take its output time with it. Two earlier
 * versions of this got it wrong in opposite directions - one left the previous
 * turn's pulse in place for a turn that died before speaking, the other left a
 * finished rotation's last line standing while the Codex turn it overlapped was
 * still running.
 *
 * `lastActivityAt` is the exception, and is monotonic: "when vibe last observed
 * anything at all" is a fact about the run, and it is what remains readable
 * between turns, when the other two are describing nothing.
 */
export function markActivity(state: RunState, observation: ActivityObservation): void {
  const previous = state.lastActivityAt === undefined ? NaN : Date.parse(state.lastActivityAt);
  const at = observation.at.getTime();

  if (
    !UNTHROTTLED.includes(observation.source) &&
    Number.isFinite(previous) &&
    at - previous < ACTIVITY_WRITE_MS
  ) {
    return;
  }

  if (!Number.isFinite(previous) || at > previous) {
    state.lastActivityAt = observation.at.toISOString();
  }
  // Taken from the observation, not the clock: a skipped write delays the value
  // without ever making it claim a child was quieter than it was.
  if (observation.lastLineAt === null) {
    delete state.lastOutputAt;
  } else {
    state.lastOutputAt = observation.lastLineAt.toISOString();
  }
  if (observation.turnStartedAt === null) {
    delete state.turnStartedAt;
  } else {
    state.turnStartedAt = observation.turnStartedAt.toISOString();
  }
  saveState(state);
}

export function recordEvent(state: RunState, type: string, data: Record<string, unknown> = {}): void {
  state.events.push({ at: new Date().toISOString(), type, ...data });
  saveState(state);
}

export function artifact(state: RunState, name: string, content: string | object): string {
  const file = path.join(state.dir, name);
  const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  writeFileSync(file, body, 'utf8');
  return file;
}

/**
 * Delete an artifact that no longer describes the run. True if one was there.
 *
 * The counterpart to `artifact` for a file that is rewritten as the run
 * proceeds: FOLLOW-UPS.md is regenerated from the current plan, and a plan
 * revision that drops its last out-of-scope item has to be able to take the
 * file with it. A stale artifact contradicting PLAN.md is worse than none.
 */
export function removeArtifact(state: RunState, name: string): boolean {
  const file = path.join(state.dir, name);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}

/** Whether an artifact is on disk, for a caller that must not rewrite a good one. */
export function hasArtifact(state: RunState, name: string): boolean {
  return existsSync(path.join(state.dir, name));
}

export function artifactDir(state: RunState, name: string): string {
  const dir = path.join(state.dir, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Fingerprint of a P1 set, used to tell a repeated round from a new one.
 *
 * A repeat is evidence but not a verdict on its own - see `assessConvergence`,
 * which tolerates repetition early and judges the trend late.
 */
export function p1Signature(findings: readonly Finding[]): string | null {
  const ids = findings
    // P0s count too: a round that swapped a P1 for a P0 has changed, and
    // fingerprinting only P1s would record it as having stood still.
    .filter((f) => f.severity === 'P0' || f.severity === 'P1')
    .map((f) => f.id)
    .sort();
  if (ids.length === 0) return null;
  return createHash('sha1').update(ids.join('|')).digest('hex').slice(0, 12);
}

/**
 * Rounds only count as late once this much of the cap is spent.
 *
 * Before that the loop is left alone: a review cycle churning early is normal,
 * and two models trading revisions is how it converges. The question worth
 * asking near the cap is different - not "did this round repeat?" but "is this
 * heading anywhere?"
 *
 * Set from replaying round sequences: at 0.6 a five-round cap treats round
 * three as late, and a run that went 2 -> 2 -> 2 -> 1 was cut off one round
 * before it converged. Three quarters leaves room for early churn while still
 * reclaiming the rounds at the end that a stalled run would waste.
 */
const LATE_ROUND_FRACTION = 0.75;

/**
 * Rounds after which the trend is judged regardless of how high the cap is.
 *
 * `LATE_ROUND_FRACTION` alone scales with the cap, so raising a cap silently
 * disables the brake: at `maxReviewRounds` 30 the trend check does not engage
 * until round 23, leaving the 22 rounds where grinding actually happens
 * unprotected. Observed on a run that sat at 2 -> 2 -> 2 with no check in
 * sight. Whichever of the two triggers first wins, so small caps keep their
 * existing behaviour and large ones stop being a blank cheque.
 */
const TREND_FLOOR = 8;

/**
 * Histories are passed in rather than read from a fixed field: the review loop
 * and the verification loop converge independently, and mixing their rounds
 * makes each look less stable than it is.
 */
export function recordRound(
  history: RoundRecord[],
  signature: string | null,
  count: number,
  ids: readonly string[] = [],
): void {
  history.push({ signature, count, ids: [...ids] });
}

/**
 * The fields any consumer of a stored finding needs, checked rather than
 * asserted.
 *
 * One predicate for both the follow-ups artifact and the carried findings:
 * stored state is unvalidated, so "is this object a finding" is a question the
 * codebase must answer once. `defer` is deliberately not consulted - it is a
 * fact about what one caller does with a finding, not about its shape.
 */
export function hasFindingShape(f: unknown): f is Finding {
  if (typeof f !== 'object' || f === null) return false;
  const r = f as Record<string, unknown>;
  return (
    (r['severity'] === 'P0' ||
      r['severity'] === 'P1' ||
      r['severity'] === 'P2' ||
      r['severity'] === 'P3') &&
    typeof r['id'] === 'string' &&
    r['id'].length > 0 &&
    typeof r['title'] === 'string' &&
    typeof r['detail'] === 'string' &&
    typeof r['suggested_fix'] === 'string'
  );
}

/**
 * Record what a critique or review turn found, before anything can stop the run
 * between paying for it and using it.
 */
export function recordPendingFindings(
  state: RunState,
  phase: PendingFindings['phase'],
  findings: readonly Finding[],
): void {
  state.pendingFindings = { phase, findings: [...findings] };
  saveState(state);
}

/**
 * The unconsumed findings this phase may act on, or null when there are none.
 *
 * Reads without clearing, which is the whole contract: a revision that fails,
 * is rate-limited or dies mid-turn must leave them outstanding, or this
 * mechanism reintroduces the loss it exists to prevent. Clearing is
 * `clearPendingFindings`, called by whatever consumed them.
 *
 * Never throws, and absent, empty and malformed all read as null - the answer a
 * run recorded before this field existed would have given. The stored value is
 * an assertion over unvalidated JSON, so a present non-record, a `findings` that
 * is not an array, or entries that are not findings must not reach a prompt.
 * The phase tag is checked here rather than by the caller: it is what stops a
 * plan-phase remnant being handed to the fix turn.
 */
export function takePendingFindings(
  state: RunState,
  phase: PendingFindings['phase'],
): Finding[] | null {
  const raw: unknown = state.pendingFindings;
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r['phase'] !== phase) return null;
  const findings = r['findings'];
  if (!Array.isArray(findings)) return null;
  const usable = findings.filter(hasFindingShape);
  return usable.length > 0 ? usable : null;
}

/**
 * Mark the carried findings consumed.
 *
 * Written as an explicit null rather than deleted: the run record should say
 * that this run answered them, not merely fail to mention them.
 */
export function clearPendingFindings(state: RunState): void {
  state.pendingFindings = null;
  saveState(state);
}

/**
 * Whether every finding in the window is new to it - no id in more than one
 * round.
 *
 * Judged over the whole window rather than between neighbours, on purpose. An
 * {a,b} -> {c,d} -> {a,b} oscillation has no *consecutive* overlap and is
 * genuinely stuck; it fails this test because `a` occurs twice.
 *
 * A round with absent or empty ids means "cannot tell", not "no overlap". The
 * rule read literally is vacuously true for a history that carries no ids at
 * all, and `state.json` written before `RoundRecord.ids` existed has none - so
 * taking it literally would switch the trend brake off for every resumed legacy
 * run. Such a window falls back to the count-only verdict.
 */
function windowTurnedOver(recent: readonly RoundRecord[]): boolean {
  const seen = new Map<string, number>();
  for (const r of recent) {
    const ids = r.ids;
    if (ids === undefined || ids.length === 0) return false;
    // Deduped per round, so a round that names an id twice is not mistaken for
    // the same id surviving across rounds.
    for (const id of new Set(ids)) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  for (const n of seen.values()) if (n > 1) return false;
  return true;
}

/** Trailing rounds whose blocking count equals the latest round's. */
function flatRun(history: readonly RoundRecord[]): number {
  const target = history[history.length - 1]?.count;
  if (target === undefined) return 0;
  let rounds = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.count !== target) break;
    rounds += 1;
  }
  return rounds;
}

export interface ConvergenceArgs {
  /** Identical P1 set this many rounds running is a hard stop at any point. */
  repeatThreshold: number;
  /** How many recent rounds the trend is judged over. */
  window: number;
  cap: number;
  round: number;
}

/**
 * Decide whether to stop, returning the reason or null to continue.
 *
 * Deliberately tolerant early and strict late. Some oscillation is a healthy
 * part of review - the reviewer raises something, the fix shifts the problem,
 * the next round catches the shift - and aborting on the first repeat throws
 * away runs that would have converged. What matters is whether the trend is
 * downward by the time the budget is nearly spent.
 */
export function assessConvergence(
  history: readonly RoundRecord[],
  args: ConvergenceArgs,
): string | null {
  const { repeatThreshold, window, cap, round } = args;

  // Identical findings N rounds running means no new information is being
  // produced at all. More rounds cannot help, whenever it happens.
  const repeats = history.slice(-repeatThreshold);
  const first = repeats[0];
  if (
    repeats.length === repeatThreshold &&
    first?.signature != null &&
    repeats.every((r) => r.signature === first.signature)
  ) {
    return `the same P1 set came back ${repeatThreshold} rounds running`;
  }

  const recent = history.slice(-window);
  const hasWindow = recent.length === window;
  const improved =
    hasWindow && recent.some((r, idx) => idx > 0 && r.count < (recent[idx - 1]?.count ?? r.count));

  // A single id surviving many rounds *while its companions rotate* is NOT a
  // stop condition - see `persistenceNotice`, which reports it instead. It used
  // to abort the run here, and the picomatch reimplementation disproved the
  // premise. An unchanging singleton set is a different case and still stops:
  // it repeats its signature, so the set rule above catches it.

  // Trend: engaged near the cap, or once the run is simply long. Findings may
  // be new every round and still be going nowhere - a run that went 1 -> 1 -> 3
  // produced correct, distinct findings while getting further from done.
  const late = round >= Math.ceil(cap * LATE_ROUND_FRACTION) || round >= TREND_FLOOR;
  if (!late || !hasWindow) return null;

  if (!improved) {
    // A flat count whose findings turned over completely is not deadlock. The
    // planning run for issue #2 was stopped at 2 -> 2 -> 2 on three rounds with
    // zero id overlap - each a narrower restatement of the last - and the round
    // that followed fell to 1. The repeat arm above already treats identity as
    // meaningful; this was the one place that information was dropped.
    //
    // Bounded on purpose. Turnover buys one window, not the cap: the flat run
    // must have *started inside* this window, so the excuse can fire at most
    // once per run of equal counts. It says nothing about a rising count, which
    // leaves the flat run shorter than the window - 1 -> 1 -> 3 produces
    // correct, distinct findings while getting further from done, and still
    // stops here.
    //
    // Loosening a brake is worth being nervous about. The blast radius is one
    // window of rounds the run was already allowed: maxPlanRounds /
    // maxReviewRounds, `guardPlanBudget` and `budget.maxTokens` all still bind,
    // so the worst case of being wrong is a run spending what it was budgeted.
    //
    // `window > 1` because `convergenceWindow` is only validated as >= 1, and a
    // one-round window is never `improved` and always flat - without this the
    // excuse would fire on every late round and disable the brake outright.
    if (window > 1 && flatRun(history) === window && windowTurnedOver(recent)) return null;

    const trail = recent.map((r) => r.count).join(' -> ');
    const left = cap - round;
    return (
      `the P1 count has not fallen in ${window} rounds (${trail})` +
      (left > 0 ? ` with ${left} round(s) left` : '')
    );
  }

  return null;
}

/**
 * The id with the longest unbroken run of presence ending at the last round.
 *
 * Trailing streaks only: an id that persisted for five rounds and was then
 * cleared is not what anyone needs telling about.
 */
export function persistentStreak(
  history: readonly RoundRecord[],
): { id: string; rounds: number } | null {
  const last = history[history.length - 1]?.ids;
  if (last === undefined || last.length === 0) return null;

  let best: { id: string; rounds: number } | null = null;
  for (const id of last) {
    let rounds = 0;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      if (history[i]?.ids?.includes(id) !== true) break;
      rounds += 1;
    }
    if (best === null || rounds > best.rounds) best = { id, rounds };
  }
  return best;
}

export interface PersistenceNoticeArgs {
  /** Rounds of unbroken persistence before the run says anything. */
  minRounds: number;
  /**
   * The phase round cap, already worded, e.g. "maxReviewRounds (12)". This is
   * the one limit that can be stated exactly: it bounds the loop, and nothing
   * makes the loop run longer.
   */
  capLimit: string;
  /**
   * Armed whole-run budget ceilings, already worded. Deliberately NOT a
   * complete list of what can stop the run - planShare, maxQuestionRounds and
   * the rate-limit exits can all stop it sooner - so the wording built from
   * this offers examples, never an enumeration. May be empty.
   */
  ceilings: readonly string[];
}

/**
 * What to tell the user about a long-lived finding, or null when there is
 * nothing to say.
 *
 * This used to be a stop: a finding that came back `oscillationThreshold + 1`
 * rounds running ended the run, on the claim that the fixer could not resolve
 * it. The picomatch reimplementation disproved the claim -
 * `regex-group-prefix-not-literalized` was present in rounds 3 through 8 and
 * was cleared on the sixth attempt at round 9, in a run that went on to pass
 * 1977/1977 tests. Persistence measures how long something has taken, not
 * whether it can be done, and the thing the stop was really proxying for -
 * runaway spend - is now measured directly by `budget.maxTokens`, which counts
 * both agents.
 *
 * It only ever describes a survivor amid rotating companions. An id that is the
 * whole blocking set repeats its signature and is stopped earlier by the set
 * rule in `assessConvergence`.
 *
 * The wording hedges about which brake will stop the run because several of
 * them - `budget.planShare`, `maxQuestionRounds`, the rate-limit exits - are
 * outside what this function is told, and naming one of them as *the* limit
 * would send the user to raise the wrong setting.
 */
export function persistenceNotice(
  history: readonly RoundRecord[],
  args: PersistenceNoticeArgs,
): string | null {
  const streak = persistentStreak(history);
  if (streak === null || streak.rounds < args.minRounds) return null;

  const examples = args.ceilings.length > 0 ? ` - ${args.ceilings.join(', ')} -` : '';
  return (
    `"${streak.id}" has been blocking for ${streak.rounds} rounds running - continuing, ` +
    'since a finding coming back is not evidence it cannot be fixed. ' +
    `This loop runs to ${args.capLimit} at the latest and can stop sooner on a ` +
    `budget ceiling${examples} or another brake. Whichever limit stops the run, ` +
    "raise it and 'vibe resume <run-id>' to carry on."
  );
}
