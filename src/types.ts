import type { RoleProviders } from '@src/roles.js';
import type { EnvironmentFacts, ToolchainContract } from '@src/runtime.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * The efforts either provider accepts, as a list.
 *
 * Here rather than in `src/config.ts`, which is where it used to live and which
 * still exports it: `src/roles.ts` has to check a role's own effort (#46) and
 * cannot import config, because config imports the role table's runtime values.
 * A closed enum is the whole reason effort is the one provider setting a role may
 * name - it is checkable before a turn is spawned, and a model string is not.
 */
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * P0 exists because P1s are now survivable.
 *
 * The loop moves on with up to `loop.p1Tolerance` P1s outstanding, which is
 * right for findings that are real but resolvable against a test suite. It
 * would be badly wrong for a finding that makes the work unshippable, so there
 * has to be a level the tolerance cannot swallow. P0 is that level, and it
 * blocks on its own no matter how few there are.
 */
export type Severity = 'P0' | 'P1' | 'P2' | 'P3';
export type Verdict = 'APPROVE' | 'REVISE';
export type QuestionKind = 'technical' | 'product';
export type Confidence = 'high' | 'medium' | 'low';
export type Sandbox = 'read-only' | 'workspace-write' | 'danger-full-access';
export type PermissionMode = 'plan' | 'bypassPermissions' | 'acceptEdits' | 'auto' | 'manual' | 'dontAsk';

export type RunStatus =
  | 'planning'
  | 'implementing'
  | 'reviewing'
  | 'planned'
  | 'done'
  | 'needs-input'
  | 'stalled'
  | 'error';

/**
 * How far the run got, as distinct from how it is currently doing.
 *
 * `status` cannot answer this: it carries both, so any terminal outcome
 * ('error', 'stalled', 'needs-input') erases the phase it happened in. A run
 * that died committing a finished implementation came back as 'error', resume
 * could not tell it apart from a run that died while planning, and it restarted
 * from the plan - re-critiquing an approved plan against a tree that already
 * held the implementation, then paying for the implementation turn twice.
 */
export type RunPhase = 'planning' | 'implementing' | 'reviewing' | 'complete';

export interface ClaudeConfig {
  model: string;
  effort: Effort;
  planTimeoutMs: number;
  implementTimeoutMs: number;
}

export interface CodexConfig {
  model: string;
  effort: Effort;
  sandbox: Sandbox;
  /**
   * How long a *reading* Codex turn gets - critique, answers, review.
   *
   * Provider-named for history; what it means is the reviewing figure, which is
   * the only kind of Codex turn a default run makes.
   */
  timeoutMs: number;
  /**
   * How long a *writing* Codex turn gets, for a table that seats the implementer
   * on Codex. Implementing takes longer than reviewing whoever does it, which is
   * why Claude has had this pair since before roles were configurable.
   */
  implementTimeoutMs: number;
  /**
   * Carry each Codex conversation across the run via `codex exec resume`, so a
   * judging agent remembers what it already raised instead of re-deriving it.
   *
   * One switch, every Codex conversation - not one thread. Since #45 the
   * plan-side judge (critic and answerer) and the reviewer hold *separate*
   * threads, so that neither forms its judgement inside the other's; this key
   * says whether either is carried at all, and off means every judging turn is
   * one-shot.
   */
  persistSession: boolean;
  /**
   * The Codex model's context window in tokens, or null when it is unknown.
   *
   * Null is not a failure state - it is the truth about a thread whose window
   * vibe cannot ask for. `ThreadTokenUsage.modelContextWindow` exists only on the
   * `thread/tokenUsage/updated` push notification, delivered to a client the
   * app-server is driving a thread for; no request or response returns it,
   * `thread/read` carries no tokenUsage and `model/list` has no window field. vibe
   * drives Codex with `codex exec`, which is not an app-server client, so the
   * notification never arrives - which is why this is a setting and not a probe.
   *
   * Nothing guesses one from the model name: a table mapping `gpt-5.6-luna` to a
   * number is a fabricated denominator that goes stale silently. Set it if you
   * know it; leave it null and occupancy is reported as a token count with no
   * ratio, no percentage and no threshold.
   */
  contextWindow: number | null;
  /**
   * Read Codex's rate-limit window from `codex app-server` before each Codex turn.
   *
   * A switch exists because this is a second process model - a persistent
   * JSON-RPC connection alongside the one-shot `codex exec` spawns - against an
   * interface OpenAI marks experimental. Turning it off restores exactly the
   * behaviour of every release before it: the signal is never required.
   */
  readRateLimits: boolean;
}

