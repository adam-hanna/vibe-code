import path from 'node:path';
import { setOwn } from '@src/runtime.js';
import type { AgentEnvironmentFacts, EnvironmentFacts } from '@src/runtime.js';
import type { AgentProvider, AgentShell } from '@src/runtime.js';
import type { PathStyle } from '@src/pathstyle.js';
import type { SlotName } from '@src/slots.js';
import type {
  AcceptanceCriterion,
  Answer,
  Assumption,
  CheckKind,
  CheckpointBoundary,
  CheckpointCommitNote,
  CodexRateLimitRecord,
  ArtifactEntryOutcome,
  Confidence,
  DeferredQuestion,
  Finding,
  GateArtifacts,
  ForkedConversation,
  ForkOrigin,
  ForkPendingEntry,
  GateOutcome,
  InFlightTurn,
  OpenQuestion,
  OutOfScopeItem,
  PendingFindings,
  Plan,
  QuestionKind,
  ResolvedQuestion,
  ReviewCoverage,
  RoundClaim,
  RoundRecord,
  RunCheckpointMeta,
  RunEvent,
  RunPhase,
  RunState,
  RunStatus,
  RunSummary,
  SuppressedQuestion,
} from '@src/types.js';

/**
 * Reading what is already written: `state.json` on the way back in.
 *
 * `loadRun` used to cast the parsed JSON to `RunState`, so every field of a
 * resumed run was a type by assertion and TypeScript guaranteed nothing
 * downstream - a stored *string* in `pendingAnswers` reached the planner as
 * individual characters, and a non-array `events` took the resume down on the
 * first event. The realistic causes are a run killed mid-write, a truncated or
 * hand-edited file, and a field whose shape changed between versions, and all
 * three land on a user who is resuming precisely because the run already cost
 * them something.
 *
 * The rules, in the order they matter:
 *
 * 1. **Repair what is only a record; refuse what is a promise.** A record is
 *    something the run wrote down about its own history, and losing it costs a
 *    re-derivation at most. A promise is something a later decision is enforced
 *    against - `costUsd` and `tokensUsed` above all, because #16 took three PRs
 *    to make `budget.maxTokens` an honest ceiling and zeroing either here would
 *    undo that invisibly.
 * 2. **An absent optional and a legal `null` are never corruption.** Every
 *    optional field's doc comment in `src/types.ts` already says what absence
 *    means, and `clearPendingFindings` writes an explicit `null` on the ordinary
 *    path. Only a value that is PRESENT and of the WRONG TYPE - or outside the
 *    range its writer can produce - is repaired.
 * 3. **An invalid element is dropped; an invalid container becomes its empty
 *    value.** Dropping one malformed assumption should not cost a user their
 *    approved plan. A display-only member of a record that also carries a live
 *    value is repaired in place instead of costing its container - see
 *    `readRateLimit`, where a junk `resetsAt` must not discard `usedPercent`.
 * 4. **The reader's domain is the writer's range**, judged against what the
 *    consumer does with the value. `contextRatio` may legitimately exceed 1
 *    (`src/claude.ts` divides prompt tokens by the window and only checks that
 *    both are positive) and `src/context.ts` rotates on it, so an overfull ratio
 *    is a live signal and is kept. A percentage above 100 is likewise kept.
 * 5. **Validation is strictly per-field.** No pair, triple or relationship rule
 *    lives here. The plausible ones are wrong: `status: 'error'` beside
 *    `phase: 'complete'` is writer-generated - a failed preflight sets the
 *    status without touching the phase (`src/cli.ts`), so a finished run that is
 *    resumed and fails preflight persists exactly that pair, and "repairing" it
 *    would make `resumePhase` infer `planning` and re-run completed work.
 *    Cross-field consistency over `status`/`phase`/`planOnly` lives in
 *    `src/consistency.ts` (#54). It is written against the phase `resumePhase`
 *    RESOLVES rather than the stored field, because `phase` is optional and the
 *    loop branches on the resolution. Of its two normalisations, rule B keeps
 *    matching on every later load - its predicate reads `status`, which is
 *    never rewritten - while rule C matches once, because the phase it writes
 *    makes its own predicate false.
 *
 *    `loadRun` applies it, after this validator and before its first write, so
 *    a refusal there can promise that nothing was rewritten for the same reason
 *    a refusal here can. Three cases in `tests/stored-state.test.ts` had to be
 *    narrowed for it: each asserted a contradictory triple loads clean, which
 *    is the claim the module exists to withdraw - see that file's comments and
 *    the PR for which was which. The `codexTokens <= tokensUsed` share is that
 *    module's rule D since #87: still not policed HERE - both values are legal
 *    per field, and this validator does not ask what the pair says - but the
 *    load path clamps the Codex share down to the run total and records the
 *    change, because `summary()` (`src/cli.ts`) renders `tokensUsed -
 *    codexTokens` and printed a negative Claude share without it. Rule D
 *    normalises rather than refusing, and runs in `loadRun` and `planFork`
 *    alike.
 * 6. **Nothing is written on a refusal path.** Every function here is pure: it
 *    reads, decides, and either throws or returns. That is what makes the
 *    refusal messages' "the run directory is intact and no file has been
 *    rewritten" literally true.
 *
 * Containment (`assertUsableRunId`) is **lexical**, and stays that way: it
 * answers "is this string a single directory name" before a path exists, which
 * is what a CLI argument can reach. Whether the entry that name reaches is a
 * SYMLINK or a junction pointing outside the archive is a filesystem question,
 * and it is asked one layer down, at the read, by `linkedRunReason` and
 * `assertUnlinkedRun` in `src/run.ts` (#53) - which `loadRun`, `listRuns`,
 * `cmdResume`, `listForkPoints`, `planFork` and `commitFork` each apply before
 * they open anything. It needs no `realpath` and no platform split:
 * `lstat(...).isSymbolicLink()` is true of a POSIX symlink, a Node junction and
 * an `mklink /J` junction alike.
 *
 * The strict parsers in `src/validate.ts` are deliberately NOT reused. They
 * exist for model output, which is adversarial-ish and always fresh, and they
 * throw. Stored state is ours and must stay loadable across versions, which
 * argues for tolerant repair.
 *
 * **Type assertions in this file, in full** (test files are not in scope):
 *   1. `unvalidated('config')` - the one field this module does not check.
 *   2. `Object.keys(FIELDS) as StoredKey[]` in `validateStoredState`.
 *   3. the single `as StoredRunState` on the assembled accumulator.
 * There are no others: the enum tables map member to member so lookups are
 * cast-free, and every record is narrowed through `isRecord`.
 */

// ---- primitives -------------------------------------------------------------

