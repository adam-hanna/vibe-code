import path from 'node:path';
import { ClaudeAdapter } from '@src/adapters/claude-adapter.js';
import { CodexAdapter, selectProbeTranscript } from '@src/adapters/codex-adapter.js';
import { claudeBin, parseProbeTurn } from '@src/claude.js';
import { codexBin, parseProbeStream } from '@src/codex.js';
import * as git from '@src/git.js';
import { hostExecutableFor } from '@src/hosttools.js';
import { run } from '@src/proc.js';
import { codexProbeSandbox, enabledRolesFor, providerAccess, rolesFor } from '@src/roles.js';
import type { Access, RoleTable } from '@src/roles.js';
import { contractForAgent, setOwn, validateContract } from '@src/runtime.js';
import type {
  AgentProvider,
  AgentRuntime,
  ContractViolation,
  Phase,
  PreparedEnvironment,
  ToolchainContract,
} from '@src/runtime.js';
import type { Config } from '@src/types.js';

/** Probe turns are throwaway; a small model and low effort are ample. */
const PROBE_MODEL = 'haiku';
const PROBE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * What a probe's agent turns spent.
 *
 * `costUsd` is null where the provider reports none, which is the same
 * distinction `applyCharge` already routes on - Codex reports no cost, so its
 * probe is counted in tokens only.
 */
export interface ProbeUsage {
  costUsd: number | null;
  tokens: number;
  /** Agent turns behind the figure: Claude's probe can make two, Codex can retry. */
  turns: number;
}

export interface AgentPreflight {
  runtime: AgentRuntime | null;
  violations: readonly ContractViolation[];
  prepared: PreparedEnvironment | null;
  /** Set when the probe itself failed, as distinct from the contract failing. */
  probeError: string | null;
  /**
   * What this probe spent, or absent where nothing reported usage.
   *
   * Reported, not charged: `vibe doctor` probes with no `RunState` at all, so
   * preflight cannot be the thing that pays. The run path charges this through
   * the shared accounting seam before the first real turn.
   */
  usage?: ProbeUsage | null | undefined;
}

export interface PreflightReport {
  claude: AgentPreflight;
  codex: AgentPreflight;
  /** Whether the run may proceed. See `blockingReasons` for why not. */
  ok: boolean;
  blockingReasons: readonly string[];
  warnings: readonly string[];
}

export interface PreflightProbes {
  claude: (
    targetDir: string,
    cfg: Config,
    contract: ToolchainContract,
    phases: readonly Phase[],
    workDir: string,
  ) => Promise<AgentPreflight>;
  codex: (
    targetDir: string,
    cfg: Config,
    contract: ToolchainContract,
    phases: readonly Phase[],
  ) => Promise<AgentPreflight>;
}

/** What a real run probes with. Tests substitute fakes for both. */
export const REAL_PROBES: PreflightProbes = { claude: preflightClaude, codex: preflightCodex };

/**
 * Verify both agents can run what the phases ahead require.
 *
 * Runs before any planning token is spent. The failure this prevents took 35
 * minutes and two plan-revision rounds to surface, and surfaced as a plan-stage
 * P1 from the reviewer rather than as an environment error.
 */
export async function preflight(
  targetDir: string,
  cfg: Config,
  phases: readonly Phase[],
  workDir: string,
  probes: PreflightProbes = REAL_PROBES,
): Promise<PreflightReport> {
  const contract = contractForPhases(cfg.toolchain, phases);
  // The run's own table, so enforcement follows who actually takes a turn.
  const roles = rolesFor(cfg);

  // Each agent is probed only against the tools it is responsible for running.
  const claude = await probes.claude(
    targetDir,
    cfg,
    contractForAgent(contract, 'claude'),
    phases,
    workDir,
  );
  const codex = await probes.codex(targetDir, cfg, contractForAgent(contract, 'codex'), phases);

  const verdicts: AgentVerdict[] = [
    { provider: 'claude', access: providerAccess('claude', cfg, roles), result: claude },
    { provider: 'codex', access: providerAccess('codex', cfg, roles), result: codex },
  ];
  const { blockingReasons, warnings } = adjudicate(verdicts, cfg, roles);

  return { claude, codex, ok: blockingReasons.length === 0, blockingReasons, warnings };
}

export interface AgentVerdict {
  provider: AgentProvider;
  access: Access;
  result: AgentPreflight;
}

