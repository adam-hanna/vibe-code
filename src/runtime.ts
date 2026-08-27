import type { PathStyle } from '@src/pathstyle.js';

/**
 * An agent's execution environment, modelled separately from vibe's own.
 *
 * The bug this exists to prevent: `vibe doctor` resolved `node` with
 * `where.exe` in vibe's Windows process, reported OK, and the run then burned
 * 35 minutes before Codex noticed the implementation shell had no `node`. Both
 * observations were correct; they were about different environments. Nothing
 * here may be inferred from vibe's own process - it is probed, per provider.
 */
export type AgentProvider = 'claude' | 'codex';

export type AgentShell = 'bash' | 'zsh' | 'sh' | 'powershell' | 'cmd' | 'unknown';

export type Platform = 'windows' | 'darwin' | 'linux';

export type Phase = 'plan' | 'implement' | 'review';

/**
 * Result of *executing* a tool in the agent's shell.
 *
 * Never populated by inspecting PATH. Verified counter-example: Codex's
 * `$env:PATH` contained `C:\Program Files\nodejs` and `PATHEXT` was intact,
 * yet `node` failed - the sandbox denied access to the binary. A PATH-inspecting
 * probe would have returned a false pass on the exact failure it exists to catch.
 */
export interface ToolResolution {
  available: boolean;
  executable: string | null;
  version: string | null;
  exitCode: number | null;
  /** Verbatim failure output, kept for the doctor's diagnostic block. */
  failure: string | null;
}

export type AccessScope = 'none' | 'workspace' | 'full';

/**
 * What the agent is permitted to touch, as distinct from what exists.
 *
 * This dimension is why the two providers failed identically for unrelated
 * reasons: Claude's shell genuinely could not resolve `node`, while Codex could
 * resolve it and was refused by its sandbox (`UnauthorizedAccessException`).
 * A model with only `env` and `tools` cannot tell those apart.
 */
export interface AccessPolicy {
  read: AccessScope;
  write: AccessScope;
  /** Roots outside the workspace the agent may execute binaries from. */
  execRoots: readonly string[];
  networkAllowed: boolean;
}

/**
 * Environment facts worth carrying, by name.
 *
 * An allowlist rather than the whole environment: runtime snapshots are
 * persisted under `.vibe/runs/`, and capturing everything would write API keys
 * and tokens to disk as a side effect of diagnostics.
 */
export const ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'PATHEXT',
  'SHELL',
  'MSYSTEM',
  'HOME',
  'COMSPEC',
  'OS',
];

export interface AgentRuntime {
  provider: AgentProvider;
  platform: Platform;
  shell: AgentShell;
  pathStyle: PathStyle;
  /** Host-native. Translate with `toAgentPath` before putting it in a prompt. */
  cwd: string;
  access: AccessPolicy;
  tools: Readonly<Record<string, ToolResolution>>;
  /** Allowlisted subset only - see ENV_ALLOWLIST. */
  env: Readonly<Record<string, string>>;
  probedAt: string;
  /** The session the probe observed, so a stale snapshot cannot pass as fresh. */
  sessionId: string | null;
}

export interface ToolRequirement {
  /** Command to execute in the agent's shell. Must run, not merely resolve. */
  probe: string;
  /** Semver-ish floor, compared against the parsed probe output. */
  minVersion?: string | undefined;
  phases: readonly Phase[];
  /**
   * Which agents must be able to run this. Omitted means all of them.
   *
   * `phases` alone says *when* a tool is needed, not *who* needs it, and the
   * two differ: the implementer runs the test suite during review while the
   * reviewer only reads the diff. Requiring a runtime of both makes the
   * reviewer's deliberately restricted sandbox look like a broken environment.
   */
  agents?: readonly AgentProvider[] | undefined;
}

export type ToolchainContract = Readonly<Record<string, ToolRequirement>>;

/** Narrow a contract to the tools one agent is responsible for running. */
export function contractForAgent(
  contract: ToolchainContract,
  provider: AgentProvider,
): ToolchainContract {
  const out: Record<string, ToolRequirement> = {};
  for (const [tool, requirement] of Object.entries(contract)) {
    if (requirement.agents === undefined || requirement.agents.includes(provider)) {
      // Tool names are the user's, and `toolchain` is the one open-ended section
      // (a project may require `go`, `cargo`, anything) - so a name that is a
      // reserved property goes through `setOwn`, or narrowing a contract would
      // quietly drop the tool rather than narrow to it.
      setOwn(out, tool, requirement);
    }
  }
  return out;
}

export type ViolationReason = 'missing' | 'unreachable' | 'version' | 'not-probed';

export interface ContractViolation {
  provider: AgentProvider;
  tool: string;
  reason: ViolationReason;
  detail: string;
  required: string | null;
  found: string | null;
  /** Where vibe's own process finds the tool, if anywhere - the repair hint. */
  hostExecutable: string | null;
}

