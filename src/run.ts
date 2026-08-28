import {
  closeSync,
  mkdirSync,
  openSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as log from '@src/log.js';
import { livenessOf } from '@src/lock.js';
import type { ActivityObservation } from '@src/progress.js';
import { initialSlotFields } from '@src/slots.js';
import { checkStoredConsistency, checkTokenShare } from '@src/consistency.js';
import {
  assertUsableRunId,
  hasFindingShape,
  isRecord,
  parseStoredState,
  readCheckpointShape,
  summariseStored,
  validateStoredState,
} from '@src/stored.js';
import type {
  CheckpointBoundary,
  CheckpointCommitNote,
  Finding,
  GateOutcome,
  InFlightTurn,
  PendingFindings,
  RoundRecord,
  RunCheckpointMeta,
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

/** A run directory that exists, before any state has been written into it. */
export interface AllocatedRun {
  id: string;
  dir: string;
}

/**
 * Make the run directory, and write nothing into it.
 *
 * Split out of `createRun` so `vibe run` can take the run's lock *before* the
 * first state write (#77). The old order created a state, then saved the
 * effective config, then saved the extra context, so a kill in either gap left a
 * loadable state.json with no config and no context - and a resume then silently
 * fell back to current defaults and dropped the context file the user passed.
 * Atomic writes cannot help with that: each write was whole, and the run was
 * still wrong. Allocation and initialisation are separate acts because only one
 * of them has to be inside the lock.
 */
export function mintRunId(task: string): string {
  return `${stamp()}-${slugify(task)}`;
}

/**
 * Take exclusive ownership of a run directory, or null if someone else has it.
 *
 * The leaf is created **non-recursively** on purpose: `mkdirSync(dir, {
 * recursive: true })` succeeds silently on a directory that already exists, so
 * two runs started in the same second on the same task shared an id and the
 * second overwrote the first - a real data-loss defect for `vibe run`, not just
 * for forking. `EEXIST` is the whole mechanism; anything else is a real error
 * and is left to throw.
 *
 * `.vibe/runs` itself is still recursive - that one is *meant* to be shared.
 */
export function claimRunDir(targetDir: string, id: string): AllocatedRun | null {
  const root = path.join(targetDir, RUNS_DIR);
  mkdirSync(root, { recursive: true });
  const dir = path.join(root, id);
  try {
    mkdirSync(dir);
  } catch (err: unknown) {
    if ((err as { code?: unknown } | null)?.code === 'EEXIST') return null;
    throw err;
  }
  try {
    ensureVibeIgnored(targetDir);
  } catch (err: unknown) {
    // The claim is not complete until the directory is usable. `ensureVibeIgnored`
    // writes, and a write that fails here would otherwise leave an empty run
    // directory behind for the caller's own rollback to know nothing about - and
    // for the NEXT allocation to collide with. Removing the leaf this call
    // created moments ago is safe: the exclusive mkdir above is what proves
    // nobody else owns it.
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Nothing useful to say over the real failure.
    }
    throw err;
  }
  return { id, dir };
}

/**
 * How many suffixed ids a collision may try before refusing.
 *
 * The id is a second-resolution stamp plus a task slug, so a collision means
 * two runs on the same task within the same second. Nine is far past anything
 * observed; the point of the bound is that a tenth **refuses** rather than
 * quietly reusing a directory that already holds a run.
 */
const CLAIM_ATTEMPTS = 9;

export function allocateRun(targetDir: string, task: string): AllocatedRun {
  const id = mintRunId(task);
  for (let attempt = 1; attempt <= CLAIM_ATTEMPTS; attempt++) {
    const candidate = attempt === 1 ? id : `${id}-${attempt}`;
    const claimed = claimRunDir(targetDir, candidate);
    if (claimed !== null) return claimed;
  }
  throw new Error(
    `Could not allocate a run directory: ${id} and ${CLAIM_ATTEMPTS - 1} suffixed variants of it ` +
      'already exist. Nothing was written. Wait a second and try again.',
  );
}

/**
 * Everything the first state write must already carry.
 *
 * `config` and `extraContext` are here rather than saved afterwards for the
 * reason `allocateRun` states: a run whose first persisted state is missing them
 * is a run that resumes on the wrong settings.
 */
export interface RunInit {
  allocated?: AllocatedRun | undefined;
  config?: RunState['config'] | undefined;
  extraContext?: string | null | undefined;
}

export function createRun(
  targetDir: string,
  task: string,
  planOnly: boolean,
  init: RunInit = {},
): RunState {
  const { id, dir } = init.allocated ?? allocateRun(targetDir, task);

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
    // Assigned before the single save below, never after it: see `RunInit`.
    extraContext: init.extraContext ?? null,
    ...(init.config === undefined ? {} : { config: init.config }),
  };
  saveState(state);
  return state;
}

