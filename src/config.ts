import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_ROLE_PROVIDERS,
  PROVIDERS as ROLE_PROVIDERS,
  providersForRoles,
  ROLE_NAMES,
  roleRefusals,
  rolesFor,
} from '@src/roles.js';
import type { Role, RoleProviders } from '@src/roles.js';
import type { AgentProvider, ToolchainContract, ToolRequirement, Phase } from '@src/runtime.js';
import type { Config, ConfigOverrides, Effort, LoadedConfig, Sandbox } from '@src/types.js';

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const SANDBOXES: readonly Sandbox[] = ['read-only', 'workspace-write', 'danger-full-access'];

export const DEFAULTS: Config = {
  // Claude plans and implements, Codex critiques, answers and reviews - the
  // assignment every run made before this key existed.
  roles: DEFAULT_ROLE_PROVIDERS,
  claude: {
    // Matches the interactive workflow this tool automates: opus, medium thinking.
    model: 'opus',
    effort: 'medium',
    planTimeoutMs: 30 * 60 * 1000,
    implementTimeoutMs: 90 * 60 * 1000,
  },
  codex: {
    model: 'gpt-5.6-luna',
    effort: 'xhigh',
    // Critique and review never need write access.
    sandbox: 'read-only',
    timeoutMs: 45 * 60 * 1000,
    // The writing figure, for a table that seats the implementer on Codex.
    // Matches claude.implementTimeoutMs: implementing takes as long as it takes
    // whoever does it.
    implementTimeoutMs: 90 * 60 * 1000,
    persistSession: true,
    readRateLimits: true,
  },
  loop: {
    maxPlanRounds: 5,
    maxReviewRounds: 5,
    // Fewer than review rounds: a suite that will not pass after three
    // attempts is not going to pass on the fourth, and every one of these
    // costs a full implementation-sized turn.
    maxVerifyRounds: 3,
    // The planner answering its own questions is useful once or twice; a third
    // round of new questions means it is not converging on what to build, and
    // a human is the right next step.
    maxQuestionRounds: 3,
    // One P1 may ride along into the next phase; P0s never can. Perfection in
    // prose is not worth buying when a test suite will settle the question.
    p1Tolerance: 1,
    // Identical findings three rounds running, not two: a single repeat is a
    // normal part of a review cycle - the fix shifts the problem and the next
    // round catches the shift - and stopping on it discarded runs that would
    // have converged.
    oscillationThreshold: 3,
    convergenceWindow: 3,
  },
  budget: {
    // NOT a spend limit on a Claude subscription - the CLI derives this from
    // token counts at API rates and nothing is billed. It is a work-volume
    // brake. The Codex CLI reports no cost at all, so this covers half the run.
    maxCostUsd: 25,
    // The only ceiling that counts both agents, so it is the one that actually
    // bounds a run: Codex tokens are measurable but Codex spend is not, and at
    // 0 the reviewer's half had no brake on it at all.
    //
    // 25M is drawn from the runs on record rather than picked round. Successful
    // fixture runs land between 1.2M and 4.5M tokens, so this is roughly five
    // times the largest one that finished normally. The run that justifies a
    // token ceiling existing separately from the dollar one is the planning
    // stall: 29.2M tokens for $16.03, under the $25 cost ceiling and therefore
    // invisible to it, where 25M would have stopped it - and planShare would
    // have stopped it at 10M, since it never left the plan phase.
    //
    // It is deliberately not sized for the hardest work. A from-scratch parser
    // against a 1977-test suite took 138M tokens; a task like that is expected
    // to raise this. Hitting the ceiling exits resumable, so the cost of the
    // default being too low is one flag on `vibe resume`, while the cost of it
    // being too high is another unnoticed 29M-token stall. 0 disables.
    maxTokens: 25_000_000,
    waitOnRateLimit: true,
    maxWaitMinutes: 360,
    // 95, not 100: the point is to stop *before* starting an expensive turn that
    // the window will kill partway through, and a turn cannot be un-started. It
    // is deliberately high enough not to fire on a healthy account - the cost of
    // a false stop is one `vibe resume`, but the cost of firing early on every
    // run would be a brake nobody keeps switched on. 0 disables.
    codexLimitPercent: 95,
    // Planning gets at most 40% of the ceiling. A plan that has eaten more
    // than that has not left enough to implement and review what it describes,
    // and the round counter alone will not notice - the run that motivated
    // this spent its whole budget on plan revisions and never wrote a line.
    planShare: 0.4,
  },
  questions: {
    // Codex answers Claude's blocking questions first. Anything Codex flags as
    // product intent, or answers with low confidence, still escalates.
    askCodex: true,
    answerNonBlocking: true,
    escalateOnDefer: true,
    escalateOnLowConfidence: true,
  },
  git: {
    // Implementation runs with permissions bypassed; keep it off the working branch.
    useBranch: true,
    branchPrefix: 'vibe/',
    commitEachRound: true,
  },
  context: {
    enabled: true,
    compactAboveRatio: 0.5,
    compactDuringCodex: true,
  },
  verify: {
    enabled: true,
    // Auto-detected from package.json unless set.
    command: null,
    timeoutMs: 15 * 60 * 1000,
    // Three, not one. Measured on the run that motivated this gate: a racy
    // lock implementation failed roughly half its executions, and a single
    // sample called it green twice in a row. At p=0.5 one run catches 50%,
    // three catch 87%. The cost is linear and small; the false pass is not.
    runs: 3,
  },
  progress: {
    enabled: true,
    // 30s. A line every 30 seconds in a log file is cheap; one line per stream
    // event is not - a single implementation turn runs 28 agentic iterations
    // and emits thousands.
    intervalMs: 30_000,
  },
  toolchain: {
    // Deliberately minimal. `git` is needed in every phase because vibe commits
    // per round; node and npm only matter once something is being built or
    // verified, so a documentation change is not blocked by a missing runtime.
    //
    // node and npm are required of the implementer only - it is the one that
    // builds and runs the suite. The reviewer reads the diff rather than
    // running it, and its sandbox is read-only by design, so demanding a
    // runtime of it would fail preflight on a correct setup. The rule is about
    // the role, so it is asked of the role table rather than spelled as a
    // provider name that happens to hold it today.
    git: { probe: 'git --version', phases: ['plan', 'implement', 'review'] },
    node: {
      probe: 'node --version',
      phases: ['implement', 'review'],
      agents: providersForRoles(['implementer']),
    },
    npm: {
      probe: 'npm --version',
      phases: ['implement', 'review'],
      agents: providersForRoles(['implementer']),
    },
  },
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Merge one config section, ignoring keys the section does not define. */
function mergeSection<T extends object>(base: T, override: unknown): T {
  if (!isRecord(override)) return base;
  const out: T = { ...base };
  for (const key of Object.keys(base) as (keyof T)[]) {
    const v = override[key as string];
    if (v !== undefined) out[key] = v as T[keyof T];
  }
  return out;
}

/**
 * Merge the role assignment, keeping anything wrong for validation to name.
 *
 * Deliberately not `mergeSection`, which treats a malformed override as no
 * override at all. Swallowing `"roles": null` - or a typo'd role name, which
 * `mergeSection` would drop because it iterates the *base's* keys - would run
 * the default table while the user believes Codex is implementing: a different
 * agent, silently, with no error and no log line. Nothing else in a config can
 * fail that way, which is why this one section is strict.
 */
function mergeRoles(base: RoleProviders, override: unknown): RoleProviders {
  if (override === undefined) return base;
  if (!isRecord(override)) return override as RoleProviders;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) out[key] = value;
  return out as unknown as RoleProviders;
}

