import path from 'node:path';
import { ClaudeAdapter } from '@src/adapters/claude-adapter.js';
import { CodexAdapter } from '@src/adapters/codex-adapter.js';
import { claudeBin } from '@src/claude.js';
import { codexBin } from '@src/codex.js';
import { hostExecutableFor } from '@src/hosttools.js';
import { run } from '@src/proc.js';
import { contractForAgent, validateContract } from '@src/runtime.js';
import type {
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
): Promise<PreflightReport> {
  const contract = contractForPhases(cfg.toolchain, phases);

  // Each agent is probed only against the tools it is responsible for running.
  const claude = await preflightClaude(
    targetDir,
    cfg,
    contractForAgent(contract, 'claude'),
    phases,
    workDir,
  );
  const codex = await preflightCodex(targetDir, cfg, contractForAgent(contract, 'codex'), phases);

  const blockingReasons: string[] = [];
  const warnings: string[] = [];

  if (claude.probeError !== null) blockingReasons.push(`Claude probe failed: ${claude.probeError}`);
  for (const violation of claude.violations) {
    blockingReasons.push(describe(violation));
  }

  // Codex's probe is a language model, and the same probe on the same host has
  // returned a correct result, no result, and a confidently wrong one. Its tool
  // findings are reported but do not by themselves stop a run.
  if (codex.probeError !== null) warnings.push(`Codex probe failed: ${codex.probeError}`);
  for (const violation of codex.violations) {
    warnings.push(describe(violation));
  }

  // Sandbox blocking is the exception: that conclusion is drawn from vibe's own
  // resolution plus the configured sandbox mode, both deterministic, so it is
  // trustworthy enough to stop on.
  if (codex.prepared?.mechanisms.includes('sandbox-policy') === true) {
    blockingReasons.push(
      `Codex's ${cfg.codex.sandbox} sandbox blocks required tools. ` +
        'Only danger-full-access permits running toolchain binaries outside the workspace.',
    );
  }

  return { claude, codex, ok: blockingReasons.length === 0, blockingReasons, warnings };
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
