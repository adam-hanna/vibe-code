import type { RoleProviders } from '@src/roles.js';
import type { EnvironmentFacts, ToolchainContract } from '@src/runtime.js';
import type { Liveness } from '@src/lock.js';
import type { SlotName } from '@src/slots.js';

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
/**
 * One blocking finding, as much of it as the convergence guards need.
 *
 * The title rides along because the id does not mean what three guards took it
 * to mean. Across 25 archived runs an id came back in more than one round 21
 * times, and all 21 carried a different claim - the critic reuses a label for
 * the next defect in the same area while the planner closes the last one (#116).
 * The id alone is a model-authored slug and nothing enforces its stability.
 */
export interface RoundClaim {
  id: string;
  title: string;
}

export interface RoundRecord {
  /**
   * Fingerprint of the blocking id set, or null when the round had none.
   *
   * Kept, and still written, but only *read* for a record that predates
   * `claims`: it hashes ids, so it inherits exactly the defect `claims` exists
   * to fix. A resumed legacy history has nothing else to compare, and falling
   * back to it leaves such a run behaving precisely as it did before (#116).
   */
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
   *
   * Superseded as an identity by `claims`, and retained as the legacy fallback
   * for the same reason `signature` is.
   */
  ids?: string[];
  /**
   * What each blocking finding actually claimed, which is what the guards
   * compare since #116.
   *
   * Optional, and absent means "this round was recorded before finding identity
   * meant anything": every guard falls back to `ids`/`signature` for such a
   * round rather than inventing claims for it.
   */
  claims?: RoundClaim[];
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

/**
 * A question the re-ask guard suppressed as a rephrasing of one already asked
 * (#65).
 *
 * `matched` is the *normalized* earlier question, because `answeredQuestions`
 * has only ever held normalized keys and the original wording cannot be
 * recovered from one. Said plainly in `REPHRASED.md` rather than dressed up as
 * the wording the planner used.
 */
export interface SuppressedQuestion {
  /** The new wording, verbatim, as the planner asked it. */
  question: string;
  /** The `answeredQuestions` key it matched. Normalized, not the original. */
  matched: string;
  /** Jaccard over `normalize`'s tokens: 0..1. */
  score: number;
}

/**
 * A deferred question a human's answer disposed of, matched by rephrasing
 * (#65).
 *
 * Recorded because the alternative is a silent omission: the entry leaves
 * `ASSUMED.md` on the strength of a similarity score, and a wrong match must
 * cost a line someone can check rather than a question nobody hears about
 * again.
 */
export interface ResolvedQuestion {
  /** The deferred wording, as `ASSUMED.md` would have printed it. */
  question: string;
  /** The question the human answered, verbatim. */
  answered: string;
  score: number;
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
  /**
   * What the command produced, preserved when this gate FAILS (#62).
   *
   * Project-relative paths, each a directory or a file - not globs. `fs.glob`
   * arrived in Node 22 and `engines` is node >=20 with no dependencies, so a
   * glob would mean hand-rolling a matcher; worse, the matcher would have to be
   * link-aware while it expanded, which puts the containment rule in a second
   * place. A path needs neither.
   *
   * Absolute paths, `..` segments and anything under `.vibe` are refused by
   * `refuseArtifactPath`, and overlapping entries by `refuseOverlappingArtifacts`.
   */
  artifacts?: string[];
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
  /**
   * A ceiling on what one gate artifact entry may copy, in bytes. Null is no
   * ceiling, and it is the default (#62).
   *
   * Null rather than a number because there is nothing to derive a number from.
   * The only measurement available bounds what *vibe* writes - 11.6MB across 24
   * archived runs, largest single record 1.14MB - and says nothing about what a
   * test reporter writes, which is the thing a ceiling is about. A default here
   * would be invented, and the user opted in by naming the path.
   *
   * One setting for all gates rather than a per-gate key: the surface is smaller
   * and nothing yet wants two.
   */
  artifactMaxBytes: number | null;
  /**
   * Whether a reviewer's reproducer is placed and run (#113).
   *
   * True by default. Two things make that the right default rather than an
   * opt-in: a run whose reviewer supplies no reproducer is byte-identical either
   * way, so nothing changes for anyone until a reviewer writes one; and a
   * feature nobody turns on proves nothing about false findings, which is the
   * whole point of it.
   *
   * What turning it off buys is the one thing it costs: a gate run per blocking
   * finding that carries a reproducer, at that gate's own timeout. There is no
   * cap on how many, deliberately - a number here would be invented, and the
   * ceiling that exists is the reviewer's own willingness to write tests.
   *
   * Off also means the file is never written into the working tree. That is a
   * real reason to want it off on a repository where an unexpected file would
   * matter, even though the implementer writes files there every round.
   */
  reproducers: boolean;
}

export interface ProgressConfig {
  enabled: boolean;
  /** Minimum gap between heartbeat lines, and the tick interval for a silent turn. */
  intervalMs: number;
  /**
   * Gap between readings of what a write turn has changed in the tree (#136).
   *
   * Its own number rather than `intervalMs`, because the two cost different
   * things. A heartbeat is a counter incremented by a line that had already
   * arrived; a work reading is three `git` child processes against a tree an
   * agent is writing to, and on a large repository that is not free. Halving
   * the cadence halves the cost of the only part of in-turn progress that has
   * one.
   *
   * `progress.enabled: false` turns this off with everything else - there is no
   * second switch, because a run that does not want progress does not want this
   * either.
   */
  workIntervalMs: number;
}

/**
 * What the loop does when it reaches a boundary that has a row in the matrix.
 *
 * Three modes, and the difference between the two that hold is **what a hold
 * costs**, not how often it happens:
 *
 * - **`auto`** - the loop runs through. Nothing is asked and nothing is written.
 * - **`step`** - the loop holds and asks. That costs nothing, because the app
 *   links this source and a gate is an `await` at a phase boundary: the process
 *   stays alive and the agent session stays warm. It needs somebody who can be
 *   asked, and a terminal is not one - `vibe run` passes no host and a promise
 *   is not answerable from a prompt - so from the CLI a `step` row runs through.
 *   That is the mode's definition rather than a failure of it, and `vibe doctor`
 *   prints it per row so it is not something you find out by not seeing it.
 * - **`stop`** - the run **ends** here, resumably: `Escalation(NEEDS_HUMAN)` ->
 *   `NEEDS-INPUT.md` -> `status: 'needs-input'` -> `vibe resume`. It asks
 *   nobody, so it means exactly the same thing in both front ends, and it is the
 *   mode to reach for from a terminal.
 *
 * The earlier reading of `step` - "hold the second and every later time this
 * boundary is reached, where `stop` holds the first" - was rejected because it
 * needs a durable per-boundary record of whether the run has been here before,
 * and nothing in `RunState` carries one. Two modes that differ only in a count
 * nobody stores is a distinction that survives a process and not a resume.
 */
export type GateMode = 'auto' | 'step' | 'stop';

/**
 * The boundaries that get a row. Two of the eight deliberately do not.
 *
 * **`complete`.** A gate holds *before the next thing*, and at `complete` there
 * is no next thing. `holdAt` has excluded it since #134 and the reasoning is
 * recorded there; this makes the exclusion a fact about the vocabulary rather
 * than a line in one function.
 *
 * **`final-fix`.** Drawn locked in the settings design - *"notifies, never
 * gates"* - and the loop agrees: the checkpoint is written, and then the loop
 * goes *back to the top so the verification gate proves the final fix broke
 * nothing*. Holding before that offers a decision made with strictly less
 * information than the same decision one step later, and it converts a run that
 * was one gate from finished into one that reports needing input. #134 shipped
 * it gateable because nothing could configure a gate yet; naming it here is
 * where that gets decided rather than defaulted.
 *
 * Both are refused by name in `vibe.config.json`, each with its own reason -
 * dropping the key silently would leave someone believing they had armed a gate.
 */
export type GateableBoundary = Exclude<CheckpointBoundary, 'final-fix' | 'complete'>;

/** A mode per gateable boundary. Every row is present; `auto` is a value, not an absence. */
export type GatesConfig = Record<GateableBoundary, GateMode>;

export interface Config {
  /**
   * Which agent holds each role on this run, and what model, effort and turn
   * timeout it runs under.
   *
   * The four choices a run makes about the role table - a provider per role, and
   * optionally that role's own effort (#46), model (#60) and timeout (#84):
   * `access`, the output schema and the conversation slot are facts about the
   * job, not user settings. Absent - a config stored before this key existed -
   * means the default assignment, which is what every run before it did.
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
   * Where the loop hands control back, and what that costs.
   *
   * One setting for both front ends. Before this there was exactly one gate in
   * the product and it was a command name - `vibe plan` - and the six boundaries
   * #134 made holdable were held at unconditionally by anything that passed a
   * host, which is to say the app asked you to release every plan round and
   * every review round of every run.
   *
   * `planOnly` is deliberately NOT folded in here, and that is a decision rather
   * than an omission - see `RunState.planOnly`.
   */
  gates: GatesConfig;
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

/**
 * What kind of claim a citation is making - and, therefore, what can be checked
 * about it.
 *
 * Three of the four are checkable and one is not, which is the whole design.
 * `code` is "this line does X"; `artifact` is "the plan does not say what
 * happens on resume"; `absence` is "no test covers the carried-P1 path", and
 * cites the place the thing is missing *from*, so a directory is legitimate;
 * `external` is "`codex exec resume` takes no `-s` flag", where nothing here
 * can check another tool's CLI and pretending otherwise would be inventing a
 * verdict.
 *
 * `external` is an escape hatch and that is accepted deliberately: a model that
 * wants to keep a blocking severity can always pick it. What the taxonomy buys
 * is that it must *say* which kind of claim it is making, and the
 * `finding_downgraded` event names the kinds each finding offered - so "this P1
 * rested only on an unverifiable external claim" is a fact a human can see
 * (#48).
 */
export type EvidenceKind = 'code' | 'artifact' | 'absence' | 'external';

/**
 * One place a finding points at. Checked by `src/evidence.ts`, never here.
 *
 * Every field but `kind` is optional in TypeScript because the requirement is
 * per-kind - `path` for the three filesystem kinds, `ref` for `external` - and
 * expressing that in the schema needs `oneOf`, whose handling by both CLIs is
 * unverified. A missing field costs the entry, never the report.
 */
export interface Evidence {
  kind: EvidenceKind;
  path?: string;
  line?: number;
  excerpt?: string;
  ref?: string;
}

/**
 * Who made a claim (#141).
 *
 * A severity is an assertion with an owner - that is the whole design of #48 and
 * #66 - and until this existed the archive could not name one. Every finding came
 * from `parseFindings` reading a model's structured output, so "absent means an
 * agent said it" was true by construction and therefore never written down. The
 * moment a human can raise one, that inference is wrong, and a human finding
 * indistinguishable from the reviewer's in `code-review-N.json` would corrupt the
 * one record that says what the reviewer thought.
 *
 * Four members, and each is a different kind of claim:
 *
 * - `critic` / `reviewer` - a model's judgement, bought with a turn. Stamped by
 *   `groundAndRecord`, which is the single point both writers pass through and
 *   the only place that knows which role produced the report.
 * - `human` - a person, through `src/raise.ts`. Costs no tokens and no turn.
 * - `vibe` - a mechanical fact about an artifact on disk, asserted by the tool
 *   itself. `refusePlaceholderPlan` is the only one today, and it used to be
 *   indistinguishable from the critic's own P1 about the same defect.
 *
 * The seated *provider* is deliberately not part of this. `roles.ts` already
 * records who holds a seat and it can change mid-run; this names the position
 * that made the claim, which is what a later reader is asking about.
 */
export type FindingAuthor = 'critic' | 'reviewer' | 'human' | 'vibe';

/**
 * One move of a severity, and who made it (#142).
 *
 * `by` is `FindingAuthor` rather than a second vocabulary: #141 already answered
 * "how does this record name a source", on the same record, and inventing a
 * parallel enum a month later is how two fields come to disagree about what
 * `human` means. Only `human` is ever written today - the guards write
 * `downgraded`, which says the same thing in the field that is theirs - and the
 * type is the shared one so that a later writer has a name already waiting.
 *
 * `from` is captured by `move` in `src/evidence.ts` at the instant of the change
 * and can never be supplied by a caller. That is the whole reason the guards
 * share a construction, and it is why widening it was the right shape rather
 * than adding a third path beside it: a `from` a caller could type is a `from`
 * that eventually names a severity the finding never had.
 */
export interface SeverityChange {
  from: Severity;
  to: Severity;
  by: FindingAuthor;
  /** Why, in the person's own words. Required: a move nobody explained is noise. */
  reason: string;
  /** ISO 8601, so the order in the list is checkable rather than asserted. */
  at: string;
}

/**
 * A test the reviewer wrote to make its own finding fail - the executable
 * witness (#113).
 *
 * `src/evidence.ts` says what grounding can and cannot do, in its own words:
 * *"Not whether it is correct. Nothing here can judge a claim; it can only check
 * that the claim names a real place."* A finding that is **wrong** and cites a
 * real line is passed by both guards and cannot be told from a true one - #44's
 * P1 is the standing example, and it bought a fix round that edited working code
 * to satisfy a premise `tsc` refutes in four seconds. This is the field that
 * makes that case observable.
 *
 * **A file, never a command**, and that is the whole shape of the design.
 * `src/verify.ts` states the rule at the one place a shell is used at all -
 * *"Model-authored text is never passed to a shell"* - so a reviewer-supplied
 * `command` would hand a Codex turn the user's own privileges on the user's own
 * machine. What ships instead: the reviewer returns a test file, vibe places it,
 * and the command executed is **byte-identical to the gate the user configured**.
 * No new execution authority, and nothing model-authored on a command line.
 *
 * Writing a model-authored *file* into the tree is not new authority either -
 * the implementer does it every round, and the gate runs what it wrote. What is
 * new is that vibe does the writing, so the containment, the refusal to
 * overwrite and the removal afterwards are all in `src/reproducer.ts` rather
 * than in an agent's judgement.
 */
export interface Reproducer {
  /**
   * Where the file goes, repo-relative.
   *
   * Model-authored, so it is resolved through the same containment
   * `checkEvidence` applies to a citation - and then held to more, because this
   * one writes: an existing path is refused rather than overwritten, and a
   * symlinked ancestor is refused rather than followed.
   */
  path: string;
  /** The file itself, written verbatim. */
  contents: string;
  /**
   * Which configured gate runs it, by name.
   *
   * A name matched against `resolveGates`, never a command: the reviewer chooses
   * *which* of the user's own gates observes the file, and cannot choose what
   * that gate runs. Absent is legal and resolves to the sole gate when there is
   * exactly one - which is every legacy config, since `resolveGates` synthesizes
   * a single gate named `verification`.
   */
  gate?: string;
}

/**
 * What running a reproducer observed. Three answers, and one of them is "cannot
 * tell" (#113).
 *
 * - `reproduced` - the gate passed on this tree without the file and failed with
 *   it. The finding points at something that actually happens.
 * - `did-not-reproduce` - the gate passed with the file present. The test the
 *   reviewer wrote to make its own finding fail did not fail.
 * - `unproven` - nothing was observed: the file could not be placed, no gate
 *   could be resolved, the gate could not run, or it failed with no observed
 *   baseline to attribute the failure to.
 *
 * **The two directions need different amounts of evidence, and that asymmetry is
 * the design.** A *pass* is self-certifying: the added test ran inside a suite
 * that exited 0, so nothing else was broken and the test itself passed. A
 * *failure* is not: without an observed pass of the same gate on the same tree
 * without the file, the failure may be any other test in the suite. So
 * `reproduced` requires the baseline and `did-not-reproduce` does not, and a
 * failure with no baseline is `unproven` rather than a proof.
 */
export type ReproducerVerdict = 'reproduced' | 'did-not-reproduce' | 'unproven';

export interface ReproducerOutcome {
  verdict: ReproducerVerdict;
  /**
   * Which moment this observation is from.
   *
   * `review` is before the fix, and is what decides whether the finding blocks.
   * `final-fix` is after the round that is deliberately never re-reviewed, and
   * is the one thing that has ever been able to turn OUTSTANDING.md's *"worked
   * on and unconfirmed"* into a fact.
   */
  at: 'review' | 'final-fix';
  /** The gate that ran it, or null when none could be resolved. */
  gate: string | null;
  /** What was executed - the configured gate's command, unchanged. Null when nothing ran. */
  command: string | null;
  /** Null when the command never ran, or ended without one. */
  exitCode?: number | null;
  /**
   * Whether a pass of the same gate on the same tree *without* the file was
   * observed. Only `gate-passed` can support `reproduced`.
   */
  baseline: 'gate-passed' | 'not-observed';
  /** Why it is unproven. Null on the two verdicts that observed a run. */
  reason: string | null;
  /** Where the file was kept under the run directory, or null when it was not. */
  archived: string | null;
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  suggested_fix: string;
  /**
   * Who raised it, or absent (#141).
   *
   * **Absent is not "an agent".** Every finding recorded before this field
   * existed has none, and so does one whose author could not be attributed -
   * `groundAndRecord` stamps only the two roles that can produce a report, and
   * leaves the field off for anything else rather than guessing. A renderer that
   * needs the value narrows it through `authorOf`, which returns null for
   * anything outside the four members above: this rides through `readFinding`
   * unvalidated, exactly as `evidence` does, because refusing a whole finding
   * over a bad label would delete a claim to protect a caption.
   */
  raisedBy?: FindingAuthor;
  /**
   * Where this finding says to look. At least one entry, per the schema.
   *
   * A blocking finding with no entry that resolves is downgraded to P2 before
   * anything reads its severity (#48): a reviewer that ran no commands could
   * previously halt a run over a claim it could not point at. Optional in
   * TypeScript for the reason `defer` is - a report stored before this field
   * existed has none - and absent rather than `[]` when the model cited
   * nothing, because absent is what actually happened.
   */
  evidence?: Evidence[];
  /**
   * Set when a blocking finding was downgraded for citing nothing that
   * resolves.
   *
   * On the finding itself, not only in the event log: a downgrade that appeared
   * in a log line alone would be invisible by the time anyone read the round's
   * artifact.
   *
   * **The guards' field, and theirs alone** (#142). `toP2` is the only writer,
   * nothing clears it, and a person restoring the severity afterwards does not
   * touch it - overwriting it on a restore would erase the fact that a guard
   * fired, which is the exact thing #48 added the field for. What a person did
   * lands in `severityChanges` beside it, so the two questions a reader has -
   * *did a guard fire, and why* and *how did this reach the severity it has* -
   * each have their own answer rather than one answer that has to serve both.
   */
  downgraded?: { from: Severity; reason: string };
  /**
   * Severity changes a **person** made, oldest first (#142).
   *
   * Until this existed a severity moved in exactly one direction, was written by
   * exactly one function, and could never be moved back: every instance came
   * from `toP2`, always landing on P2, always for a mechanical reason, and
   * permanent. That is correct for a rule running unattended - grounding
   * *"cannot judge a claim; it can only check that the claim names a real
   * place"* - and it means a true P1 that cited a file the reviewer described
   * from memory is demoted for the same reason a false one is. The only thing in
   * the system that can tell those apart is a person reading the finding, and
   * they could see the downgrade, agree it was wrong, and do nothing about it.
   *
   * A list rather than a field, because a finding grounding demoted and a person
   * restored has a history of two steps and the artifact should show both.
   * Append-only: nothing here is ever rewritten, so the guard's reason stays
   * readable after the restore that overrode it.
   *
   * Absent on every finding nobody touched, which is almost all of them, and an
   * empty list is never written - a run in which no severity moved produces the
   * artifacts it produced before this existed, byte for byte.
   */
  severityChanges?: SeverityChange[];
  /**
   * The test the reviewer wrote to make this finding fail (#113).
   *
   * Optional, and its absence is never held against the finding. Requiring one
   * would mean a reviewer that cannot write a failing test loses its finding,
   * which is the opposite of what a guard should cost - and it would put a
   * schema requirement on a field the loop can only *sometimes* act on. A
   * finding with none behaves exactly as every finding did before this existed.
   */
  reproducer?: Reproducer;
  /**
   * What running that test observed, oldest first (#113).
   *
   * A list because the same reproducer is run at two different moments and they
   * answer two different questions: at `review`, does the defect happen at all;
   * after the final fix, is it gone. Append-only, like `severityChanges` and for
   * the same reason - each entry is a record of an observation, and an
   * observation is not corrected by a later one.
   *
   * A `did-not-reproduce` at `review` costs the finding its blocking severity
   * through `toP2`, so `downgraded` carries the demotion and this carries the
   * evidence for it. Nothing here ever *raises* a severity: `reproduced` records
   * that the finding is real and leaves it exactly where the reviewer put it,
   * because promoting on a machine's say-so is the move #142 reserved for a
   * person.
   */
  reproducerOutcomes?: ReproducerOutcome[];
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

/**
 * What one turn actually did, counted from its own live stream (#66).
 *
 * `tool` is stored rather than re-derived on read, because the classification is
 * the *provider's*: a Claude tally is keyed by tool name (`Read`, `Bash`) and a
 * Codex one by item type (`command_execution`, `agent_message`), and a reader
 * holding only `items` cannot tell which vocabulary it has. `items` is kept
 * beside it so a human can second-guess the judgement the run made.
 *
 * Absent, never zeroed, for a turn nothing measured - no heartbeat at all
 * (`progress.enabled` false, or the preflight probe, which passes none), or an
 * injected agent in a test. "Nothing was observed" is not "nothing was done".
 */
export interface TurnActivity {
  /** Item kinds this turn emitted, counted once each. Provider vocabulary. */
  items: Record<string, number>;
  /** How many of them were the agent using a tool rather than thinking or talking. */
  tool: number;
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
  /**
   * What the turn did, from its heartbeat. Absent when it had none (#66).
   *
   * Optional so every injected fake reports an unmeasured turn rather than a
   * fabricated empty one.
   */
  activity?: TurnActivity | undefined;
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
  /**
   * How many of those `runs` failed (#135).
   *
   * The fraction is the whole point: `failed: 1` of `runs: 3` is a suite that is
   * not deterministic, and `failed: 3` of `runs: 3` is one that is broken. Until
   * this existed a failing gate returned on its first non-zero exit, so `runs`
   * was the attempt that failed and no archive entry could tell the two apart.
   *
   * **Optional, and absent is not zero.** Every gate outcome recorded before
   * this field existed has none, and a `0` there would assert that a failing
   * gate failed nothing. Present on a `failed` outcome and absent on every other
   * status, where the count is either meaningless or already implied by `runs`.
   */
  failed?: number;
  required: boolean;
  /**
   * What was preserved of what the failing command produced (#62).
   *
   * Absent when the gate passed, when it named no `artifacts`, and when
   * verification is disabled. Absent is NOT an empty record: "nothing was asked
   * for" and "something was asked for and nothing survived" are different facts,
   * and only the second one is a report a human has to go and read.
   */
  artifacts?: GateArtifacts | undefined;
}

/**
 * What happened to ONE configured artifact path.
 *
 * Every status other than `copied` carries its `reason`, because a run record
 * that quietly omits half a report looks complete - and looking complete while
 * being partial is the fabrication this repo's rules exist to prevent.
 */
export interface ArtifactEntryOutcome {
  /** The path exactly as configured, so a reader can match it to their config. */
  path: string;
  status: 'copied' | 'missing' | 'refused' | 'too-large' | 'failed';
  files?: number;
  bytes?: number;
  /** Why, for anything that is not `copied`. Present for every other status. */
  reason?: string;
  /** Links refused inside the tree, relative to the entry, in walk order. */
  skippedLinks?: string[];
}

/** One gate's preserved evidence for one verification round. */
export interface GateArtifacts {
  /**
   * Where they went, RELATIVE to the run directory and with POSIX separators -
   * `artifacts/qa/round-1`.
   *
   * Relative for the reason `loadRun` re-derives `dir` and `targetDir` rather
   * than trusting the stored ones: a run record has to stay readable when the
   * repository moves, and an absolute host-native path stored in state.json
   * would be wrong the moment it did.
   */
  dir: string;
  entries: ArtifactEntryOutcome[];
  /** Bytes actually written. The sum of the entries that were copied. */
  bytes: number;
  /**
   * Housekeeping this attempt could not finish, named.
   *
   * Deleting the superseded round after the new one is installed is the last
   * step and the only one that can fail without costing anything - the snapshot
   * is already in place, so reporting the entries as failed would make the
   * record contradict a filesystem holding exactly what was asked for. But a
   * `round-1.superseded-*` directory nobody explained is a puzzle for whoever
   * opens the run, so what is left over is said here instead of only in a log
   * line that has long since scrolled away. Absent means the directory holds
   * exactly the round and nothing else.
   */
  unresolved?: string;
}

/**
 * What the most recent review round actually saw - extended after each chunk
 * turn succeeds, never before it.
 *
 * Absent means no completed review coverage: no review has run, or one is in
 * flight and has not finished a single part. Never repaired into a zero-valued
 * record - "the reviewer saw no files" is a different fact from "no review
 * happened" (#49, and #44's rule about absence).
 *
 * Flat by decision: which chunk saw which file lives in the per-turn Codex
 * artifacts and in the prompts, and storing it here would be redundant state
 * with a second repair surface.
 */
export interface ReviewCoverage {
  /** 1-based, matching the `Code review (round N)` heading. */
  round: number;
  /** Chunk turns COMPLETED so far, not the number planned. One for an ordinary round. */
  chunks: number;
  /** Every file the reviewer was actually shown, in order. */
  files: string[];
  /** Files whose diff was cut even inside their own chunk. */
  truncated: string[];
}

/**
 * One turn's observed-but-uncharged spend. See `RunState.inFlight`.
 *
 * Keyed by `label` plus `provider` wherever it is looked up, which is unique
 * among live turns: the only concurrency is `withConcurrentCompaction`, and it
 * pairs Claude's `compact` with a Codex critique or review turn, so the pair
 * differs on both axes.
 *
 * `tokens` absent means the provider reports no figure while a turn is in
 * flight, which is true of Codex: its stream carries usage only on
 * `turn.completed`, so a killed Codex turn has no number to recover and is
 * recorded as a known unknown rather than as a zero.
 */
export interface InFlightTurn {
  label: string;
  provider: 'claude' | 'codex';
  tokens?: number;
}

export interface RunEvent {
  at: string;
  type: string;
  [key: string]: unknown;
}

/**
 * The phase or round boundary a checkpoint was taken at (#78).
 *
 * A run's `state.json` is a single mutable file, so nothing recorded what it
 * looked like at any earlier point. These are the points at which a snapshot is
 * a coherent thing to resume from: each is taken after the work of a round has
 * been recorded and before the next round has begun.
 *
 * `question-round` joined them in #139, and its absence had been the one hole in
 * that sentence: the question loop has its own counter and its own cap, it buys
 * an answerer turn every time round, and it was the only round in the loop that
 * left no snapshot. It also ends the blur - a revision driven by the planner's
 * own questions used to be recorded as a plan round, which is a different
 * diagnosis about a run wearing the same name.
 */
export type CheckpointBoundary =
  | 'plan-round'
  /** After the answerer's turn, whether or not a revision followed it (#139). */
  | 'question-round'
  | 'plan-approved'
  | 'implemented'
  | 'verify-round'
  | 'review-round'
  | 'final-fix'
  | 'complete';

/**
 * Why a checkpoint's `commit` is what it is.
 *
 * Absence is reported as absence, with the cause named: a boundary that never
 * commits (`no-commit-in-round`) says something different from a repository
 * where commits are switched off, from a round that changed no files, and from
 * a commit that failed. `sha-unusable` is the one that would otherwise be a
 * fabrication - a commit succeeded but git named it something that is not a
 * 40-hex object id, so the id is dropped rather than stored as though it could
 * be resolved later.
 */
export type CheckpointCommitNote =
  | 'committed'
  | 'nothing-to-commit'
  | 'commit-failed'
  | 'sha-unusable'
  | 'commits-disabled'
  | 'not-a-repo'
  | 'no-commit-in-round';

/**
 * A checkpoint's own metadata, carried inside the snapshot it describes.
 *
 * Written into `checkpoint-<n>.json` only. A live `state.json` gains it on a
 * forked run, where it means "this state came from that checkpoint".
 */
export interface RunCheckpointMeta {
  /** Matches the filename. Monotonic per run, from 1. */
  n: number;
  at: string;
  boundary: CheckpointBoundary;
  phase: RunPhase;
  planRound: number;
  reviewRound: number;
  verifyRound: number;
  /**
   * Question rounds spent so far. **Absent means the checkpoint predates #139**,
   * which is not the same fact as zero and must not be drawn as one.
   *
   * Optional for exactly that reason: `readCheckpointShape` refuses a snapshot
   * missing any field it requires, so requiring this would make every checkpoint
   * written before this change unreadable - and `vibe fork` would report a
   * directory of healthy snapshots as damaged.
   *
   * It is here rather than only in the snapshot body (which is a whole
   * `RunState` and has always carried the counter) because this is the summary a
   * reader actually gets: the fork listing and `ForkOrigin` read the meta, and a
   * rounds fingerprint like `q3 p1` is unreadable without it - three rounds of
   * the planner answering itself is a recognisable and unhealthy shape, and it
   * looked identical to `p4`.
   */
  questionRound?: number;
  /** A full 40-hex object id, or null. Never abbreviated, never symbolic. */
  commit: string | null;
  commitNote: CheckpointCommitNote;
}

/** One conversation a fork did - or could not do - anything about. */
export interface ForkedConversation {
  slot: SlotName;
  /** The parent conversation this slot's first turn will fork from, or null when there was none. */
  parentId: string | null;
  why?: 'never-started' | 'not-persisted';
}

/**
 * What the parent was, at the checkpoint the fork was taken from.
 *
 * **A PROVENANCE RECORD.** Nothing in vibe reads these figures: no ceiling, no
 * guard, no summary arithmetic. They exist so a human - or a later tool - can
 * subtract the shared prefix when adding two runs up, which is the whole of what
 * was asked for. A fork's own `tokensUsed` and `costUsd` are the checkpoint's
 * plus whatever it goes on to spend, and its ceilings read those exactly as an
 * unforked run's do.
 */
export interface ForkOrigin {
  /** The parent run. */
  runId: string;
  checkpoint: number;
  checkpointAt: string;
  boundary: CheckpointBoundary;
  forkedAt: string;
  /** The checkpoint's totals, verbatim. */
  inheritedTokens: number;
  inheritedCostUsd: number;
  /**
   * The checkpoint's `codexTokens` - **absent when the checkpoint had none.**
   * Not classified and not defaulted: an absent Codex share may mean no Codex
   * turn ran or that none was recorded, and nothing here decides which, because
   * nothing depends on the answer. A zero would be an invented number.
   *
   * Verbatim except for rule D (`checkTokenShare`, `src/consistency.ts`): a
   * checkpoint whose Codex share exceeded its own total is **normalised down to
   * `inheritedTokens`** before the fork copies it, because a provenance figure
   * larger than the total beside it is the same defect one layer down. The raw
   * figure is not lost - it is in the child's rule-D `state_repaired` event and
   * named in `notInherited` (#87).
   */
  inheritedCodexTokens?: number;
  /** The 40-hex commit the fork's branch ref was created at, or null. */
  branchFrom: string | null;
  conversations: ForkedConversation[];
  /** What the fork did NOT carry, stated rather than left to be assumed. */
  notInherited: string[];
}

/** A conversation a forked run's first turn still owes a fork to. */
export interface ForkPendingEntry {
  parentId: string;
  attempts: number;
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
   * Turns whose spend has been observed but not yet charged (#77).
   *
   * **An amount observed, never a claim that a turn is running.** That
   * distinction is load-bearing: `src/progress.ts` keeps the live-turn set in
   * memory only, because a persisted liveness record left behind by a killed
   * process would assert that a turn is running when none is. Liveness is the
   * run lock's job (`src/lock.ts`); this is accounting.
   *
   * **One lifetime rule, and only one.** An entry lives from its turn's first
   * observation until the next accounting decision touches it - a charge, a
   * failure, a recovery, or a forced release - and every one of those disposes
   * of it in the same `saveState` that records what it decided. So an entry
   * still here when a process starts means the last process died before
   * reaching that turn's accounting, and recovery never has to guess. Nothing
   * may add a second rule: a sealed or protected entry would be one that
   * survives its own disposal, and the sentence above would stop being true.
   *
   * Optional so every state written before this existed loads with no repair.
   */
  inFlight?: InFlightTurn[];
  /**
   * Codex's rate-limit window as last read from app-server, so the summary can
   * report it. Optional: it is absent whenever app-server is unavailable, which
   * is a normal outcome rather than an error.
   */
  codexRateLimit?: CodexRateLimitRecord | null;
  rateLimitWaits: number;
  baseSha: string | null;
  branch: string | null;
  /**
   * The checkpoint this state came from (#78).
   *
   * Written into every `checkpoint-<n>.json`, and present on a live
   * `state.json` only for a forked run - where it says which snapshot the run
   * was seeded from. Optional, so every state written before checkpoints existed
   * loads with no repair.
   */
  checkpoint?: RunCheckpointMeta;
  /**
   * What this run was forked from, or absent because it is not a fork (#78).
   *
   * Present-but-unreadable is fatal on load rather than repaired: provenance
   * quietly discarded leaves a state indistinguishable from an ordinary run,
   * and once every pending fork has been consumed there is nothing else left
   * that would show the loss. Purely a record - see `ForkOrigin`.
   */
  forkedFrom?: ForkOrigin;
  /**
   * Conversations whose first turn still owes a fork, and how many times it has
   * been attempted.
   *
   * An **instruction**, not a record, which is why a present-but-unreadable
   * value refuses the load: dropped silently, a forked conversation becomes a
   * fresh one and the run loses the parent's context with nobody told. An entry
   * is cleared by the accounting write that charges the turn which forked it, so
   * absent means every fork this run owed has been made and paid for.
   */
  forkPending?: Partial<Record<SlotName, ForkPendingEntry>>;
  /**
   * Set by `vibe fork` when it creates the branch ref; cleared by `prepareGit`
   * once the run is actually on that branch.
   *
   * An instruction too, and refused when unreadable for the same reason one
   * layer down: dropped, the forked run never checks its branch out and its
   * commits land wherever HEAD happens to be.
   */
  branchPending?: true;
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
  /**
   * What the most recent review round was shown.
   *
   * Reset at the start of each round and extended one completed chunk at a
   * time, so it never claims coverage a turn has not bought. Absent on a run
   * that has not finished a review part, and never repaired into a record
   * (#49).
   */
  reviewCoverage?: ReviewCoverage | undefined;
  /**
   * The **basename** of the most recent write turn's report artifact.
   *
   * Cleared before each write turn and written again once that turn's report is
   * on disk - implement, verify-fix, review-fix, final-fix - and read by
   * `runReview`, which renders the file's text into the reviewer's prompt. The
   * clear comes first deliberately: the artifact write and this field's save
   * are two separate file writes, and a process that died between them would
   * otherwise leave a pointer to the PREVIOUS round's report, which the prompt
   * presents as current. Absent is the honest answer in that window (#50).
   *
   * A basename and not the text: `state.json` is already ~96KB on a real run
   * and a report is prose of unbounded length, and the handoff has to survive a
   * resume through the persisted artifact rather than through in-memory state.
   *
   * Absent means no write turn has recorded a report this run can vouch for -
   * including every run whose state predates this field. Nothing probes the run
   * directory for one: `implementation-report.md` may still be sitting there
   * three fix rounds later, and a stale report presented as current is worse
   * than none.
   */
  lastReport?: string | undefined;
  /** Question-and-replan cycles spent so far. */
  questionRound: number;
  events: RunEvent[];
  /**
   * Whether a turn has ever succeeded on `sessionId` - `SLOTS.main`'s marker,
   * separate from its id because every slot has both. Read and written through
   * `src/slots.ts`, never here.
   */
  sessionStarted: boolean;
  /**
   * Whether `sessionId` has been handed to the Claude CLI - `SLOTS.main`'s third
   * marker (#74).
   *
   * Written BEFORE the spawn, because `claude --session-id` spends the id on
   * *attempt* and not on success: a process killed after the CLI registered the
   * session but before the turn returned otherwise leaves a state that believes
   * the id is still free, and every later attempt fails instantly with
   * "Session ID ... is already in use".
   *
   * Separate from `sessionStarted`, which answers a different question - has a
   * turn ever SUCCEEDED here. The two together are what distinguish a session
   * that died mid-turn (resumable, and holding that turn's work) from one that
   * has never been spawned at all.
   *
   * Optional: absent means never registered, so every state written before this
   * existed loads with no repair. Read and written through `src/slots.ts`,
   * never here.
   */
  sessionRegistered?: boolean;
  /**
   * This run has one phase, and it is planning.
   *
   * **Not a gate, and #140 deliberately did not make it one.** That issue asked
   * for `vibe plan` to resolve to `gates['plan-approved'] = 'stop'` so there
   * would not be two mechanisms for "stop after planning". They are not two
   * mechanisms for one thing; they are two different things, and the difference
   * is the one #140 itself insists on elsewhere - *a gate stop and a run that
   * finished are not the same event*:
   *
   * - `planOnly` says there is no next phase. The run **completes**: `status:
   *   'planned'`, `phase: 'complete'`, a `complete` checkpoint, exit 0. Nothing
   *   is being held back, which is the same reason `complete` has no row in the
   *   matrix at all.
   * - `gates['plan-approved'] = 'stop'` says a full run halts before
   *   implementing. It exits 2 with `status: 'needs-input'`, and `vibe resume`
   *   carries on into the implementation it was always going to do.
   *
   * Folding the first into the second would make `vibe plan` exit 2 and report
   * needing input on a run that produced exactly what it was asked for - which
   * is the failure #140 describes as *"makes every scripted caller treat a
   * planned stop as a problem"*, arrived at from the other direction.
   */
  planOnly: boolean;
  answeredQuestions: string[];
  deferredQuestions: DeferredQuestion[];
  /**
   * Questions a human actually answered, verbatim as the `### ` headings of
   * `NEEDS-INPUT.md` gave them (#65).
   *
   * Neither existing field can do this job. `pendingAnswers` is *consumed* by
   * the loop the moment it revises against them, so it is gone by the time
   * anything reports; `answeredQuestions` is marked for every question **asked**
   * whatever came back, so reconciling `ASSUMED.md` against it would empty the
   * file including the entries that are true.
   *
   * Optional, so a state written before this existed loads with no repair and a
   * run nobody answered writes no field at all.
   */
  humanAnswered?: string[];
  /**
   * Re-asks the guard suppressed as rephrasings, with what each matched.
   *
   * Written the moment a suppression happens rather than at the end of the run:
   * the run that motivated this stopped at the round cap, and a record that
   * only exists on the success path is missing exactly when it is wanted.
   */
  suppressedQuestions?: SuppressedQuestion[];
  /** Deferred questions a human's answer disposed of - see `ResolvedQuestion`. */
  resolvedByHuman?: ResolvedQuestion[];
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

/**
 * What is at an artifact's name: its text, nothing usable, or a link.
 *
 * Three answers rather than two, and the third exists for the distinction #53
 * drew and #102 kept: `absent` says a file was opened and could not be used,
 * `linked` says vibe never looked inside it. A caller that narrates must be able
 * to tell a reader which of those happened, and a reader must never be told a
 * file was unreadable when it was never read.
 *
 * Here rather than in `run.ts` beside `readArtifact`, because `protocol.ts`
 * carries one on a frame and that file is a leaf on purpose: the vocabulary two
 * processes agree on should not have to import the loop to be read.
 */
export type ArtifactRead =
  | { kind: 'text'; text: string }
  | { kind: 'absent' }
  | { kind: 'linked'; reason: string };

/**
 * One entry in a run directory, as `lstat` classified it.
 *
 * `kind` rather than a filter, because a run directory legitimately holds things
 * that are not files - `gate-artifacts-<n>/` is a directory #111 writes - and an
 * entry silently missing from a listing reads as an artifact that was never
 * produced. A link is reported as one for the same reason `readArtifact` refuses
 * rather than following: vibe never creates one, so its presence is the finding.
 *
 * `bytes` is null for anything but a plain file. A size for a thing that has no
 * meaningful size is a number nobody measured.
 */
export interface RunArtifact {
  name: string;
  kind: 'file' | 'directory' | 'link' | 'unknown';
  bytes: number | null;
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
  /**
   * Whether anything is working on this run, from its lock (#77).
   *
   * Optional so that a caller building a summary by hand does not have to have
   * an answer; `cmdList` renders an absent value as `unknown`, which is what an
   * unasked question and an unanswerable one both amount to on a listing.
   * `listRuns` always fills it, including for a run whose state.json could not
   * be read - the lock is a separate file and stays legible when state does not.
   */
  liveness?: Liveness;
  /**
   * The run and checkpoint this one was forked from, when the stored state says
   * so legibly (#78).
   *
   * Filled tolerantly, unlike `loadRun`'s refusal for the same field: a listing
   * must not fail over one bad run. The two rules differ because the two callers
   * do - one prints, the other acts.
   */
  forkedFrom?: { runId: string; checkpoint: number };
  /**
   * Set only by `listRuns`, and only for an entry it refused to follow because
   * the directory or its state.json is a symlink or a junction (#53).
   *
   * Separate from `status` because `status` is read off disk and displayed
   * verbatim - `summariseStored` passes an unrecognised value straight through
   * on purpose - so a stored `"status": "linked"` is a display coincidence, not
   * a fact about the filesystem. Anything that must ACT on the distinction (the
   * planner's do-not-open warning) reads this; anything that only prints reads
   * `status`. Never set for an entry that is merely unreadable: a claim that
   * something is a link is a measurement, not a fallback.
   */
  linked?: true;
  /**
   * Set only by `listRuns`, and only for an entry whose `lstat` threw - so
   * whether it is a link could not be established at all (#53).
   *
   * The fail-closed half of `linked`. Nothing under such an entry was followed,
   * and the planner is warned off it for the same reason, but it is a separate
   * field because it is a separate fact: one is measured, the other is the
   * absence of a measurement, and collapsing them would either fabricate a link
   * or drop the warning. Distinct from an `unreadable` row, where the state.json
   * WAS opened and the entry itself was never in doubt.
   */
  unverified?: true;
}