/**
 * The Codex rate-limit window as last read, persisted with the run.
 *
 * Plain primitives only: state.json is round-tripped through `JSON.parse`, so a
 * `Date` would come back as a string and compare unequal to itself.
 */
export interface CodexRateLimitRecord {
  /** Which of the two windows the numbers below describe. */
  window: 'primary' | 'secondary';
  /**
   * True only when the server itself named this window in `rateLimitReachedType`.
   *
   * False means vibe picked the fuller of the two, which is a different claim -
   * a reached type naming a window this version does not recognise lands here,
   * and reporting that window's reset as if the server had named it would be a
   * fabricated reset time in the one place a user acts on it.
   */
  windowFromServer: boolean;
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: string | null;
  reachedType: string | null;
  planType: string | null;
  capturedAt: string;
}

/** What one review round produced: which blocking findings, and how many. */
export interface RoundRecord {
  /** Fingerprint of the blocking id set, or null when the round had none. */
  signature: string | null;
  count: number;
  /**
   * The individual blocking ids.
   *
   * Kept alongside the fingerprint because the fingerprint only matches an
   * *identical* set. One finding that survives every round while its companions
   * rotate produces a different fingerprint each time and slips through, so the
   * ids are what makes such a finding *reportable* - see `persistenceNotice`.
   * It is reported rather than stopped on: one finding in this project's own
   * history survived rounds 3 through 8 and was cleared at round 9, in a run
   * that then passed 1977/1977 tests. Optional so runs recorded before this
   * field loaded still parse.
   */
  ids?: string[];
}

export interface LoopConfig {
  maxPlanRounds: number;
  maxReviewRounds: number;
  /**
   * Fix rounds spent making the verification command pass.
   *
   * Separate from `maxReviewRounds` because they were previously one counter:
   * a run that spent every round fixing a failing suite had none left for the
   * reviewer's findings, and stopped with a message blaming a reviewer that
   * had never run.
   */
  maxVerifyRounds: number;
  /**
   * Times the planner may answer its own questions and re-plan before the run
   * stops for a human.
   *
   * The question path re-plans without ever consulting the round cap, so a
   * planner that keeps inventing new questions was bounded only by budget.
   */
  maxQuestionRounds: number;
  /**
   * P1s the loop may carry forward instead of fixing, in both the plan and
   * review phases. P0s are never carried.
   *
   * Zero restores the original behaviour of demanding a spotless verdict. The
   * default of one exists because that demand is unmeetable on hard work: a
   * plan for a 1416-line parser went eight rounds and $24 without reaching
   * implementation, every finding legitimate and every one of them answerable
   * in 400ms by the 1977-test suite nobody had run yet. A carried P1 is not
   * ignored - it is handed to the phase that can actually settle it.
   */
  p1Tolerance: number;
  /**
   * Identical P1 set this many rounds running is a hard stop, at any point in
   * the run. Nothing new is being produced, so more rounds cannot help.
   */
  oscillationThreshold: number;
  /**
   * How many recent rounds the late-phase trend is judged over.
   *
   * Only consulted once most of the round budget is spent. Early churn is
   * normal and is left alone.
   */
  convergenceWindow: number;
}

