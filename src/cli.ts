import { readFileSync, existsSync, renameSync } from 'node:fs';
import path from 'node:path';
import { applyOverrides, configDiff, EFFORTS, loadConfig } from '@src/config.js';
import {
  artifact,
  createRun,
  listRuns,
  loadRun,
  recordEvent,
  saveState,
  unavailableGates,
  verificationCaveat,
  verificationIncomplete,
} from '@src/run.js';
import { Escalation, EXIT, orchestrate, writeEscalation } from '@src/orchestrator.js';
import type { ExitCode } from '@src/orchestrator.js';
import {
  codexConversations,
  DEFAULT_ROLE_PROVIDERS,
  ROLE_NAMES,
  rolesFor,
  roleWarnings,
} from '@src/roles.js';
import { claudeBin, setSessionArgs } from '@src/claude.js';
import { codexBin } from '@src/codex.js';
// The accounting seam, from the leaf it lives in: orchestrator.js re-exports
// applyCharge but not fmtTokens, and charge.js imports nothing that imports this.
import { applyCharge, fmtTokens } from '@src/charge.js';
import { preflight, REAL_PROBES } from '@src/preflight.js';
import type { PreflightProbes, PreflightReport } from '@src/preflight.js';
import { closeCodexRateLimits, describeLimits, readCodexRateLimits } from '@src/ratelimits.js';
import { resolveGates } from '@src/verify.js';
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
  --codex-context-window <n> The Codex model's context window in tokens. Unset by default:
                             the protocol never reports it for a codex exec thread, so
                             occupancy is reported in tokens with no ratio until you say
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
  --budget <usd>             Work ceiling, API-equivalent, Claude only - Codex reports no
                             cost (default: 25; not a bill on a plan)
  --max-tokens <n>           Cumulative token ceiling across both agents - the only ceiling
                             that bounds Codex work (default: 25,000,000; 0 = off)
  --no-wait-on-limit         Exit on a rate limit instead of waiting for the reset
  --codex-limit-percent <n>  Stop before a Codex turn once Codex's rate-limit window is
                             this full (default: 95; 0 = off)
  --no-codex-limits          Do not read Codex's rate-limit window from codex app-server
  --compact-above <ratio>    Rotate the Claude session above this context share (default: 0.5)
  --no-compact               Never rotate the session
  --progress-interval <sec>  Heartbeat cadence during a turn (default: 30)
  --no-progress              Do not emit the in-turn progress heartbeat
  --no-branch                Do not create an isolated branch
  --no-codex-answers         Escalate every blocking question straight to you
  --blocking-questions-only  Only send Codex the questions marked blocking
  --no-codex-session         Run each Codex turn as a fresh one-shot (no memory)
  --verify-command <cmd>     Verification command (default: auto-detect, e.g. npm test).
                             Refused when verify.gates is configured - put the command in
                             a gate instead of naming what to run twice
  --verify-runs <n>          Times it must pass (default: 3; catches races)
  --no-verify                Do not run the verification gates
  --skip-probe               Skip the agent environment preflight
  -h, --help

Exit codes
  0 done (plan approved, or every required gate passed)   1 error
  2 needs your input   3 no convergence   4 ceiling hit   5 rate limited
  6 agent environment fails the toolchain contract
  7 unverified - the run finished but a required gate never ran
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
    codexContextWindow?: number;
    maxPlanRounds?: number;
    maxReviewRounds?: number;
    maxVerifyRounds?: number;
    maxQuestionRounds?: number;
    p1Tolerance?: number;
    budget?: number;
    maxTokens?: number;
    noWaitOnLimit?: boolean;
    codexLimitPercent?: number;
    noCodexLimits?: boolean;
    compactAbove?: number;
    noCompact?: boolean;
    progressInterval?: number;
    noProgress?: boolean;
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