/**
 * A stored run, checked rather than asserted - see `src/stored.ts` for the
 * repair-or-refuse rule this enforces.
 *
 * The order is load-bearing. The id is constrained before it becomes a path, so
 * a traversal attempt never opens a file; parsing and validation are pure and
 * throw before anything is written, so a refused state file is left
 * byte-for-byte unchanged; and only once the state is known good are the
 * repairs recorded, which is the first write this function makes.
 */
export function loadRun(targetDir: string, id: string): RunState {
  const root = path.join(targetDir, RUNS_DIR);
  assertUsableRunId(id, root);
  const dir = path.join(root, id);
  const file = path.join(dir, 'state.json');
  if (!existsSync(file)) throw new Error(`No run "${id}" under ${RUNS_DIR}`);

  const parsed = parseStoredState(readFileSync(file, 'utf8'), id, dir);
  const { state: checked, repairs } = validateStoredState(parsed, id, dir);

  // Paths are re-derived so a run directory stays valid if the repo moves. They
  // are the two fields the validator does not decide, and the only two it does
  // not carry, so they are supplied here rather than asserted there.
  //
  // Built before `ensureVibeIgnored` rather than after it, which is a move from
  // where this line used to sit: it is a pure object spread, and the cross-field
  // pass below needs a whole `RunState` to hand `resumePhase`. Nothing between
  // here and there writes anything.
  const state: RunState = { ...checked, dir, targetDir };

  // The cross-field pass, before `ensureVibeIgnored`, which is this function's
  // first write of any kind: `checkStoredConsistency` can refuse, and its
  // message promises that no file has been rewritten (#54).
  //
  // The RAW phase is handed over rather than the validated one because they can
  // differ: a `phase` this version does not recognise is dropped by the reader
  // as a repair, so `state.phase` is absent while the file on disk still holds
  // the value the user would see in it. A refusal has to name what is actually
  // there, not what survived the reader.
  const normalisation = checkStoredConsistency(
    state,
    resumePhase(state),
    isRecord(parsed) ? parsed['phase'] : undefined,
  );

  // Also on resume: a run created before this existed still needs the guard.
  ensureVibeIgnored(targetDir);

  // Recorded, not merely applied: a repair the user cannot see is one they
  // cannot judge, and `recordEvent` persists the repaired state that the resume
  // is about to run on. This is an audit entry, not a migration.
  for (const repair of repairs) {
    recordEvent(state, 'state_repaired', {
      field: repair.field,
      found: repair.found,
      replacedWith: repair.replacedWith,
      droppedCount: repair.droppedCount,
      droppedPaths: repair.droppedPaths,
    });
  }
  if (repairs.length > 0) {
    log.warn(
      `state.json for ${id} had ${repairs.length} unusable field(s) - ` +
        `${repairs.map((r) => r.field).join(', ')}. Each was replaced with the empty value its ` +
        'type implies and recorded in the run\'s event log; nothing else was changed.',
    );
  }

  // Its own event type and its own wording, deliberately not folded into the
  // repair loop above. A repair replaces an unusable value with the empty one
  // its type implies; this replaces a perfectly valid phase with a different
  // valid phase, because of what the other two fields say. Reported as a repair
  // it would claim something untrue about both the cause and the remedy (#54).
  //
  // Recorded only when the phase actually moves. Rule B's predicate reads
  // `status`, which is never rewritten, so it keeps matching on every later load
  // of the same run - warning each time is right, but appending an identical
  // event each time would grow the log without adding a fact.
  if (normalisation !== null) {
    const moved = state.phase !== normalisation.phase;
    state.phase = normalisation.phase;
    if (moved) {
      recordEvent(state, 'state_normalised', {
        rule: normalisation.rule,
        storedPhase: normalisation.storedPhase ?? null,
        resolvedPhase: normalisation.resolvedPhase,
        status: normalisation.status,
        planOnly: normalisation.planOnly,
        phase: normalisation.phase,
        why: normalisation.why,
      });
    }
    log.warn(
      `state.json for ${id} says status "${normalisation.status}" with ` +
        `planOnly ${String(normalisation.planOnly)}, which would have resumed at the ` +
        `${normalisation.resolvedPhase} phase - ${normalisation.why}. Resuming from ` +
        `${normalisation.phase} instead, which repeats work rather than skipping it. ` +
        'Nothing else was changed.',
    );
  }

  // Rule D, the other cross-field pass (#87). Applied here rather than beside
  // the phase one because it never refuses: it makes no promise about what has
  // been written, so it does not need to precede `ensureVibeIgnored`.
  //
  // Recorded as a `state_repaired` event, NOT as a `state_normalised` one, and
  // not by joining the `repairs` array above. The event type is the one every
  // consumer already filters for "which stored fields did this load alter", and
  // its payload is a superset of `StateRepair`, so a reader of
  // `field`/`found`/`replacedWith` needs no change; the `rule`, `against` and
  // `storedCodexTokens` keys are what tell a clamp from a per-field repair, and
  // they are the only surviving copy of the figure the file held.
  // `state_normalised`'s payload is phase-shaped - `storedPhase`,
  // `resolvedPhase`, `planOnly` - and describes nothing here. Joining `repairs`
  // was the third option and is wrong for the warning it would print: that line
  // says each field "was replaced with the empty value its type implies", which
  // is untrue of a clamp. Hence the separate line below.
  //
  // Fires once. It rewrites the field its own predicate reads, so the next load
  // of the same run sees a consistent state - unlike rule B.
  const share = checkTokenShare(state);
  if (share !== null) {
    state.codexTokens = share.codexTokens;
    recordEvent(state, 'state_repaired', {
      field: 'codexTokens',
      found: String(share.storedCodexTokens),
      replacedWith: String(share.codexTokens),
      droppedCount: 0,
      droppedPaths: [],
      rule: share.rule,
      against: 'tokensUsed',
      storedCodexTokens: share.storedCodexTokens,
      tokensUsed: share.tokensUsed,
      why: share.why,
    });
    log.warn(
      `state.json for ${id} recorded ${share.storedCodexTokens.toLocaleString()} Codex tokens ` +
        `against a run total of ${share.tokensUsed.toLocaleString()} - ${share.why}. The Codex ` +
        `share was clamped to ${share.codexTokens.toLocaleString()} and the change recorded in ` +
        "the run's event log; the run total, the cost and nothing else were touched.",
    );
  }
  return state;
}