export interface BudgetConfig {
  /**
   * Ceiling on Claude's reported `total_cost_usd`.
   *
   * On a subscription this is NOT money: the CLI computes it from token counts
   * at public API rates, and nothing is billed. Treat it as a proxy for work
   * volume - a runaway-loop brake, not a spend limit.
   *
   * Claude-only, and unavoidably so: the Codex CLI reports no cost field in any
   * output mode, and deriving one would mean hardcoding a price table for
   * models that are renamed faster than it could be maintained - a fabricated
   * number in the field the ceiling is enforced against. Use `maxTokens` for a
   * brake that covers both agents.
   *
   * The account API does not rescue this. `codex app-server` exposes
   * `account/usage/read` and `account/rateLimits/read`, but usage is daily
   * token buckets for the whole account - not attributable to one run - and
   * rate limits are an integer percent of a rolling window. `credits.balance`
   * does not move when subscription-metered work is done, so it is not a cost
   * signal either. There is no dollar figure to read.
   */
  maxCostUsd: number;
  /**
   * Ceiling on cumulative tokens across BOTH agents. 0 disables.
   *
   * The real currency on a plan, and the only ceiling that sees the whole run:
   * Codex reports usage on its `turn.completed` event, so its work counts here
   * even though it can never count toward `maxCostUsd`.
   */
  maxTokens: number;
  /**
   * On hitting a subscription rate limit, wait for the window to reset and
   * carry on instead of stopping the run.
   */
  waitOnRateLimit: boolean;
  /** Cap on a single wait, so a run cannot hang for a weekly-cap reset. */
  maxWaitMinutes: number;
  /**
   * Stop the run before a Codex turn once Codex's fuller rate-limit window is
   * this full, as a percentage. 0 disables.
   *
   * A whole-run brake, not per-turn metering: `usedPercent` is an integer
   * percent of a rolling window - 10080 minutes, a week, on the account this
   * was measured against - so it does not move measurably for a single turn.
   * What it can do is stop a long unattended run before it starts work that
   * will die partway through, which is the failure this exists for.
   */
  codexLimitPercent: number;
  /**
   * Share of the ceiling the planning phase may consume before stopping.
   *
   * Planning that will not converge is the most expensive way for a run to
   * fail: it produces nothing, and the overall ceiling only catches it after
   * the whole budget is gone. One run spent $16 over two attempts and never
   * reached implementation. A plan costing most of the budget is not going to
   * leave enough to build anything, whatever the round counter says.
   *
   * 0 disables the sub-ceiling.
   */
  planShare: number;
}

export interface QuestionsConfig {
  askCodex: boolean;
  /**
   * Send non-blocking questions to Codex too. A considered answer beats the
   * planner's own fallback even when the fallback would have been survivable.
   */
  answerNonBlocking: boolean;
  escalateOnDefer: boolean;
  escalateOnLowConfidence: boolean;
}

/** A question Codex declined that was not important enough to stop the run. */
export interface DeferredQuestion {
  question: string;
  kind: QuestionKind;
  recommended: string;
  reason: string;
}

export interface GitConfig {
  useBranch: boolean;
  branchPrefix: string;
  commitEachRound: boolean;
}

export interface ContextConfig {
  /** Rotate the Claude session once its prompt exceeds this share of the window. */
  compactAboveRatio: number;
  /**
   * Rotate while Codex is busy rather than between Claude turns, so the
   * summarisation cost overlaps work that was going to happen anyway.
   */
  compactDuringCodex: boolean;
  enabled: boolean;
}

/**
 * One named check the run must pass before the reviewer is asked for an opinion.
 *
 * The name is not decoration: it becomes the finding id (`${name}-failing`), so
 * the oscillation guard can tell a typecheck that keeps failing from a test
 * suite that keeps failing - which it could not do while every failure was
 * filed under one id (#47, problem 2).
 */
export interface VerifyGate {
  /** Kebab-case, unique in the list. It becomes a finding id, so it must be stable. */
  name: string;
  /**
   * Null means the gate is unavailable - enabled, but with nothing to run.
   *
   * A required key that may hold null, for the reason `provider` is required
   * inside a role object (#46): a key that must be written cannot be forgotten
   * into a default, and "I meant to configure this" must not read as "there is
   * deliberately nothing here".
   */
  command: string | null;
  /** Defaults to `verify.runs`. */
  runs?: number;
  /** Defaults to `verify.timeoutMs`. */
  timeoutMs?: number;
  /**
   * Defaults to true. False says only: if this gate has no command, that is a
   * deliberate configuration and not a hole. A gate that RUNS and fails always
   * blocks, whatever this says.
   */
  required?: boolean;
}

export interface VerifyConfig {
  enabled: boolean;
  /** Shell command to run. Null auto-detects (`npm test` when a test script exists). */
  command: string | null;
  timeoutMs: number;
  /**
   * How many times a passing command must pass.
   *
   * Not paranoia. The first run to reach implementation shipped a concurrency
   * fix that failed roughly half its executions; the implementer ran it once,
   * saw green, and reported success truthfully. A later four-run check passed
   * cleanly and then failed on the next attempt. A single execution cannot
   * distinguish working code from a race that happened to win.
   */
  runs: number;
  /**
   * The gates, in the order they run.
   *
   * Null means not configured: one gate named `verification` is synthesized from
   * `command`, `runs` and `timeoutMs`, so a config written before this key
   * existed behaves exactly as it did - including its finding id (#47).
   * `command` and `gates` together are refused: two keys naming what to run is
   * the ambiguity. `runs` and `timeoutMs` are NOT in conflict - they are the
   * per-gate defaults a gate may override.
   */
  gates: VerifyGate[] | null;
}