function mergeConfig(base: Config, override: unknown): Config {
  if (!isRecord(override)) return base;
  return {
    roles: mergeRoles(base.roles, override['roles']),
    claude: mergeSection(base.claude, override['claude']),
    codex: mergeSection(base.codex, override['codex']),
    loop: mergeSection(base.loop, override['loop']),
    budget: mergeSection(base.budget, override['budget']),
    questions: mergeSection(base.questions, override['questions']),
    git: mergeSection(base.git, override['git']),
    context: mergeSection(base.context, override['context']),
    verify: mergeSection(base.verify, override['verify']),
    progress: mergeSection(base.progress, override['progress']),
    toolchain: mergeToolchain(base.toolchain, override['toolchain']),
  };
}

/**
 * Merge the contract per tool rather than per known key.
 *
 * Unlike every other section this one has open-ended keys - a project can
 * require `go`, `cargo` or anything else - so `mergeSection`, which iterates
 * the base's keys, would silently discard additions.
 */
function mergeToolchain(base: ToolchainContract, override: unknown): ToolchainContract {
  if (!isRecord(override)) return base;
  const out: Record<string, ToolRequirement> = { ...base };
  for (const [tool, requirement] of Object.entries(override)) {
    if (isRecord(requirement)) out[tool] = requirement as unknown as ToolRequirement;
  }
  return out;
}