/** Narrowing applied before any state.json is parsed (#52). */
export interface ListRunsOptions {
  /**
   * A run id to leave out. `createRun` mkdirs and saves state *before* the
   * planning turn, so the current run is always already on disk; without this
   * filter the planner's index would list the run reading it, and a repo with
   * no prior runs would never happen. A resume keeps the same id, so the same
   * filter covers it.
   */
  exclude?: string | undefined;
  /**
   * Parse at most this many runs, newest first. Applied before the map, so an
   * archive of a hundred runs costs ten reads rather than a hundred.
   *
   * Until #85 the *scan* was still proportional to the archive: every entry was
   * stat-ed before the limit was applied, which at 2000 runs was 74.40ms of a
   * 77.03ms `limit: 10` call - 97% of it, against 1.46ms of `readdirSync`.
   * `selectRunIds` now walks the sorted entries and stops at the first `limit`
   * survivors, so the stats are proportional to the rows returned. `limit:
   * undefined` (`vibe list`) still examines everything: there is no limit to
   * stop at, and that listing shows every run by design.
   */
  limit?: number | undefined;
}

/** What a run directory's state.json can be told to be (#77). */
export type StatePresence = 'absent' | 'present' | 'unknown';

/**
 * Whether a directory holds a run at all - and, when that cannot be told apart,
 * which way to fail.
 *
 * `existsSync` answers `false` both for "there is no state.json" and for "there
 * is one and this process may not look at it", and those need opposite
 * treatment: the first is an allocated-but-uninitialised directory that was
 * never a run and must not appear in the listing or in the planner's index, the
 * second is a run that exists and whose row belongs in the listing as
 * `unreadable`, with the liveness verdict the lock beside it can still give.
 * Dropping the second is how an inaccessible run disappears entirely (#77).
 *
 * `throwIfNoEntry: false` is what separates them: `undefined` is `ENOENT`, and a
 * throw is everything else.
 */
export function statePresence(file: string): StatePresence {
  try {
    return statSync(file, { throwIfNoEntry: false }) === undefined ? 'absent' : 'present';
  } catch {
    return 'unknown';
  }
}

/**
 * Which run ids to read, newest first - and only as many stats as that costs.
 *
 * Ordering first and probing second is what makes the scan proportional to the
 * rows returned rather than to the archive (#85). It changes nothing about the
 * answer: `filter` preserves order, so filtering before or after a total-order
 * sort gives the same sequence, and taking the first `limit` of that sequence is
 * the same list as walking it and keeping the first `limit` that pass. The stat
 * count is bounded above by the old always-N, never higher - even in the
 * pathological archive of 1000 uninitialised directories sorting newer than 100
 * real runs, where the old chain probed 1100 and this probes 1010.
 *
 * The presence probe is a parameter rather than a direct `statSync` so that a
 * test can count the examinations: `mock.module` is experimental and 22.3+ while
 * `engines` is node >=20, and nothing in tests/ mocks a module. `listRuns`
 * passes the real `statePresence`. Exported for its test, as `assessConvergence`
 * and friends already are.
 *
 * The per-entry decision - "is this entry a run, and may we look at it?" - is
 * deliberately in one place, the loop body, so that #53 has one site to change
 * rather than a filter chain and a loop.
 */