export interface ProgressConfig {
  enabled: boolean;
  /** Minimum gap between heartbeat lines, and the tick interval for a silent turn. */
  intervalMs: number;
}

export interface Config {
  /**
   * Which agent holds each role on this run, and what effort it runs at.
   *
   * The two choices a run makes about the role table - a provider per role, and
   * optionally that role's own effort (#46): `access`, the output schema and the
   * conversation slot are facts about the job, not user settings. Absent - a
   * config stored before this key existed - means the default assignment, which
   * is what every run before it did.
   */
  roles: RoleProviders;
  claude: ClaudeConfig;
  codex: CodexConfig;
  loop: LoopConfig;
  budget: BudgetConfig;
  questions: QuestionsConfig;
  git: GitConfig;
  context: ContextConfig;
  /**
   * Does the code actually run.
   *
   * The loop previously terminated on "the reviewer found no P1s", which is a
   * statement about reading, not about working. It declared success over an
   * implementation that failed its own suite most of the time.
   */
  verify: VerifyConfig;
  /**
   * In-turn progress output.
   *
   * A turn is a single long-running CLI invocation, so without this the
   * terminal prints one line and then nothing for up to ninety minutes - a
   * healthy run being indistinguishable from a hung one is how a user ends up
   * killing work that was nearly finished.
   */
  progress: ProgressConfig;
  /**
   * Tools each agent must be able to *run*, declared up front.
   *
   * Verified before planning so a broken environment costs 30 seconds instead
   * of the 35 minutes it took to reach the implementation phase and discover
   * the shell had no node. Also keeps environment prerequisites out of the
   * review loop, where they consumed a round as a plan-stage P1.
   */
  toolchain: ToolchainContract;
}

export interface LoadedConfig extends Config {
  configPath: string | null;
}

/** Deep-partial shape accepted from vibe.config.json and CLI overrides. */
export type ConfigOverrides = {
  [K in keyof Config]?: Partial<Config[K]>;
};

export interface Assumption {
  assumption: string;
  why: string;
  blast_radius: string;
}

export interface OpenQuestion {
  question: string;
  options: string[];
  recommended: string;
  kind: QuestionKind;
  blocking: boolean;
}

/** A boundary the plan drew deliberately: real work it is not doing, and why. */
export interface OutOfScopeItem {
  item: string;
  why: string;
}

/**
 * How a criterion says it can be checked.
 *
 * Descriptive, not dispatched on: nothing in the loop reads this to decide what
 * to run, and nothing may. It exists so the critic can argue about whether a
 * criterion is checkable the way it claims to be.
 */
export type CheckKind = 'command' | 'inspection' | 'qa';

/** One observable condition that says whether the change is done. */
export interface AcceptanceCriterion {
  /**
   * Stable kebab-case slug. Like a finding's id and for the same reason:
   * something must be able to refer to one without quoting it.
   */
  id: string;
  /** The condition, stated so that two people would agree whether it holds. */
  criterion: string;
  check: CheckKind;
  /** The command to run, what to inspect, or the named scenario. */
  how: string;
}