/**
 * Exported for `loadRun`, which reads one raw field back out of the parsed JSON
 * to hand to the cross-field pass. One narrowing predicate for the whole
 * codebase rather than a type assertion at the one call site that needs it - the
 * assertions in this file are enumerated in the header, and a second copy of
 * this question would have to join them (#54).
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

/** Money, not a count: `budget.maxCostUsd` compares it and `toFixed(2)` prints it. */
function isMoney(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * A cumulative total. Deliberately NOT integer-checked: these are sums of
 * provider-reported numbers vibe does not control, and refusing a resumable run
 * over a fractional token total is the expensive direction.
 */
function isTotal(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** A counter vibe increments itself from zero, so a fraction is a hand edit. */
function isCounter(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** `verify.runs` is validated as a positive integer before it is ever stored. */
function isPositiveInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

function isPositive(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

/** No upper bound: an overfull context is a real measurement and a live signal. */
function isRatio(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** No upper bound either - the server can report above 100 and it prints meaningfully. */
function isPercent(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/** A string a `Date` can read. `src/cli.ts` renders some of these. */
function isTimestamp(v: unknown): v is string {
  return typeof v === 'string' && Number.isFinite(Date.parse(v));
}

/**
 * Membership without a cast: the tables below map each member to itself, so the
 * looked-up value carries the union type rather than an assertion.
 */
function enumOf<T extends string>(v: unknown, table: Readonly<Record<string, T>>): T | null {
  if (typeof v !== 'string') return null;
  return Object.hasOwn(table, v) ? (table[v] ?? null) : null;
}

// `satisfies Record<Union, Union>` makes a union gaining a member a build error
// here, which is what keeps these tables from drifting from the types.
const STATUSES = {
  planning: 'planning',
  implementing: 'implementing',
  reviewing: 'reviewing',
  planned: 'planned',
  done: 'done',
  'needs-input': 'needs-input',
  stalled: 'stalled',
  error: 'error',
} satisfies Record<RunStatus, RunStatus>;

const PHASES = {
  planning: 'planning',
  implementing: 'implementing',
  reviewing: 'reviewing',
  complete: 'complete',
} satisfies Record<RunPhase, RunPhase>;

const KINDS = {
  technical: 'technical',
  product: 'product',
} satisfies Record<QuestionKind, QuestionKind>;

const CONFIDENCES = {
  high: 'high',
  medium: 'medium',
  low: 'low',
} satisfies Record<Confidence, Confidence>;

const CHECKS = {
  command: 'command',
  inspection: 'inspection',
  qa: 'qa',
} satisfies Record<CheckKind, CheckKind>;

const PROVIDERS = {
  claude: 'claude',
  codex: 'codex',
} satisfies Record<AgentProvider, AgentProvider>;

const BOUNDARIES = {
  'plan-round': 'plan-round',
  'plan-approved': 'plan-approved',
  implemented: 'implemented',
  'verify-round': 'verify-round',
  'review-round': 'review-round',
  'final-fix': 'final-fix',
  complete: 'complete',
} satisfies Record<CheckpointBoundary, CheckpointBoundary>;

const COMMIT_NOTES = {
  committed: 'committed',
  'nothing-to-commit': 'nothing-to-commit',
  'commit-failed': 'commit-failed',
  'sha-unusable': 'sha-unusable',
  'commits-disabled': 'commits-disabled',
  'not-a-repo': 'not-a-repo',
  'no-commit-in-round': 'no-commit-in-round',
} satisfies Record<CheckpointCommitNote, CheckpointCommitNote>;

const SLOT_NAMES = {
  main: 'main',
  judge: 'judge',
  review: 'review',
} satisfies Record<SlotName, SlotName>;

const FORK_WHYS = {
  'never-started': 'never-started',
  'not-persisted': 'not-persisted',
} satisfies Record<NonNullable<ForkedConversation['why']>, NonNullable<ForkedConversation['why']>>;

const SHELLS = {
  bash: 'bash',
  zsh: 'zsh',
  sh: 'sh',
  powershell: 'powershell',
  cmd: 'cmd',
  unknown: 'unknown',
} satisfies Record<AgentShell, AgentShell>;

const PATH_STYLES = {
  win32: 'win32',
  msys: 'msys',
  cygwin: 'cygwin',
  wsl: 'wsl',
  posix: 'posix',
} satisfies Record<PathStyle, PathStyle>;

const WINDOWS = {
  primary: 'primary',
  secondary: 'secondary',
} satisfies Record<CodexRateLimitRecord['window'], CodexRateLimitRecord['window']>;

const FINDING_PHASES = {
  plan: 'plan',
  review: 'review',
} satisfies Record<PendingFindings['phase'], PendingFindings['phase']>;

/**
 * What was found, worded for a human rather than as a type name.
 *
 * Exported for `src/consistency.ts`, which has to describe a stored `phase` this
 * version does not recognise: the repair that drops it is discarded on the
 * refusal path, so the file still holds the value and the message must say so.
 * One wording for both modules, like `intact` below.
 */
export function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  switch (typeof v) {
    case 'undefined':
      return 'nothing';
    case 'string':
      return `a string (${JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}...` : v)})`;
    case 'number':
      return `a number (${v})`;
    case 'boolean':
      return `a boolean (${v})`;
    default:
      return 'an object';
  }
}

// ---- refusals ---------------------------------------------------------------

/**
 * A stored state this version will not act on. Carried to `main`'s handler,
 * which prints the message and nothing else - a stack trace is the unhelpful
 * throw this module exists to remove.
 */
export class StoredStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoredStateError';
  }
}

/**
 * The one sentence a user needs after a refusal: nothing was destroyed.
 *
 * Exported so `src/consistency.ts` refuses in the same words. Two wordings of
 * "nothing has been lost" is exactly the drift `unvalidated('config')` warns
 * about one field along.
 */
export const intact = (dir: string): string =>
  `Nothing has been lost - the run directory is intact at ${dir} and no file has been rewritten.`;

/**
 * Why the accounting fields are refused rather than reset. #16 took three PRs
 * (#24, #25, #26) to route every token through one seam so `budget.maxTokens` is
 * an honest ceiling; zeroing either field on load would undo that silently, and
 * the user would never know their ceiling had moved.
 */
const CEILING_NOTE =
  'vibe refuses rather than resetting this field, because it is what the run budget is ' +
  'enforced against; correct it by hand and resume.';

// ---- repairs ----------------------------------------------------------------

export interface StateRepair {
  /** The top-level field, or a dotted path for a member repaired in place. */
  field: string;
  found: string;
  replacedWith: string;
  /** Exact number of elements discarded, even when `droppedPaths` is truncated. */
  droppedCount: number;
  droppedPaths: string[];
}

/** Element paths enumerated per field. The count stays exact beyond this. */
const MAX_PATHS = 50;

/**
 * What a load changed, one entry per field, so `loadRun` can record it and a
 * user can see what happened rather than guessing.
 */
class RepairLog {
  private readonly byField = new Map<string, StateRepair>();

  replaced(field: string, found: unknown, replacedWith: string): void {
    this.entry(field).found = describe(found);
    this.entry(field).replacedWith = replacedWith;
  }

  dropped(field: string, path: string): void {
    const entry = this.entry(field);
    entry.droppedCount += 1;
    if (entry.droppedPaths.length < MAX_PATHS) entry.droppedPaths.push(path);
    if (entry.found === '') entry.found = 'unusable entries';
    if (entry.replacedWith === '') entry.replacedWith = 'the usable entries';
  }

  list(): StateRepair[] {
    return [...this.byField.values()];
  }

  private entry(field: string): StateRepair {
    const existing = this.byField.get(field);
    if (existing !== undefined) return existing;
    const fresh: StateRepair = {
      field,
      found: '',
      replacedWith: '',
      droppedCount: 0,
      droppedPaths: [],
    };
    this.byField.set(field, fresh);
    return fresh;
  }
}

/** What a reader may consult besides its own value: who is being loaded, and from where. */
interface ReadContext {
  id: string;
  dir: string;
  repairs: RepairLog;
}

// ---- ids and paths ----------------------------------------------------------

/**
 * A run id is a single directory name, and this is checked before it becomes a
 * path.
 *
 * `cmdResume` passes its positional argument straight through, so without this
 * `vibe resume ../outside` reads - and, on a successful load, appends repair
 * events to - a `state.json` outside `.vibe/runs`. Comparing the stored id to
 * the requested one is no defence: a crafted file out there would agree with it.
 * A whitelist rather than a separator blacklist, so `/`, `\`, drive prefixes and
 * control characters are all covered at once, with `basename` as a second belt.
 *
 * Lexical only, deliberately: symlinks and junctions are a filesystem question,
 * asked by `assertUnlinkedRun` (`src/run.ts`) at each site that reads (#53).
 */
const RUN_ID = /^[A-Za-z0-9._-]+$/;

/**
 * The exact names `recordReport` writes: `implementation-report.md`, and the two
 * numbered forms.
 *
 * Case-sensitive, and the round number is a canonical positive decimal -
 * `[1-9][0-9]*`, so neither `fix-report-0.md` nor `fix-report-01.md` is
 * accepted. Both writers interpolate a round that has just been incremented, so
 * neither can produce a zero or a leading zero; a predicate that accepts more
 * than the writer emits is one that will be asked to accept something else
 * later, which is exactly how the character whitelist this replaced came to
 * accept `state.json`.
 */
const REPORT_NAME =
  /^(implementation-report\.md|fix-report-[1-9][0-9]*\.md|verify-fix-[1-9][0-9]*\.md)$/;

/**
 * A report basename this tool wrote, or nothing. **An allowlist, and it replaces
 * a character whitelist that could not answer the question.**
 *
 * Its two callers - the `lastReport` reader and `latestReport`
 * (`src/orchestrator.ts`) - both ask exactly one thing: is this the name of a
 * report *vibe produced*. The old whitelist only asked whether the string was a
 * plausible basename, which passes `state.json` (so `latestReport` renders the
 * whole state file into the reviewer's prompt), passes `PLAN.md` (so a fork
 * would copy over the plan it just generated), and on Windows passes
 * `STATE.JSON` and `state.json.` - both of which open `state.json`.
 *
 * The trailing dot/space rejection is Windows: the filesystem strips them, so
 * `"state.json."` and `"state.json"` are the same file while being different
 * strings. `path.basename` on both flavours is kept as a second belt.
 */
export function isReportBasename(v: unknown): v is string {
  return (
    isString(v) &&
    v !== '' &&
    v !== '.' &&
    v !== '..' &&
    !/[. ]$/.test(v) &&
    REPORT_NAME.test(v) &&
    path.basename(v) === v &&
    path.win32.basename(v) === v
  );
}

export function assertUsableRunId(id: string, runsRoot: string): void {
  // A trailing dot or space is stripped by Windows, so `"<id>."` names `<id>`
  // while passing every lexical check above - the same hole `isReportBasename`
  // closes one field along.
  if (/[. ]$/.test(id)) {
    throw new StoredStateError(
      `"${id}" is not a run id: it ends in a dot or a space, which Windows strips - so it would ` +
        'name a different directory than it says. Nothing was read or written.',
    );
  }
  if (id === '' || id === '.' || id === '..' || !RUN_ID.test(id) || path.basename(id) !== id) {
    throw new StoredStateError(
      `"${id}" is not a run id. A run id is a single directory name under ${runsRoot} - ` +
        'letters, digits, dots, dashes and underscores. Nothing was read or written. ' +
        'Run "vibe list" to see the runs in this repo.',
    );
  }
  if (path.resolve(runsRoot, id) !== path.join(path.resolve(runsRoot), id)) {
    throw new StoredStateError(
      `"${id}" resolves outside ${runsRoot}. Nothing was read or written.`,
    );
  }
}

/**
 * `JSON.parse`, with the `SyntaxError` turned into something a user can act on.
 *
 * A truncated file is one of the three realistic causes of corruption named in
 * the issue - a run killed mid-write - so it must not be the one case that still
 * surfaces as a stack trace.
 */
export function parseStoredState(text: string, id: string, dir: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new StoredStateError(
      `Run ${id} cannot be resumed: state.json is not valid JSON (${detail}). This is what a ` +
        `run killed mid-write looks like. ${intact(dir)} The artifacts beside it are unaffected.`,
    );
  }
}

// ---- field readers ----------------------------------------------------------

function refuse(field: string, found: unknown, expected: string, ctx: ReadContext, note = ''): never {
  throw new StoredStateError(
    `Run ${ctx.id} cannot be resumed: state.json field "${field}" holds ${describe(found)}, and ` +
      `${expected} is required. ${intact(ctx.dir)}${note === '' ? '' : ` ${note}`}`,
  );
}

function refusedString(field: string, raw: unknown, ctx: ReadContext): string {
  if (isString(raw) && raw !== '') return raw;
  return refuse(field, raw, 'a non-empty string', ctx, 'The run cannot proceed without it.');
}

function refusedBool(field: string, raw: unknown, ctx: ReadContext): boolean {
  if (isBool(raw)) return raw;
  return refuse(field, raw, 'a boolean', ctx, 'The run cannot proceed without it.');
}

function refusedTimestamp(field: string, raw: unknown, ctx: ReadContext): string {
  if (isTimestamp(raw)) return raw;
  return refuse(field, raw, 'a date vibe can parse', ctx, 'The run cannot proceed without it.');
}

function refusedNumber(
  field: string,
  raw: unknown,
  ctx: ReadContext,
  ok: (v: unknown) => v is number,
  expected: string,
  note = 'The run cannot proceed without it.',
): number {
  if (ok(raw)) return raw;
  return refuse(field, raw, expected, ctx, note);
}

function refusedEnum<T extends string>(
  field: string,
  raw: unknown,
  table: Readonly<Record<string, T>>,
  ctx: ReadContext,
): T {
  const value = enumOf(raw, table);
  if (value !== null) return value;
  return refuse(
    field,
    raw,
    `one of ${Object.keys(table).join(', ')}`,
    ctx,
    'Resume decides where to restart from this field, so it cannot proceed on a value it ' +
      'cannot interpret. If the run was made by a newer vibe, upgrade and resume.',
  );
}

/**
 * The run must be the one the directory says it is.
 *
 * `state.id` becomes the branch name (`vibe/${state.id}`) and names artifacts,
 * the resume heading and the escalation instructions, so a state carrying id `A`
 * loaded from directory `B` would label its work as one run while writing
 * another - worse than a crash, because it looks like it worked. Not re-derived
 * the way `dir` and `targetDir` are: those move because a repo legitimately
 * moves, whereas an id that disagrees with its own directory means the file is
 * not what the directory says, and picking a winner would be inventing an
 * answer.
 */
function refusedId(raw: unknown, ctx: ReadContext): string {
  if (isString(raw) && raw === ctx.id) return raw;
  if (!isString(raw) || raw === '') {
    return refuse(
      'id',
      raw,
      'a non-empty string naming this run',
      ctx,
      'The run cannot proceed without it.',
    );
  }
  throw new StoredStateError(
    `Run ${ctx.id} cannot be resumed: state.json says this run is "${raw}", but it was loaded ` +
      `from the directory "${ctx.id}". vibe will not guess which is right - the id names the ` +
      `run's branch (vibe/${raw}), its artifacts and its resume instructions, so continuing ` +
      `under a mismatched id would label the work as one run while writing another. ` +
      `${intact(ctx.dir)} Resume the run under its own id, or correct "id" in state.json to ` +
      'match the directory.',
  );
}

/** Present-but-wrong-typed becomes the empty value; a legal `null` is left alone. */
function repairedNullableString(
  field: string,
  raw: unknown,
  ctx: ReadContext,
): string | null {
  if (raw === null || isString(raw)) return raw;
  ctx.repairs.replaced(field, raw, 'null');
  return null;
}

function repairedBool(field: string, raw: unknown, ctx: ReadContext): boolean {
  if (isBool(raw)) return raw;
  ctx.repairs.replaced(field, raw, 'false');
  return false;
}

function repairedNumber(
  field: string,
  raw: unknown,
  ctx: ReadContext,
  ok: (v: unknown) => v is number,
  empty: number,
): number {
  if (ok(raw)) return raw;
  ctx.repairs.replaced(field, raw, String(empty));
  return empty;
}

/** Valid when present, dropped when malformed, absent when missing. */
function optionalString(field: string, raw: unknown, ctx: ReadContext): string | undefined {
  if (raw === undefined) return undefined;
  if (isString(raw)) return raw;
  ctx.repairs.replaced(field, raw, 'nothing');
  return undefined;
}

function optionalTimestamp(field: string, raw: unknown, ctx: ReadContext): string | undefined {
  if (raw === undefined) return undefined;
  if (isTimestamp(raw)) return raw;
  ctx.repairs.replaced(field, raw, 'nothing');
  return undefined;
}

function optionalBool(field: string, raw: unknown, ctx: ReadContext): boolean | undefined {
  if (raw === undefined) return undefined;
  if (isBool(raw)) return raw;
  ctx.repairs.replaced(field, raw, 'nothing');
  return undefined;
}

function optionalNumber(
  field: string,
  raw: unknown,
  ctx: ReadContext,
  ok: (v: unknown) => v is number,
): number | undefined {
  if (raw === undefined) return undefined;
  if (ok(raw)) return raw;
  ctx.repairs.replaced(field, raw, 'nothing');
  return undefined;
}

function optionalEnum<T extends string>(
  field: string,
  raw: unknown,
  table: Readonly<Record<string, T>>,
  ctx: ReadContext,
): T | undefined {
  if (raw === undefined) return undefined;
  const value = enumOf(raw, table);
  if (value !== null) return value;
  ctx.repairs.replaced(field, raw, 'nothing');
  return undefined;
}

/**
 * A present non-array is dirty rather than absent, so it reads as empty and gets
 * replaced - the precedent #20 set for `deferred`. Unusable entries are dropped
 * individually, each one pathed, so a single bad element never costs the rest.
 */
function repairedArray<T>(
  field: string,
  raw: unknown,
  ctx: ReadContext,
  read: (entry: unknown, at: string) => T | null,
): T[] {
  if (!Array.isArray(raw)) {
    ctx.repairs.replaced(field, raw, 'an empty list');
    return [];
  }
  const out: T[] = [];
  raw.forEach((entry, i) => {
    const at = `${field}[${i}]`;
    const value = read(entry, at);
    if (value === null) ctx.repairs.dropped(field, at);
    else out.push(value);
  });
  return out;
}

// ---- compound readers -------------------------------------------------------

/**
 * The fields any consumer of a stored finding needs, checked rather than
 * asserted.
 *
 * One predicate for the follow-ups artifact, the carried findings and the
 * validator: "is this stored object a finding" is a question the codebase must
 * answer once. `defer` is deliberately not consulted - it is a fact about what
 * one caller does with a finding, not about its shape.
 */
export function hasFindingShape(f: unknown): f is Finding {
  if (!isRecord(f)) return false;
  return (
    (f['severity'] === 'P0' ||
      f['severity'] === 'P1' ||
      f['severity'] === 'P2' ||
      f['severity'] === 'P3') &&
    isString(f['id']) &&
    f['id'].length > 0 &&
    isString(f['title']) &&
    isString(f['detail']) &&
    isString(f['suggested_fix'])
  );
}

function readFinding(entry: unknown): Finding | null {
  return hasFindingShape(entry) ? entry : null;
}

function readString(entry: unknown): string | null {
  return isString(entry) ? entry : null;
}

/** `RunEvent` carries an index signature, so unknown keys ride along untouched. */
function readEvent(entry: unknown): RunEvent | null {
  if (!isRecord(entry) || !isString(entry['at']) || !isString(entry['type'])) return null;
  return { ...entry, at: entry['at'], type: entry['type'] };
}

/**
 * One round of the convergence history.
 *
 * `windowTurnedOver` does `ids.length` and `new Set(ids)`, so a string `ids`
 * would iterate as characters and quietly change a convergence verdict. A bad
 * `ids` costs only itself - the count beside it is still the round's real
 * blocking count - and it reads as ABSENT rather than as an empty list, because
 * absent is "cannot tell", which is what a round with unusable ids is.
 */
const roundReader =
  (ctx: ReadContext) =>
  (entry: unknown, at: string): RoundRecord | null => {
    if (!isRecord(entry)) return null;
    const signature = entry['signature'];
    if (signature !== null && !isString(signature)) return null;
    const count = entry['count'];
    if (!isCounter(count)) return null;
    const claims = readClaims(ctx, entry['claims'], at);
    const rawIds = entry['ids'];
    if (rawIds === undefined) return { signature, count, ...claims };
    if (!Array.isArray(rawIds)) {
      ctx.repairs.replaced(`${at}.ids`, rawIds, 'nothing');
      return { signature, count, ...claims };
    }
    const ids: string[] = [];
    rawIds.forEach((id, i) => {
      // Recorded, not filtered. A dropped id changes what `windowTurnedOver`
      // sees, so a repair the user cannot see is one they cannot judge - the
      // same rule the array-level drops already follow.
      if (isString(id)) ids.push(id);
      else ctx.repairs.dropped(`${at}.ids`, `${at}.ids[${i}]`);
    });
    return { signature, count, ids, ...claims };
  };

/**
 * The claims of one round, on the same terms as its ids.
 *
 * Absent stays absent, and an unusable `claims` becomes absent rather than an
 * empty list - because absent is what every guard reads as "recorded before
 * claims existed", and it makes them fall back to `ids`/`signature`. An empty
 * list would instead assert that the round had no blocking findings, which is a
 * claim about a run nobody measured (#116).
 *
 * A partial drop is deliberately fatal to the whole field, unlike `ids`. A round
 * missing one claim would be compared as a *shorter* round, and `claimsMatch`
 * requires equal lengths - so a single dropped entry would silently turn a
 * repeated round into a differing one and disable the brake for that window.
 */
function readClaims(
  ctx: ReadContext,
  raw: unknown,
  at: string,
): { claims?: RoundClaim[] } {
  if (raw === undefined) return {};
  if (!Array.isArray(raw)) {
    ctx.repairs.replaced(`${at}.claims`, raw, 'nothing');
    return {};
  }
  const claims: RoundClaim[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || !isString(entry['id']) || !isString(entry['title'])) {
      ctx.repairs.replaced(`${at}.claims`, raw, 'nothing');
      return {};
    }
    claims.push({ id: entry['id'], title: entry['title'] });
  }
  return { claims };
}

function readDeferredQuestion(entry: unknown): DeferredQuestion | null {
  if (!isRecord(entry)) return null;
  const kind = enumOf(entry['kind'], KINDS);
  if (
    kind === null ||
    !isString(entry['question']) ||
    !isString(entry['recommended']) ||
    !isString(entry['reason'])
  ) {
    return null;
  }
  return {
    question: entry['question'],
    kind,
    recommended: entry['recommended'],
    reason: entry['reason'],
  };
}

/**
 * A similarity, not a context ratio: 1 is the top of this scale.
 *
 * Deliberately not `isRatio`, which has no upper bound because an overfull
 * context is a real measurement. A score above 1 is not a measurement of
 * anything `similarity` can produce, so it is damage.
 */
function isUnitInterval(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

function readSuppressedQuestion(entry: unknown): SuppressedQuestion | null {
  if (!isRecord(entry)) return null;
  if (!isString(entry['question']) || !isString(entry['matched']) || !isUnitInterval(entry['score'])) {
    return null;
  }
  return { question: entry['question'], matched: entry['matched'], score: entry['score'] };
}

function readResolvedQuestion(entry: unknown): ResolvedQuestion | null {
  if (!isRecord(entry)) return null;
  if (!isString(entry['question']) || !isString(entry['answered']) || !isUnitInterval(entry['score'])) {
    return null;
  }
  return { question: entry['question'], answered: entry['answered'], score: entry['score'] };
}

/**
 * `markAnswered` calls `normalize(a.question)`, which lowercases whatever it is
 * given, and `formatAnswer` interpolates every field into a prompt.
 */
function readAnswer(entry: unknown): Answer | null {
  if (!isRecord(entry)) return null;
  const confidence = enumOf(entry['confidence'], CONFIDENCES);
  if (
    confidence === null ||
    !isString(entry['question']) ||
    !isString(entry['answer']) ||
    !isString(entry['rationale']) ||
    !isBool(entry['defer_to_human'])
  ) {
    return null;
  }
  return {
    question: entry['question'],
    answer: entry['answer'],
    confidence,
    defer_to_human: entry['defer_to_human'],
    rationale: entry['rationale'],
  };
}

function readAssumption(entry: unknown): Assumption | null {
  if (!isRecord(entry)) return null;
  if (
    !isString(entry['assumption']) ||
    !isString(entry['why']) ||
    !isString(entry['blast_radius'])
  ) {
    return null;
  }
  return {
    assumption: entry['assumption'],
    why: entry['why'],
    blast_radius: entry['blast_radius'],
  };
}

/**
 * `formatQuestion` reads `q.options.length`, and `normalize` lowercases
 * `q.question`.
 *
 * Curried over the context for the same reason `roundReader` is: a discarded
 * option changes what the user is shown to choose between, so it is recorded
 * rather than filtered away.
 */
const openQuestionReader =
  (ctx: ReadContext) =>
  (entry: unknown, at: string): OpenQuestion | null => {
    if (!isRecord(entry)) return null;
    const kind = enumOf(entry['kind'], KINDS);
    if (
      kind === null ||
      !isString(entry['question']) ||
      !isString(entry['recommended']) ||
      !isBool(entry['blocking'])
    ) {
      return null;
    }
    const rawOptions = entry['options'];
    const options: string[] = [];
    if (Array.isArray(rawOptions)) {
      rawOptions.forEach((option, i) => {
        if (isString(option)) options.push(option);
        else ctx.repairs.dropped(`${at}.options`, `${at}.options[${i}]`);
      });
    } else if (rawOptions !== undefined) {
      ctx.repairs.replaced(`${at}.options`, rawOptions, 'an empty list');
    }
    return {
      question: entry['question'],
      options,
      recommended: entry['recommended'],
      kind,
      blocking: entry['blocking'],
    };
  };

function readOutOfScope(entry: unknown): OutOfScopeItem | null {
  if (!isRecord(entry)) return null;
  if (!isString(entry['item']) || !isString(entry['why'])) return null;
  return { item: entry['item'], why: entry['why'] };
}

function readAcceptanceCriterion(entry: unknown): AcceptanceCriterion | null {
  if (!isRecord(entry)) return null;
  const check = enumOf(entry['check'], CHECKS);
  if (
    check === null ||
    !isString(entry['id']) ||
    !isString(entry['criterion']) ||
    !isString(entry['how'])
  ) {
    return null;
  }
  return { id: entry['id'], criterion: entry['criterion'], check, how: entry['how'] };
}

/**
 * A stored plan, or null when there is nothing usable.
 *
 * `out_of_scope` absent and `out_of_scope: []` are different facts - the first
 * is a plan recorded before the field existed, the second a planner claiming no
 * interesting edges - and `formatOutOfScope` prints different text for each, so
 * absence is preserved rather than filled in. `acceptance_criteria` is read the
 * same way and for the same reason: absent is a plan that predates the bar,
 * empty is a planner claiming done-ness is unobservable, and only the planner
 * gets to make the second claim.
 *
 * The two are independent - a plan can carry either, both or neither - so each
 * is added only when it was stored.
 */
function readPlan(raw: unknown, ctx: ReadContext): Plan | null {
  if (raw === null) return null;
  if (!isRecord(raw) || !isString(raw['plan_md'])) {
    ctx.repairs.replaced('plan', raw, 'null');
    return null;
  }
  const assumptions = repairedArray('plan.assumptions', raw['assumptions'], ctx, readAssumption);
  const openQuestions = repairedArray(
    'plan.open_questions',
    raw['open_questions'],
    ctx,
    openQuestionReader(ctx),
  );
  const plan: Plan = {
    plan_md: raw['plan_md'],
    assumptions,
    open_questions: openQuestions,
  };
  if (raw['out_of_scope'] !== undefined) {
    plan.out_of_scope = repairedArray(
      'plan.out_of_scope',
      raw['out_of_scope'],
      ctx,
      readOutOfScope,
    );
  }
  if (raw['acceptance_criteria'] !== undefined) {
    plan.acceptance_criteria = repairedArray(
      'plan.acceptance_criteria',
      raw['acceptance_criteria'],
      ctx,
      readAcceptanceCriterion,
    );
  }
  return plan;
}

/**
 * The findings a turn paid for and no revision consumed, or absent.
 *
 * `null` here is the ordinary post-consumption value `clearPendingFindings`
 * writes, so it is kept as-is and produces no repair.
 */
function readPendingFindings(
  raw: unknown,
  ctx: ReadContext,
): PendingFindings | null | undefined {
  if (raw === undefined || raw === null) return raw;
  const phase = isRecord(raw) ? enumOf(raw['phase'], FINDING_PHASES) : null;
  if (phase === null || !isRecord(raw)) {
    ctx.repairs.replaced('pendingFindings', raw, 'nothing');
    return undefined;
  }
  return {
    phase,
    findings: repairedArray('pendingFindings.findings', raw['findings'], ctx, readFinding),
  };
}

// Member-to-member, like the tables above: a status gaining a member becomes a
// build error here rather than a value that silently fails to read back.
const GATE_STATUSES = {
  passed: 'passed',
  failed: 'failed',
  unavailable: 'unavailable',
  disabled: 'disabled',
} satisfies Record<GateOutcome['status'], GateOutcome['status']>;

/**
 * One gate's outcome, or null.
 *
 * `status` and `required` are checked strictly because the exit code is computed
 * from them: a record whose `required` cannot be read must not be guessed into
 * `false`, which would turn an unverified run into a clean one.
 */
function readGateOutcome(entry: unknown, at: string, ctx: ReadContext): GateOutcome | null {
  if (!isRecord(entry)) return null;
  const status = enumOf(entry['status'], GATE_STATUSES);
  const command = entry['command'];
  if (status === null || !isString(entry['name'])) return null;
  if (!(command === null || isString(command))) return null;
  if (!isCounter(entry['runs']) || !isBool(entry['required'])) return null;
  const artifacts = readGateArtifacts(`${at}.artifacts`, entry['artifacts'], ctx);
  return {
    name: entry['name'],
    status,
    command,
    runs: entry['runs'],
    required: entry['required'],
    ...(artifacts === undefined ? {} : { artifacts }),
  };
}

// The same member-to-member table, for the same reason: a new artifact status
// has to fail the build rather than fail to read back.
const GATE_ARTIFACT_STATUSES = {
  copied: 'copied',
  missing: 'missing',
  refused: 'refused',
  'too-large': 'too-large',
  failed: 'failed',
} satisfies Record<ArtifactEntryOutcome['status'], ArtifactEntryOutcome['status']>;

/** One preserved path's outcome, or null so the array reader drops just this one. */
function readArtifactEntry(raw: unknown, at: string, ctx: ReadContext): ArtifactEntryOutcome | null {
  if (!isRecord(raw)) return null;
  const status = enumOf(raw['status'], GATE_ARTIFACT_STATUSES);
  if (status === null || !isString(raw['path'])) return null;
  const files = optionalNumber(`${at}.files`, raw['files'], ctx, isCounter);
  const bytes = optionalNumber(`${at}.bytes`, raw['bytes'], ctx, isCounter);
  const why = optionalString(`${at}.reason`, raw['reason'], ctx);
  const links =
    raw['skippedLinks'] === undefined
      ? undefined
      : repairedArray(`${at}.skippedLinks`, raw['skippedLinks'], ctx, (v) =>
          isString(v) ? v : null,
        );
  return {
    path: raw['path'],
    status,
    ...(files === undefined ? {} : { files }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(why === undefined ? {} : { reason: why }),
    ...(links === undefined ? {} : { skippedLinks: links }),
  };
}

/**
 * A gate's preserved artifacts, or nothing.
 *
 * The one field on a gate outcome that is repaired ELEMENT BY ELEMENT rather
 * than costing the whole list, and the distinction is what the value is for.
 * `readGateOutcomes` below discards everything on a single bad entry because the
 * exit code is computed from `status` and `required` - a partial gate record
 * would read as a clean run. Nothing computes anything from this field: it tells
 * a human where to look. Discarding a run's whole gate record over a damaged
 * pointer to a report would be the wrong trade in the other direction.
 *
 * Every drop still goes through `ctx.repairs`, which `loadRun` turns into a
 * `state_repaired` event, so the loss is visible even though the field is not.
 */
function readGateArtifacts(field: string, raw: unknown, ctx: ReadContext): GateArtifacts | undefined {
  if (raw === undefined) return undefined;
  // `entries` is checked HERE, with the rest of the record, rather than being
  // handed to `repairedArray`: that helper turns a non-array into `[]`, which
  // would leave `{dir, bytes, entries: "bad"}` reading as a complete record of a
  // preservation that copied nothing - a record contradicting a directory that
  // may hold a whole report. The container is part of what makes this record
  // one, so it fails with it.
  if (
    !isRecord(raw) ||
    !isString(raw['dir']) ||
    !isCounter(raw['bytes']) ||
    !Array.isArray(raw['entries'])
  ) {
    ctx.repairs.replaced(field, raw, 'nothing');
    return undefined;
  }
  const unresolved = optionalString(`${field}.unresolved`, raw['unresolved'], ctx);
  return {
    dir: raw['dir'],
    bytes: raw['bytes'],
    entries: repairedArray(`${field}.entries`, raw['entries'], ctx, (entry, at) =>
      readArtifactEntry(entry, at, ctx),
    ),
    ...(unresolved === undefined ? {} : { unresolved }),
  };
}

/**
 * The gate record: all of it, or none of it.
 *
 * The one list in this file that is NOT repaired element by element, and the
 * reason is what the value is used for. Every other repaired array is a log -
 * dropping a damaged entry costs a line of history. This one is evidence, read
 * by the exit rule: a list of three gates whose two failures were dropped as
 * malformed looks exactly like a run where one gate passed and there was nothing
 * else to run, and it would exit 0 saying so.
 *
 * So a single unreadable entry discards the whole list, which `run.ts` reads as
 * "no gate outcomes were recorded" - incomplete, not clean. Absent still means
 * no gate ran, which is a different and legitimate fact (#47, #44).
 */
function readGateOutcomes(raw: unknown, ctx: ReadContext): GateOutcome[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    ctx.repairs.replaced('gateOutcomes', raw, 'an empty list, which reads as no evidence');
    return [];
  }

  const outcomes: GateOutcome[] = [];
  for (const [i, entry] of raw.entries()) {
    const outcome = readGateOutcome(entry, `gateOutcomes[${i}]`, ctx);
    if (outcome === null) {
      ctx.repairs.dropped('gateOutcomes', `gateOutcomes[${i}]`);
      ctx.repairs.replaced(
        'gateOutcomes',
        raw,
        'an empty list: a partial gate record cannot be told from a complete one',
      );
      return [];
    }
    outcomes.push(outcome);
  }
  return outcomes;
}

/**
 * Turns observed but not charged, or nothing at all (#77).
 *
 * Dropped rather than repaired, for `readReviewCoverage`'s reason one function
 * down: every field of an entry is load-bearing and none can be reconstructed. A
 * `label` invented for an entry that lost its own would be charged against a
 * turn name no run ever ran, and a `tokens` invented as 0 would turn "we never
 * saw a figure" into "the turn spent nothing" - which is the same fabrication
 * `codexTokens` and the context window refuse.
 *
 * Per-entry, so one damaged entry does not take the readable ones with it, and
 * an empty survivor list becomes absent: absent is what a run with nothing in
 * flight looks like, and `[]` would be a second spelling of it for every later
 * reader to remember.
 */
function readInFlight(raw: unknown, ctx: ReadContext): InFlightTurn[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    ctx.repairs.replaced('inFlight', raw, 'nothing');
    return undefined;
  }

  const turns: InFlightTurn[] = [];
  for (const entry of raw) {
    const provider = isRecord(entry) ? enumOf(entry['provider'], PROVIDERS) : null;
    if (!isRecord(entry) || provider === null || !isString(entry['label']) || entry['label'] === '') {
      ctx.repairs.dropped('inFlight', 'inFlight entry');
      continue;
    }
    const tokens = entry['tokens'];
    if (tokens !== undefined && !isTotal(tokens)) {
      // The entry names a real turn, so it is kept: an interrupted turn with no
      // usable figure is exactly what a Codex entry is, and reporting it as
      // unattributed is more than dropping it would say.
      ctx.repairs.dropped('inFlight', `inFlight tokens for "${entry['label']}"`);
      turns.push({ label: entry['label'], provider });
      continue;
    }
    turns.push({
      label: entry['label'],
      provider,
      ...(tokens === undefined ? {} : { tokens }),
    });
  }
  return turns.length > 0 ? turns : undefined;
}

/**
 * What the last review round saw, or nothing at all.
 *
 * Dropped rather than repaired, which is the opposite of `gateOutcomes` one
 * function up, and the difference is what the value is for. A gate record feeds
 * the exit rule, so it has to be repaired into something the rule reads as "no
 * evidence". This one is read only to be reported, and its two scalars cannot be
 * reconstructed - a `round` invented as 0 would be exactly the fabricated number
 * this repo refuses everywhere else. So a damaged record reads as "this run
 * makes no claim about coverage", and the repair is still logged: `loadRun`
 * turns the repair log into a `state_repaired` event, so the corruption is
 * visible even though the field is not.
 *
 * `isPositiveInt`, not `isCounter`: the writer only ever emits `round >= 1` and
 * `chunks >= 1`, so a stored zero is not a value any version of this tool
 * produced and must not read back as a plausible record (#49).
 */
function readReviewCoverage(raw: unknown, ctx: ReadContext): ReviewCoverage | undefined {
  if (raw === undefined) return undefined;
  if (
    !isRecord(raw) ||
    !isPositiveInt(raw['round']) ||
    !isPositiveInt(raw['chunks']) ||
    !Array.isArray(raw['files']) ||
    !Array.isArray(raw['truncated'])
  ) {
    ctx.repairs.dropped('reviewCoverage', 'reviewCoverage');
    return undefined;
  }
  const strings = (list: readonly unknown[]): string[] => list.filter((v): v is string => isString(v));
  const files = strings(raw['files']);
  const truncated = strings(raw['truncated']);
  if (files.length !== raw['files'].length || truncated.length !== raw['truncated'].length) {
    ctx.repairs.dropped('reviewCoverage', 'reviewCoverage entries that were not paths');
  }
  return { round: raw['round'], chunks: raw['chunks'], files, truncated };
}

/** A full object id, never an abbreviation. The same rule `src/git.ts` applies. */
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * A checkpoint's metadata, or null - a pure shape check with no repair log.
 *
 * Exported because `listCheckpoints` needs the same answer without a
 * `ReadContext` to log into: a listing reads snapshots that are not the run
 * being loaded, and there is nothing there to repair.
 *
 * `commit` is null or 40 hex and nothing else. An abbreviation or a branch name
 * would resolve to *something* months later, which is how a fork ends up seeded
 * from a commit no round ever produced.
 */
export function readCheckpointShape(raw: unknown): RunCheckpointMeta | null {
  if (!isRecord(raw)) return null;
  const boundary = enumOf(raw['boundary'], BOUNDARIES);
  const commitNote = enumOf(raw['commitNote'], COMMIT_NOTES);
  const phase = enumOf(raw['phase'], PHASES);
  const commit = raw['commit'];
  if (boundary === null || commitNote === null || phase === null) return null;
  if (!isPositiveInt(raw['n']) || !isTimestamp(raw['at'])) return null;
  if (!isCounter(raw['planRound']) || !isCounter(raw['reviewRound']) || !isCounter(raw['verifyRound'])) {
    return null;
  }
  if (!(commit === null || (isString(commit) && FULL_SHA.test(commit)))) return null;
  return {
    n: raw['n'],
    at: raw['at'],
    boundary,
    phase,
    planRound: raw['planRound'],
    reviewRound: raw['reviewRound'],
    verifyRound: raw['verifyRound'],
    commit,
    commitNote,
  };
}

/**
 * The checkpoint a state came from, dropped to absent when unreadable.
 *
 * Tolerant, unlike the three fork fields below, and deliberately so. On a live
 * `state.json` this is display-only provenance that nothing acts on; on a
 * snapshot it is required, and `planFork` refuses to fork anything that needed a
 * repair at all - so a dropped `checkpoint` refuses the fork rather than being
 * quietly forked from an unknown boundary.
 */
function readCheckpointMeta(raw: unknown, ctx: ReadContext): RunCheckpointMeta | undefined {
  if (raw === undefined) return undefined;
  const meta = readCheckpointShape(raw);
  if (meta === null) {
    ctx.repairs.dropped('checkpoint', 'checkpoint');
    return undefined;
  }
  return meta;
}

/**
 * What this run was forked from - **refused when present and unreadable.**
 *
 * The one field here whose loss cannot be noticed later. Once a forked run's
 * pending conversations have all been consumed, `forkPending` is legitimately
 * absent and every slot is legitimately started, so a state whose `forkedFrom`
 * was silently dropped is indistinguishable from an ordinary run: its
 * provenance is gone, and no invariant over the other fields can tell. The
 * alternative - a second durable marker whose only job is to detect the loss of
 * this one - just moves the question.
 *
 * Absent is not an error: that is every non-forked run there has ever been.
 */
function readForkOrigin(raw: unknown, ctx: ReadContext): ForkOrigin | undefined {
  if (raw === undefined) return undefined;
  const note =
    'A fork records where it came from; discarding that silently would leave the run ' +
    'indistinguishable from one that was never forked. Nothing was rewritten.';
  if (!isRecord(raw)) return refuse('forkedFrom', raw, 'an object', ctx, note);

  const boundary = enumOf(raw['boundary'], BOUNDARIES);
  const branchFrom = raw['branchFrom'];
  if (
    !isString(raw['runId']) ||
    raw['runId'] === '' ||
    !isPositiveInt(raw['checkpoint']) ||
    !isTimestamp(raw['checkpointAt']) ||
    !isTimestamp(raw['forkedAt']) ||
    boundary === null ||
    !isTotal(raw['inheritedTokens']) ||
    !isMoney(raw['inheritedCostUsd']) ||
    !(branchFrom === null || (isString(branchFrom) && FULL_SHA.test(branchFrom))) ||
    !Array.isArray(raw['conversations']) ||
    !Array.isArray(raw['notInherited'])
  ) {
    return refuse('forkedFrom', raw, 'a complete fork record', ctx, note);
  }

  const codexTokens = raw['inheritedCodexTokens'];
  // Absent stays absent. It is NOT defaulted to zero: a checkpoint with no
  // recorded Codex share may mean no Codex turn ran or that none was recorded,
  // and vibe does not decide which.
  //
  // And deliberately NOT checked against `inheritedTokens` the way rule D checks
  // the live pair (#87). Two reasons. This is a historical record of what a
  // parent held at a point in time, and `commitFork` cannot write an over-large
  // one any more - `planFork` clamps first. And nothing subtracts these: the
  // `Forked:` lines in `summary()` print `inheritedTokens` and
  // `inheritedCostUsd` only, so no display can turn this field negative.
  // Clamping on read would rewrite a record to satisfy an invariant no reader
  // has.
  if (codexTokens !== undefined && !isTotal(codexTokens)) {
    return refuse('forkedFrom', raw, 'a complete fork record', ctx, note);
  }

  const conversations: ForkedConversation[] = [];
  for (const entry of raw['conversations']) {
    if (!isRecord(entry)) return refuse('forkedFrom', raw, 'a complete fork record', ctx, note);
    const slot = enumOf(entry['slot'], SLOT_NAMES);
    const parentId = entry['parentId'];
    if (slot === null || !(parentId === null || (isString(parentId) && parentId !== ''))) {
      return refuse('forkedFrom', raw, 'a complete fork record', ctx, note);
    }
    const why = entry['why'] === undefined ? null : enumOf(entry['why'], FORK_WHYS);
    if (entry['why'] !== undefined && why === null) {
      return refuse('forkedFrom', raw, 'a complete fork record', ctx, note);
    }
    conversations.push({ slot, parentId, ...(why === null ? {} : { why }) });
  }

  const notInherited: string[] = [];
  for (const entry of raw['notInherited']) {
    if (!isString(entry)) return refuse('forkedFrom', raw, 'a complete fork record', ctx, note);
    notInherited.push(entry);
  }

  return {
    runId: raw['runId'],
    checkpoint: raw['checkpoint'],
    checkpointAt: raw['checkpointAt'],
    boundary,
    forkedAt: raw['forkedAt'],
    inheritedTokens: raw['inheritedTokens'],
    inheritedCostUsd: raw['inheritedCostUsd'],
    ...(codexTokens === undefined ? {} : { inheritedCodexTokens: codexTokens }),
    branchFrom,
    conversations,
    notInherited,
  };
}

/**
 * The forks a run still owes - **refused when present and unreadable.**
 *
 * An instruction rather than a record: dropped silently, the next turn on that
 * slot starts a fresh conversation instead of forking the parent's, and the run
 * loses the context it was created to inherit without anyone being told.
 */
function readForkPending(
  raw: unknown,
  ctx: ReadContext,
): Partial<Record<SlotName, ForkPendingEntry>> | undefined {
  if (raw === undefined) return undefined;
  const note =
    'It says which conversations the next turn must fork; dropping it would silently start ' +
    'them fresh instead. Nothing was rewritten.';
  if (!isRecord(raw)) return refuse('forkPending', raw, 'an object', ctx, note);

  const out: Partial<Record<SlotName, ForkPendingEntry>> = {};
  for (const [key, value] of Object.entries(raw)) {
    const slot = enumOf(key, SLOT_NAMES);
    if (slot === null || !isRecord(value)) {
      return refuse('forkPending', raw, 'entries naming a known conversation', ctx, note);
    }
    if (!isString(value['parentId']) || value['parentId'] === '' || !isCounter(value['attempts'])) {
      return refuse('forkPending', raw, 'entries with a parent id and an attempt count', ctx, note);
    }
    out[slot] = { parentId: value['parentId'], attempts: value['attempts'] };
  }
  return out;
}

/**
 * Whether a forked run still has to check its branch out - **refused when
 * present and unreadable.**
 *
 * The same class of loss as `forkPending`, one layer down: dropped, the fork
 * never gets onto the branch `vibe fork` created for it and its commits land on
 * whatever HEAD happens to be. `true` is the only value any writer produces -
 * the flag is deleted rather than set false - so anything else is corruption.
 */
function readBranchPending(raw: unknown, ctx: ReadContext): true | undefined {
  if (raw === undefined) return undefined;
  if (raw === true) return true;
  return refuse(
    'branchPending',
    raw,
    'true, or nothing at all',
    ctx,
    'It says the run has not yet been put on the branch its fork created; dropping it would ' +
      'let the run commit to whatever branch happens to be checked out. Nothing was rewritten.',
  );
}

function readTool(entry: unknown): AgentEnvironmentFacts['tools'][number] | null {
  if (!isRecord(entry)) return null;
  const version = entry['version'];
  if (!isString(entry['name']) || !isBool(entry['available'])) return null;
  if (version !== null && !isString(version)) return null;
  return { name: entry['name'], available: entry['available'], version };
}

/**
 * One agent's verified facts, or null.
 *
 * The three descriptors are checked against their exact unions rather than as
 * strings: `environmentBlock` interpolates them into both agents' prompts as
 * observations about the world, so a `provider` of "other" would state something
 * untrue rather than merely be unrecognised.
 */
function readAgent(
  entry: unknown,
  ctx: ReadContext,
  at: string,
): AgentEnvironmentFacts | null {
  if (!isRecord(entry)) return null;
  const provider = enumOf(entry['provider'], PROVIDERS);
  const shell = enumOf(entry['shell'], SHELLS);
  const pathStyle = enumOf(entry['pathStyle'], PATH_STYLES);
  if (provider === null || shell === null || pathStyle === null) return null;
  if (!isBool(entry['repaired']) || !Array.isArray(entry['tools'])) return null;
  const tools: AgentEnvironmentFacts['tools'] = [];
  entry['tools'].forEach((raw, i) => {
    const tool = readTool(raw);
    // A dropped tool is a claim about the environment quietly withdrawn, so it
    // is recorded like every other discard rather than filtered away.
    if (tool === null) ctx.repairs.dropped('environment', `${at}.tools[${i}]`);
    else tools.push(tool);
  });
  return { provider, shell, pathStyle, repaired: entry['repaired'], tools };
}

function readEnvironment(
  raw: unknown,
  ctx: ReadContext,
): EnvironmentFacts | null | undefined {
  if (raw === undefined || raw === null) return raw;
  if (
    !isRecord(raw) ||
    !Array.isArray(raw['agents']) ||
    !isPositiveInt(raw['verifyRuns']) ||
    !(raw['verifyCommand'] === null || isString(raw['verifyCommand']))
  ) {
    ctx.repairs.replaced('environment', raw, 'nothing');
    return undefined;
  }
  const agents: AgentEnvironmentFacts[] = [];
  raw['agents'].forEach((entry, i) => {
    const at = `environment.agents[${i}]`;
    const agent = readAgent(entry, ctx, at);
    if (agent === null) ctx.repairs.dropped('environment', at);
    else agents.push(agent);
  });
  const facts: EnvironmentFacts = {
    agents,
    verifyCommand: raw['verifyCommand'],
    verifyRuns: raw['verifyRuns'],
  };

  // Tolerant, and absence-preserving: a record written before #47 has no gate
  // list, and inventing an empty one would tell the prompt "there are gates, and
  // there are none of them". A malformed list is dropped rather than taking the
  // whole environment section with it, because the pair above still states the
  // truth this file has always stated.
  const gates = raw['verifyGates'];
  if (gates !== undefined) {
    if (!Array.isArray(gates)) {
      ctx.repairs.dropped('environment', 'environment.verifyGates');
    } else {
      const read: { name: string; command: string | null; runs: number }[] = [];
      gates.forEach((entry, i) => {
        const at = `environment.verifyGates[${i}]`;
        if (
          !isRecord(entry) ||
          !isString(entry['name']) ||
          !(entry['command'] === null || isString(entry['command'])) ||
          !isPositiveInt(entry['runs'])
        ) {
          ctx.repairs.dropped('environment', at);
          return;
        }
        read.push({ name: entry['name'], command: entry['command'], runs: entry['runs'] });
      });
      if (read.length > 0) facts.verifyGates = read;
    }
  }

  return facts;
}

/**
 * The last rate-limit reading, for the run summary.
 *
 * Display-only: the brake reads fresh limits before each Codex turn and decides
 * from those, and this record is written afterwards. So `usedPercent` above 100
 * is kept - the server can report it and it prints meaningfully - while a
 * percentage that is not a usable number drops the record, mirroring
 * `parseWindow`, which returns null when there is nothing to brake on. The two
 * display members are repaired IN PLACE instead: a junk `resetsAt` would print
 * as "Invalid Date" and a negative duration as "(-5 min)", and neither is worth
 * discarding the percentage beside it.
 */
function readRateLimit(
  raw: unknown,
  ctx: ReadContext,
): CodexRateLimitRecord | null | undefined {
  if (raw === undefined || raw === null) return raw;
  const window = isRecord(raw) ? enumOf(raw['window'], WINDOWS) : null;
  if (
    !isRecord(raw) ||
    window === null ||
    !isBool(raw['windowFromServer']) ||
    !isPercent(raw['usedPercent']) ||
    !isString(raw['capturedAt']) ||
    !(raw['reachedType'] === null || isString(raw['reachedType'])) ||
    !(raw['planType'] === null || isString(raw['planType']))
  ) {
    ctx.repairs.replaced('codexRateLimit', raw, 'nothing');
    return undefined;
  }

  const rawDuration = raw['windowDurationMins'];
  let windowDurationMins: number | null = null;
  if (isPositive(rawDuration)) windowDurationMins = rawDuration;
  else if (rawDuration !== null) {
    ctx.repairs.replaced('codexRateLimit.windowDurationMins', rawDuration, 'null');
  }

  const rawReset = raw['resetsAt'];
  let resetsAt: string | null = null;
  if (isTimestamp(rawReset)) resetsAt = rawReset;
  else if (rawReset !== null) ctx.repairs.replaced('codexRateLimit.resetsAt', rawReset, 'null');

  return {
    window,
    windowFromServer: raw['windowFromServer'],
    usedPercent: raw['usedPercent'],
    windowDurationMins,
    resetsAt,
    reachedType: raw['reachedType'],
    planType: raw['planType'],
    capturedAt: raw['capturedAt'],
  };
}

// ---- the registry -----------------------------------------------------------

/** Paths `loadRun` re-derives, so a run directory stays valid if the repo moves. */
export const REDERIVED_KEYS: ReadonlySet<string> = new Set(['dir', 'targetDir']);

/** Everything `validateStoredState` decides. The two re-derived paths are added by `loadRun`. */
export type StoredRunState = Omit<RunState, 'dir' | 'targetDir'>;

type StoredKey = keyof StoredRunState;

/**
 * A reader for exactly one field. `RunState[K]` already includes `undefined` for
 * an optional key under `exactOptionalPropertyTypes` and excludes it for a
 * required one, so optionality is proved here as well as the value type.
 */
type Reader<K extends StoredKey> = (raw: unknown, ctx: ReadContext) => StoredRunState[K];

/**
 * The one field this module deliberately does NOT check.
 *
 * `state.config` is validated on the path that uses it: `resumeConfig` hands it
 * to `applyOverrides`, which merges it over DEFAULTS and runs `validateRoles`
 * and `validate` (src/config.ts). Checking it here would be a second, stricter
 * answer to one question. The assertion is the honest expression of that
 * boundary: this helper is named and parameterised by key so a second use is
 * conspicuous at the call site rather than hidden in an inline `as`.
 */
const unvalidated =
  <K extends StoredKey>(_field: K) =>
  (raw: unknown): StoredRunState[K] =>
    raw as StoredRunState[K];

/**
 * Every field, with the reader that decides it.
 *
 * Checked twice, because one check cannot do both jobs. `satisfies` against a
 * target whose optionality is stripped (`-?`) is what makes a MISSING reader a
 * build error: `{ [K in keyof T]: ... }` is a homomorphic mapped type and
 * preserves each key's optionality, so annotating the literal with it directly
 * would let a reader for an optional field be left out silently. The `FIELDS`
 * alias below then carries the annotated type, which is what gives `readField`
 * its per-key return type - `-?` also strips `undefined` from the property type
 * and loses that relation.
 */
const READERS = {
  // Identity and the other promises: refused, never repaired.
  id: (raw, ctx) => refusedId(raw, ctx),
  task: (raw, ctx) => refusedString('task', raw, ctx),
  sessionId: (raw, ctx) => refusedString('sessionId', raw, ctx),
  createdAt: (raw, ctx) => refusedTimestamp('createdAt', raw, ctx),
  status: (raw, ctx) => refusedEnum('status', raw, STATUSES, ctx),
  planOnly: (raw, ctx) => refusedBool('planOnly', raw, ctx),
  costUsd: (raw, ctx) =>
    refusedNumber('costUsd', raw, ctx, isMoney, 'a number of dollars', CEILING_NOTE),
  tokensUsed: (raw, ctx) =>
    refusedNumber('tokensUsed', raw, ctx, isTotal, 'a number of tokens', CEILING_NOTE),
  planRound: (raw, ctx) => refusedNumber('planRound', raw, ctx, isCounter, 'a whole number'),
  reviewRound: (raw, ctx) => refusedNumber('reviewRound', raw, ctx, isCounter, 'a whole number'),
  verifyRound: (raw, ctx) => refusedNumber('verifyRound', raw, ctx, isCounter, 'a whole number'),
  questionRound: (raw, ctx) =>
    refusedNumber('questionRound', raw, ctx, isCounter, 'a whole number'),
  rateLimitWaits: (raw, ctx) =>
    refusedNumber('rateLimitWaits', raw, ctx, isCounter, 'a whole number'),
  sessionRotations: (raw, ctx) =>
    refusedNumber('sessionRotations', raw, ctx, isCounter, 'a whole number'),

  // Records: repaired to the empty value their type implies.
  events: (raw, ctx) => repairedArray('events', raw, ctx, readEvent),
  p1Rounds: (raw, ctx) => repairedArray('p1Rounds', raw, ctx, roundReader(ctx)),
  verifyRounds: (raw, ctx) => repairedArray('verifyRounds', raw, ctx, roundReader(ctx)),
  answeredQuestions: (raw, ctx) => repairedArray('answeredQuestions', raw, ctx, readString),
  deferredQuestions: (raw, ctx) =>
    repairedArray('deferredQuestions', raw, ctx, readDeferredQuestion),
  sessionStarted: (raw, ctx) => repairedBool('sessionStarted', raw, ctx),
  contextRatio: (raw, ctx) => repairedNumber('contextRatio', raw, ctx, isRatio, 0),
  baseSha: (raw, ctx) => repairedNullableString('baseSha', raw, ctx),
  branch: (raw, ctx) => repairedNullableString('branch', raw, ctx),
  handoff: (raw, ctx) => repairedNullableString('handoff', raw, ctx),
  extraContext: (raw, ctx) => repairedNullableString('extraContext', raw, ctx),
  codexSessionId: (raw, ctx) => repairedNullableString('codexSessionId', raw, ctx),
  plan: (raw, ctx) => readPlan(raw, ctx),
  pendingAnswers: (raw, ctx) => {
    if (raw === null) return null;
    const answers = repairedArray('pendingAnswers', raw, ctx, readAnswer);
    return answers.length > 0 ? answers : null;
  },

  // Optionals: absent when missing, dropped when malformed. Never corruption.
  phase: (raw, ctx) => optionalEnum('phase', raw, PHASES, ctx),
  pendingFindings: (raw, ctx) => readPendingFindings(raw, ctx),
  codexTokens: (raw, ctx) => optionalNumber('codexTokens', raw, ctx, isTotal),
  inFlight: (raw, ctx) => readInFlight(raw, ctx),
  codexRateLimit: (raw, ctx) => readRateLimit(raw, ctx),
  codexSessionStarted: (raw, ctx) => optionalBool('codexSessionStarted', raw, ctx),
  judgeContextTokens: (raw, ctx) =>
    optionalNumber('judgeContextTokens', raw, ctx, isPositiveInt),
  judgeContextThread: (raw, ctx) => optionalString('judgeContextThread', raw, ctx),
  // The review slot's four. Optional every one, so a state written before that
  // conversation existed loads with no repair at all: absent is what a slot that
  // has never run looks like, and there is nothing here to migrate into.
  reviewSessionId: (raw, ctx) => optionalString('reviewSessionId', raw, ctx),
  reviewSessionStarted: (raw, ctx) => optionalBool('reviewSessionStarted', raw, ctx),
  // The Claude slot's registration marker (#74). Optional for the reason the
  // four above are: absent is what an id that has never been handed to the CLI
  // looks like, and it is what every state written before this field existed
  // presents - so nothing here is migrated and nothing is repaired.
  sessionRegistered: (raw, ctx) => optionalBool('sessionRegistered', raw, ctx),
  reviewContextTokens: (raw, ctx) =>
    optionalNumber('reviewContextTokens', raw, ctx, isPositiveInt),
  reviewContextThread: (raw, ctx) => optionalString('reviewContextThread', raw, ctx),
  handoffStale: (raw, ctx) => optionalBool('handoffStale', raw, ctx),
  contextModel: (raw, ctx) => optionalString('contextModel', raw, ctx),
  contextWindow: (raw, ctx) => optionalNumber('contextWindow', raw, ctx, isPositive),
  turnStartedAt: (raw, ctx) => optionalTimestamp('turnStartedAt', raw, ctx),
  lastActivityAt: (raw, ctx) => optionalTimestamp('lastActivityAt', raw, ctx),
  lastOutputAt: (raw, ctx) => optionalTimestamp('lastOutputAt', raw, ctx),
  finalFixDone: (raw, ctx) => optionalBool('finalFixDone', raw, ctx),
  environment: (raw, ctx) => readEnvironment(raw, ctx),
  // Absent stays absent, never repaired into `[]`: absence means no gate has run
  // (a plan-only run, or one that stopped before the gate), while `[]` is what a
  // record that could not be read is repaired to - and `run.ts` reads that as
  // "no evidence", never as "nothing went wrong" (#47).
  gateOutcomes: (raw, ctx) => readGateOutcomes(raw, ctx),
  // Absent stays absent for the same reason, one field along: absence means no
  // review part has completed, and a damaged record is dropped to absence
  // rather than guessed into one (#49).
  reviewCoverage: (raw, ctx) => readReviewCoverage(raw, ctx),
  // Absent stays absent again, and a present value is checked rather than
  // trusted: this one becomes a path under the run directory and its contents
  // are rendered into a prompt, so a stored `../../something` would read a file
  // the run never wrote. Dropped, logged, and the reviewer is told there is no
  // report - which is what a pointer vibe will not follow honestly means (#50).
  lastReport: (raw, ctx) => {
    if (raw === undefined) return undefined;
    if (isReportBasename(raw)) return raw;
    ctx.repairs.replaced('lastReport', raw, 'nothing');
    return undefined;
  },
  // The snapshot a state came from: tolerant, because nothing acts on it. The
  // three fork fields below are refused instead - see each reader for why.
  checkpoint: (raw, ctx) => readCheckpointMeta(raw, ctx),
  forkedFrom: (raw, ctx) => readForkOrigin(raw, ctx),
  forkPending: (raw, ctx) => readForkPending(raw, ctx),
  branchPending: (raw, ctx) => readBranchPending(raw, ctx),
  // The three question-record fields (#65). Optional every one: absent is what
  // a run that suppressed nothing and was answered by nobody looks like, and it
  // is what every state written before they existed presents - so nothing here
  // migrates and nothing is repaired.
  humanAnswered: (raw, ctx) =>
    raw === undefined ? undefined : repairedArray('humanAnswered', raw, ctx, readString),
  suppressedQuestions: (raw, ctx) =>
    raw === undefined
      ? undefined
      : repairedArray('suppressedQuestions', raw, ctx, readSuppressedQuestion),
  resolvedByHuman: (raw, ctx) =>
    raw === undefined ? undefined : repairedArray('resolvedByHuman', raw, ctx, readResolvedQuestion),
  carried: (raw, ctx) =>
    raw === undefined ? undefined : repairedArray('carried', raw, ctx, readFinding),
  declined: (raw, ctx) =>
    raw === undefined ? undefined : repairedArray('declined', raw, ctx, readFinding),
  acceptanceCriteria: (raw, ctx) =>
    raw === undefined
      ? undefined
      : repairedArray('acceptanceCriteria', raw, ctx, readAcceptanceCriterion),
  outstanding: (raw, ctx) =>
    raw === undefined ? undefined : repairedArray('outstanding', raw, ctx, readFinding),
  deferred: (raw, ctx) =>
    raw === undefined ? undefined : repairedArray('deferred', raw, ctx, readFinding),
  config: unvalidated<'config'>('config'),
} satisfies { [K in StoredKey]-?: Reader<K> };

/** The same table, typed so `readField` keeps each field's own value type. */
const FIELDS: { [K in StoredKey]: Reader<K> } = READERS;

/** Every field this module decides. Derived, so it cannot drift from the registry. */
export const KNOWN_KEYS: ReadonlySet<string> = new Set(Object.keys(FIELDS));

/**
 * The key picks the reader AND the raw value, so a reader cannot be wired to
 * another field's data.
 */
function readField<K extends StoredKey>(
  key: K,
  rec: Record<string, unknown>,
  ctx: ReadContext,
): StoredRunState[K] {
  return FIELDS[key](rec[key], ctx);
}

/**
 * Check a parsed `state.json`, returning what the run may act on and what had to
 * be repaired to get there.
 *
 * Pure: it reads, decides, and either throws or returns. The repair log it is
 * building is discarded with a throw, so a refused state file is left
 * byte-for-byte unchanged whichever check fires.
 *
 * Keys the registry does not name are carried through untouched. A newer vibe
 * may have written a field this version has never heard of, and dropping it
 * would corrupt the run on the next save.
 */
export function validateStoredState(
  raw: unknown,
  id: string,
  dir: string,
): { state: StoredRunState; repairs: StateRepair[] } {
  if (!isRecord(raw)) {
    throw new StoredStateError(
      `Run ${id} cannot be resumed: state.json does not contain a run - its top level is ` +
        `${describe(raw)}, and an object is required. ${intact(dir)}`,
    );
  }

  const ctx: ReadContext = { id, dir, repairs: new RepairLog() };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    // `setOwn`: a field this version has never heard of is carried through
    // *untouched*, and `out[key] = value` is not that for `__proto__` - the
    // assignment invokes the prototype setter, so the field would be dropped on
    // the next save rather than preserved, which is the corruption this loop
    // exists to avoid.
    if (!KNOWN_KEYS.has(key) && !REDERIVED_KEYS.has(key)) setOwn(out, key, value);
  }
  for (const key of Object.keys(FIELDS) as StoredKey[]) {
    const value = readField(key, raw, ctx);
    // Not assigned when absent: `exactOptionalPropertyTypes` distinguishes a key
    // holding `undefined` from a key that is not there, and so does the summary.
    if (value !== undefined) out[key] = value;
  }

  // The one assembly assertion. Every value above was produced at type
  // `StoredRunState[K]` and every required key is present because its reader
  // either returned a value or threw; what cannot be inferred is that an object
  // built by iteration has that shape.
  return { state: out as StoredRunState, repairs: ctx.repairs.list() };
}

