import { describe, intact, StoredStateError } from '@src/stored.js';
import type { RunPhase, RunStatus } from '@src/types.js';

/**
 * The one cross-field rule over `status`, `phase` and `planOnly` (#54).
 *
 * `src/stored.ts` validates strictly per field and says so as its rule 5: each
 * of these three fields is individually legal in every value the other two can
 * hold, so no per-field reader can see the contradiction. What a *pair* or a
 * *triple* of them can say is a different question, and this module is the only
 * place it is asked.
 *
 * ## Where it runs
 *
 * `loadRun` (`src/run.ts`), after `validateStoredState` and *before*
 * `ensureVibeIgnored`, which is that function's first write of any kind. The
 * resume path is the only place these three fields decide anything: `loadRun`
 * has exactly one production caller, `cmdResume` in `src/cli.ts`. `listRuns`
 * reads through `summariseStored` and only prints, so it is deliberately not
 * covered.
 *
 * Three cases in `tests/stored-state.test.ts` had to be narrowed to wire it,
 * which is worth knowing about before touching them again. `fresh()` there
 * builds PLAN-ONLY runs, so two of the three were fixtures that had drifted -
 * they set an implementing, reviewing or done status on a plan-only run, which
 * F4 says no writer produces - and they were fixed by naming the `planOnly` the
 * status actually belongs to. The third, `a recognised phase is trusted whatever
 * status and planOnly hold`, was a real over-generalisation: it guarded the
 * twice-refuted rule with five triples, of which only two were counterexamples
 * to it and three were the states #54 was filed to catch. It is narrowed to the
 * two and renamed for what it defends. None of the three lost coverage -
 * `tests/state-consistency.test.ts` asserts the rule each removed triple trips.
 *
 * **Pure, like `stored.ts`.** It reads, decides, and either throws or returns.
 * That is what makes "no file has been rewritten" in the refusal below literally
 * true, and it is why `loadRun` calls this before its first write of any kind.
 *
 * ## What the writers can produce
 *
 * Every site that assigns any of the three, verified against the tree:
 *
 * | # | Site | Writes |
 * |---|---|---|
 * | W1 | `createRun` (`src/run.ts`) | `status='planning'`, `phase='planning'` |
 * | W2 | `runPhases` plan-only exit (`src/orchestrator.ts`) | `status='planned'`, `phase='complete'` |
 * | W3 | `runPhases` (`src/orchestrator.ts`) | `phase='implementing'` |
 * | W4 | `runPhases` (`src/orchestrator.ts`) | `status='implementing'` |
 * | W5 | `runPhases` (`src/orchestrator.ts`) | `phase='reviewing'` |
 * | W6 | `runPhases` (`src/orchestrator.ts`) | `status='reviewing'` |
 * | W7 | `runPhases` (`src/orchestrator.ts`) | `status='done'`, `phase='complete'` |
 * | W8 | `execute` escalation handler (`src/cli.ts`) | `status='needs-input'`/`'stalled'` |
 * | W9 | `execute` error and preflight paths (`src/cli.ts`) | `status='error'` |
 * | W10 | `createRun` (`src/run.ts`) | `planOnly`, once, never mutated |
 *
 * W2 sits inside `if (state.planOnly)` and returns, so W3-W7 are all reachable
 * only when `planOnly` is false. That gives the five facts the rules rest on:
 *
 * - **F1** `planOnly` is immutable - W10 is its only writer.
 * - **F2** `status: 'planned'` implies `planOnly: true` - W2 is its only writer.
 * - **F3** `planOnly: true` implies `phase` is never implementing or reviewing.
 * - **F4** `planOnly: true` implies `status` is never implementing, reviewing or done.
 * - **F5** A terminal status pairs legitimately with ANY phase - W8 and W9 never
 *   touch `phase`.
 *
 * ## The two states that look wrong and are not
 *
 * Getting these wrong is worse than the bug being fixed, so they are named here
 * as well as pinned in `tests/state-consistency.test.ts`:
 *
 * 1. **A terminal status beside `phase: 'complete'` is writer-generated.**
 *    `execute` runs preflight before the loop and a failed preflight sets
 *    `status = 'error'` without touching the phase, so a finished run that is
 *    resumed and fails preflight persists `error`/`complete`. "Repairing" it
 *    would make `resumePhase` infer `planning` and re-run completed work.
 * 2. **`status` and `phase` legitimately disagree mid-flight.** `advancePhase`
 *    saves immediately, so `planning`/`implementing` (between W3 and W4) and
 *    `implementing`/`reviewing` (between W5 and W6) are both real persisted
 *    states. A process killed in either window leaves exactly that.
 *
 * "They must match" is therefore NOT the rule, and neither is "drop the phase".
 */