/**
 * Layer CLI overrides onto an already-resolved config.
 *
 * Used on resume, where the base is the config the run started with rather
 * than freshly-loaded defaults.
 *
 * DEFAULTS go underneath that base rather than being skipped. `mergeSection`
 * iterates the *base's* keys, so a config persisted by an older vibe is missing
 * every setting added since - and a resume of such a run failed validation
 * outright on the first required key that did not exist yet. Layering fills only
 * the absent keys: every stored value still beats the default, and the flags
 * given now still beat both. This is not specific to any one setting; without
 * it, the next key added breaks resume for every run already on disk.
 */
export function applyOverrides(base: Config, overrides: ConfigOverrides): Config {
  const merged = mergeConfig(mergeConfig(DEFAULTS, base), overrides);
  // The table is checked before anything derives from it - see loadConfig.
  validateRoles(merged.roles);
  const cfg = resolveRoleScopedAgents(merged, [base, overrides]);
  validate(cfg);
  return cfg;
}

const SECTIONS = [
  'roles',
  'claude',
  'codex',
  'loop',
  'budget',
  'questions',
  'git',
  'context',
  'verify',
  'progress',
] as const;

/**
 * Dotted paths whose values differ: ['claude.model', 'loop.maxQuestionRounds'].
 *
 * Only resolved configs are compared, so `LoadedConfig.configPath` and anything
 * else describing where a setting came from never appears - the question this
 * answers is what the run will now behave like, not how it was sourced.
 *
 * Compared as JSON because `verify.command` is nullable and toolchain entries
 * are objects. Both sides come out of `mergeConfig`, which builds keys in a
 * fixed order, so key order cannot produce a false difference.
 */
export function configDiff(before: Config, after: Config): string[] {
  const changed: string[] = [];
  for (const section of SECTIONS) {
    const b = before[section] as unknown as Record<string, unknown>;
    const a = after[section] as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
      if (JSON.stringify(b[key]) !== JSON.stringify(a[key])) changed.push(`${section}.${key}`);
    }
  }
  // Open-ended keys, so compared whole rather than per tool.
  if (JSON.stringify(before.toolchain) !== JSON.stringify(after.toolchain)) changed.push('toolchain');
  return changed.sort();
}