/**
 * One row of `vibe list`, for a file that may be anything at all.
 *
 * Display-only, and it never refuses: one corrupt run must not take out the
 * listing of every healthy one beside it. It shares the validator's predicates
 * so the two cannot disagree - a `costUsd` that refuses on resume must not print
 * as money here - with ONE deliberate divergence: an unrecognised `status` is
 * shown verbatim rather than refused, because resuming acts on that value while
 * listing only prints it.
 *
 * That verbatim rule is exactly why `RunSummary.linked` exists rather than a
 * reserved status string: a stored `"status": "linked"` reaches the row from
 * this function, and anything that ACTS on "vibe refused to follow this entry"
 * has to read a field only `listRuns`'s own guard can set (#53). Nothing here
 * sets it - the summary is built field by field from `id`, `status`, `task`,
 * `costUsd` and `forkLabel`, so no stored value can reach it.
 */
export function summariseStored(raw: unknown, id: string): RunSummary {
  if (!isRecord(raw)) return { id, status: 'unreadable', task: '', costUsd: null };
  const status = raw['status'];
  const task = raw['task'];
  const cost = raw['costUsd'];
  return {
    id,
    status: isString(status) ? status : 'unknown',
    task: isString(task) ? task : '',
    costUsd: isMoney(cost) ? cost : null,
    ...forkLabel(raw['forkedFrom']),
  };
}

/**
 * The parent and checkpoint a row may be labelled with, or nothing.
 *
 * Deliberately more tolerant than `readForkOrigin`, which refuses the same
 * field: a listing that failed over one bad run would hide every healthy row
 * beside it, and the two rules differ because one prints and the other acts.
 * Both halves must be legible or the row renders exactly as it does today.
 */
function forkLabel(raw: unknown): { forkedFrom?: { runId: string; checkpoint: number } } {
  if (!isRecord(raw)) return {};
  const runId = raw['runId'];
  const checkpoint = raw['checkpoint'];
  if (!isString(runId) || runId === '' || !isPositiveInt(checkpoint)) return {};
  return { forkedFrom: { runId, checkpoint } };
}