/**
 * The fields the rules read.
 *
 * `RunState` satisfies it, and so does an object literal - which is what lets
 * the rule matrix be tested without building a run on disk for each of the
 * eighty combinations.
 */
export interface ConsistencyFields {
  readonly id: string;
  readonly dir: string;
  readonly status: RunStatus;
  readonly phase?: RunPhase | undefined;
  readonly planOnly: boolean;
}

/** A phase the loader corrected, and everything needed to justify it. */
export interface PhaseNormalisation {
  /** Which rule fired. Recorded so a future reader can check the derivation. */
  rule: 'B' | 'C';
  /**
   * Always 'planning'. Toward redoing work, never toward skipping it: repeating
   * a completed phase costs tokens, while skipping an incomplete one ships
   * nothing and claims success.
   */
  phase: 'planning';
  /** What the validated state held - absent when it held nothing usable. */
  storedPhase: RunPhase | undefined;
  /** What `resumePhase` made of it, which is what the loop would have run. */
  resolvedPhase: RunPhase;
  status: RunStatus;
  planOnly: boolean;
  /** Which writer could not have produced this, worded for a human. */
  why: string;
}

/** W3 and W5 are the only writers of these, and both are past W2's return. */
const WORK_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>(['implementing', 'reviewing']);

/** W4, W6 and W7, same reason. */
const WORK_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'implementing',
  'reviewing',
  'done',
]);

/**
 * Every status that may legitimately sit beside a completed phase.
 *
 * W7 leaves `done`, W2 leaves `planned`, and W8/W9 can overwrite either with a
 * terminal status without touching the phase. Nothing else can: `planning`,
 * `implementing` and `reviewing` are all mid-flight statuses, and no writer
 * leaves one of them beside a completion.
 */
const COMPLETION_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'done',
  'planned',
  'error',
  'stalled',
  'needs-input',
]);

/**
 * How the stored `phase` is described back to the user.
 *
 * Three cases, and the third is the one that matters: `validateStoredState`
 * turns an unrecognised phase into ABSENCE plus a pending repair, and on the
 * refusal path that repair is discarded unwritten - so `state.json` still holds
 * the junk value while the checked state holds nothing. Saying "phase is not
 * recorded" there would describe the projection rather than the file the user is
 * about to open, and would hide the one field that is visibly wrong. The raw
 * value is therefore passed in alongside the validated one.
 */
function phaseClause(phase: RunPhase | undefined, rawPhase: unknown): string {
  if (phase !== undefined) return `phase is "${phase}"`;
  if (rawPhase === undefined) return 'phase is not recorded';
  return (
    `phase holds ${describe(rawPhase)}, which this version does not recognise and reads ` +
    'as absent'
  );
}

/**
 * Rule A's message.
 *
 * Built from `resolved`, never from `status`. `resumePhase` returns the stored
 * phase whenever it is present and only falls back to `status` when it is
 * absent, so for `planOnly: true, status: 'implementing', phase: 'planning'` the
 * resume would have started at PLANNING - and a message that named the status
 * would tell the user vibe was about to do something it was not.
 */