export interface Plan {
  plan_md: string;
  assumptions: Assumption[];
  open_questions: OpenQuestion[];
  /**
   * What the plan is deliberately not doing.
   *
   * Absent and empty are different facts and must stay different. `undefined`
   * means no boundary was ever recorded - a plan stored before this field
   * existed. `[]` means the planner considered the question and claims the
   * change has no interesting edges. Collapsing the two with `?? []` would make
   * a legacy plan assert something it never said, so only `writeFollowUps` does
   * it, where both cases legitimately contribute nothing.
   *
   * Optional in TypeScript, required in `PLAN_SCHEMA`: the schema governs fresh
   * model output, while `validateStoredState` reads stored JSON tolerantly and
   * must keep loading runs recorded before this existed - which is why it
   * preserves an absent `out_of_scope` rather than filling one in.
   */
  out_of_scope?: OutOfScopeItem[];
  /**
   * How anyone can tell this change worked.
   *
   * Absent and empty are different facts here too. `undefined` means no bar was
   * ever recorded - a plan stored before this field existed. `[]` means the
   * planner considered the question and claims done-ness here is unobservable,
   * which is a claim the critic can attack.
   *
   * Optional in TypeScript, required in `PLAN_SCHEMA`, for the reason
   * `out_of_scope` is: the schema governs fresh model output, while
   * `validateStoredState` reads stored JSON tolerantly and must keep loading
   * runs recorded before this existed.
   */
  acceptance_criteria?: AcceptanceCriterion[];
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  suggested_fix: string;
  /**
   * Real, worth doing, and belongs in separate work rather than in this change.
   *
   * The third option the loop previously lacked: without it a legitimate
   * finding outside the change can only be absorbed or argued away, and a good
   * planner absorbs - which grows the plan, which grows the critique surface.
   *
   * A deferred finding is by definition non-blocking, so it is P2 or P3 and
   * never P0 or P1; `parseFindings` enforces that on read. Optional in
   * TypeScript because a report stored before this field existed has none.
   */
  defer?: boolean;
}

export interface FindingsReport {
  verdict: Verdict;
  summary: string;
  findings: Finding[];
}

/**
 * A findings report the run has paid for and not yet answered, tagged with the
 * loop that bought it.
 *
 * The tag is what lets one field serve both loops. A run is only ever in one
 * phase, but a plan-phase remnant left by a crash must be unreadable to the
 * review loop rather than merely unlikely to be read by it - a critique's
 * findings handed to the fix turn would be a fix against the wrong artifact.
 */
export interface PendingFindings {
  /** 'plan' from the critic, 'review' from the reviewer. */
  phase: 'plan' | 'review';
  findings: Finding[];
}

export interface Answer {
  question: string;
  answer: string;
  confidence: Confidence;
  defer_to_human: boolean;
  rationale: string;
}

export interface AnswersReport {
  answers: Answer[];
}

export interface ContextUsage {
  /** Prompt tokens for the last request: a close proxy for live context size. */
  promptTokens: number;
  contextWindow: number;
  ratio: number;
}

/** Total tokens moved by a turn, summed across its API requests. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  total: number;
}

export interface ClaudeTurnResult {
  text: string;
  costUsd: number;
  sessionId: string;
  denials: unknown[];
  numTurns: number;
  /** Live context occupancy, from the last assistant message. */
  usage: ContextUsage | null;
  /** Cumulative work for the turn, from the aggregated envelope. */
  tokens: TokenUsage;
}

/**
 * What one gate did on the most recent pass.
 *
 * `required` is stored here rather than re-read from config so the exit rule is
 * a pure function of state: a summary written from `state.json` must not need
 * the config that produced it (#47).
 */
export interface GateOutcome {
  name: string;
  status: 'passed' | 'failed' | 'unavailable' | 'disabled';
  command: string | null;
  /** Executions actually performed. Zero for unavailable and disabled. */
  runs: number;
  required: boolean;
}

export interface RunEvent {
  at: string;
  type: string;
  [key: string]: unknown;
}

