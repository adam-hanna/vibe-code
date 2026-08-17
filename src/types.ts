import type { EnvironmentFacts, ToolchainContract } from '@src/runtime.js';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
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
  timeoutMs: number;
  /**
   * Keep one Codex thread for the whole run via `codex exec resume`, so the
   * reviewer remembers what it already raised instead of re-deriving it.
   */
  persistSession: boolean;
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
   * rotate produces a different fingerprint each time and slips through - which
   * is exactly what a defect the fixer cannot fix looks like. Optional so runs
   * recorded before this field loaded still parse.
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
}

export interface Config {
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

export interface Plan {
  plan_md: string;
  assumptions: Assumption[];
  open_questions: OpenQuestion[];
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  suggested_fix: string;
}

export interface FindingsReport {
  verdict: Verdict;
  summary: string;
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
  rateLimitWaits: number;
  baseSha: string | null;
  branch: string | null;
  /** One entry per code-review round, driving the convergence assessment. */
  p1Rounds: RoundRecord[];
  /** The same, for verification-fix rounds, which converge independently. */
  verifyRounds: RoundRecord[];
  /** Verification-fix rounds spent so far. */
  verifyRound: number;
  /** Question-and-replan cycles spent so far. */
  questionRound: number;
  events: RunEvent[];
  sessionStarted: boolean;
  planOnly: boolean;
  answeredQuestions: string[];
  deferredQuestions: DeferredQuestion[];
  sessionRotations: number;
  /** Codex's own thread id, reused across critique/answer/review turns. */
  codexSessionId: string | null;
  /** Carried into the first turn of a rotated session. */
  handoff: string | null;
  contextRatio: number;
  /**
   * P1s the plan critique raised that were carried into implementation rather
   * than argued out in prose. Stated in the implementation prompt.
   */
  carried?: Finding[];
  /**
   * P1s the review carried, within `loop.p1Tolerance`. A final fix round
   * addresses them and OUTSTANDING.md records them, because that round is not
   * re-reviewed and so nothing has confirmed they are gone.
   */
  outstanding?: Finding[];
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
  extraContext: string | null;
}

export interface RunSummary {
  id: string;
  status: string;
  task: string;
  costUsd: number;
}