const LABEL: Readonly<Record<AgentProvider, string>> = { claude: 'Claude', codex: 'Codex' };

/**
 * Which findings stop the run.
 *
 * Keyed off `access`, not off the provider: an agent that may write cannot
 * proceed past a toolchain it cannot run, because that failure would otherwise
 * surface mid-turn, after the expensive part has begun, instead of here.
 *
 * A read-only agent keeps warn-only. Codex's probe is a language model, and the
 * same probe on the same host has returned a correct result, no result, and a
 * confidently wrong one; its tool findings were never trustworthy enough to
 * stop a run on while it only reads a diff.
 */
export function adjudicate(
  verdicts: readonly AgentVerdict[],
  cfg: Config,
  roles: RoleTable = rolesFor(cfg),
): { blockingReasons: string[]; warnings: string[] } {
  const blockingReasons: string[] = [];
  const warnings: string[] = [];

  for (const verdict of verdicts) {
    const { probeError, violations } = verdict.result;
    const sink = verdict.access === 'write' ? blockingReasons : warnings;
    if (probeError !== null) sink.push(`${LABEL[verdict.provider]} probe failed: ${probeError}`);
    for (const violation of violations) sink.push(describe(violation));
  }

  // Sandbox blocking is the exception: that conclusion is drawn from vibe's own
  // resolution plus the configured sandbox mode, both deterministic, so it is
  // trustworthy enough to stop on whatever the agent is permitted to do.
  //
  // Reported alongside any tool violation rather than instead of it. The two
  // are separately observed and imply different fixes - widen the sandbox
  // versus repair the tool - and folding them together would hide which tool
  // failed behind a message about policy.
  //
  // Gated on Codex holding an *enabled* role, and through the same predicate
  // `providerAccess` uses rather than a second spelling of the question. What
  // makes this worth stopping for is that a Codex turn would be spawned into a
  // sandbox that cannot run the toolchain; where no such turn is dispatched, the
  // finding describes a shell nothing will use.
  const codex = verdicts.find((verdict) => verdict.provider === 'codex');
  const codexRuns = enabledRolesFor('codex', cfg, roles).length > 0;
  if (codexRuns && codex?.result.prepared?.mechanisms.includes('sandbox-policy') === true) {
    blockingReasons.push(
      `Codex's ${cfg.codex.sandbox} sandbox blocks required tools. ` +
        'Only danger-full-access permits running toolchain binaries outside the workspace.',
    );
  }

  return { blockingReasons, warnings };
}

/** Narrow the contract to tools any of the upcoming phases actually needs. */
export function contractForPhases(
  contract: ToolchainContract,
  phases: readonly Phase[],
): ToolchainContract {
  const out: Record<string, (typeof contract)[string]> = {};
  for (const [tool, requirement] of Object.entries(contract)) {
    // `setOwn` because the tool name is the user's - see its comment in
    // src/runtime.ts. Dropping a required tool while narrowing would have
    // preflight vouch for a contract it never checked.
    if (requirement.phases.some((phase) => phases.includes(phase))) setOwn(out, tool, requirement);
  }
  return out;
}

/**
 * Phases that cannot run at all outside a git repository.
 *
 * `review` alone. `plan` needs nothing from git, and `implement` degrades
 * honestly: `markBase` goes through `hasCommits`, which is `allowFail`, so it
 * returns null, and `maybeCommit` answers `not-a-repo` (measured 2026-08-27,
 * #71). Only the review phase has no honest degraded form - its entire input is
 * a diff produced by git.
 */
export function repoRequiredBy(phases: readonly Phase[]): boolean {
  return phases.includes('review');
}

/**
 * The reason this directory cannot host these phases, or null. Never throws.
 *
 * Deterministic, free, and therefore NOT part of the probe half of preflight:
 * there is no configuration in which refusing is wrong. Outside a repository
 * `git diff` falls back to `--no-index` mode, which has no `--cached`, so
 * `runReview`'s `diffChunks` call dies with `git diff --cached failed (129):
 * error: unknown option 'cached'` - a git usage message naming neither the
 * repository, nor the review phase, nor anything a user could act on. The run
 * that produced #71 hit it 30,277,210 tokens and 70.7 minutes in, with the plan
 * converged, the implementation written and the verification gate passed three
 * times.
 *
 * `isRepo`, and specifically NOT `hasCommits`: a repository with no commits
 * reviews fine, because `diffSince`'s null-base path does `add -A` then
 * `diff --cached` (measured 2026-08-27 on a `git init` with nothing committed:
 * `chunks=1 files=["a.txt","b.txt"]`). A check that demanded a commit would
 * refuse a working case.
 *
 * `isRepo`, and specifically NOT a `.git` directory check: the run that
 * produced #71 had a `.git` *file* pointing somewhere that could not be
 * followed. `git rev-parse --git-dir` is the only thing that answers the real
 * question - can the git binary this run will use resolve this directory?
 */