export function selectRunIds(
  entries: readonly string[],
  opts: ListRunsOptions,
  presence: (id: string) => StatePresence,
): string[] {
  // `slice(0, n)` truncated a fractional limit and returned nothing for a
  // negative or a NaN one; the loop has to reproduce both, not approximate them.
  // `!(limit >= 1)` is all three: zero, negative and NaN.
  const limit = opts.limit === undefined ? undefined : Math.floor(Math.max(0, opts.limit));
  if (limit !== undefined && !(limit >= 1)) return [];

  // Copied because the parameter is readonly and `sort` mutates in place.
  const ordered = [...entries].sort().reverse();
  const kept: string[] = [];
  for (const id of ordered) {
    // Before the stat: excluding the current run must never cost a listed one,
    // and it is the one entry guaranteed to be present, so the stat is waste.
    if (id === opts.exclude) continue;
    // Only 'absent' drops it. 'unknown' is a run that exists and may not be
    // read, and its row belongs in the listing as unreadable (#77, #78).
    if (presence(id) === 'absent') continue;
    kept.push(id);
    if (limit !== undefined && kept.length >= limit) break;
  }
  return kept;
}

/**
 * What `vibe list` shows, and what the planner's past-run index is built from
 * (#52). Never throws, and never writes.
 *
 * A run whose state.json cannot be read at all lists as unreadable with no cost
 * figure: `$0.00` would assert that an unreadable run cost nothing, which is the
 * invented number this codebase refuses everywhere else. One corrupt run must
 * not take out the listing of every healthy one beside it.
 *
 * Values are returned exactly as they were stored - `summariseStored` passes an
 * unrecognised status through verbatim on purpose. That is safe for a terminal
 * and is not for a prompt, so the bounding happens where the prompt is
 * rendered, in `priorRunsSection`, and this stays the listing it has always
 * been.
 */
