import { readFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { EFFORTS, loadConfig } from '@src/config.js';
import { artifact, createRun, listRuns, loadRun, recordEvent, saveState } from '@src/run.js';
import { Escalation, EXIT, orchestrate, writeEscalation } from '@src/orchestrator.js';
import type { ExitCode } from '@src/orchestrator.js';
import { claudeBin } from '@src/claude.js';
import { codexBin } from '@src/codex.js';
import * as git from '@src/git.js';
import * as log from '@src/log.js';
import type { Answer, Config, ConfigOverrides, Effort, RunState } from '@src/types.js';

const USAGE = `
vibe - automated plan/critique/implement/review loop (Claude Code + Codex)

Usage
  vibe run "<task>" [options]      Plan, critique to zero P1s, implement, review to zero P1s
  vibe plan "<task>" [options]     Stop after the plan is approved; do not implement
  vibe resume <run-id>             Continue a run that stopped for input
  vibe list                        Show runs in this repo
  vibe doctor                      Verify both CLIs and the environment

Options
  -C, --cwd <dir>            Target repository (default: cwd)
  --context <file>           Extra context file appended to the planning prompt
  --claude-model <m>         Default: opus
  --claude-effort <e>        low|medium|high|xhigh|max (default: medium)
  --codex-model <m>          Default: gpt-5.6-luna
  --codex-effort <e>         Default: xhigh
  --max-plan-rounds <n>      Default: 5
  --max-review-rounds <n>    Default: 5
  --budget <usd>             Work ceiling, API-equivalent (default: 25; not a bill on a plan)
  --max-tokens <n>           Cumulative Claude token ceiling (0 = off)
  --no-wait-on-limit         Exit on a rate limit instead of waiting for the reset
  --compact-above <ratio>    Rotate the Claude session above this context share (default: 0.5)
  --no-compact               Never rotate the session
  --no-branch                Do not create an isolated branch
  --no-codex-answers         Escalate every blocking question straight to you
  --blocking-questions-only  Only send Codex the questions marked blocking
  --no-codex-session         Run each Codex turn as a fresh one-shot (no memory)
  -h, --help

Exit codes
  0 done   1 error   2 needs your input   3 no convergence   4 ceiling hit   5 rate limited
`;

interface ParsedArgs {
  positional: string[];
  flags: {
    cwd?: string;
    context?: string;
    claudeModel?: string;
    claudeEffort?: string;
    codexModel?: string;
    codexEffort?: string;
    maxPlanRounds?: number;
    maxReviewRounds?: number;
    budget?: number;
    maxTokens?: number;
    noWaitOnLimit?: boolean;
    compactAbove?: number;
    noCompact?: boolean;
    noBranch?: boolean;
    noCodexAnswers?: boolean;
    noCodexSession?: boolean;
    blockingQuestionsOnly?: boolean;
    help?: boolean;
  };
}

export async function main(argv: readonly string[]): Promise<ExitCode> {
  const cmd = argv[0];
  if (cmd === undefined || cmd === '-h' || cmd === '--help') {
    console.log(USAGE);
    return EXIT.OK;
  }

  try {
    switch (cmd) {
      case 'run':
        return await cmdRun(argv.slice(1), false);
      case 'plan':
        return await cmdRun(argv.slice(1), true);
      case 'resume':
        return await cmdResume(argv.slice(1));
      case 'list':
        return cmdList(argv.slice(1));
      case 'doctor':
        return await cmdDoctor(argv.slice(1));
      default:
        log.fail(`Unknown command "${cmd}"`);
        console.log(USAGE);
        return EXIT.ERROR;
    }
  } catch (err) {
    log.fail(err instanceof Error ? err.message : String(err));
    return EXIT.ERROR;
  }
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { positional: [], flags: {} };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (!a.startsWith('-')) {
      out.positional.push(a);
      continue;
    }

    const next = (): string => {
      const v = args[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    const nextNum = (): number => {
      const raw = next();
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${a} must be a number, got "${raw}"`);
      return n;
    };

    switch (a) {
      case '-C':
      case '--cwd': out.flags.cwd = next(); break;
      case '--context': out.flags.context = next(); break;
      case '--claude-model': out.flags.claudeModel = next(); break;
      case '--claude-effort': out.flags.claudeEffort = next(); break;
      case '--codex-model': out.flags.codexModel = next(); break;
      case '--codex-effort': out.flags.codexEffort = next(); break;
      case '--max-plan-rounds': out.flags.maxPlanRounds = nextNum(); break;
      case '--max-review-rounds': out.flags.maxReviewRounds = nextNum(); break;
      case '--budget': out.flags.budget = nextNum(); break;
      case '--max-tokens': out.flags.maxTokens = nextNum(); break;
      case '--no-wait-on-limit': out.flags.noWaitOnLimit = true; break;
      case '--compact-above': out.flags.compactAbove = nextNum(); break;
      case '--no-compact': out.flags.noCompact = true; break;
      case '--no-branch': out.flags.noBranch = true; break;
      case '--no-codex-answers': out.flags.noCodexAnswers = true; break;
      case '--no-codex-session': out.flags.noCodexSession = true; break;
      case '--blocking-questions-only': out.flags.blockingQuestionsOnly = true; break;
      case '-h':
      case '--help': out.flags.help = true; break;
      default: throw new Error(`Unknown option "${a}"`);
    }
  }
  return out;
}

function asEffort(value: string, flagName: string): Effort {
  if (!(EFFORTS as readonly string[]).includes(value)) {
    throw new Error(`${flagName} must be one of ${EFFORTS.join(', ')}`);
  }
  return value as Effort;
}

function buildOverrides(flags: ParsedArgs['flags']): ConfigOverrides {
  const claude: Partial<Config['claude']> = {};
  const codex: Partial<Config['codex']> = {};
  const loop: Partial<Config['loop']> = {};
  const budget: Partial<Config['budget']> = {};
  const gitCfg: Partial<Config['git']> = {};
  const questions: Partial<Config['questions']> = {};
  const context: Partial<Config['context']> = {};

  if (flags.claudeModel !== undefined) claude.model = flags.claudeModel;
  if (flags.claudeEffort !== undefined) claude.effort = asEffort(flags.claudeEffort, '--claude-effort');
  if (flags.codexModel !== undefined) codex.model = flags.codexModel;
  if (flags.codexEffort !== undefined) codex.effort = asEffort(flags.codexEffort, '--codex-effort');
  if (flags.maxPlanRounds !== undefined) loop.maxPlanRounds = flags.maxPlanRounds;
  if (flags.maxReviewRounds !== undefined) loop.maxReviewRounds = flags.maxReviewRounds;
  if (flags.budget !== undefined) budget.maxCostUsd = flags.budget;
  if (flags.maxTokens !== undefined) budget.maxTokens = flags.maxTokens;
  if (flags.noWaitOnLimit) budget.waitOnRateLimit = false;
  if (flags.compactAbove !== undefined) context.compactAboveRatio = flags.compactAbove;
  if (flags.noCompact) context.enabled = false;
  if (flags.noBranch) gitCfg.useBranch = false;
  if (flags.noCodexAnswers) questions.askCodex = false;
  if (flags.noCodexSession) codex.persistSession = false;
  if (flags.blockingQuestionsOnly) questions.answerNonBlocking = false;

  return { claude, codex, loop, budget, git: gitCfg, questions, context };
}

async function cmdRun(args: readonly string[], planOnly: boolean): Promise<ExitCode> {
  const { positional, flags } = parseArgs(args);
  if (flags.help) {
    console.log(USAGE);
    return EXIT.OK;
  }

  const task = positional.join(' ').trim();
  if (!task) {
    log.fail('A task description is required.');
    console.log(USAGE);
    return EXIT.ERROR;
  }

  const targetDir = path.resolve(flags.cwd ?? process.cwd());
  const cfg = loadConfig(targetDir, buildOverrides(flags));
  const state = createRun(targetDir, task, planOnly);

  if (flags.context !== undefined) {
    const file = path.resolve(flags.context);
    if (!existsSync(file)) {
      log.fail(`Context file not found: ${file}`);
      return EXIT.ERROR;
    }
    state.extraContext = readFileSync(file, 'utf8');
  }
  saveState(state);

  log.attachTranscript(path.join(state.dir, 'transcript.log'));
  log.heading(`Run ${state.id}`);
  log.info(`Repo:    ${targetDir}`);
  log.info(`Claude:  ${cfg.claude.model} / ${cfg.claude.effort}`);
  log.info(
    `Codex:   ${cfg.codex.model} / ${cfg.codex.effort}` +
      `${cfg.codex.persistSession ? ' (single thread)' : ' (one-shot per turn)'}`,
  );
  log.info(
    `Ceiling: ~$${cfg.budget.maxCostUsd} API-equivalent` +
      `${cfg.budget.maxTokens > 0 ? ` / ${cfg.budget.maxTokens.toLocaleString()} tokens` : ''}` +
      ` (Claude side; on a subscription this is a volume brake, not a bill)`,
  );
  log.info(
    `Limits:  ${cfg.budget.waitOnRateLimit ? `wait up to ${cfg.budget.maxWaitMinutes} min for a rate-limit reset` : 'exit on rate limit'}`,
  );
  log.info(
    `Compact: ${cfg.context.enabled ? `above ${(cfg.context.compactAboveRatio * 100).toFixed(0)}% context` : 'disabled'}`,
  );
  // `codex exec resume` takes no -s flag and defaults to read-only, so a
  // non-default sandbox would silently apply to the first turn only.
  if (cfg.codex.persistSession && cfg.codex.sandbox !== 'read-only') {
    log.warn(
      `codex.sandbox "${cfg.codex.sandbox}" applies only to the first Codex turn; ` +
        'resumed turns are read-only. Use --no-codex-session for a uniform sandbox.',
    );
  }

  return execute(state, cfg, false);
}

async function cmdResume(args: readonly string[]): Promise<ExitCode> {
  const { positional, flags } = parseArgs(args);
  if (flags.help) {
    console.log(USAGE);
    return EXIT.OK;
  }

  const targetDir = path.resolve(flags.cwd ?? process.cwd());
  const id = positional[0];
  if (id === undefined) {
    log.fail('A run id is required. See "vibe list".');
    return EXIT.ERROR;
  }

  const state = loadRun(targetDir, id);
  const cfg = loadConfig(targetDir, buildOverrides(flags));
  log.attachTranscript(path.join(state.dir, 'transcript.log'));

  const answersFile = path.join(state.dir, 'NEEDS-INPUT.md');
  if (existsSync(answersFile)) {
    const answers = parseHumanAnswers(readFileSync(answersFile, 'utf8'));
    if (answers.length === 0) {
      log.fail(`No answers found in ${answersFile}`);
      log.info('Fill in the "**Your answer:**" blocks (replace the empty "> " line), then resume.');
      return EXIT.NEEDS_HUMAN;
    }
    log.ok(`Picked up ${answers.length} answer(s) from NEEDS-INPUT.md`);
    state.pendingAnswers = answers;
    saveState(state);
    // Retire the file so a later escalation writes a fresh one and these
    // answers are not silently replayed.
    renameSync(answersFile, path.join(state.dir, `answered-${state.planRound}.md`));
  }

  log.heading(`Resuming ${state.id}`);
  return execute(state, cfg, true);
}

/**
 * Answers live under "**Your answer:**" as blockquote lines. The template ships
 * an empty "> " so an untouched file is distinguishable from a real answer.
 */
export function parseHumanAnswers(md: string): Answer[] {
  const answers: Answer[] = [];
  const marker = '**Your answer:**';

  for (const block of md.split(/^### /m).slice(1)) {
    const firstLine = block.split('\n')[0] ?? '';
    const question = firstLine.replace(/^\d+\.\s*/, '').trim();
    const idx = block.indexOf(marker);
    if (idx === -1) continue;

    const text = block
      .slice(idx + marker.length)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('>'))
      .map((l) => l.replace(/^>\s?/, '').trim())
      .join(' ')
      .trim();

    if (text) {
      answers.push({
        question,
        answer: text,
        confidence: 'high',
        defer_to_human: false,
        rationale: 'Answered by the user.',
      });
    }
  }
  return answers;
}

async function execute(state: RunState, cfg: Config, resume: boolean): Promise<ExitCode> {
  const started = Date.now();
  try {
    await orchestrate(state, cfg, resume);
    log.heading('Done');
    log.ok(
      state.planOnly
        ? 'Plan cleared critique with zero P1s. Not implemented (plan-only run).'
        : 'Plan and implementation both cleared review with zero P1s.',
    );
    reportDeferred(state);
    summary(state, started);
    return EXIT.OK;
  } catch (err) {
    if (err instanceof Escalation) {
      state.status = err.code === EXIT.NEEDS_HUMAN ? 'needs-input' : 'stalled';
      saveState(state);
      recordEvent(state, 'escalation', { code: err.code, message: err.message });
      const file = writeEscalation(state, err);
      log.heading('Stopped for input');
      log.warn(err.message);
      log.info(`Details: ${file}`);
      log.info(`Resume:  vibe resume ${state.id}`);
      summary(state, started);
      return err.code;
    }
    state.status = 'error';
    saveState(state);
    recordEvent(state, 'error', { message: err instanceof Error ? err.message : String(err) });
    log.heading('Failed');
    log.fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
    summary(state, started);
    return EXIT.ERROR;
  }
}

/**
 * Advisory questions Codex declined ran on the planner's guess. That is a
 * deliberate choice, not a silent one - it gets reported every time.
 */
function reportDeferred(state: RunState): void {
  if (state.deferredQuestions.length === 0) return;

  const lines: string[] = [
    '# Questions answered by assumption\n',
    `**Run:** \`${state.id}\``,
    '',
    'Codex declined these and they were not blocking, so the run continued on the',
    "planner's fallback. Nothing is wrong with the run - but these are the points",
    'where the result rests on a guess rather than a decision.\n',
  ];
  for (const [i, q] of state.deferredQuestions.entries()) {
    lines.push(`### ${i + 1}. ${q.question}`);
    lines.push(`*Kind:* ${q.kind}`);
    lines.push(`*Proceeded with:* ${q.recommended}`);
    lines.push(`*Why Codex declined:* ${q.reason}\n`);
  }
  const file = artifact(state, 'ASSUMED.md', lines.join('\n'));

  log.warn(`${state.deferredQuestions.length} question(s) ran on the planner's default:`);
  for (const q of state.deferredQuestions) log.info(`  - ${q.question}`);
  log.info(`  Detail: ${file}`);
}

function summary(state: RunState, started: number): void {
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  log.info(`Run:      ${state.id}  (${state.status})`);
  log.info(
    `Work:     ${state.tokensUsed.toLocaleString()} Claude tokens ` +
      `(~$${state.costUsd.toFixed(2)} API-equivalent), ${mins} min`,
  );
  if (state.rateLimitWaits > 0) log.info(`Waits:    ${state.rateLimitWaits} rate-limit pause(s)`);
  log.info(`Rounds:   ${state.planRound} plan revision(s), ${state.reviewRound} fix round(s)`);
  if (state.sessionRotations > 0) log.info(`Compacted: ${state.sessionRotations} time(s)`);
  if (state.branch) log.info(`Branch:   ${state.branch}`);
  log.info(`Files:    ${state.dir}`);
}

function cmdList(args: readonly string[]): ExitCode {
  const { flags } = parseArgs(args);
  const targetDir = path.resolve(flags.cwd ?? process.cwd());
  const runs = listRuns(targetDir);

  if (runs.length === 0) {
    log.info('No runs yet.');
    return EXIT.OK;
  }
  log.heading(`Runs in ${targetDir}`);
  for (const r of runs) {
    console.log(`  ${r.id.padEnd(52)} ${r.status.padEnd(12)} $${r.costUsd.toFixed(2)}`);
    console.log(log.dim(`    ${r.task}`));
  }
  return EXIT.OK;
}

async function cmdDoctor(args: readonly string[]): Promise<ExitCode> {
  const { flags } = parseArgs(args);
  const targetDir = path.resolve(flags.cwd ?? process.cwd());
  log.heading('vibe doctor');

  let bad = 0;
  const check = (label: string, fn: () => string): void => {
    try {
      log.ok(`${label}: ${fn()}`);
    } catch (err) {
      log.fail(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      bad++;
    }
  };

  check('node', () => process.version);
  check('claude', claudeBin);
  check('codex', codexBin);
  check('git', git.gitBin);

  try {
    const cfg = loadConfig(targetDir);
    log.ok(`config: ${cfg.configPath ?? 'defaults'}`);
    log.info(`  claude ${cfg.claude.model}/${cfg.claude.effort} - codex ${cfg.codex.model}/${cfg.codex.effort}`);
    log.info(
      `  budget $${cfg.budget.maxCostUsd} - plan rounds ${cfg.loop.maxPlanRounds} - review rounds ${cfg.loop.maxReviewRounds}`,
    );
    log.info(
      `  compaction ${cfg.context.enabled ? `above ${(cfg.context.compactAboveRatio * 100).toFixed(0)}%` : 'off'}` +
        `${cfg.context.compactDuringCodex ? ' (overlapped with Codex)' : ''}`,
    );
  } catch (err) {
    log.fail(`config: ${err instanceof Error ? err.message : String(err)}`);
    bad++;
  }

  if (await git.isRepo(targetDir)) {
    log.ok(`git repo: ${targetDir} (branch ${await git.currentBranch(targetDir)})`);
    if (await git.isDirty(targetDir)) log.warn('working tree is dirty');
  } else {
    log.warn(`not a git repository: ${targetDir} - no branch isolation or commits`);
  }

  return bad > 0 ? EXIT.ERROR : EXIT.OK;
}
