import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { ActivityObservation } from '@src/progress.js';
import type { Finding, RoundRecord, RunPhase, RunState, RunSummary } from '@src/types.js';

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
    sessionId: randomUUID(),
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
    sessionStarted: false,
    planOnly,
    answeredQuestions: [],
    deferredQuestions: [],
    sessionRotations: 0,
    codexSessionId: null,
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

  // One finding the fixer cannot fix, whatever else changes around it.
  //
  // The fingerprint above only catches an *identical* set. A defect that
  // survives every round while its companions rotate produces a new
  // fingerprint each time and never trips it.
  //
  // Judged on persistence alone, deliberately. An earlier version also required
  // the total count to have stalled, which sounded prudent and was useless: on
  // the run that motivated this, one id survived six consecutive fix attempts
  // while the count wobbled 2 -> 4 -> 3, so every window contained a decrease
  // and the rule could never fire. The count and a single defect are separate
  // axes - findings falling elsewhere says nothing about the one that keeps
  // coming back.
  //
  // One round longer than the set rule, because a single repeated id is weaker
  // evidence per round than an identical set.
  const persistWindow = repeatThreshold + 1;
  const persisted = history.slice(-persistWindow);
  if (persisted.length === persistWindow) {
    const stuck = persistentId(persisted);
    if (stuck !== null) {
      return `"${stuck}" has come back ${persistWindow} rounds running; the fixer cannot resolve it`;
    }
  }

  // Trend: engaged near the cap, or once the run is simply long. Findings may
  // be new every round and still be going nowhere - a run that went 1 -> 1 -> 3
  // produced correct, distinct findings while getting further from done.
  const late = round >= Math.ceil(cap * LATE_ROUND_FRACTION) || round >= TREND_FLOOR;
  if (!late || !hasWindow) return null;

  if (!improved) {
    const trail = recent.map((r) => r.count).join(' -> ');
    const left = cap - round;
    return (
      `the P1 count has not fallen in ${window} rounds (${trail})` +
      (left > 0 ? ` with ${left} round(s) left` : '')
    );
  }

  return null;
}

/** An id present in every round of the window, or null. */
function persistentId(recent: readonly RoundRecord[]): string | null {
  const first = recent[0]?.ids;
  if (first === undefined || first.length === 0) return null;
  for (const id of first) {
    if (recent.every((r) => r.ids?.includes(id) === true)) return id;
  }
  return null;
}