export function listRuns(targetDir: string, opts: ListRunsOptions = {}): RunSummary[] {
  const root = path.join(targetDir, RUNS_DIR);
  if (!existsSync(root)) return [];

  // Since #52 this sits on the planning path, where "never throws" has to hold
  // against a runs root that exists but cannot be read (EACCES, EPERM, a name
  // that is not a directory). An unreadable archive is an absent one.
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  // Ordering, exclusion and the presence probe all happen in there, so that the
  // stats stop at the limit rather than sweeping the archive (#85). Before the
  // map either way, so only the runs that will be shown are read and parsed.
  const ids = selectRunIds(entries, opts, (d) =>
    statePresence(path.join(root, d, 'state.json')),
  );

  return ids.map((d): RunSummary => {
    const dir = path.join(root, d);
    let raw: unknown;
    let summary: RunSummary;
    try {
      raw = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8'));
      summary = summariseStored(raw, d);
    } catch {
      summary = { id: d, status: 'unreadable', task: '', costUsd: null };
    }
    // Outside the parse, so an unreadable state.json still gets a verdict: the
    // lock is a separate file, and "this run cannot be read" and "nobody is
    // working on it" are answers to different questions (#77). `livenessOf`
    // never throws and never writes, which is what lets it sit on this path at
    // all - `listRuns` promises both, and the planner's index depends on it.
    summary.liveness = livenessOf(dir, raw).liveness;
    return summary;
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

/**
 * How many times a rename may be retried, and how long to pause between tries.
 *
 * Windows only, in practice: `renameSync` over an open file fails with EPERM or
 * EBUSY while a reader holds it, where the truncate-then-write this replaced
 * would have succeeded. `listRuns` and any watching shell open state.json for a
 * few milliseconds at a time, so a short bounded wait clears it. Deliberately
 * small: this is a sharing violation, not a lock, and anything longer would be a
 * mutex nobody asked for.
 */
const RENAME_RETRIES = 3;
const RENAME_PAUSE_MS = 5;

/** A synchronous pause. `saveState` has no await to give and must not grow one. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isSharingViolation(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
}

/**
 * Persist the run, whole or not at all.
 *
 * Write-temp-then-rename, because this file is rewritten every five seconds for
 * the whole run (`ACTIVITY_WRITE_MS`) and a real one reaches ~96KB: a process
 * killed inside the old truncate-then-write left a half-written state.json, and
 * the run could only be resumed by hand (#77). `renameSync` over a file on the
 * same volume is atomic, so a reader sees either the previous state or this one.
 *
 * The temp name carries the pid so that two processes writing the same run
 * cannot corrupt each other through a shared `state.json.tmp`. The run lock is a
 * refusal, not a mutex, and `--force` can put two writers here deliberately.
 *
 * **`fsync` is deliberately out of scope.** Rename gives the process-kill
 * guarantee this was built for. Surviving a power loss additionally needs the
 * file *and its directory* fsynced, and directory fsync is not available on
 * Windows - claiming a durability that is not there is worse than not claiming
 * it. That limit is unchanged by #88, which routed `artifact()` through
 * `writeAtomic` as well: both are safe against a process kill and neither claims
 * more.
 *
 * Still throws whatever the write throws: `chargeFailure` has a `catch` that
 * depends on it.
 */
export function saveState(state: RunState): void {
  writeAtomic(state.dir, 'state.json', JSON.stringify(state, null, 2));
}

/**
 * Write one file under a run directory, whole or not at all.
 *
 * Extracted from `saveState` unchanged so the checkpoint snapshots get the same
 * guarantee from the same code rather than a second implementation of it - same
 * retry constants, same pid-carrying temp name, same cleanup. `saveState`'s
 * contract is exactly what it was, including that it still throws whatever the
 * write throws.
 */
export function writeAtomic(dir: string, name: string, body: string): void {
  const file = path.join(dir, name);
  const tmp = path.join(dir, `${name}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, body, 'utf8');
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, file);
        return;
      } catch (err: unknown) {
        if (attempt >= RENAME_RETRIES - 1 || !isSharingViolation(err)) throw err;
        pause(RENAME_PAUSE_MS);
      }
    }
  } catch (err: unknown) {
    // The temp file is this process's litter and must not outlive the failure.
    // Its own removal failing is not worth reporting over the real error.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Nothing to do, and nothing this can usefully say.
    }
    throw err;
  }
}

/**
 * How often a heartbeat may rewrite state.json. The file carries the whole
 * event log, so a turn emitting thousands of stream events must not write it
 * per event. The end-of-turn flush is exempt: it is the only chance to persist
 * a line that arrived inside the window.
 */
const ACTIVITY_WRITE_MS = 5_000;

/** Boundary sources, which say something the write throttle must not swallow. */
const UNTHROTTLED: readonly ActivityObservation['source'][] = ['start', 'end', 'final', 'failed'];

/**
 * Fold what the live turns have spent into the run's in-flight record.
 *
 * Upsert only: an entry is replaced by its own turn's later figure and removed
 * by nothing here. Removal belongs to the accounting - `applyCharge`,
 * `chargeFailure`, recovery, forced release - which is what makes a surviving
 * entry mean "the process died before its accounting ran" (#77). A heartbeat
 * that dropped entries would be a second rule about when an entry ends, and the
 * whole design has one.
 *
 * Keyed by label plus provider, which is unique among live turns: the only
 * concurrency is `withConcurrentCompaction`, pairing Claude `compact` with a
 * Codex critique or review, so the pair differs on both axes.
 */
function mergeInFlight(state: RunState, turns: readonly InFlightTurn[]): void {
  if (turns.length === 0) return;
  const list = state.inFlight ?? [];
  for (const turn of turns) {
    const existing = list.find((e) => e.label === turn.label && e.provider === turn.provider);
    if (existing === undefined) {
      list.push({ ...turn });
      continue;
    }
    // Replaced, never added: the figure is this turn's running total, not a
    // delta, so summing would multiply what the turn actually spent.
    if (turn.tokens === undefined) delete existing.tokens;
    else existing.tokens = turn.tokens;
  }
  state.inFlight = list;
}

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
 *
 * `observation.turns` rides the same write rather than opening a second cadence
 * (#77): the in-flight amounts are persisted exactly as often as the timestamps
 * already are, plus the two exemptions the throttle now makes - `'failed'`, and
 * the first observation on which a turn's figure becomes non-zero.
 */
export function markActivity(state: RunState, observation: ActivityObservation): void {
  const previous = state.lastActivityAt === undefined ? NaN : Date.parse(state.lastActivityAt);
  const at = observation.at.getTime();

  if (
    !UNTHROTTLED.includes(observation.source) &&
    observation.urgent !== true &&
    Number.isFinite(previous) &&
    at - previous < ACTIVITY_WRITE_MS
  ) {
    return;
  }

  if (observation.turns !== undefined) mergeInFlight(state, observation.turns);

  if (!Number.isFinite(previous) || at > previous) {
    state.lastActivityAt = observation.at.toISOString();
  }

  // A failed turn records what it spent and nothing else. `lastOutputAt` and
  // `turnStartedAt` describe turns that are *running*, and `withHeartbeat` has
  // always refused to record a completed-turn output time for a turn the adapter
  // rejected; `stop()` recomputes both for whatever is still live a moment later.
  if (observation.source === 'failed') {
    saveState(state);
    return;
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

/**
 * Append an event **without** persisting it.
 *
 * Split out of `recordEvent` with no behaviour change, so a caller that must
 * record a counter and the event that discloses it can land both in one write.
 * Two writes there would leave a window in which the counter is durable and the
 * disclosure is not - see the fork-attempt counter in `src/orchestrator.ts`.
 */
export function stageEvent(state: RunState, type: string, data: Record<string, unknown> = {}): void {
  state.events.push({ at: new Date().toISOString(), type, ...data });
}

export function recordEvent(state: RunState, type: string, data: Record<string, unknown> = {}): void {
  stageEvent(state, type, data);
  saveState(state);
}

/**
 * `recordEvent`, for a caller that must not be taken down by its own audit
 * trail. True when the event was persisted.
 *
 * `saveState` rethrows, so on an unwritable directory or ENOSPC an event
 * recorded from a best-effort path would escape and change the run's exit code -
 * which is precisely what the checkpoint machinery must never do.
 */
export function tryRecordEvent(
  state: RunState,
  type: string,
  data: Record<string, unknown> = {},
): boolean {
  try {
    recordEvent(state, type, data);
    return true;
  } catch (err: unknown) {
    log.warn(`could not record the "${type}" event: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * The exact filenames `writeCheckpoint` produces: a canonical positive decimal,
 * so neither `checkpoint-0.json` nor `checkpoint-01.json` is one of ours.
 *
 * The looser `\d+` was a scanner accepting more than the writer emits, and the
 * two ends then disagreed: `checkpoint-01.json` listed as fork point 1, while
 * `--at 1` rebuilds the canonical `checkpoint-1.json` and refuses - and with
 * both files present the listing showed the same number twice. Same rule, and
 * the same reason, as `isReportBasename` in `src/stored.ts`.
 */
const CHECKPOINT_RE = /^checkpoint-([1-9][0-9]*)\.json$/;

const checkpointName = (n: number): string => `checkpoint-${n}.json`;

/**
 * How many numbers a reservation may try before giving up.
 *
 * Only two writers can ever contend here - `--force` puts a second process on
 * one run deliberately - so this is a bound on a pathology, not a capacity.
 */
const RESERVE_ATTEMPTS = 50;

/**
 * Claim the next checkpoint number, by creating the file exclusively.
 *
 * The directory listing is the index: there is no index file to fall out of step
 * with what is on disk. `wx` is what makes two concurrent writers get two
 * numbers rather than one of them silently overwriting the other's snapshot, and
 * the handle is closed immediately because Windows cannot rename over an open
 * file - `writeAtomic` renames the body over this empty placeholder.
 *
 * Null on an unreadable directory: fail closed, and let the caller warn.
 */
function reserveCheckpoint(dir: string): { n: number; file: string } | null {
  let next: number;
  try {
    let max = 0;
    for (const entry of readdirSync(dir)) {
      const found = CHECKPOINT_RE.exec(entry);
      if (found?.[1] !== undefined) max = Math.max(max, Number(found[1]));
    }
    next = max + 1;
  } catch {
    return null;
  }

  for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
    const n = next + attempt;
    const file = path.join(dir, checkpointName(n));
    try {
      // Closed at once: the reservation is the *name*, not the handle.
      closeSync(openSync(file, 'wx'));
      return { n, file };
    } catch (err: unknown) {
      if ((err as { code?: unknown } | null)?.code !== 'EEXIST') return null;
    }
  }
  return null;
}

/**
 * Snapshot the run at a phase or round boundary (#78). Never throws.
 *
 * The snapshot is the whole state plus its own metadata, so it is a complete,
 * valid `RunState` that `loadRun` accepts and `vibe fork` can seed a new run
 * from without reading anything else.
 *
 * Every failure is a warning and an event, never an exception: a run must not
 * change its exit code because it could not write a file nothing has read yet.
 * A reservation whose body never landed is unlinked by the same call, which is
 * safe precisely because no other writer can hold that name - they would have
 * taken `EEXIST` and moved on.
 */
export function writeCheckpoint(
  state: RunState,
  boundary: CheckpointBoundary,
  commit: { sha: string | null; note: CheckpointCommitNote },
): RunCheckpointMeta | null {
  const reserved = reserveCheckpoint(state.dir);
  if (reserved === null) {
    log.warn(`could not reserve a checkpoint number in ${state.dir} - continuing without one`);
    tryRecordEvent(state, 'checkpoint_failed', { boundary, stage: 'reserve' });
    return null;
  }

  const meta: RunCheckpointMeta = {
    n: reserved.n,
    at: new Date().toISOString(),
    boundary,
    phase: resumePhase(state),
    planRound: state.planRound,
    reviewRound: state.reviewRound,
    verifyRound: state.verifyRound,
    commit: commit.sha,
    commitNote: commit.note,
  };

  try {
    writeAtomic(state.dir, checkpointName(reserved.n), JSON.stringify({ ...state, checkpoint: meta }, null, 2));
    return meta;
  } catch (err: unknown) {
    // This call owns that name, so removing it cannot take another writer's
    // snapshot with it. Its own failure is not worth reporting over the real one.
    try {
      rmSync(reserved.file, { force: true });
    } catch {
      // Nothing to do, and nothing this can usefully say.
    }
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(`could not write checkpoint ${reserved.n}: ${detail} - the run continues`);
    tryRecordEvent(state, 'checkpoint_failed', { boundary, n: reserved.n, error: detail });
    return null;
  }
}

/** One checkpoint on disk. `meta` is null when the file could not be read as one. */
export interface CheckpointEntry {
  n: number;
  file: string;
  meta: RunCheckpointMeta | null;
}

/**
 * Every checkpoint in a run directory, by number. Never throws and never writes.
 *
 * Read by `vibe fork` to list where a run can be forked from, which is a
 * listing: one damaged snapshot must not hide the healthy ones beside it, so a
 * file that cannot be read is reported with `meta: null` rather than dropped.
 */
export function listCheckpoints(dir: string): CheckpointEntry[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: CheckpointEntry[] = [];
  for (const entry of entries) {
    const found = CHECKPOINT_RE.exec(entry);
    if (found?.[1] === undefined) continue;
    const file = path.join(dir, entry);
    let meta: RunCheckpointMeta | null = null;
    try {
      const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
      const held = isRecord(raw) ? raw['checkpoint'] : undefined;
      meta = readCheckpointShape(held);
    } catch {
      meta = null;
    }
    out.push({ n: Number(found[1]), file, meta });
  }
  return out.sort((a, b) => a.n - b.n);
}

/**
 * Write one of the run's documents, whole or not at all.
 *
 * Through `writeAtomic` since #88, for a failure that is not the one state.json
 * had. `writeFileSync` opens `O_TRUNC`: the file is *emptied at open* and only
 * then written, so a killed process leaves zero bytes rather than a splice - and
 * unlike tearing it does not need a large file to appear. Measured against
 * `develop` at `99eca2e`, 40 kills per size: a 17KB `PLAN.md` was destroyed 5
 * times in 40, a 47KB checkpoint 2, a 1.1MB body 2. The truncate window is
 * roughly fixed while the write after it grows, so the ordinary artifact is the
 * one most often lost.
 *
 * The file that made it worth fixing is `OUTSTANDING.md`, which is read back by
 * code on both sides and which an empty copy strands between them:
 * `recoverOutstanding` skips it because `hasArtifact` is `existsSync` and an
 * empty file exists, and `settlePendingOutstanding` skips it because it does not
 * contain `OUTSTANDING_OWNED`. The run then finishes reporting carried findings
 * into a file that says nothing, and nothing will ever correct it.
 *
 * Cost of the reuse, median of 400 writes: +0.44ms at 17KB, +0.32ms at 47KB.
 * The busiest archived run wrote 29 artifacts, so this is tens of milliseconds
 * across a run measured in hours.
 *
 * Still throws whatever the write throws - several callers depend on that, for
 * the same reason `saveState` records.
 */
export function artifact(state: RunState, name: string, content: string | object): string {
  const file = path.join(state.dir, name);
  const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  writeAtomic(state.dir, name, body);
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
 * An artifact's text, or null when there is nothing readable there.
 *
 * Null rather than a throw for a directory of that name or an unreadable file.
 * Both callers want that: `finaliseOutstanding` asks "does this file say what I
 * wrote", and anything it cannot read is not a file it wrote; `runReview` asks
 * for the last write turn's report, and a file it cannot read is no report at
 * all - missing and unreadable render the reviewer the same notice, so they are
 * the same answer here too (#50).
 */
export function artifactText(state: RunState, name: string): string | null {
  const file = path.join(state.dir, name);
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Gates that were enabled and could not run, in list order.
 *
 * One source for both the report line and the exit rule, so the human contract
 * and the machine one cannot drift (#47).
 */
export function unavailableGates(state: RunState): readonly GateOutcome[] {
  return (state.gateOutcomes ?? []).filter((o) => o.status === 'unavailable');
}

/**
 * Required gates that could not run. Empty when the run is verified, when the
 * only unavailable gates were optional, or when verification is off.
 *
 * This is what `EXIT.UNVERIFIED` is keyed to: an optional unavailable gate and a
 * disabled section are both stated configurations, and only a *required* gate
 * that never ran is the hole #47 closes.
 */
export function unverifiedGates(state: RunState): string[] {
  return unavailableGates(state)
    .filter((o) => o.required)
    .map((o) => o.name);
}

/**
 * Why this run may not exit 0, or null when it may.
 *
 * The exit rule, and deliberately NOT "are there unavailable required gates" -
 * that question answers "no" for a record that says nothing at all. A present
 * but empty `gateOutcomes` is what `validateStoredState` leaves behind when the
 * stored list could not be read, and reading it as "every gate passed" turns a
 * corrupt state into a clean bill of health. Nothing in the run ever writes an
 * empty list: `runGate` records one outcome per resolved gate, and
 * `resolveGates` always returns at least one gate.
 *
 * ABSENT is still a pass, and must stay one: it means no gate has run, which is
 * a plan-only run or a state written before #47 existed. That is the legacy
 * contract, and it is a different fact from "a record exists and says nothing".
 */
export function verificationIncomplete(state: RunState): string | null {
  const outcomes = state.gateOutcomes;
  if (outcomes === undefined) return null;
  if (outcomes.length === 0) {
    return 'no gate outcomes were recorded, so nothing shows the gates ran';
  }
  // Fail closed on a failure too. A completing run cannot carry one - the loop
  // is on the far side of a clean gate - so this only fires for a state that
  // says something no healthy run produces.
  const failed = outcomes.filter((o) => o.status === 'failed').map((o) => o.name);
  if (failed.length > 0) return `gate(s) ${quoted(failed)} did not pass`;

  const required = unverifiedGates(state);
  if (required.length > 0) {
    return `required gate(s) ${quoted(required)} could not run`;
  }
  return null;
}

const quoted = (names: readonly string[]): string => names.map((n) => `\`${n}\``).join(', ');

/**
 * How the last pass over the gates may be described in a completion claim.
 *
 * Null ONLY when every gate ran and passed - then the caller says what it always
 * said. Anything else gets a correction, including the two states that do not
 * cost the exit code: a run that logs, prints and writes "verification still
 * passed" while a gate never ran is making a claim nobody checked, and that was
 * true of three separate sentences before #47.
 */
export function verificationCaveat(state: RunState): string | null {
  const outcomes = state.gateOutcomes;
  // Absent means no gate has run at all. Reachable only from a caller writing
  // before the gate; a completed run has been through `runGate` at least once.
  if (outcomes === undefined) return 'verification has not run';

  // A record that exists and says nothing. Nothing in the run writes one - it is
  // what a stored list that could not be read is repaired to - so it is reported
  // as the absence of evidence it is, rather than as an empty set of problems.
  if (outcomes.length === 0) {
    return 'no gate outcomes were recorded, so nothing shows the gates ran';
  }

  // Checked first, and the reason it is here at all: a run does not COMPLETE
  // over a failed gate, but it can stop over one - at `maxVerifyRounds`, or on a
  // ceiling - and whatever was written before the gate ran must not be left
  // describing a pass. Ordered ahead of the others because a gate that ran and
  // failed is the most specific thing that can be said about the pass.
  const failed = outcomes.filter((o) => o.status === 'failed').map((o) => o.name);
  if (failed.length > 0) {
    return `gate(s) ${quoted(failed)} did not pass`;
  }

  const unavailable = outcomes.filter((o) => o.status === 'unavailable');
  const required = unavailable.filter((o) => o.required).map((o) => o.name);
  if (required.length > 0) {
    return `required gate(s) ${quoted(required)} could not run, so verification is incomplete`;
  }
  if (unavailable.length > 0) {
    return (
      `every required gate passed; optional gate(s) ${quoted(unavailable.map((o) => o.name))} ` +
      'had no command and did not run'
    );
  }
  if (outcomes.length > 0 && outcomes.every((o) => o.status === 'disabled')) {
    return 'verification is disabled, so nothing was executed';
  }
  return null;
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
 * run recorded before this field existed would have given. `validateStoredState`
 * now owns that invariant on the way in; this check remains as defence in depth,
 * because the field is also written mid-run and a present non-record, a
 * `findings` that is not an array, or entries that are not findings must never
 * reach a prompt. The phase tag is checked here rather than by the caller: it is
 * what stops a plan-phase remnant being handed to the fix turn.
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
