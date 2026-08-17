import { readFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { applyOverrides, EFFORTS, loadConfig } from '@src/config.js';
import { artifact, createRun, listRuns, loadRun, recordEvent, saveState } from '@src/run.js';
import { Escalation, EXIT, orchestrate, writeEscalation } from '@src/orchestrator.js';
import type { ExitCode } from '@src/orchestrator.js';
import { claudeBin, setSessionArgs } from '@src/claude.js';
import { codexBin } from '@src/codex.js';
import { preflight } from '@src/preflight.js';
import { detectCommand } from '@src/verify.js';
import type { AgentPreflight } from '@src/preflight.js';
import * as git from '@src/git.js';
import * as log from '@src/log.js';
import type { EnvironmentFacts, Phase } from '@src/runtime.js';
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
  --max-verify-rounds <n>    Fix rounds for a failing verification (default: 3)
  --max-question-rounds <n>  Planner self-answer rounds before asking you (default: 3)
  --p1-tolerance <n>         P1s a phase may carry forward rather than fix (default: 1;
                             0 demands a spotless verdict. P0s are never carried)
  --plan-timeout <min>       Per planning turn (default: 30)
  --implement-timeout <min>  Per implement/fix turn (default: 90)
  --codex-timeout <min>      Per Codex turn (default: 45)
  --verify-timeout <min>     Per verification command run (default: 15)
  --budget <usd>             Work ceiling, API-equivalent (default: 25; not a bill on a plan)
  --max-tokens <n>           Cumulative Claude token ceiling (0 = off)
  --no-wait-on-limit         Exit on a rate limit instead of waiting for the reset
  --compact-above <ratio>    Rotate the Claude session above this context share (default: 0.5)
  --no-compact               Never rotate the session
  --no-branch                Do not create an isolated branch
  --no-codex-answers         Escalate every blocking question straight to you
  --blocking-questions-only  Only send Codex the questions marked blocking
  --no-codex-session         Run each Codex turn as a fresh one-shot (no memory)
  --verify-command <cmd>     Verification command (default: auto-detect, e.g. npm test)
  --verify-runs <n>          Times it must pass (default: 3; catches races)
  --no-verify                Do not run the verification gate
  --skip-probe               Skip the agent environment preflight
  -h, --help

Exit codes
  0 done   1 error   2 needs your input   3 no convergence   4 ceiling hit
  5 rate limited   6 agent environment fails the toolchain contract
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
    maxVerifyRounds?: number;
    maxQuestionRounds?: number;
    p1Tolerance?: number;
    budget?: number;
    maxTokens?: number;
    noWaitOnLimit?: boolean;
    compactAbove?: number;
    noCompact?: boolean;
    noBranch?: boolean;
    noCodexAnswers?: boolean;
    noCodexSession?: boolean;
    blockingQuestionsOnly?: boolean;
    skipProbe?: boolean;
    noVerify?: boolean;
    verifyCommand?: string;
    verifyRuns?: number;
    planTimeout?: number;
    implementTimeout?: number;
    codexTimeout?: number;
    verifyTimeout?: number;
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
      case '--max-verify-rounds': out.flags.maxVerifyRounds = nextNum(); break;
      case '--max-question-rounds': out.flags.maxQuestionRounds = nextNum(); break;
      case '--p1-tolerance': out.flags.p1Tolerance = nextNum(); break;
      case '--budget': out.flags.budget = nextNum(); break;
      case '--max-tokens': out.flags.maxTokens = nextNum(); break;
      case '--no-wait-on-limit': out.flags.noWaitOnLimit = true; break;
      case '--compact-above': out.flags.compactAbove = nextNum(); break;
      case '--no-compact': out.flags.noCompact = true; break;
      case '--no-branch': out.flags.noBranch = true; break;
      case '--no-codex-answers': out.flags.noCodexAnswers = true; break;
      case '--no-codex-session': out.flags.noCodexSession = true; break;
      case '--blocking-questions-only': out.flags.blockingQuestionsOnly = true; break;
      case '--skip-probe': out.flags.skipProbe = true; break;
      case '--no-verify': out.flags.noVerify = true; break;
      case '--verify-command': out.flags.verifyCommand = next(); break;
      case '--verify-runs': out.flags.verifyRuns = nextNum(); break;
      case '--plan-timeout': out.flags.planTimeout = nextNum(); break;
      case '--implement-timeout': out.flags.implementTimeout = nextNum(); break;
      case '--codex-timeout': out.flags.codexTimeout = nextNum(); break;
      case '--verify-timeout': out.flags.verifyTimeout = nextNum(); break;
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
  const verify: Partial<Config['verify']> = {};

  if (flags.claudeModel !== undefined) claude.model = flags.claudeModel;
  if (flags.claudeEffort !== undefined) claude.effort = asEffort(flags.claudeEffort, '--claude-effort');
  if (flags.codexModel !== undefined) codex.model = flags.codexModel;
  if (flags.codexEffort !== undefined) codex.effort = asEffort(flags.codexEffort, '--codex-effort');
  if (flags.maxPlanRounds !== undefined) loop.maxPlanRounds = flags.maxPlanRounds;
  if (flags.maxReviewRounds !== undefined) loop.maxReviewRounds = flags.maxReviewRounds;
  if (flags.maxVerifyRounds !== undefined) loop.maxVerifyRounds = flags.maxVerifyRounds;
  if (flags.maxQuestionRounds !== undefined) loop.maxQuestionRounds = flags.maxQuestionRounds;
  if (flags.p1Tolerance !== undefined) loop.p1Tolerance = flags.p1Tolerance;
  if (flags.budget !== undefined) budget.maxCostUsd = flags.budget;
  if (flags.maxTokens !== undefined) budget.maxTokens = flags.maxTokens;
  if (flags.noWaitOnLimit) budget.waitOnRateLimit = false;
  if (flags.compactAbove !== undefined) context.compactAboveRatio = flags.compactAbove;
  if (flags.noCompact) context.enabled = false;
  if (flags.noBranch) gitCfg.useBranch = false;
  if (flags.noCodexAnswers) questions.askCodex = false;
  if (flags.noCodexSession) codex.persistSession = false;
  if (flags.blockingQuestionsOnly) questions.answerNonBlocking = false;
  if (flags.noVerify) verify.enabled = false;
  if (flags.verifyCommand !== undefined) verify.command = flags.verifyCommand;
  if (flags.verifyRuns !== undefined) verify.runs = flags.verifyRuns;
  // Timeouts are given in minutes: the config stores milliseconds, which is a
  // poor unit to type on a command line.
  if (flags.planTimeout !== undefined) claude.planTimeoutMs = flags.planTimeout * 60_000;
  if (flags.implementTimeout !== undefined) claude.implementTimeoutMs = flags.implementTimeout * 60_000;
  if (flags.codexTimeout !== undefined) codex.timeoutMs = flags.codexTimeout * 60_000;
  if (flags.verifyTimeout !== undefined) verify.timeoutMs = flags.verifyTimeout * 60_000;

  return { claude, codex, loop, budget, git: gitCfg, questions, context, verify };
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
  // Persist the effective settings so resume continues on them.
  state.config = cfg;
  saveState(state);

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

  return execute(state, cfg, false, flags.skipProbe === true);
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
  // The run's own settings are the base, so a resumed run continues on the
  // model and effort it started with. Flags given now still win.
  const stored = state.config;
  const cfg =
    stored === undefined
      ? loadConfig(targetDir, buildOverrides(flags))
      : applyOverrides(stored, buildOverrides(flags));
  if (stored !== undefined) {
    log.detail(`resuming with the run's settings: claude ${cfg.claude.model}/${cfg.claude.effort}`);
  }
  log.attachTranscript(path.join(state.dir, 'transcript.log'));

  const answersFile = path.join(state.dir, 'NEEDS-INPUT.md');
  if (existsSync(answersFile)) {
    const raw = readFileSync(answersFile, 'utf8');
    // A round-cap or oscillation stall writes the same filename but reports
    // findings rather than questions. Demanding answers there made those runs
    // unresumable: there was nothing to answer, and the only way forward was
    // to delete the file by hand.
    if (!raw.includes('**Your answer:**')) {
      log.info('Previous stop reported findings, not questions - continuing with raised limits.');
      renameSync(answersFile, path.join(state.dir, `stalled-${state.planRound}.md`));
      log.heading(`Resuming ${state.id}`);
      return execute(state, cfg, true, flags.skipProbe === true);
    }

    const answers = parseHumanAnswers(raw);
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
  return execute(state, cfg, true, flags.skipProbe === true);
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

async function execute(
  state: RunState,
  cfg: Config,
  resume: boolean,
  skipProbe = false,
): Promise<ExitCode> {
  const started = Date.now();

  if (!skipProbe) {
    const gate = await runPreflight(state, cfg);
    if (gate !== null) return gate;
  }

  try {
    await orchestrate(state, cfg, resume);
    log.heading('Done');
    // Never claim a spotless finish when a P1 was carried. The tolerance lets a
    // run complete with findings outstanding; reporting that as "zero P1s"
    // would contradict the OUTSTANDING.md written moments earlier, and a
    // summary a user cannot trust is worse than no summary.
    const left = state.outstanding ?? [];
    if (left.length > 0) {
      log.warn(
        `Finished after a final fix round for ${left.length} carried P1(s): ` +
          `${left.map((f) => f.id).join(', ')}. Verification passed, but that round was not ` +
          're-reviewed - see OUTSTANDING.md.',
      );
    } else {
      log.ok(
        state.planOnly
          ? 'Plan cleared critique with zero P1s. Not implemented (plan-only run).'
          : 'Plan and implementation both cleared review with zero P1s.',
      );
    }
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

/** Flatten a preflight report into the facts the prompts state. */
function environmentFacts(
  report: Awaited<ReturnType<typeof preflight>>,
  cfg: Config,
  targetDir: string,
): EnvironmentFacts {
  const agents: EnvironmentFacts['agents'] = [];
  for (const result of [report.claude, report.codex]) {
    const rt = result.runtime;
    if (rt === null) continue;
    const repaired =
      result.prepared !== null && !result.prepared.mechanisms.includes('none');
    agents.push({
      provider: rt.provider,
      shell: rt.shell,
      pathStyle: rt.pathStyle,
      repaired,
      tools: Object.entries(rt.tools).map(([name, resolution]) => ({
        name,
        // Report the post-repair truth: a tool the repair restored is
        // available to that agent, whatever the pre-repair probe saw.
        available: resolution.available || (repaired && result.violations.length === 0),
        version: resolution.version,
      })),
    });
  }

  return {
    agents,
    verifyCommand: cfg.verify.enabled ? (cfg.verify.command ?? detectCommand(targetDir)) : null,
    verifyRuns: cfg.verify.runs,
  };
}

/**
 * Gate the run on both agents' execution environments.
 *
 * Returns an exit code to stop on, or null to proceed. Deliberately before the
 * first planning token: the failure this replaces cost 35 minutes and surfaced
 * as a plan-stage P1 from the reviewer rather than as an environment error.
 */
async function runPreflight(state: RunState, cfg: Config): Promise<ExitCode | null> {
  const phases: Phase[] = state.planOnly ? ['plan'] : ['plan', 'implement', 'review'];
  log.heading('Preflight');

  let report: Awaited<ReturnType<typeof preflight>>;
  try {
    report = await preflight(state.targetDir, cfg, phases, state.dir);
  } catch (err) {
    log.fail(`environment probe failed: ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.PREFLIGHT;
  }

  for (const [label, result] of [
    ['claude', report.claude],
    ['codex', report.codex],
  ] as const) {
    if (result.runtime === null) continue;
    const repaired =
      result.prepared !== null && !result.prepared.mechanisms.includes('none')
        ? ` (repaired via ${result.prepared.mechanisms.join(' + ')})`
        : '';
    log.info(`${label}: ${result.runtime.shell} / ${result.runtime.pathStyle} paths${repaired}`);
  }
  for (const warning of report.warnings) log.warn(warning);

  if (report.ok) {
    // Carry the repair into every turn of the run, not just the probe turns
    // preflight issued itself.
    const repairArgs = report.claude.prepared?.extraArgs ?? [];
    setSessionArgs(repairArgs);
    // Hand both agents what was actually observed, so neither has to guess at
    // the other's environment from its own.
    state.environment = environmentFacts(report, cfg, state.targetDir);
    saveState(state);
    if (repairArgs.length > 0) log.info('Environment repair will be applied to every Claude turn');
    log.ok('Toolchain contract satisfied');
    recordEvent(state, 'preflight-ok', { repairArgs: repairArgs.length > 0 });
    return null;
  }

  for (const reason of report.blockingReasons) log.fail(reason);
  state.status = 'error';
  saveState(state);
  recordEvent(state, 'preflight-failed', { reasons: report.blockingReasons });
  log.info('Fix the environment, or re-run with --skip-probe to proceed anyway.');
  return EXIT.PREFLIGHT;
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

/** One line of runtime facts per agent, then its tool results. */
function reportAgent(label: string, result: AgentPreflight): void {
  if (result.runtime === null) {
    log.fail(`${label}: probe failed - ${result.probeError ?? 'unknown error'}`);
    return;
  }
  const rt = result.runtime;
  log.ok(`${label}: ${rt.shell} / ${rt.pathStyle} paths / ${rt.platform}`);

  // The snapshot is the *pre-repair* environment. Where a repair was applied
  // and verified, report the tool as fixed rather than as the failure it was -
  // otherwise a healthy run prints a screen of FAILs under an OK heading.
  const repaired =
    result.prepared !== null &&
    !result.prepared.mechanisms.includes('none') &&
    result.violations.length === 0 &&
    result.probeError === null;

  for (const [tool, resolution] of Object.entries(rt.tools)) {
    const status = resolution.available ? 'OK  ' : repaired ? 'FIXED' : 'FAIL';
    const detail = resolution.available
      ? (resolution.version ?? 'ok')
      : repaired
        ? 'was unavailable; repaired'
        : (resolution.failure ?? 'not available');
    log.info(`  ${status.padEnd(5)} ${tool.padEnd(6)} ${detail}`);
  }
  if (result.prepared !== null && !result.prepared.mechanisms.includes('none')) {
    log.info(`  repaired via ${result.prepared.mechanisms.join(' + ')}`);
  }
  if (result.probeError !== null) log.warn(`  ${result.probeError}`);
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

  // vibe's own process, labelled as such. An earlier version checked only this
  // and reported a healthy environment while the agents' shells could not run
  // node at all - the two are unrelated, and conflating them hid the failure.
  check('vibe host node', () => process.version);
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
    if (cfg.verify.enabled) {
      const cmd = cfg.verify.command ?? detectCommand(targetDir);
      log.info(
        cmd === null
          ? '  verify: enabled but no command configured or detected - runs will not be gated'
          : `  verify: ${cmd} (must pass ${cfg.verify.runs}x)`,
      );
    } else {
      log.info('  verify: off - the loop will not check that the code runs');
    }
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

  if (flags.skipProbe === true) {
    log.info('agent environments: skipped (--skip-probe)');
    return bad > 0 ? EXIT.ERROR : EXIT.OK;
  }

  log.heading('agent environments');
  try {
    const cfg = loadConfig(targetDir);
    const report = await preflight(
      targetDir,
      cfg,
      ['plan', 'implement', 'review'],
      path.join(targetDir, '.vibe'),
    );
    reportAgent('claude', report.claude);
    reportAgent('codex', report.codex);

    for (const warning of report.warnings) log.warn(warning);
    for (const reason of report.blockingReasons) {
      log.fail(reason);
      bad++;
    }
    if (report.ok) log.ok('both agents satisfy the toolchain contract');
  } catch (err) {
    log.fail(`agent probe: ${err instanceof Error ? err.message : String(err)}`);
    bad++;
  }

  return bad > 0 ? EXIT.ERROR : EXIT.OK;
}
