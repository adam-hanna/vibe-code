import path from 'node:path';
import type { AgentEnvironmentFacts, EnvironmentFacts } from '@src/runtime.js';
import type { AgentProvider, AgentShell } from '@src/runtime.js';
import type { PathStyle } from '@src/pathstyle.js';
import type {
  Answer,
  Assumption,
  CodexRateLimitRecord,
  Confidence,
  DeferredQuestion,
  Finding,
  OpenQuestion,
  OutOfScopeItem,
  PendingFindings,
  Plan,
  QuestionKind,
  RoundRecord,
  RunEvent,
  RunPhase,
  RunState,
  RunStatus,
  RunSummary,
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
 *    Cross-field consistency over `status`/`phase`/`planOnly`, and the
 *    `codexTokens <= tokensUsed` share, are issue #54.
 * 6. **Nothing is written on a refusal path.** Every function here is pure: it
 *    reads, decides, and either throws or returns. That is what makes the
 *    refusal messages' "the run directory is intact and no file has been
 *    rewritten" literally true.
 *
 * Containment (`assertUsableRunId`) is **lexical**: it closes `../` traversal,
 * which is what a CLI argument can reach. A symlinked or junctioned run
 * directory can still point outside the runs root, in `loadRun` and `listRuns`
 * alike; resolving that needs `realpath` on both sides plus separate POSIX and
 * Windows handling, and it is issue #53.
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

function isRecord(v: unknown): v is Record<string, unknown> {
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

const PROVIDERS = {
  claude: 'claude',
  codex: 'codex',
} satisfies Record<AgentProvider, AgentProvider>;

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

/** What was found, worded for a human rather than as a type name. */
function describe(v: unknown): string {
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

/** The one sentence a user needs after a refusal: nothing was destroyed. */
const intact = (dir: string): string =>
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
 * Lexical only. Symlinks and junctions are issue #53.
 */
const RUN_ID = /^[A-Za-z0-9._-]+$/;

export function assertUsableRunId(id: string, runsRoot: string): void {
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
    const rawIds = entry['ids'];
    if (rawIds === undefined) return { signature, count };
    if (!Array.isArray(rawIds)) {
      ctx.repairs.replaced(`${at}.ids`, rawIds, 'nothing');
      return { signature, count };
    }
    return { signature, count, ids: rawIds.filter(isString) };
  };

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

/** `formatQuestion` reads `q.options.length`, and `normalize` lowercases `q.question`. */
function readOpenQuestion(entry: unknown): OpenQuestion | null {
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
  return {
    question: entry['question'],
    options: Array.isArray(rawOptions) ? rawOptions.filter(isString) : [],
    recommended: entry['recommended'],
    kind,
    blocking: entry['blocking'],
  };
}

function readOutOfScope(entry: unknown): OutOfScopeItem | null {
  if (!isRecord(entry)) return null;
  if (!isString(entry['item']) || !isString(entry['why'])) return null;
  return { item: entry['item'], why: entry['why'] };
}

/**
 * A stored plan, or null when there is nothing usable.
 *
 * `out_of_scope` absent and `out_of_scope: []` are different facts - the first
 * is a plan recorded before the field existed, the second a planner claiming no
 * interesting edges - and `formatOutOfScope` prints different text for each, so
 * absence is preserved rather than filled in.
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
    readOpenQuestion,
  );
  const plan: Plan = {
    plan_md: raw['plan_md'],
    assumptions,
    open_questions: openQuestions,
  };
  if (raw['out_of_scope'] === undefined) return plan;
  return {
    ...plan,
    out_of_scope: repairedArray('plan.out_of_scope', raw['out_of_scope'], ctx, readOutOfScope),
  };
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
function readAgent(entry: unknown): AgentEnvironmentFacts | null {
  if (!isRecord(entry)) return null;
  const provider = enumOf(entry['provider'], PROVIDERS);
  const shell = enumOf(entry['shell'], SHELLS);
  const pathStyle = enumOf(entry['pathStyle'], PATH_STYLES);
  if (provider === null || shell === null || pathStyle === null) return null;
  if (!isBool(entry['repaired']) || !Array.isArray(entry['tools'])) return null;
  const tools: AgentEnvironmentFacts['tools'] = [];
  for (const raw of entry['tools']) {
    const tool = readTool(raw);
    if (tool !== null) tools.push(tool);
  }
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
    const agent = readAgent(entry);
    if (agent === null) ctx.repairs.dropped('environment', `environment.agents[${i}]`);
    else agents.push(agent);
  });
  return { agents, verifyCommand: raw['verifyCommand'], verifyRuns: raw['verifyRuns'] };
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
  codexRateLimit: (raw, ctx) => readRateLimit(raw, ctx),
  codexSessionStarted: (raw, ctx) => optionalBool('codexSessionStarted', raw, ctx),
  judgeContextTokens: (raw, ctx) =>
    optionalNumber('judgeContextTokens', raw, ctx, isPositiveInt),
  judgeContextThread: (raw, ctx) => optionalString('judgeContextThread', raw, ctx),
  handoffStale: (raw, ctx) => optionalBool('handoffStale', raw, ctx),
  contextModel: (raw, ctx) => optionalString('contextModel', raw, ctx),
  contextWindow: (raw, ctx) => optionalNumber('contextWindow', raw, ctx, isPositive),
  turnStartedAt: (raw, ctx) => optionalTimestamp('turnStartedAt', raw, ctx),
  lastActivityAt: (raw, ctx) => optionalTimestamp('lastActivityAt', raw, ctx),
  lastOutputAt: (raw, ctx) => optionalTimestamp('lastOutputAt', raw, ctx),
  finalFixDone: (raw, ctx) => optionalBool('finalFixDone', raw, ctx),
  environment: (raw, ctx) => readEnvironment(raw, ctx),
  carried: (raw, ctx) =>
    raw === undefined ? undefined : repairedArray('carried', raw, ctx, readFinding),
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
    if (!KNOWN_KEYS.has(key) && !REDERIVED_KEYS.has(key)) out[key] = value;
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
  };
}
