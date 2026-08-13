import path from 'node:path';
import { claudeTurn, parseStructured, RateLimitError } from '@src/claude.js';
import { codexTurn } from '@src/codex.js';
import * as git from '@src/git.js';
import * as log from '@src/log.js';
import * as P from '@src/prompts.js';
import { ANSWERS_SCHEMA, FINDINGS_SCHEMA, PLAN_SCHEMA } from '@src/schemas.js';
import { artifact, artifactDir, detectOscillation, p1Signature, recordEvent, saveState } from '@src/run.js';
import { parseAnswers, parseFindings, parsePlan, p1s } from '@src/validate.js';
import { withConcurrentCompaction, rotateSession, shouldRotate } from '@src/context.js';
import type {
  Answer,
  Config,
  Finding,
  FindingsReport,
  OpenQuestion,
  PermissionMode,
  Plan,
  RunState,
} from '@src/types.js';

export const EXIT = {
  OK: 0,
  ERROR: 1,
  NEEDS_HUMAN: 2,
  NO_CONVERGENCE: 3,
  BUDGET: 4,
  RATE_LIMITED: 5,
  /** The agents' execution environments do not satisfy the toolchain contract. */
  PREFLIGHT: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class Escalation extends Error {
  constructor(
    readonly code: ExitCode,
    message: string,
    readonly questions: OpenQuestion[] | null = null,
    readonly findings: Finding[] | null = null,
  ) {
    super(message);
    this.name = 'Escalation';
  }
}

/** Read-only toolset for planning turns, alongside plan mode itself. */
const PLAN_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch'] as const;

export async function orchestrate(state: RunState, cfg: Config, resume: boolean): Promise<RunState> {
  const cwd = state.targetDir;

  if (!resume) await prepareGit(state, cfg, cwd);

  // ---- Planning ------------------------------------------------------------
  let plan: Plan;
  if (state.plan) {
    plan = state.plan;
  } else {
    log.heading('Planning');
    plan = await runPlan(state, cfg, cwd);
  }

  // Answers supplied by a human in NEEDS-INPUT.md, picked up on resume.
  if (state.pendingAnswers && state.pendingAnswers.length > 0) {
    for (const a of state.pendingAnswers) markAnswered(state, a.question);
    plan = await revisePlan(state, cfg, cwd, { answers: state.pendingAnswers });
    state.pendingAnswers = null;
    saveState(state);
  }

  for (;;) {
    // A question already put to Codex never comes back, however the revised plan
    // rephrases it - otherwise an insistent planner loops the run forever.
    const pending = plan.open_questions.filter(
      (q) => (q.blocking || cfg.questions.answerNonBlocking) && !isAnswered(state, q.question),
    );
    if (pending.length > 0) {
      const answers = await resolveQuestions(state, cfg, cwd, pending, plan);
      // Codex may have declined every one; only revise if something came back.
      plan = answers.length > 0 ? await revisePlan(state, cfg, cwd, { answers }) : plan;
      continue;
    }

    log.heading(`Plan critique (round ${state.planRound + 1})`);
    const critique = await withConcurrentCompaction(state, cfg, () => runCritique(state, cfg, cwd, plan));
    artifact(state, `plan-critique-${state.planRound}.json`, critique);

    const blockers = p1s(critique.findings);
    if (blockers.length === 0) {
      log.ok(`Plan approved - ${critique.findings.length} non-blocking finding(s)`);
      recordEvent(state, 'plan_approved', { findings: critique.findings.length });
      break;
    }

    log.warn(`${blockers.length} P1 finding(s): ${blockers.map((f) => f.id).join(', ')}`);
    for (const f of blockers) log.info(`  - ${f.title}`);

    guardProgress(state, cfg, critique.findings, blockers, {
      cap: cfg.loop.maxPlanRounds,
      round: state.planRound + 1,
      capName: 'maxPlanRounds',
      deadlockMsg: 'the planner and reviewer are deadlocked',
    });

    plan = await revisePlan(state, cfg, cwd, { findings: critique.findings });
  }

  const planFile = artifact(state, 'PLAN.md', plan.plan_md);
  log.info(`Plan: ${path.relative(cwd, planFile)}`);

  if (state.planOnly) {
    state.status = 'planned';
    saveState(state);
    log.ok('Plan-only run: stopping before implementation.');
    return state;
  }

  // ---- Implementation ------------------------------------------------------
  state.status = 'implementing';
  state.baseSha = await git.markBase(cwd);
  saveState(state);

  log.heading('Implementing');
  const impl = await claudeStep(state, cfg, {
    prompt: P.implementPrompt(plan.plan_md),
    cwd,
    permissionMode: 'bypassPermissions',
    timeoutMs: cfg.claude.implementTimeoutMs,
    label: 'implement',
  });
  artifact(state, 'implementation-report.md', impl);
  await maybeCommit(cfg, cwd, 'vibe: implement approved plan');

  // ---- Review --------------------------------------------------------------
  state.status = 'reviewing';
  state.p1History = [];
  saveState(state);

  for (;;) {
    log.heading(`Code review (round ${state.reviewRound + 1})`);
    const review = await withConcurrentCompaction(state, cfg, () => runReview(state, cfg, cwd, plan));
    artifact(state, `code-review-${state.reviewRound}.json`, review);

    const blockers = p1s(review.findings);
    if (blockers.length === 0) {
      log.ok(`Review clean - ${review.findings.length} non-blocking finding(s)`);
      recordEvent(state, 'review_approved', { findings: review.findings.length });
      break;
    }

    log.warn(`${blockers.length} P1 finding(s): ${blockers.map((f) => f.id).join(', ')}`);
    for (const f of blockers) log.info(`  - ${f.title}`);

    guardProgress(state, cfg, review.findings, blockers, {
      cap: cfg.loop.maxReviewRounds,
      round: state.reviewRound + 1,
      capName: 'maxReviewRounds',
      deadlockMsg: 'the fixer and reviewer are deadlocked',
    });

    state.reviewRound += 1;
    saveState(state);

    log.step(`Fixing ${blockers.length} P1(s)`);
    const fix = await claudeStep(state, cfg, {
      prompt: P.fixPrompt(review.findings, state.reviewRound),
      cwd,
      permissionMode: 'bypassPermissions',
      timeoutMs: cfg.claude.implementTimeoutMs,
      label: `fix-${state.reviewRound}`,
    });
    artifact(state, `fix-report-${state.reviewRound}.md`, fix);
    await maybeCommit(cfg, cwd, `vibe: address review round ${state.reviewRound}`);
  }

  state.status = 'done';
  saveState(state);
  return state;
}

// ---------------------------------------------------------------------------

interface GuardArgs {
  cap: number;
  round: number;
  capName: string;
  deadlockMsg: string;
}

/** Both brakes that stop a loop from running forever on the same disagreement. */
function guardProgress(
  state: RunState,
  cfg: Config,
  all: readonly Finding[],
  blockers: readonly Finding[],
  { cap, round, capName, deadlockMsg }: GuardArgs,
): void {
  const signature = p1Signature(all);
  if (detectOscillation(state, signature, cfg.loop.oscillationThreshold)) {
    throw new Escalation(
      EXIT.NO_CONVERGENCE,
      `The same P1 set came back ${cfg.loop.oscillationThreshold} rounds running - ${deadlockMsg}.`,
      null,
      [...blockers],
    );
  }
  if (round >= cap) {
    throw new Escalation(
      EXIT.NO_CONVERGENCE,
      `Hit ${capName} (${cap}) with ${blockers.length} P1(s) outstanding.`,
      null,
      [...blockers],
    );
  }
}

async function prepareGit(state: RunState, cfg: Config, cwd: string): Promise<void> {
  if (!(await git.isRepo(cwd))) {
    log.warn('Not a git repository - running without branch isolation or commits.');
    return;
  }
  if (await git.isDirty(cwd)) {
    log.warn('Working tree has uncommitted changes; they will be swept into the first commit.');
  }
  if (cfg.git.useBranch) {
    const branch = `${cfg.git.branchPrefix}${state.id}`;
    await git.createBranch(cwd, branch);
    state.branch = branch;
    saveState(state);
    log.ok(`Isolated on branch ${branch}`);
  }
}

async function maybeCommit(cfg: Config, cwd: string, message: string): Promise<void> {
  if (!cfg.git.commitEachRound) return;
  if (!(await git.isRepo(cwd))) return;
  const sha = await git.commitAll(cwd, message);
  if (sha) log.ok(`Committed ${sha}`);
}

interface ClaudeStepArgs {
  prompt: string;
  cwd: string;
  permissionMode: PermissionMode;
  timeoutMs: number;
  label: string;
  jsonSchema?: object | undefined;
  tools?: readonly string[] | undefined;
}

/** Wraps a Claude turn with session rotation, cost accounting and the budget ceiling. */
async function claudeStep(state: RunState, cfg: Config, args: ClaudeStepArgs): Promise<string> {
  // A rotation that could not be overlapped with Codex work happens here, at a
  // turn boundary - never mid-turn.
  if (shouldRotate(state, cfg)) await rotateSession(state, cfg);

  const resume = state.sessionStarted;
  const prompt =
    !resume && state.handoff
      ? P.handoffContext(state.handoff, state.plan?.plan_md ?? null) + args.prompt
      : args.prompt;

  const result = await withRateLimitRetry(state, cfg, args.label, () =>
    claudeTurn({
      prompt,
      sessionId: state.sessionId,
      resume,
      permissionMode: args.permissionMode,
      model: cfg.claude.model,
      effort: cfg.claude.effort,
      cwd: args.cwd,
      jsonSchema: args.jsonSchema,
      tools: args.tools,
      timeoutMs: args.timeoutMs,
    }),
  );

  state.sessionStarted = true;
  state.costUsd = Number((state.costUsd + result.costUsd).toFixed(4));
  state.tokensUsed += result.tokens.total;
  if (result.usage) state.contextRatio = result.usage.ratio;

  recordEvent(state, 'claude_turn', {
    label: args.label,
    costUsd: result.costUsd,
    tokens: result.tokens.total,
    turns: result.numTurns,
    contextRatio: Number(state.contextRatio.toFixed(3)),
  });

  const ctx = result.usage ? `, ctx ${(result.usage.ratio * 100).toFixed(0)}%` : '';
  log.detail(
    `${args.label}: ${fmtTokens(result.tokens.total)} tok, ~$${result.costUsd.toFixed(3)} ` +
      `(run ${fmtTokens(state.tokensUsed)} tok / ~$${state.costUsd.toFixed(2)}${ctx})`,
  );

  if (result.denials.length > 0) log.warn(`${result.denials.length} permission denial(s) in ${args.label}`);

  if (cfg.budget.maxTokens > 0 && state.tokensUsed > cfg.budget.maxTokens) {
    throw new Escalation(
      EXIT.BUDGET,
      `Token ceiling exceeded: ${fmtTokens(state.tokensUsed)} > ${fmtTokens(cfg.budget.maxTokens)}. ` +
        'Raise budget.maxTokens to continue.',
    );
  }
  if (state.costUsd > cfg.budget.maxCostUsd) {
    throw new Escalation(
      EXIT.BUDGET,
      `Work ceiling reached: ~$${state.costUsd.toFixed(2)} API-equivalent > $${cfg.budget.maxCostUsd}. ` +
        'On a subscription this is a volume brake, not a bill. Raise budget.maxCostUsd to continue.',
    );
  }
  return result.text;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/**
 * Wait out a subscription rate limit rather than losing the run to it.
 *
 * This is the ceiling that actually stops long unattended runs on a plan with
 * overage disabled - no charge accrues, requests simply start failing. The wait
 * is capped so a weekly-cap reset cannot hang the process for days; past the cap
 * the run exits resumable.
 */
async function withRateLimitRetry<T>(
  state: RunState,
  cfg: Config,
  label: string,
  work: () => Promise<T>,
): Promise<T> {
  for (;;) {
    try {
      return await work();
    } catch (err) {
      if (!(err instanceof RateLimitError)) throw err;

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
      recordEvent(state, 'rate_limited', { label, waitMs, resetsAt: err.resetsAt?.toISOString() ?? null });
      log.warn(`Rate limited during "${label}". ${describeReset(err)} Waiting ${minutes} min.`);
      await sleep(waitMs);
      log.step(`Resuming "${label}" after rate-limit wait`);
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function runPlan(state: RunState, cfg: Config, cwd: string): Promise<Plan> {
  log.step('Claude is planning (read-only)');
  const text = await claudeStep(state, cfg, {
    prompt: P.planPrompt(state.task, state.extraContext),
    cwd,
    permissionMode: 'plan',
    tools: PLAN_TOOLS,
    jsonSchema: PLAN_SCHEMA,
    timeoutMs: cfg.claude.planTimeoutMs,
    label: 'plan',
  });

  const plan = parsePlan(parseStructured(text));
  state.plan = plan;
  saveState(state);
  artifact(state, `plan-${state.planRound}.json`, plan);
  log.ok(
    `Plan drafted - ${plan.assumptions.length} assumption(s), ${plan.open_questions.length} open question(s)`,
  );
  return plan;
}

interface ReviseArgs {
  findings?: readonly Finding[] | undefined;
  answers?: readonly Answer[] | undefined;
}

async function revisePlan(state: RunState, cfg: Config, cwd: string, args: ReviseArgs): Promise<Plan> {
  state.planRound += 1;
  saveState(state);
  log.step(`Claude is revising the plan (round ${state.planRound})`);

  const text = await claudeStep(state, cfg, {
    prompt: P.revisePlanPrompt({
      findings: args.findings,
      answers: args.answers,
      round: state.planRound,
    }),
    cwd,
    permissionMode: 'plan',
    tools: PLAN_TOOLS,
    jsonSchema: PLAN_SCHEMA,
    timeoutMs: cfg.claude.planTimeoutMs,
    label: `revise-${state.planRound}`,
  });

  const plan = parsePlan(parseStructured(text));
  state.plan = plan;
  saveState(state);
  artifact(state, `plan-${state.planRound}.json`, plan);
  return plan;
}

/**
 * Every Codex call goes through here so the run keeps a single Codex thread.
 * Continuity matters for the oscillation guard: a stateless reviewer re-derives
 * a still-unresolved issue under a fresh id each round, which reads as progress
 * when it is actually the same objection.
 */
async function runCodex(
  state: RunState,
  cfg: Config,
  cwd: string,
  args: { prompt: string; schemaName: string },
): Promise<unknown> {
  const { structured, sessionId } = await codexTurn({
    prompt: args.prompt,
    schema: args.schemaName.startsWith('answers') ? ANSWERS_SCHEMA : FINDINGS_SCHEMA,
    schemaName: args.schemaName,
    artifactDir: artifactDir(state, 'codex'),
    model: cfg.codex.model,
    effort: cfg.codex.effort,
    sandbox: cfg.codex.sandbox,
    cwd,
    timeoutMs: cfg.codex.timeoutMs,
    sessionId: cfg.codex.persistSession ? state.codexSessionId : null,
  });

  if (cfg.codex.persistSession && sessionId && sessionId !== state.codexSessionId) {
    const isFirst = state.codexSessionId === null;
    state.codexSessionId = sessionId;
    saveState(state);
    if (isFirst) log.detail(`codex thread ${sessionId}`);
  }
  return structured;
}

function codexHasMemory(state: RunState, cfg: Config): boolean {
  return cfg.codex.persistSession && state.codexSessionId !== null;
}

async function runCritique(
  state: RunState,
  cfg: Config,
  cwd: string,
  plan: Plan,
): Promise<FindingsReport> {
  log.step('Codex is critiquing the plan');
  const structured = await runCodex(state, cfg, cwd, {
    prompt: P.critiquePrompt(
      plan.plan_md,
      plan.assumptions,
      state.planRound + 1,
      codexHasMemory(state, cfg),
    ),
    schemaName: `critique-${state.planRound}`,
  });
  return parseFindings(structured);
}

async function runReview(
  state: RunState,
  cfg: Config,
  cwd: string,
  plan: Plan,
): Promise<FindingsReport> {
  log.step('Codex is reviewing the implementation');
  const diff = await git.diffSince(cwd, state.baseSha);
  const files = await git.changedFiles(cwd, state.baseSha);

  const structured = await runCodex(state, cfg, cwd, {
    prompt: P.reviewPrompt(
      diff,
      files,
      plan.plan_md,
      state.reviewRound + 1,
      codexHasMemory(state, cfg),
    ),
    schemaName: `review-${state.reviewRound}`,
  });
  return parseFindings(structured);
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
): Promise<Answer[]> {
  const blockingCount = questions.filter((q) => q.blocking).length;
  log.heading(
    `${questions.length} open question(s) - ${blockingCount} blocking, ${questions.length - blockingCount} advisory`,
  );
  for (const q of questions) log.info(`- [${q.kind}${q.blocking ? ', blocking' : ''}] ${q.question}`);

  if (!cfg.questions.askCodex) {
    const blockers = questions.filter((q) => q.blocking);
    if (blockers.length === 0) return [];
    throw new Escalation(EXIT.NEEDS_HUMAN, 'Blocking questions need answers.', [...blockers]);
  }

  log.step('Codex is answering');
  const structured = await runCodex(state, cfg, cwd, {
    prompt: P.answerPrompt(questions, plan.plan_md),
    schemaName: `answers-${state.planRound}`,
  });

  const { answers } = parseAnswers(structured);
  artifact(state, `answers-${state.planRound}.json`, answers);

  // Every question asked is marked answered regardless of outcome, so a
  // rephrased repeat in the next revision cannot re-enter this branch.
  for (const q of questions) markAnswered(state, q.question);
  for (const a of answers) markAnswered(state, a.question);

  const declined = (a: Answer): boolean =>
    (cfg.questions.escalateOnDefer && a.defer_to_human) ||
    (cfg.questions.escalateOnLowConfidence && a.confidence === 'low');

  const usable = answers.filter((a) => !declined(a));
  const refused = answers.filter(declined);

  const matches = (q: OpenQuestion, a: Answer): boolean => a.question.trim() === q.question.trim();
  const refusedBlocking = questions.filter((q) => q.blocking && refused.some((a) => matches(q, a)));
  const refusedAdvisory = questions.filter((q) => !q.blocking && refused.some((a) => matches(q, a)));

  for (const q of refusedAdvisory) {
    const reason = refused.find((a) => matches(q, a))?.rationale ?? 'Codex declined to answer.';
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
      `${refusedBlocking.length} blocking question(s) need you - Codex declined to guess at product intent.`,
      refusedBlocking,
    );
  }

  log.ok(`Codex answered ${usable.length} of ${questions.length} question(s)`);
  return usable;
}

const normalize = (s: string): string => s.toLowerCase().replace(/\W+/g, ' ').trim();

function markAnswered(state: RunState, question: string): void {
  const key = normalize(question);
  if (key && !state.answeredQuestions.includes(key)) state.answeredQuestions.push(key);
  saveState(state);
}

function isAnswered(state: RunState, question: string): boolean {
  return state.answeredQuestions.includes(normalize(question));
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
      lines.push(`*Claude would default to:* ${q.recommended}`);
      lines.push('\n**Your answer:**\n\n> \n');
    });
  }

  if (escalation.findings && escalation.findings.length > 0) {
    lines.push('## Outstanding P1 findings\n');
    for (const f of escalation.findings) {
      lines.push(`### ${f.title} \`${f.id}\`\n${f.detail}\n\n*Suggested fix:* ${f.suggested_fix}\n`);
    }
  }

  return artifact(state, 'NEEDS-INPUT.md', lines.join('\n'));
}