export interface RunState {
  id: string;
  dir: string;
  targetDir: string;
  task: string;
  /**
   * The Claude conversation's id - `SLOTS.main`'s storage. Minted before the
   * first turn, so its existence says nothing about whether one ever ran; that
   * is `sessionStarted`. Read and written through `src/slots.ts`, never here.
   */
  sessionId: string;
  createdAt: string;
  status: RunStatus;
  /**
   * The phase to resume into. Survives a terminal `status`, so work already
   * paid for is not repeated. Optional so runs predating it still load; when
   * absent it is inferred from `status`.
   */
  phase?: RunPhase;
  planRound: number;
  reviewRound: number;
  /** Claude's reported spend. Codex contributes nothing: it reports no cost. */
  costUsd: number;
  /** Both agents' tokens, which is what makes `budget.maxTokens` the honest ceiling. */
  tokensUsed: number;
  /**
   * The Codex share of `tokensUsed`, so the summary can say how much of the run
   * carries no cost figure instead of implying `costUsd` covered all of it.
   * Optional so runs recorded before Codex usage was read still load.
   */
  codexTokens?: number;
  /**
   * Codex's rate-limit window as last read from app-server, so the summary can
   * report it. Optional: it is absent whenever app-server is unavailable, which
   * is a normal outcome rather than an error.
   */
  codexRateLimit?: CodexRateLimitRecord | null;
  rateLimitWaits: number;
  baseSha: string | null;
  branch: string | null;
  /** One entry per code-review round, driving the convergence assessment. */
  p1Rounds: RoundRecord[];
  /** The same, for verification-fix rounds, which converge independently. */
  verifyRounds: RoundRecord[];
  /** Verification-fix rounds spent so far. */
  verifyRound: number;
  /**
   * The most recent pass over the gates.
   *
   * Absent means no gate has run - a plan-only run, or a run that stopped before
   * the gate. Never repaired into `[]`, which would mean "gates ran and there
   * were none" and is a state nothing produces (#47, and #44's rule about
   * absence).
   */
  gateOutcomes?: GateOutcome[] | undefined;
  /** Question-and-replan cycles spent so far. */
  questionRound: number;
  events: RunEvent[];
  /**
   * Whether a turn has ever succeeded on `sessionId` - `SLOTS.main`'s marker,
   * separate from its id because every slot has both. Read and written through
   * `src/slots.ts`, never here.
   */
  sessionStarted: boolean;
  planOnly: boolean;
  answeredQuestions: string[];
  deferredQuestions: DeferredQuestion[];
  sessionRotations: number;
  /**
   * The plan-side judge's Codex thread id, reused across critique and answer
   * turns - `SLOTS.judge`'s storage. Provider-minted, so it is null until a turn
   * has returned one. Read and written through `src/slots.ts`, never here.
   *
   * Provider-named for history, and deliberately not renamed by #45: it is one
   * of two Codex threads now, but renaming it would be a stored-state migration
   * where this comment does the job. A state written before that change keeps
   * naming the thread this field has always named - the critique conversation -
   * and the reviewer, which used to share it, simply starts fresh.
   */
  codexSessionId: string | null;
  /**
   * Whether a Codex turn has ever succeeded on `codexSessionId` - the slot's
   * `started` marker, separate from its id because every slot has both.
   *
   * Optional: a state written before slots were explicit has no field, and for a
   * provider-minted id its absence is answered by the id itself, which only ever
   * comes from a successful turn. An explicit `false` outranks a present id, and
   * a `true` beside a null id is valid - a turn succeeded on a run that is not
   * carrying the thread. Read and written through `SLOTS.judge`, never here.
   */
  codexSessionStarted?: boolean;
  /**
   * Tokens occupying the judge slot's Codex thread as of the last turn that
   * reported any - `turn.completed`'s `input_tokens`, which on a resumed thread
   * is the whole conversation going in rather than the increment.
   *
   * Meaningless without `judgeContextThread`, and read only through
   * `src/slots.ts`. Absent means no measurement, which is NOT zero: a thread that
   * has taken no turn has no occupancy, and reporting one as empty would be the
   * fabricated figure this whole area exists to refuse.
   */
  judgeContextTokens?: number;
  /**
   * The Codex thread id the figure above was measured on.
   *
   * The whole of the provenance rule, and one comparison: the measurement is
   * reportable only while this is strictly equal to the slot's id now. A thread
   * that has been replaced, an id that was never usable, or a state written
   * without this field leaves nothing to report - and vibe says nothing rather
   * than attributing a figure to a conversation it does not describe.
   *
   * Never null and never empty. There is no "the unnamed conversation" value: a
   * turn that cannot be attributed to a named thread writes nothing at all, so a
   * one-shot run simply carries no measurement between turns.
   */
  judgeContextThread?: string;
  /**
   * The reviewer's own Codex thread id - `SLOTS.review`'s storage, and the whole
   * of #45: the agent that reviews the code must not be the conversation that
   * argued the plan into shape and approved it.
   *
   * Optional and never null, unlike `codexSessionId`. Absent is the correct
   * reading for a conversation that has never run, it is what every state
   * written before this field presents, and only a successful turn ever produces
   * an id to store. Read and written through `SLOTS.review`, never here.
   */
  reviewSessionId?: string;
  /**
   * Whether a Codex turn has ever succeeded on `reviewSessionId` - the slot's
   * `started` marker, separate from its id because every slot has both.
   *
   * No state has ever carried a review thread, so this has no legacy reading to
   * answer for and the marker is the only evidence a turn happened here. See
   * `SLOTS.review.started`, which is why it is not inferred from the id the way
   * `codexSessionStarted`'s absence is.
   */
  reviewSessionStarted?: boolean;
  /**
   * Tokens occupying the review slot's Codex thread as of the last turn that
   * reported any, exactly as `judgeContextTokens` is for the judge's.
   *
   * Meaningless without `reviewContextThread`, and read only through
   * `src/slots.ts`. Absent means no measurement, which is NOT zero.
   */
  reviewContextTokens?: number;
  /**
   * The Codex thread id the figure above was measured on.
   *
   * Same provenance rule as `judgeContextThread`, and separately stored for the
   * same reason the threads are separate: a figure measured on the reviewer's
   * conversation must never be readable as the judge's, and a turn on one
   * conversation must not disturb the other's record.
   */
  reviewContextThread?: string;
  /** Carried into the first turn of a rotated session. */
  handoff: string | null;
  /**
   * The briefing describes an earlier point in the run, not the session that
   * just ended.
   *
   * Set when a rotation completed without a new briefing - the baseline
   * rotation for an unattributable measurement abandons the old session whether
   * or not it could be summarised. The previous briefing is still worth
   * carrying, but handing it over as "what you knew" would deny the work done
   * since it was written. Optional so runs recorded before this load.
   */
  handoffStale?: boolean;
  /**
   * Occupancy of the current Claude session, as a fraction of `contextModel`'s
   * window. Zero means nothing has been measured on this session yet, which is
   * the state a rotation leaves behind - not evidence that the session is empty
   * under some other model.
   */
  contextRatio: number;
  /**
   * Provenance tag: the Claude model the stored measurements describe.
   *
   * Set by a completed turn under that model, and by the rotation reset that
   * tags the incoming model before anything has been measured on it. A ratio is
   * a fraction of one model's window: a run measured at 40% of a 1M window and
   * resumed with `--claude-model` onto a 200k one is really at 200%, and reading
   * the stored number deferred compaction past the turn that overflowed. Absent
   * means the measurement cannot be attributed - not that it is valid.
   * `state.config` cannot stand in for it: resume overrides were applied to a
   * local config for most of this tool's history, so a stored config may name a
   * model no turn ever ran under.
   */
  contextModel?: string;
  /**
   * Window, in tokens, of `contextModel` - metadata about the model rather than
   * about the session, and read only by the `ctx%` display.
   *
   * Present with a zero `contextRatio` is a valid state: a rotation's handoff
   * turn measures a window while its occupancy, which belongs to the session
   * being abandoned, is discarded.
   */
  contextWindow?: number;
  /**
   * When the most recently started *running* turn began.
   *
   * The boundary marker for `lastOutputAt`: it is what distinguishes "quiet
   * because the turn started three seconds ago" from "quiet for twenty minutes".
   *
   * "Most recently started" rather than "the" turn because a rotation overlapped
   * with a Codex turn makes two turns live at once. Both this and `lastOutputAt`
   * are recomputed across the live turns on every observation, so when the
   * rotation finishes they fall back to the Codex turn that is still running -
   * they can move backwards, and must, or a finished turn's output reads as the
   * live one's progress. Between turns they keep the last turn's values until
   * the next turn's boundary rebases them, which is what makes the end-of-turn
   * flush worth doing. Maintained only while progress is enabled.
   */
  turnStartedAt?: string;
  /**
   * When vibe last observed any of its turns making progress - from a child's
   * stdout OR from its own heartbeat tick.
   *
   * The field a watcher in another shell should read: it answers "is this run
   * still being worked", which previously took `Get-Process` plus a guess. It
   * deliberately advances during a silent reasoning block, because a turn that
   * emits no events for twelve minutes is still a healthy turn.
   *
   * Monotonic, and the one of the three that is about the run rather than about
   * a turn: it stays readable between turns, when the other two describe a turn
   * that has ended.
   */
  lastActivityAt?: string;
  /**
   * The exact time of the last line a running turn wrote. Flushed at the end of
   * a turn whose output the adapter accepted, so it is never left behind by the
   * write throttle and never records a rejected turn as a completed one.
   * Distinct from `lastActivityAt` on purpose: this is the one that goes quiet,
   * so the pair separates "thinking" from "gone".
   *
   * Absent means no running turn has spoken yet - the turn boundary clears it,
   * unless another turn is still running and has.
   */
  lastOutputAt?: string;
  /**
   * P1s the plan critique raised that were carried into implementation rather
   * than argued out in prose. Stated in the implementation prompt.
   */
  carried?: Finding[];
  /**
   * Findings the approving plan-critique round marked `defer`. Stated to the
   * implementer as work *not* to do.
   *
   * The mirror image of `carried`, and the one round whose deferrals reach
   * nobody otherwise: a revising round already hands its findings to the
   * planner through `pendingFindings`, but the round that passes the gate
   * clears them and breaks. Plan phase only - a review that approves has no
   * later turn to tell, and FOLLOW-UPS.md is the whole of that record.
   *
   * Optional, so state written before this existed loads unchanged.
   */
  declined?: Finding[];
  /**
   * The acceptance bar the critique round that *approved* the plan saw.
   *
   * A copy, not a view of `state.plan`. The plan can be replaced by a later
   * write, mutated in place by anything holding the same objects, or replaced
   * with `null` by `readPlan` when a stored one is unusable - and none of that
   * may move a bar the critic already passed. Where the two disagree the
   * snapshot wins: a criterion the critic never saw is not an approved
   * criterion.
   *
   * Assigned unconditionally at the gate, including as `undefined` for a legacy
   * plan that never stated a bar - inventing `[]` there would put a claim in
   * its mouth, and a conditional assignment would leave an earlier round's bar
   * standing. Optional, so state written before this existed loads unchanged.
   */
  acceptanceCriteria?: AcceptanceCriterion[] | undefined;
  /**
   * P1s the review carried, within `loop.p1Tolerance`. A final fix round
   * addresses them and OUTSTANDING.md records them, because that round is not
   * re-reviewed and so nothing has confirmed they are gone.
   */
  outstanding?: Finding[];
  /**
   * Findings the critic or the reviewer marked `defer`: real work that belongs
   * in separate effort, collected across every plan-critique and code-review
   * round and deduped by id.
   *
   * Distinct from `deferredQuestions`, which is about questions Codex declined.
   * Purely a record: `FOLLOW-UPS.md` is rendered from it and nothing in the loop
   * reads it, because a deferred finding is P2/P3 and already non-blocking.
   */
  deferred?: Finding[];
  /**
   * The final fix round has run. Stops the review loop reopening the argument
   * the tolerance just settled, and survives resume so a restart does not
   * review again.
   */
  finalFixDone?: boolean;
  /** Verified agent environment facts, stated to both agents in their prompts. */
  environment?: EnvironmentFacts | null;
  /**
   * The effective config this run started with.
   *
   * Resume reloaded config from defaults, so a run launched with
   * `--claude-model sonnet` silently continued on opus - a 4x cost change
   * chosen by accident. Stored settings are the base on resume; new flags
   * still override them. Optional so runs created before this existed load.
   */
  config?: Config;
  plan: Plan | null;
  pendingAnswers: Answer[] | null;
  /**
   * Findings the run has paid for that no revision or fix round has yet
   * answered.
   *
   * Written by the critique or review turn itself and cleared by the revision
   * or fix that consumes them. Both loops are shaped turn -> gate -> guard ->
   * consume, and the guard throws in the gap: the findings lived only in a
   * local binding, so a convergence or budget stop discarded them and the
   * resumed loop re-entered at the turn that bought them. That cost 7.5M tokens
   * to re-derive an answer the run already had, byte for byte, and appended a
   * second `RoundRecord` for a plan that had not changed.
   *
   * Optional, and absent means "nothing unconsumed": a state written before this
   * field existed has none, and that is precisely what such a run meant. An
   * explicit `null` is the ordinary post-consumption value `clearPendingFindings`
   * writes, and `validateStoredState` keeps it as it is - it is healthy, not
   * damage.
   */
  pendingFindings?: PendingFindings | null;
  extraContext: string | null;
}

export interface RunSummary {
  id: string;
  status: string;
  task: string;
  /**
   * Null when the file could not be read, or held something that is not a cost.
   *
   * Not zero: `$0.00` asserts that an unreadable run cost nothing, which is the
   * fabricated figure this codebase refuses everywhere else - an unknown Codex
   * cost is reported as absent, an unknown context window stays null.
   */
  costUsd: number | null;
}