export async function gitPrecondition(
  targetDir: string,
  phases: readonly Phase[],
): Promise<string | null> {
  if (!repoRequiredBy(phases)) return null;
  // `repoStatus`, not `isRepo`: a git binary that cannot be resolved or spawned
  // makes `isRepo` throw, and a throw here would escape as a generic run error
  // (exit 1) instead of the named environment refusal this gate exists to give
  // (exit 6). Both answers mean the same thing for the review phase - there
  // will be no diff - so both are refused, and each says which it was.
  const { isRepo, error } = await git.repoStatus(targetDir);
  if (isRepo) return null;
  const why =
    "the reviewer's only input is a diff produced by git, and there is no second source " +
    'for it. ';
  return error === null
    ? `${targetDir} is not a git repository, and the review phase cannot run without one: ` +
        `${why}Run \`git init\` here, point -C at the repository, or run \`vibe plan\` if a ` +
        'plan is all you need.'
    : `git could not be run against ${targetDir} (${error}), so the review phase cannot run: ` +
        `${why}Repair the git binary - VIBE_GIT_BIN, or git on PATH - or run \`vibe plan\` if ` +
        'a plan is all you need.';
}

/**
 * A probe's running total, and the figure to report.
 *
 * Null until a turn actually reports one: a probe that was skipped, failed
 * before spending, or timed out has no figure, and inventing one would make the
 * run's totals a number nobody could trace to a source. A turn killed by the
 * timeout is the unrecoverable case - `run()` rejects and the child's stdout
 * goes with it, so what it spent cannot be known here at all.
 */
function accumulator(costed: boolean): {
  add: (costUsd: number, tokens: number) => void;
  snapshot: () => ProbeUsage | null;
} {
  const spend = { costUsd: 0, tokens: 0, turns: 0 };
  return {
    add: (costUsd, tokens) => {
      spend.costUsd += costUsd;
      spend.tokens += tokens;
      spend.turns += 1;
    },
    snapshot: () =>
      spend.turns === 0
        ? null
        : { costUsd: costed ? spend.costUsd : null, tokens: spend.tokens, turns: spend.turns },
  };
}

async function preflightClaude(
  targetDir: string,
  cfg: Config,
  contract: ToolchainContract,
  phases: readonly Phase[],
  workDir: string,
): Promise<AgentPreflight> {
  // Claude reports a cost, so the probe is charged on the Claude side - the same
  // routing an ordinary Claude turn takes.
  const spend = accumulator(true);

  const adapter = new ClaudeAdapter(async ({ args, prompt, cwd, timeoutMs }) => {
    // stream-json rather than plain output: it is the mode that reports what the
    // turn spent, and `claude.ts` already parses it. `--verbose` is required
    // alongside it under `-p`, and `--tools` stays last because it is variadic.
    const result = await run(
      claudeBin(),
      [
        '-p',
        '--output-format', 'stream-json',
        '--verbose',
        '--model', PROBE_MODEL,
        '--permission-mode', 'bypassPermissions',
        ...args,
        '--tools', 'Bash',
      ],
      { input: prompt, cwd, timeoutMs },
    );

    const turn = parseProbeTurn(result.stdout);
    if (turn.usage !== null) spend.add(turn.usage.costUsd, turn.usage.tokens.total);
    // The result event's text, not the raw stream: `verifyRepair` reads its
    // probe block out of this, and NDJSON carries that block with its newlines
    // escaped, which parses as one unusable line.
    return turn.text;
  }, path.join(workDir, 'preflight'));

  const ctx = { cwd: targetDir, contract, timeoutMs: PROBE_TIMEOUT_MS };

  let runtime: AgentRuntime;
  try {
    runtime = await adapter.probeRuntime(ctx);
  } catch (err) {
    // Still reported: a probe that spent and then failed has spent.
    return {
      runtime: null,
      violations: [],
      prepared: null,
      probeError: err instanceof Error ? err.message : String(err),
      usage: spend.snapshot(),
    };
  }

  const prepared = await adapter.prepareEnvironment(runtime, contract);

  // Re-check against the repaired environment rather than the broken one it
  // replaced, otherwise every repaired run still reports the original failure.
  if (prepared.mechanisms.includes('claude-env-file')) {
    const verification = await adapter.verifyRepair(ctx);
    if (verification.ok) {
      return { runtime, violations: [], prepared, probeError: null, usage: spend.snapshot() };
    }
    return {
      runtime,
      violations: violationsFor(runtime, contract, phases),
      prepared,
      probeError: `repair did not take effect: ${verification.detail}`,
      usage: spend.snapshot(),
    };
  }

  void cfg;
  return {
    runtime,
    violations: violationsFor(runtime, contract, phases),
    prepared,
    probeError: null,
    usage: spend.snapshot(),
  };
}