/** Precedence: defaults < vibe.config.json in the target repo < CLI flags. */
export function loadConfig(targetDir: string, overrides: ConfigOverrides = {}): LoadedConfig {
  const configPath = path.join(targetDir, 'vibe.config.json');
  let fromFile: unknown = {};

  if (existsSync(configPath)) {
    try {
      fromFile = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid vibe.config.json: ${message}`);
    }
  }

  const merged = mergeConfig(mergeConfig(DEFAULTS, fromFile), overrides);
  // Order matters. `resolveRoleScopedAgents` reads the table, so a bad role
  // value checked afterwards would surface as an empty `toolchain.node.agents`
  // - a toolchain error for what is a `roles` mistake.
  validateRoles(merged.roles);
  const cfg = resolveRoleScopedAgents(merged, [fromFile, overrides]);
  validate(cfg);
  return { ...cfg, configPath: existsSync(configPath) ? configPath : null };
}

/**
 * Which tools are required of whoever holds a role, rather than of a provider
 * named at import time.
 *
 * node and npm are the implementer's: it is the one that builds and runs the
 * suite. The reviewer reads the diff, and its sandbox is read-only by design.
 */
const ROLE_SCOPED_TOOLS: Readonly<Record<string, readonly Role[]>> = {
  node: ['implementer'],
  npm: ['implementer'],
};

/** Whether any layer named `toolchain.<tool>.agents` itself. */
function pinnedByAnyLayer(layers: readonly unknown[], tool: string): boolean {
  return layers.some((layer) => {
    if (!isRecord(layer)) return false;
    const toolchain = layer['toolchain'];
    if (!isRecord(toolchain)) return false;
    const requirement = toolchain[tool];
    return isRecord(requirement) && requirement['agents'] !== undefined;
  });
}

/**
 * Re-scope the role-derived `agents` for this config. Pure.
 *
 * A new map and a NEW `ToolRequirement` for every entry it computes - never a
 * write into one it was handed. `mergeToolchain` shallow-copies the map and
 * reuses each nested requirement from its base, so an entry the user did not
 * override is still the object inside `DEFAULTS`: assigning `agents` into it
 * would rewrite the module default for the life of the process, and the next
 * `loadConfig` in the same process would inherit it.
 *
 * A layer that named `agents` wins. That keeps a user's own contract, and keeps
 * a stored `state.config` - which always carries concrete agents - authoritative
 * on resume.
 *
 * Runs after `validateRoles`, so the table is well formed and `agents` is never
 * resolved to an empty list.
 */
function resolveRoleScopedAgents(cfg: Config, layers: readonly unknown[]): Config {
  const table = rolesFor(cfg);
  const toolchain: Record<string, ToolRequirement> = { ...cfg.toolchain };
  for (const [tool, wanted] of Object.entries(ROLE_SCOPED_TOOLS)) {
    const requirement = toolchain[tool];
    if (requirement === undefined) continue;
    if (pinnedByAnyLayer(layers, tool)) continue;
    toolchain[tool] = { ...requirement, agents: providersForRoles(wanted, table) };
  }
  return { ...cfg, toolchain };
}

/**
 * The role assignment, checked before anything reads it.
 *
 * Separate from `validate` and called first by both entry points, because every
 * role-derived value - the toolchain scoping, the refusals below, the table
 * itself - would otherwise report a `roles` mistake as something else.
 */
function validateRoles(raw: unknown): void {
  if (!isRecord(raw)) {
    throw new Error('roles must be an object mapping role names to "claude" or "codex"');
  }
  for (const key of Object.keys(raw)) {
    if (!ROLE_NAMES.includes(key as Role)) {
      throw new Error(`roles."${key}" is not a role; expected one of ${ROLE_NAMES.join(', ')}`);
    }
  }
  for (const role of ROLE_NAMES) {
    const provider = raw[role];
    if (provider === undefined) throw new Error(`roles.${role} is missing`);
    if (!ROLE_PROVIDERS.includes(provider as AgentProvider)) {
      throw new Error(
        `roles.${role} is ${JSON.stringify(provider)}; expected ${ROLE_PROVIDERS.map((p) => `"${p}"`).join(' or ')}`,
      );
    }
  }
}

function validate(cfg: Config): void {
  // First, and again: a caller reaching validate by another route must get the
  // same answer, and it is a pure check over five keys.
  validateRoles(cfg.roles);
  // An assignment that cannot work is a config error, not an environment one -
  // so `vibe run`, `vibe resume` and `vibe doctor` all refuse it here.
  for (const message of roleRefusals(cfg)) throw new Error(message);
  if (!EFFORTS.includes(cfg.claude.effort)) {
    throw new Error(`claude.effort must be one of ${EFFORTS.join(', ')}`);
  }
  if (!EFFORTS.includes(cfg.codex.effort)) {
    throw new Error(`codex.effort must be one of ${EFFORTS.join(', ')}`);
  }
  if (!SANDBOXES.includes(cfg.codex.sandbox)) {
    throw new Error(`codex.sandbox must be one of ${SANDBOXES.join(', ')}`);
  }
  for (const key of [
    'maxPlanRounds',
    'maxReviewRounds',
    'maxVerifyRounds',
    'maxQuestionRounds',
    'oscillationThreshold',
    'convergenceWindow',
  ] as const) {
    const v = cfg.loop[key];
    if (!Number.isInteger(v) || v < 1) throw new Error(`loop.${key} must be a positive integer`);
  }
  // Zero is meaningful here, unlike the round caps: it demands a spotless verdict.
  if (!Number.isInteger(cfg.loop.p1Tolerance) || cfg.loop.p1Tolerance < 0) {
    throw new Error('loop.p1Tolerance must be zero or a positive integer');
  }
  if (!Number.isFinite(cfg.budget.maxCostUsd) || cfg.budget.maxCostUsd <= 0) {
    throw new Error('budget.maxCostUsd must be a positive number');
  }
  if (!Number.isFinite(cfg.budget.maxTokens) || cfg.budget.maxTokens < 0) {
    throw new Error('budget.maxTokens must be zero (disabled) or a positive number');
  }
  if (!Number.isFinite(cfg.budget.planShare) || cfg.budget.planShare < 0 || cfg.budget.planShare >= 1) {
    throw new Error('budget.planShare must be between 0 (disabled) and 1 (exclusive)');
  }
  if (!Number.isFinite(cfg.budget.maxWaitMinutes) || cfg.budget.maxWaitMinutes <= 0) {
    throw new Error('budget.maxWaitMinutes must be a positive number');
  }
  const limitPercent = cfg.budget.codexLimitPercent;
  if (!Number.isFinite(limitPercent) || limitPercent < 0 || limitPercent > 100) {
    throw new Error('budget.codexLimitPercent must be between 0 (disabled) and 100');
  }
  const ratio = cfg.context.compactAboveRatio;
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) {
    throw new Error('context.compactAboveRatio must be between 0 and 1 (exclusive)');
  }
  for (const key of ['planTimeoutMs', 'implementTimeoutMs'] as const) {
    if (!Number.isFinite(cfg.claude[key]) || cfg.claude[key] <= 0) {
      throw new Error(`claude.${key} must be a positive number`);
    }
  }
  for (const key of ['timeoutMs', 'implementTimeoutMs'] as const) {
    if (!Number.isFinite(cfg.codex[key]) || cfg.codex[key] <= 0) {
      throw new Error(`codex.${key} must be a positive number`);
    }
  }
  if (!Number.isFinite(cfg.verify.timeoutMs) || cfg.verify.timeoutMs <= 0) {
    throw new Error('verify.timeoutMs must be a positive number');
  }
  if (!Number.isInteger(cfg.verify.runs) || cfg.verify.runs < 1) {
    throw new Error('verify.runs must be a positive integer');
  }
  if (cfg.verify.command !== null && typeof cfg.verify.command !== 'string') {
    throw new Error('verify.command must be a command string or null to auto-detect');
  }
  // A floor rather than "positive": the heartbeat also drives a state write, and
  // a sub-second cadence would rewrite state.json continuously for a line
  // nobody can read that fast.
  if (!Number.isFinite(cfg.progress.intervalMs) || cfg.progress.intervalMs < 1000) {
    throw new Error('progress.intervalMs must be at least 1000ms');
  }
  validateToolchain(cfg.toolchain);
}

const PHASES: readonly Phase[] = ['plan', 'implement', 'review'];
const PROVIDERS: readonly AgentProvider[] = ['claude', 'codex'];

function validateToolchain(toolchain: ToolchainContract): void {
  for (const [tool, requirement] of Object.entries(toolchain)) {
    const where = `toolchain.${tool}`;
    if (typeof requirement.probe !== 'string' || requirement.probe.trim() === '') {
      throw new Error(`${where}.probe must be a non-empty command string`);
    }
    if (!Array.isArray(requirement.phases) || requirement.phases.length === 0) {
      throw new Error(`${where}.phases must list at least one of ${PHASES.join(', ')}`);
    }
    for (const phase of requirement.phases) {
      if (!PHASES.includes(phase)) {
        throw new Error(`${where}.phases contains "${phase}"; expected one of ${PHASES.join(', ')}`);
      }
    }
    const min = requirement.minVersion;
    if (min !== undefined && (typeof min !== 'string' || !/\d/.test(min))) {
      throw new Error(`${where}.minVersion must be a version string such as "20" or "2.40.0"`);
    }
    const agents = requirement.agents;
    if (agents !== undefined) {
      if (!Array.isArray(agents) || agents.length === 0) {
        throw new Error(`${where}.agents must list at least one of ${PROVIDERS.join(', ')}`);
      }
      for (const agent of agents) {
        if (!PROVIDERS.includes(agent)) {
          throw new Error(`${where}.agents contains "${agent}"; expected ${PROVIDERS.join(' or ')}`);
        }
      }
    }
  }
}