/**
 * Check a probed runtime against the contract for one phase.
 *
 * Pure, and deliberately vibe-side. Neither provider surfaces a failed
 * environment: a Claude `SessionStart` hook that exits non-zero produces empty
 * stderr, `is_error: false`, `subtype: "success"` and exit code 0, and Codex is
 * equally silent. Enforcement cannot live in the agent.
 */
export function validateContract(
  runtime: AgentRuntime,
  contract: ToolchainContract,
  phase: Phase,
  hostExecutables: Readonly<Record<string, string | null>> = {},
): ContractViolation[] {
  const violations: ContractViolation[] = [];

  for (const [tool, requirement] of Object.entries(contract)) {
    if (!requirement.phases.includes(phase)) continue;
    if (requirement.agents !== undefined && !requirement.agents.includes(runtime.provider)) continue;

    const hostExecutable = hostExecutables[tool] ?? null;
    const base = { provider: runtime.provider, tool, hostExecutable } as const;
    const resolution = runtime.tools[tool];

    if (!resolution) {
      violations.push({
        ...base,
        reason: 'not-probed',
        detail: `"${tool}" is required for the ${phase} phase but the probe did not report on it.`,
        required: requirement.minVersion ?? null,
        found: null,
      });
      continue;
    }

    if (!resolution.available) {
      // "unreachable" is a distinct diagnosis with a distinct fix: the binary
      // exists and the agent is being refused, so repairing PATH cannot help.
      const unreachable = /access is denied|unauthorized|permission denied|eacces|eperm/i.test(
        resolution.failure ?? '',
      );
      violations.push({
        ...base,
        reason: unreachable ? 'unreachable' : 'missing',
        detail: resolution.failure ?? `"${tool}" did not run in the ${runtime.provider} shell.`,
        required: requirement.minVersion ?? null,
        found: null,
      });
      continue;
    }

    const min = requirement.minVersion;
    if (min !== undefined && !satisfiesMinVersion(resolution.version, min)) {
      violations.push({
        ...base,
        reason: 'version',
        detail: `"${tool}" is ${resolution.version ?? 'an unparseable version'}, need >= ${min}.`,
        required: min,
        found: resolution.version,
      });
    }
  }

  return violations;
}

/** Numeric-prefix comparison. Tolerates `v24.18.0`, `24.18.0`, `1.9`. */
export function satisfiesMinVersion(actual: string | null, min: string): boolean {
  if (actual === null) return false;
  const a = parseVersion(actual);
  const b = parseVersion(min);
  if (a === null || b === null) return false;

  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
}

function parseVersion(raw: string): number[] | null {
  const m = /(\d+(?:\.\d+)*)/.exec(raw);
  if (!m?.[1]) return null;
  return m[1].split('.').map((part) => Number(part));
}

/**
 * Parse the flat `key=value` block both probes emit.
 *
 * Leading list markers, backticks and whitespace are stripped because one of
 * the two probe channels is a language model, which will occasionally dress the
 * block up despite being told not to. The keys are ours, so tolerating that is
 * cheaper than failing the run over formatting.
 */