/** Exported for the flag tests: the whole flag contract without running main(). */
export function parseArgs(args: readonly string[]): ParsedArgs {
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
      case '--codex-context-window': out.flags.codexContextWindow = nextNum(); break;
      case '--max-plan-rounds': out.flags.maxPlanRounds = nextNum(); break;
      case '--max-review-rounds': out.flags.maxReviewRounds = nextNum(); break;
      case '--max-verify-rounds': out.flags.maxVerifyRounds = nextNum(); break;
      case '--max-question-rounds': out.flags.maxQuestionRounds = nextNum(); break;
      case '--p1-tolerance': out.flags.p1Tolerance = nextNum(); break;
      case '--budget': out.flags.budget = nextNum(); break;
      case '--max-tokens': out.flags.maxTokens = nextNum(); break;
      case '--no-wait-on-limit': out.flags.noWaitOnLimit = true; break;
      case '--codex-limit-percent': out.flags.codexLimitPercent = nextNum(); break;
      case '--no-codex-limits': out.flags.noCodexLimits = true; break;
      case '--compact-above': out.flags.compactAbove = nextNum(); break;
      case '--no-compact': out.flags.noCompact = true; break;
      case '--progress-interval': out.flags.progressInterval = nextNum(); break;
      case '--no-progress': out.flags.noProgress = true; break;
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

/** Exported for the flag tests, alongside parseArgs. */
export function buildOverrides(flags: ParsedArgs['flags']): ConfigOverrides {
  const claude: Partial<Config['claude']> = {};
  const codex: Partial<Config['codex']> = {};
  const loop: Partial<Config['loop']> = {};
  const budget: Partial<Config['budget']> = {};
  const gitCfg: Partial<Config['git']> = {};
  const questions: Partial<Config['questions']> = {};
  const context: Partial<Config['context']> = {};
  const verify: Partial<Config['verify']> = {};
  const progress: Partial<Config['progress']> = {};

  if (flags.claudeModel !== undefined) claude.model = flags.claudeModel;
  if (flags.claudeEffort !== undefined) claude.effort = asEffort(flags.claudeEffort, '--claude-effort');
  if (flags.codexModel !== undefined) codex.model = flags.codexModel;
  if (flags.codexEffort !== undefined) codex.effort = asEffort(flags.codexEffort, '--codex-effort');
  // Validated in config.ts, so the flag and the config key fail the same way.
  if (flags.codexContextWindow !== undefined) codex.contextWindow = flags.codexContextWindow;
  if (flags.maxPlanRounds !== undefined) loop.maxPlanRounds = flags.maxPlanRounds;
  if (flags.maxReviewRounds !== undefined) loop.maxReviewRounds = flags.maxReviewRounds;
  if (flags.maxVerifyRounds !== undefined) loop.maxVerifyRounds = flags.maxVerifyRounds;
  if (flags.maxQuestionRounds !== undefined) loop.maxQuestionRounds = flags.maxQuestionRounds;
  if (flags.p1Tolerance !== undefined) loop.p1Tolerance = flags.p1Tolerance;
  if (flags.budget !== undefined) budget.maxCostUsd = flags.budget;
  if (flags.maxTokens !== undefined) budget.maxTokens = flags.maxTokens;
  if (flags.noWaitOnLimit) budget.waitOnRateLimit = false;
  if (flags.codexLimitPercent !== undefined) budget.codexLimitPercent = flags.codexLimitPercent;
  if (flags.noCodexLimits) codex.readRateLimits = false;
  if (flags.compactAbove !== undefined) context.compactAboveRatio = flags.compactAbove;
  if (flags.noCompact) context.enabled = false;
  if (flags.noProgress) progress.enabled = false;
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
  // Seconds here rather than minutes: a heartbeat cadence is on that scale.
  if (flags.progressInterval !== undefined) progress.intervalMs = flags.progressInterval * 1000;

  return { claude, codex, loop, budget, git: gitCfg, questions, context, verify, progress };
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
  // The thread count is read off the table rather than stated: since #45 the
  // reviewer holds its own Codex conversation, so a default persisted run
  // carries two and "single thread" would be a false summary of it.
  const threads = codexConversations(cfg);
  log.info(
    `Codex:   ${cfg.codex.model} / ${cfg.codex.effort}` +
      `${cfg.codex.persistSession ? ` (${threads} thread${threads === 1 ? '' : 's'}, carried across turns)` : ' (one-shot per turn)'}`,
  );
  log.info(
    `Ceiling: ~$${cfg.budget.maxCostUsd} API-equivalent, Claude only` +
      `${cfg.budget.maxTokens > 0 ? ` / ${cfg.budget.maxTokens.toLocaleString()} tokens, both agents` : ''}` +
      ` (on a subscription this is a volume brake, not a bill)`,
  );
  // Codex reports tokens but no cost, so the dollar ceiling cannot see it. With
  // maxTokens off, that leaves the reviewer's half of the run with no brake.
  if (cfg.budget.maxTokens <= 0) {
    log.warn(
      'Codex reports no cost, so budget.maxCostUsd bounds the Claude side only and ' +
        'Codex work is unbounded. Set budget.maxTokens (--max-tokens) for a ceiling covering both.',
    );
  }
  log.info(
    `Limits:  ${cfg.budget.waitOnRateLimit ? `wait up to ${cfg.budget.maxWaitMinutes} min for a rate-limit reset` : 'exit on rate limit'}` +
      `${
        cfg.codex.readRateLimits
          ? cfg.budget.codexLimitPercent > 0
            ? `, stop above ${cfg.budget.codexLimitPercent}% of Codex's window`
            : ', Codex window read but no threshold'
          : ', Codex window not read'
      }`,
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

/**
 * The config a resume runs on, written back onto the run.
 *
 * The run's own settings are the base, so a resumed run continues on the model
 * and effort it started with; flags given now still win. What was missing is
 * the write-back: overrides were applied to a local config and never persisted,
 * so a run resumed with `--max-question-rounds 5` reverted to 3 the next time
 * it was resumed without the flag. That is the same silent-revert bug
 * `state.config` exists to prevent, one command later, and it applied to every
 * flag rather than just the model.
 *
 * Exported for the resume tests: `cmdResume` goes on to spawn agents.
 */
export function resumeConfig(targetDir: string, state: RunState, flags: ParsedArgs['flags']): Config {
  const stored = state.config;
  const overrides = buildOverrides(flags);
  // What this resume would have run on with no flags at all. Compared against
  // the effective config so the event below records the user's change, and not
  // the defaults applyOverrides fills in for keys an older vibe never stored.
  const base = stored === undefined ? loadConfig(targetDir) : applyOverrides(stored, {});
  const cfg =
    stored === undefined
      ? loadConfig(targetDir, overrides)
      : applyOverrides(stored, overrides);

  // state.config holds only the latest snapshot, so on its own it cannot say
  // when a setting changed or what it was before. The resume line printed by
  // cmdResume is no substitute: it names the Claude model and effort only, and
  // is emitted before the transcript is attached.
  //
  // Computed before the config is assigned, and written by a single state write
  // either way: a save between the two would leave a window in which the new
  // settings are persisted and the record of the change is not.
  const changed = configDiff(base, cfg);
  state.config = cfg;
  if (changed.length > 0) recordEvent(state, 'resume_config', { changed });
  else saveState(state);
  return cfg;
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
  const stored = state.config;
  const cfg = resumeConfig(targetDir, state, flags);
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

/** The preflight gate, injected so its escalation path is testable without spawning. */
export type PreflightGate = (state: RunState, cfg: Config) => Promise<ExitCode | null>;

/**
 * The loop itself, injected alongside the gate for the same reason: a test that
 * pins what happens *before* the first turn must be able to prove no turn ran.
 */
export type RunLoop = (state: RunState, cfg: Config, resume: boolean) => Promise<unknown>;

/**
 * The role assignment, and what is worth saying about it - once per invocation,
 * before anything is spent.
 *
 * Here rather than in `cmdRun` so a resume reports the table it is continuing
 * on. Silent under the default assignment: `roleWarnings` is empty and the line
 * would say only what every run before this key existed already did. Refusals
 * never reach this - `loadConfig`/`resumeConfig` threw long before, which is
 * also why `rolesFor` cannot throw here.
 *
 * Compared and printed through the table rather than off the raw value, because
 * a role's value may be an object (#46): `!==` would call every role changed and
 * template interpolation would print `[object Object]`.
 */
function reportRoles(cfg: Config): void {
  const table = rolesFor(cfg);
  const changed = ROLE_NAMES.filter(
    (role) => JSON.stringify(cfg.roles[role]) !== JSON.stringify(DEFAULT_ROLE_PROVIDERS[role]),
  );
  if (changed.length > 0) {
    const named = ROLE_NAMES.map((role) => {
      const spec = table[role];
      // Only where the role named a model or an effort of its own. Printing the
      // provider's against every role would read as five overrides where there
      // are none. The model matters here in a way the effort does not: nothing
      // validates a model name, so this line is where a typo is seen in the
      // first ten lines rather than after the planner and the implementer have
      // run (#60).
      return (
        `${role}=${spec.provider}` +
        `${spec.model === undefined ? '' : `@${spec.model}`}` +
        `${spec.effort === undefined ? '' : `/${spec.effort}`}`
      );
    });
    log.info(`Roles:   ${named.join(' ')}`);
  }
  for (const warning of roleWarnings(cfg)) log.warn(warning);
}

export async function execute(
  state: RunState,
  cfg: Config,
  resume: boolean,
  skipProbe = false,
  preflightGate: PreflightGate = runPreflight,
  loop: RunLoop = orchestrate,
): Promise<ExitCode> {
  const started = Date.now();

  reportRoles(cfg);

  try {
    // Inside the try, not above it: preflight now charges what its probes spent,
    // so it can raise the same budget Escalation a turn can, and that belongs in
    // the one handler that reports an escalation rather than escaping uncaught.
    if (!skipProbe) {
      const gate = await preflightGate(state, cfg);
      if (gate !== null) return gate;
    }

    await loop(state, cfg, resume);
    log.heading('Done');
    // Never claim a spotless finish when a P1 was carried. The tolerance lets a
    // run complete with findings outstanding; reporting that as "zero P1s"
    // would contradict the OUTSTANDING.md written moments earlier, and a
    // summary a user cannot trust is worse than no summary.
    const left = state.outstanding ?? [];
    const caveat = verificationCaveat(state);
    // The exit rule, not the list of named gates: a record that says nothing at
    // all names nothing, and "no unavailable gates" is the wrong answer to give
    // for it. See `verificationIncomplete`.
    const incomplete = verificationIncomplete(state);
    if (left.length > 0) {
      log.warn(
        `Finished after a final fix round for ${left.length} carried P1(s): ` +
          `${left.map((f) => f.id).join(', ')}. ` +
          `${caveat === null ? 'Verification passed' : `But ${caveat}`}, and that round was not ` +
          're-reviewed - see OUTSTANDING.md.',
      );
    } else if (state.finalFixDone === true && state.outstanding !== undefined) {
      // The same shape of problem as the gate record, found while checking for
      // its twins: `outstanding` is also repaired to an empty list on a state
      // that could not be read, and an empty one here prints "zero P1s" over a
      // run that carried some. `finalFixDone` is an independent witness - a
      // healthy run sets it in the same breath as a NON-empty `outstanding`
      // (src/orchestrator.ts) - so the two disagreeing means the record is
      // damaged, not that the review was spotless. Absent `outstanding` is left
      // alone: that is a state written before the field existed.
      log.warn(
        'Finished after a final fix round, but the record of what it carried is empty - ' +
          'state.json was repaired on load. See OUTSTANDING.md for what was actually carried.',
      );
    } else if (incomplete === null) {
      log.ok(
        state.planOnly
          ? 'Plan cleared critique with zero P1s. Not implemented (plan-only run).'
          : 'Plan and implementation both cleared review with zero P1s.',
      );
    }
    // Here rather than in `summary()`, and here rather than only in a log line
    // emitted forty minutes ago: the run may exit 0 with a gate that never ran,
    // so the exit code cannot carry it and the end of the run is the only place
    // a human reliably reads. `summary()` is spend, rounds, branch and rate
    // limits; this is a statement about what the run did and did not establish.
    reportGates(state);
    reportReviewCoverage(state);
    reportDeferred(state);
    summary(state, started);
    return incomplete === null ? EXIT.OK : EXIT.UNVERIFIED;
  } catch (err) {
    if (err instanceof Escalation) {
      state.status = err.code === EXIT.NEEDS_HUMAN ? 'needs-input' : 'stalled';
      // recordEvent persists, so the status and the event that explains it land
      // in one write rather than two.
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

  const gates = cfg.verify.enabled ? resolveGates(cfg.verify, targetDir) : [];
  // The first gate that actually has something to run. `verifyCommand` and
  // `verifyRuns` are KEPT rather than replaced by the gate list: `readEnvironment`
  // (src/stored.ts) drops a record lacking that pair, so a run recorded by 1.1.0
  // would lose its whole environment section on resume if they went away.
  const first = gates.find((g) => g.command !== null);
  return {
    agents,
    verifyCommand: first?.command ?? null,
    verifyRuns: first?.runs ?? cfg.verify.runs,
    ...(gates.length > 0
      ? {
          verifyGates: gates.map((g) => ({ name: g.name, command: g.command, runs: g.runs })),
        }
      : {}),
  };
}

/**
 * Gate the run on both agents' execution environments.
 *
 * Returns an exit code to stop on, or null to proceed. Deliberately before the
 * first planning token: the failure this replaces cost 35 minutes and surfaced
 * as a plan-stage P1 from the reviewer rather than as an environment error.
 */
export async function runPreflight(
  state: RunState,
  cfg: Config,
  probes: PreflightProbes = REAL_PROBES,
): Promise<ExitCode | null> {
  const phases: Phase[] = state.planOnly ? ['plan'] : ['plan', 'implement', 'review'];
  log.heading('Preflight');

  let report: Awaited<ReturnType<typeof preflight>>;
  try {
    report = await preflight(state.targetDir, cfg, phases, state.dir, probes);
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
    if (repairArgs.length > 0) log.info('Environment repair will be applied to every Claude turn');
    log.ok('Toolchain contract satisfied');
    recordEvent(state, 'preflight-ok', { repairArgs: repairArgs.length > 0 });
  } else {
    for (const reason of report.blockingReasons) log.fail(reason);
    state.status = 'error';
    recordEvent(state, 'preflight-failed', { reasons: report.blockingReasons });
    log.info('Fix the environment, or re-run with --skip-probe to proceed anyway.');
  }

  // Charged after the verdict has been logged and recorded, so the run record
  // shows what preflight found before it shows the ceiling that stopped it.
  try {
    chargePreflight(state, cfg, report);
  } catch (err) {
    // A ceiling the probes themselves crossed. On the proceeding path this is
    // the point of charging here - the run stops before the first planning turn
    // rather than after paying for it - so it is rethrown for execute()'s
    // escalation handler. On the blocked path the run is already ending on the
    // environment fault, which is the more actionable report of the two, and
    // every charge and event has already landed by the time this throws.
    if (report.ok || !(err instanceof Escalation)) throw err;
  }

  return report.ok ? null : EXIT.PREFLIGHT;
}

/**
 * What preflight's probes spent, through the same seam a turn pays through.
 *
 * Here rather than inside `preflight` because `vibe doctor` probes with no
 * `RunState` at all: preflight reports, the run path charges. A probe that
 * reported nothing is charged nothing - a skipped, failed or timed-out probe
 * has no figure, and an invented one would put a number in the run's totals
 * that nobody could trace to a source.
 *
 * Both probes have already run and returned by the time this is called, so a
 * ceiling crossed by the first charge must not cost the second its place in the
 * totals and the event log. The escalation is held and raised once everything
 * reported has been recorded - the same reasoning `withConcurrentCompaction`
 * records for work that has already been paid for.
 */
export function chargePreflight(state: RunState, cfg: Config, report: PreflightReport): void {
  let held: Escalation | null = null;

  for (const [provider, result] of [
    ['claude', report.claude],
    ['codex', report.codex],
  ] as const) {
    const usage = result.usage;
    if (usage === null || usage === undefined) continue;

    try {
      applyCharge(state, cfg, {
        // Straight through the existing routing: Claude reports a cost, Codex
        // reports none, so Codex's tokens land in codexTokens exactly as a Codex
        // turn's do. No second rule.
        costUsd: usage.costUsd,
        tokens: usage.tokens,
        event: {
          type: 'preflight_probe',
          data: {
            provider,
            tokens: usage.tokens,
            costUsd: usage.costUsd,
            turns: usage.turns,
          },
        },
        describe: () =>
          `preflight ${provider}: ${fmtTokens(usage.tokens)} tok` +
          (usage.costUsd === null ? '' : `, ~$${usage.costUsd.toFixed(3)}`) +
          ` (run ${fmtTokens(state.tokensUsed)} tok / ~$${state.costUsd.toFixed(2)})`,
        warnings: [],
      });
    } catch (err) {
      // Held, not rethrown here. Anything that is not a ceiling is a real fault
      // and still propagates immediately. The latest escalation is the one
      // raised: its message quotes the running total at the moment it was built,
      // and a later charge only makes that figure more complete.
      if (!(err instanceof Escalation)) throw err;
      held = err;
    }
  }

  if (held !== null) throw held;
}

/**
 * Gates that never ran, said at the end of the run.
 *
 * Same shape of problem as the carried-P1 warning above it: a run can finish
 * with something a reader has to know about, and the exit code cannot carry the
 * optional half of it because an optional unavailable gate is a stated
 * configuration and stays at 0. A `log.warn` during the loop is not the human
 * contract - it scrolls past forty minutes before the end - so the outcome is
 * repeated here, naming which gates cost the exit code and which do not (#47).
 *
 * Silent when every gate ran, and on a plan-only run, which never reaches a
 * gate at all.
 */
function reportGates(state: RunState): void {
  const unavailable = unavailableGates(state);
  if (unavailable.length === 0) {
    // A run can be unverified with no gate to name: a stored record that could
    // not be read is repaired to an empty list, and the exit code moves without
    // anything above having said why. Silence here would be the same "exit code
    // says one thing, summary says another" this function exists to prevent.
    const incomplete = verificationIncomplete(state);
    if (incomplete !== null) {
      log.warn(
        `Verification incomplete: ${incomplete} - the run exits ${EXIT.UNVERIFIED}. ` +
          'Check `gateOutcomes` in state.json and the run log.',
      );
    }
    return;
  }

  const named = (o: { name: string }): string => `\`${o.name}\``;
  const required = unavailable.filter((o) => o.required);
  const optional = unavailable.filter((o) => !o.required);

  const parts: string[] = ['Verification incomplete.'];
  if (required.length > 0) {
    parts.push(
      `${required.map(named).join(', ')} could not run (no command configured), and ` +
        `${required.length === 1 ? 'that gate is' : 'those gates are'} required - the run ` +
        `exits ${EXIT.UNVERIFIED}.`,
    );
  }
  if (optional.length > 0) {
    parts.push(
      `${optional.map(named).join(', ')} also did not run, and ` +
        `${optional.length === 1 ? 'is optional' : 'are optional'}, so ` +
        `${required.length > 0 ? 'they do not add to' : 'this does not affect'} the exit code.`,
    );
  }
  log.warn(parts.join(' '));
}

/**
 * What the last review round was actually shown.
 *
 * Here for the reason `reportGates` is here: a change too large for one turn is
 * reviewed in parts forty minutes before the run ends, and if a file inside one
 * of those parts was still too big to show whole, the exit code cannot say so -
 * a review that covered every file across several turns is complete, and this
 * one is not quite (#49).
 *
 * Silent on the ordinary round. A chunked round that showed everything gets one
 * detail line, because it is information rather than a caveat.
 */
function reportReviewCoverage(state: RunState): void {
  const coverage = state.reviewCoverage;
  if (coverage === undefined) return;

  if (coverage.truncated.length > 0) {
    const named = coverage.truncated.map((f) => `\`${f}\``).join(', ');
    log.warn(
      `The last review saw a cut diff for ${named}: ${
        coverage.truncated.length === 1 ? 'that file is' : 'those files are'
      } larger than a single review turn can carry. The reviewer was told so and asked to read ` +
        `the rest from the working tree, but nothing here establishes that it did. The exit code ` +
        'does not move for this.',
    );
  }
  if (coverage.chunks > 1) {
    log.detail(
      `Review round ${coverage.round} ran in ${coverage.chunks} parts over ${coverage.files.length} file(s).`,
    );
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
  // Split by agent rather than printing one total beside one dollar figure: the
  // cost covers only the Claude share, and a single line implied it covered all.
  const codex = state.codexTokens ?? 0;
  log.info(`Work:     ${state.tokensUsed.toLocaleString()} tokens, ${mins} min`);
  log.info(
    `          Claude ${(state.tokensUsed - codex).toLocaleString()} tok ` +
      `(~$${state.costUsd.toFixed(2)} API-equivalent)`,
  );
  if (codex > 0) log.info(`          Codex  ${codex.toLocaleString()} tok (cost not reported)`);
  const limit = state.codexRateLimit;
  if (limit) {
    const window =
      limit.windowDurationMins === null
        ? `${limit.window} window`
        : `${limit.window} window (${limit.windowDurationMins} min)`;
    const reset = limit.resetsAt === null ? '' : `, resets ${new Date(limit.resetsAt).toLocaleString()}`;
    log.info(`Codex:    ${limit.usedPercent}% of its ${window} used${reset}`);
    // A window vibe picked is a different claim from one the server named, and
    // reporting the fuller window's reset as the reported one would be a made-up
    // time in the field a user acts on.
    if (limit.reachedType !== null && !limit.windowFromServer) {
      log.warn(
        `          Codex reported its limit reached as "${limit.reachedType}", which names no ` +
          'window vibe recognises - the figures above are the fullest window, not that one.',
      );
    }
  }
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
    // A cost that could not be read prints as unknown rather than as money.
    const cost = r.costUsd === null ? '     ?' : `$${r.costUsd.toFixed(2)}`;
    console.log(`  ${r.id.padEnd(52)} ${r.status.padEnd(12)} ${cost}`);
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
      `  budget $${cfg.budget.maxCostUsd} (Claude) / ` +
        `${cfg.budget.maxTokens > 0 ? `${cfg.budget.maxTokens.toLocaleString()} tokens (both)` : 'no token ceiling'}` +
        ` - plan rounds ${cfg.loop.maxPlanRounds} - review rounds ${cfg.loop.maxReviewRounds}`,
    );
    log.info(
      `  compaction ${cfg.context.enabled ? `above ${(cfg.context.compactAboveRatio * 100).toFixed(0)}%` : 'off'}` +
        `${cfg.context.compactDuringCodex ? ' (overlapped with Codex)' : ''}`,
    );
    if (cfg.verify.enabled) {
      // One line per gate, and each says whether it will cost the exit code.
      // "runs will not be gated" was the old wording for a state that also
      // exited 0, which is exactly the ambiguity #47 removes.
      for (const gate of resolveGates(cfg.verify, targetDir)) {
        if (gate.command !== null) {
          log.info(`  verify: ${gate.name} - ${gate.command} (must pass ${gate.runs}x)`);
        } else if (gate.required) {
          log.warn(
            `  verify: ${gate.name} - no command configured; this gate will not run ` +
              `(REQUIRED - the run will exit ${EXIT.UNVERIFIED})`,
          );
        } else {
          log.info(
            `  verify: ${gate.name} - no command configured; this gate will not run (optional)`,
          );
        }
      }
    } else {
      log.info('  verify: off - the loop will not check that the code runs');
    }
  } catch (err) {
    log.fail(`config: ${err instanceof Error ? err.message : String(err)}`);
    bad++;
  }

  // Deliberately outside `check()`, which counts a throw against the exit code:
  // app-server is experimental and absent on older Codex builds, and a machine
  // without it is not a broken environment.
  try {
    const cfg = loadConfig(targetDir);
    const limits = await readCodexRateLimits(cfg, targetDir);
    if (limits === null) {
      log.info('codex rate limits: not available (codex app-server did not answer)');
    } else {
      log.ok(`codex rate limits: ${describeLimits(limits)}`);
    }
  } catch (err) {
    log.detail(`codex rate limits: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // Otherwise the persistent child keeps `vibe doctor` from exiting.
    closeCodexRateLimits();
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
