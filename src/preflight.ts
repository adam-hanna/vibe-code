import path from 'node:path';
import { ClaudeAdapter } from '@src/adapters/claude-adapter.js';
import { CodexAdapter } from '@src/adapters/codex-adapter.js';
import { claudeBin } from '@src/claude.js';
import { codexBin } from '@src/codex.js';
import { hostExecutableFor } from '@src/hosttools.js';
import { run } from '@src/proc.js';
import { providerAccess } from '@src/roles.js';
import type { Access } from '@src/roles.js';
import { contractForAgent, validateContract } from '@src/runtime.js';
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

export interface AgentPreflight {
  runtime: AgentRuntime | null;
  violations: readonly ContractViolation[];
  prepared: PreparedEnvironment | null;
  /** Set when the probe itself failed, as distinct from the contract failing. */
  probeError: string | null;
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
    { provider: 'claude', access: providerAccess('claude', cfg), result: claude },
    { provider: 'codex', access: providerAccess('codex', cfg), result: codex },
  ];
  const { blockingReasons, warnings } = adjudicate(verdicts, cfg);

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
  const codex = verdicts.find((verdict) => verdict.provider === 'codex');
  if (codex?.result.prepared?.mechanisms.includes('sandbox-policy') === true) {
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
    if (requirement.phases.some((phase) => phases.includes(phase))) out[tool] = requirement;
  }
  return out;
}

async function preflightClaude(
  targetDir: string,
  cfg: Config,
  contract: ToolchainContract,
  phases: readonly Phase[],
  workDir: string,
): Promise<AgentPreflight> {
  const adapter = new ClaudeAdapter(async ({ args, prompt, cwd, timeoutMs }) => {
    const result = await run(
      claudeBin(),
      ['-p', '--model', PROBE_MODEL, '--permission-mode', 'bypassPermissions', ...args, '--tools', 'Bash'],
      { input: prompt, cwd, timeoutMs },
    );
    return result.stdout;
  }, path.join(workDir, 'preflight'));

  const ctx = { cwd: targetDir, contract, timeoutMs: PROBE_TIMEOUT_MS };

  let runtime: AgentRuntime;
  try {
    runtime = await adapter.probeRuntime(ctx);
  } catch (err) {
    return {
      runtime: null,
      violations: [],
      prepared: null,
      probeError: err instanceof Error ? err.message : String(err),
    };
  }

  const prepared = await adapter.prepareEnvironment(runtime, contract);

  // Re-check against the repaired environment rather than the broken one it
  // replaced, otherwise every repaired run still reports the original failure.
  if (prepared.mechanisms.includes('claude-env-file')) {
    const verification = await adapter.verifyRepair(ctx);
    if (verification.ok) {
      return { runtime, violations: [], prepared, probeError: null };
    }
    return {
      runtime,
      violations: violationsFor(runtime, contract, phases),
      prepared,
      probeError: `repair did not take effect: ${verification.detail}`,
    };
  }

  void cfg;
  return { runtime, violations: violationsFor(runtime, contract, phases), prepared, probeError: null };
}

async function preflightCodex(
  targetDir: string,
  cfg: Config,
  contract: ToolchainContract,
  phases: readonly Phase[],
): Promise<AgentPreflight> {
  const adapter = new CodexAdapter(async ({ prompt, args, cwd, timeoutMs }) => {
    const result = await run(
      codexBin(),
      [
        'exec',
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
    return result.stdout;
  }, cfg.codex.sandbox);

  let runtime: AgentRuntime;
  try {
    runtime = await adapter.probeRuntime({ cwd: targetDir, contract, timeoutMs: PROBE_TIMEOUT_MS });
  } catch (err) {
    return {
      runtime: null,
      violations: [],
      prepared: null,
      probeError: err instanceof Error ? err.message : String(err),
    };
  }

  const prepared = await adapter.prepareEnvironment(runtime, contract);
  return { runtime, violations: violationsFor(runtime, contract, phases), prepared, probeError: null };
}

function violationsFor(
  runtime: AgentRuntime,
  contract: ToolchainContract,
  phases: readonly Phase[],
): ContractViolation[] {
  const hosts: Record<string, string | null> = {};
  for (const tool of Object.keys(contract)) hosts[tool] = hostExecutableFor(tool);

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