async function preflightCodex(
  targetDir: string,
  cfg: Config,
  contract: ToolchainContract,
  phases: readonly Phase[],
): Promise<AgentPreflight> {
  // Codex reports no cost, so its probe is counted in tokens only - exactly as a
  // Codex turn is.
  const spend = accumulator(false);

  // The sandbox a Codex turn is actually spawned with, not the raw config key
  // the probe used to read. The two agree for every value today - no Codex role
  // writes, so every Codex turn gets `codexSandbox('read-only', cfg)`, which is
  // that key - but they are different statements, and the raw key would have
  // preflight vouching for a sandbox no turn runs in the moment a Codex role
  // holds write access.
  const sandbox = codexProbeSandbox(cfg);

  const adapter = new CodexAdapter(async ({ prompt, args, cwd, timeoutMs }) => {
    // `--json` is the only mode that reports token usage, and it changes nothing
    // else about the turn. `codexTurn` already sends it beside these same flags.
    const result = await run(
      codexBin(),
      [
        'exec',
        '--json',
        '-m',
        cfg.codex.model,
        '-c',
        `model_reasoning_effort="${cfg.codex.effort}"`,
        ...args,
        '-C',
        cwd,
        '-',
      ],
      { input: prompt, cwd, timeoutMs },
    );

    const stream = parseProbeStream(result.stdout);
    if (stream.tokens !== null) spend.add(0, stream.tokens.total);
    // The prompt is handed over so an echo of it can be excluded: it names both
    // sentinels itself, so an echoed prompt is a probe record that was never
    // probed.
    return selectProbeTranscript(stream.strings, stream.plain, prompt);
  }, sandbox);

  let runtime: AgentRuntime;
  try {
    runtime = await adapter.probeRuntime({ cwd: targetDir, contract, timeoutMs: PROBE_TIMEOUT_MS });
  } catch (err) {
    // Both attempts behind a give-up were paid for, so the figure is reported
    // even though the probe failed.
    return {
      runtime: null,
      violations: [],
      prepared: null,
      probeError: err instanceof Error ? err.message : String(err),
      usage: spend.snapshot(),
    };
  }

  const prepared = await adapter.prepareEnvironment(runtime, contract);
  return {
    runtime,
    violations: violationsFor(runtime, contract, phases),
    prepared,
    probeError: null,
    usage: spend.snapshot(),
  };
}

function violationsFor(
  runtime: AgentRuntime,
  contract: ToolchainContract,
  phases: readonly Phase[],
): ContractViolation[] {
  const hosts: Record<string, string | null> = {};
  // Keyed by the user's tool names, so through `setOwn` - a lookup that silently
  // missed would report a repaired tool as unrepaired.
  for (const tool of Object.keys(contract)) setOwn(hosts, tool, hostExecutableFor(tool));

  // One entry per tool, not per phase. A tool required by both `implement` and
  // `review` is one broken thing, and reporting it twice makes a short list
  // look like a cascade.
  const byTool = new Map<string, ContractViolation>();
  for (const phase of phases) {
    for (const violation of validateContract(runtime, contract, phase, hosts)) {
      if (!byTool.has(violation.tool)) byTool.set(violation.tool, violation);
    }
  }
  return [...byTool.values()];
}

/** One line, with the repair hint attached when vibe can supply one. */
export function describe(violation: ContractViolation): string {
  const head = `${violation.provider}: ${violation.tool} ${violation.reason}`;
  const hint =
    violation.hostExecutable === null
      ? ''
      : ` (present on this machine at ${violation.hostExecutable})`;
  return `${head} - ${violation.detail}${hint}`;
}