function refusal(state: ConsistencyFields, resolved: RunPhase, rawPhase: unknown): never {
  throw new StoredStateError(
    `Run ${state.id} cannot be resumed: state.json says planOnly is ${state.planOnly}, ` +
      `status is "${state.status}" and ${phaseClause(state.phase, rawPhase)} - the resume ` +
      `would have started at the ${resolved} phase. A plan-only run never implements or ` +
      'reviews, so no version of vibe wrote this combination and one of the three fields is ' +
      'wrong. vibe will not guess which: repairing toward the work would write code you asked ' +
      'not to be written, and repairing toward completion would skip an implementation that ' +
      `may really have happened. ${intact(state.dir)} Correct state.json by hand and resume, ` +
      'or start a new run.',
  );
}

function normalised(
  rule: PhaseNormalisation['rule'],
  state: ConsistencyFields,
  resolved: RunPhase,
  why: string,
): PhaseNormalisation {
  return {
    rule,
    phase: 'planning',
    storedPhase: state.phase,
    resolvedPhase: resolved,
    status: state.status,
    planOnly: state.planOnly,
    why,
  };
}

/**
 * Judge the three fields together, against the phase the loop will actually
 * branch on.
 *
 * `resolved` is a parameter rather than computed here, and it must be
 * `resumePhase(state)`. Two reasons. It keeps this module out of an import cycle
 * with `src/run.ts`, which owns both `loadRun` and `resumePhase`; and `phase` is
 * optional, so a rule written against the stored field alone misses every legacy
 * run that has none - `resumePhase` maps `status: 'planned'` to `'complete'`
 * REGARDLESS of `planOnly`, which is precisely how a full run ends up skipping
 * its implementation.
 *
 * `rawPhase` is `state.json`'s own `phase` value, before validation. It is only
 * ever used to describe the file back to the user on the refusal path; no rule
 * reads it, because the loop does not.
 *
 * Returns the correction to apply, or null when the three fields are consistent.
 * Throws `StoredStateError` - the same type per-field refusals throw, so
 * `main()` reports it identically - when they are contradictory in the one
 * direction no repair can be defended.
 */
export function checkStoredConsistency(
  state: ConsistencyFields,
  resolved: RunPhase,
  rawPhase: unknown,
): PhaseNormalisation | null {
  // Rule A - refuse. Unreachable by F3 and F4.
  //
  // Refused rather than normalised because neither repair is defensible:
  // normalising toward the work writes code the user explicitly asked not to be
  // written, and normalising toward `complete` skips a full run's implementation
  // if what is actually corrupt is `planOnly`. vibe cannot tell which of the
  // three fields is wrong, and both guesses are destructive in different
  // directions.
  if (state.planOnly && (WORK_PHASES.has(resolved) || WORK_STATUSES.has(state.status))) {
    refusal(state, resolved, rawPhase);
  }

  // Rule B - normalise. Unreachable by F2: a full run wearing a plan-only run's
  // status. Left alone it resolves to `complete` and skips implementation.
  //
  // This is the one rule that keeps matching after it has fired: its predicate
  // reads `status`, and `status` is deliberately never rewritten. Once wired,
  // the caller must therefore record its event only when the phase actually
  // changes, so a run resumed repeatedly warns every time and grows its event
  // log once.
  if (!state.planOnly && state.status === 'planned') {
    return normalised(
      'B',
      state,
      resolved,
      'only the plan-only exit writes status "planned", and this run is not plan-only',
    );
  }

  // Rule C - normalise. A completion claim no writer could have made.
  //
  // Unlike Rule B this fires once: it needs `resolved === 'complete'`, and it
  // only fires for a status of planning, implementing or reviewing - for all
  // three of which `resumePhase` returns the stored phase once it has been set
  // to 'planning'. The next load sees a consistent state.
  //
  // Unreachable with an ABSENT phase, and deliberately not special-cased for it:
  // `resumePhase` returns 'complete' only for `done` and `planned`, and both are
  // in `COMPLETION_STATUSES`. So this only ever fires on a stored 'complete'.
  if (resolved === 'complete' && !COMPLETION_STATUSES.has(state.status)) {
    return normalised(
      'C',
      state,
      resolved,
      `no writer leaves a completed phase beside status "${state.status}"`,
    );
  }

  return null;
}