export function parseKeyValueRecord(raw: string): Map<string, string> {
  const record = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = line.trim().replace(/^[`*\s-]+/, '');
    const idx = cleaned.indexOf('=');
    if (idx > 0) record.set(cleaned.slice(0, idx).trim(), cleaned.slice(idx + 1).trim());
  }
  return record;
}

/**
 * Set a key that came from outside, as an own enumerable property.
 *
 * `out[key] = value` is not that when the key is `__proto__`: the assignment
 * invokes the prototype setter, so nothing enumerable is created and the object's
 * prototype is replaced instead. Every consumer that iterates own keys - which is
 * every validator in this repo - then never sees the field, so a setting a user
 * wrote is silently ignored and a check that would have refused it never runs.
 * Found in `mergeRoles`, where `{"roles": {"__proto__": ...}}` from a config file
 * bypassed the unknown-role-name check entirely.
 *
 * Only needed where the key is not one of ours. A loop over a repo-owned constant
 * - `mergeSection` over the base's keys, `envFromRecord` over `ENV_ALLOWLIST` -
 * cannot be handed the name in the first place.
 */
export function setOwn<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Build tool resolutions from `tool.<name>.{exit,out,which}` triples. */
export function toolsFromRecord(record: ReadonlyMap<string, string>): Record<string, ToolResolution> {
  const tools: Record<string, ToolResolution> = {};
  for (const [key, value] of record) {
    const m = /^tool\.([^.]+)\.exit$/.exec(key);
    if (!m?.[1]) continue;
    const name = m[1];
    const exitCode = Number(value);
    const output = record.get(`tool.${name}.out`) ?? '';
    const which = record.get(`tool.${name}.which`) ?? '';
    // A success with no output is not a success. Contract probes are version
    // commands, so silence means the reporter is unreliable rather than that
    // the tool ran. Observed from the model-turn channel, which returned
    // `exit=0` with an empty version for a tool a previous run of the same
    // probe had correctly reported as missing.
    const succeeded = exitCode === 0 && output !== '';
    // `setOwn`, because `name` came out of a probe's own output: it matches
    // `[^.]+`, which `__proto__` satisfies.
    setOwn(tools, name, {
      available: succeeded,
      executable: which === '' ? null : which,
      version: succeeded ? output : null,
      exitCode: Number.isFinite(exitCode) ? exitCode : null,
      failure: succeeded
        ? null
        : exitCode === 0
          ? 'reported success but produced no output; treating as unverified'
          : output,
    });
  }
  return tools;
}

/** Pull only allowlisted environment facts out of a probe record. */
export function envFromRecord(record: ReadonlyMap<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = record.get(key.toLowerCase());
    if (value !== undefined && value !== '') env[key] = value;
  }
  return env;
}

/**
 * How an adapter delivered its environment repair.
 *
 * Ordered as a fallback ladder. Provider-native comes first where it exists;
 * `prompt-hint` is the degraded rung where vibe can only tell the agent about
 * an absolute path and hope it uses it. Recorded so the doctor can explain
 * *how* an environment was fixed, not just that it was.
 */
export type EnvMechanism =
  | 'claude-env-file'
  | 'spawn-env'
  | 'sandbox-policy'
  | 'shell-startup'
  | 'prompt-hint'
  | 'none';

export interface PreparedEnvironment {
  /** Merged into the child process environment at spawn time. */
  spawnEnv: Readonly<Record<string, string>>;
  /** Extra CLI arguments this adapter needs (settings file, sandbox flags). */
  extraArgs: readonly string[];
  /** Files written for the agent to consume; also what the probe verifies. */
  artifacts: readonly string[];
  /** Text appended to prompts when no mechanism can repair the environment. */
  promptHint: string | null;
  mechanisms: readonly EnvMechanism[];
}

/** What one agent's shell was observed to be and to have. */
export interface AgentEnvironmentFacts {
  provider: AgentProvider;
  shell: AgentShell;
  pathStyle: PathStyle;
  repaired: boolean;
  tools: { name: string; available: boolean; version: string | null }[];
}

/**
 * Verified environment facts, for the agents' prompts.
 *
 * These belong in the review prompts because a reviewer with no way to check
 * an environment will reason about it from its own, and be wrong: Codex runs
 * in a deliberately restricted read-only sandbox and repeatedly raised
 * "no Node runtime is available" as a plan-blocking P1 while the implementer
 * had a working one. That cost three plan rounds on a healthy setup.
 */
export interface EnvironmentFacts {
  agents: AgentEnvironmentFacts[];
  /**
   * The first gate that has a command, and how many times it must pass.
   *
   * Kept beside `verifyGates` rather than replaced by it: `readEnvironment`
   * refuses a record without this pair, so dropping it would make every run
   * recorded before #47 lose its environment facts on resume.
   */
  verifyCommand: string | null;
  verifyRuns: number;
  /**
   * Every gate, when the run has them. Absent for a record written before #47,
   * which is why the prompt still renders the single-command sentence when it
   * is not there.
   */
  verifyGates?: readonly { name: string; command: string | null; runs: number }[] | undefined;
}

export interface ProbeContext {
  /** Host-native working directory the agent will run in. */
  cwd: string;
  contract: ToolchainContract;
  timeoutMs: number;
}

/**
 * Outcome of checking that a prepared repair actually landed.
 *
 * Separate from `PreparedEnvironment` because preparation and confirmation are
 * separated by an agent turn: vibe writes the hook, the agent runs, and only
 * then is there anything to inspect. Both providers report a broken environment
 * as a clean success, so this check is the only signal that exists.
 */
export interface RepairVerification {
  ok: boolean;
  /** Session the repair was observed under, for staleness checks. */
  sessionId: string | null;
  detail: string;
}

/**
 * Per-provider machinery for observing and repairing an execution environment.
 *
 * Two implementations that agree on almost nothing keep this honest: Claude
 * probes through a `SessionStart` hook (deterministic, no model tokens) and is
 * repaired via `CLAUDE_ENV_FILE`; Codex has no hook system, so it must be
 * probed with a constrained model turn, and is repaired through the spawn
 * environment plus sandbox policy. Neither honours `PATH` through its
 * documented env-injection API.
 */
export interface AgentAdapter {
  readonly provider: AgentProvider;
  /**
   * Whether the provider offers a deterministic probe channel. `model-turn`
   * adapters must treat the model as transport only - fixed script in, verbatim
   * output out, parsed by vibe.
   */
  readonly probeChannel: 'hook' | 'model-turn';
  probeRuntime(ctx: ProbeContext): Promise<AgentRuntime>;
  prepareEnvironment(
    runtime: AgentRuntime,
    contract: ToolchainContract,
  ): Promise<PreparedEnvironment>;
}
