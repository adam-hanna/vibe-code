import { ANSWERS_SCHEMA, FINDINGS_SCHEMA } from '@src/schemas.js';
import type { AgentProvider } from '@src/runtime.js';
import type { Config, PermissionMode, Sandbox } from '@src/types.js';

/** Whether a turn may change the working tree. The one place that intent is stated. */
export type Access = 'read-only' | 'write';

export type Role = 'planner' | 'implementer' | 'critic' | 'answerer' | 'reviewer';

export type RoleSpec =
  | { provider: 'claude'; access: Access }
  | { provider: 'codex'; access: Access; schema: object };

/**
 * The shape of `ROLES`, so the functions below can be handed a different one.
 *
 * Not a config surface: there is exactly one table, `ROLES`, and every consumer
 * defaults to it. The parameter exists so a test can point a table at the other
 * provider and prove a site follows it - the same reason `runTurn` takes its
 * providers and `withConcurrentCompaction` takes its turn.
 */
export type RoleTable = Record<Role, RoleSpec>;

/**
 * Who does what, fixed at today's assignment: Claude plans and implements,
 * Codex critiques, answers and reviews. Deliberately a constant and not a
 * config key - making these swappable is its own change.
 *
 * The schema rides on the role rather than being sniffed out of the turn label,
 * which is what the previous `schemaName.startsWith('answers')` check did.
 */
export const ROLES: Record<Role, RoleSpec> = {
  planner: { provider: 'claude', access: 'read-only' },
  implementer: { provider: 'claude', access: 'write' },
  critic: { provider: 'codex', access: 'read-only', schema: FINDINGS_SCHEMA },
  answerer: { provider: 'codex', access: 'read-only', schema: ANSWERS_SCHEMA },
  reviewer: { provider: 'codex', access: 'read-only', schema: FINDINGS_SCHEMA },
};

export function claudePermission(access: Access): PermissionMode {
  return access === 'write' ? 'bypassPermissions' : 'plan';
}

/**
 * Read-only yields the configured sandbox rather than the literal 'read-only'.
 *
 * `codex.sandbox` is a user setting, and cli.ts already warns about a
 * non-default one rather than forbidding it. Hardcoding the literal here would
 * silently discard that setting on the first Codex turn - a behaviour change,
 * which this seam is not allowed to make.
 */
export function codexSandbox(access: Access, cfg: Config): Sandbox {
  return access === 'write' ? 'workspace-write' : cfg.codex.sandbox;
}

/**
 * The strongest access this provider can hold on this run.
 *
 * Derived from ROLES rather than from the provider's name, so preflight's
 * enforcement level cannot drift out of step with what a turn is actually
 * spawned with. The sandbox clause is not a second notion of write capability:
 * `codexSandbox('read-only', cfg)` is literally what a read-only Codex turn is
 * spawned with, and `--no-codex-session` plus `workspace-write` yields a Codex
 * that can rewrite the tree on every turn while every ROLES entry still says
 * read-only.
 */
export function providerAccess(provider: AgentProvider, cfg: Config): Access {
  for (const spec of Object.values(ROLES)) {
    if (spec.provider === provider && spec.access === 'write') return 'write';
  }
  if (provider === 'codex' && codexSandbox('read-only', cfg) !== 'read-only') return 'write';
  return 'read-only';
}

/**
 * Which role an agent holding several is described by, most defining first.
 *
 * An explicit list rather than `ROLES`' declaration order, which would pick
 * `planner` and `critic` and change the environment block a run has been
 * sending for its whole history. A provider-to-label constant would have been
 * the third option and is the thing this change exists to delete.
 */
const DESCRIBED_BY: readonly Role[] = [
  'implementer',
  'reviewer',
  'critic',
  'answerer',
  'planner',
];

/** The role a prompt should call this provider by, or null if it holds none. */
export function describedRole(provider: AgentProvider, roles: RoleTable = ROLES): Role | null {
  return DESCRIBED_BY.find((role) => roles[role].provider === provider) ?? null;
}

/**
 * The role whose session `rotateSession` compacts.
 *
 * There is one session vibe manages - `state.sessionId`, its measurement and
 * its handoff - and it is the one the writing Claude role talks through. Stated
 * as a role so the rule below is about who is being interrupted rather than
 * about a provider's name.
 */
export const ROTATING_ROLE: Role = 'implementer';

/**
 * Whether a rotation may run alongside a turn in this role.
 *
 * Only when the agent doing the work is not the agent whose session is being
 * rotated. That was always the rule; it was written as `compactDuringCodex`,
 * which is true of today's table and of nothing else.
 */
export function rotatesConcurrentlyWith(workRole: Role, roles: RoleTable = ROLES): boolean {
  return roles[workRole].provider !== roles[ROTATING_ROLE].provider;
}

/**
 * Whether the run is configured to spend a turn on this role.
 *
 * `questions.askCodex` is provider-named for history - renaming it would touch
 * every stored `state.config` and every user's config file - but what it decides
 * is whether *the answerer* runs. Read by role, so a table that puts the
 * answerer elsewhere still honours it.
 */
export function roleEnabled(role: Role, cfg: Config): boolean {
  return role === 'answerer' ? cfg.questions.askCodex : true;
}

/** Weakest to strongest, so "the most a turn could be given" is a max. */
const SANDBOX_RANK: Readonly<Record<Sandbox, number>> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
};

/**
 * The sandbox preflight must probe under: the strongest one any Codex turn on
 * this table is actually spawned with.
 *
 * Derived from `codexSandbox` rather than read off `cfg.codex.sandbox`, which is
 * what the probe used to do. The two agree for every value today, because no
 * Codex role writes - so nothing about any current configuration changes - but
 * they are two different statements, and the moment a Codex role holds `write`
 * the raw key would have preflight vouching for a sandbox no turn ever runs in.
 *
 * The maximum is taken over the sandboxes turns are *spawned* with and nothing
 * else. Seeding it with the read-only sandbox would put `cfg.codex.sandbox` back
 * in the running even where no turn receives it: a table whose only Codex role
 * writes is spawned with `workspace-write` however `codex.sandbox` reads, and
 * probing the wider `danger-full-access` would clear tools the run cannot then
 * execute - preflight passing for a turn that fails.
 */
export function codexProbeSandbox(cfg: Config, roles: RoleTable = ROLES): Sandbox {
  let strongest: Sandbox | null = null;
  for (const spec of Object.values(roles)) {
    if (spec.provider !== 'codex') continue;
    const sandbox = codexSandbox(spec.access, cfg);
    if (strongest === null || SANDBOX_RANK[sandbox] > SANDBOX_RANK[strongest]) strongest = sandbox;
  }
  // No Codex role at all: nothing is spawned, so the probe falls back to what a
  // read-only turn would have been given rather than inventing a wider one.
  return strongest ?? codexSandbox('read-only', cfg);
}

/** Which providers hold these roles, deduped and in a stable order. */
export function providersForRoles(
  wanted: readonly Role[],
  roles: RoleTable = ROLES,
): AgentProvider[] {
  const held = new Set(wanted.map((role) => roles[role].provider));
  return (['claude', 'codex'] as const).filter((provider) => held.has(provider));
}

/**
 * How long a turn in this role gets.
 *
 * The split it replaces was a role fact stated as a provider one: implementing
 * takes longer than reviewing, so Claude got two keys and Codex one. Which key
 * is read is now decided by the role's access. The *sections* are still
 * provider-named, and Codex still has a single `timeoutMs` - so a writing Codex
 * role would get the reviewing figure. Expressing that needs a new key, which is
 * a config surface and belongs to the change that makes roles configurable.
 */
export function turnTimeoutMs(role: Role, cfg: Config, roles: RoleTable = ROLES): number {
  const spec = roles[role];
  if (spec.provider === 'claude') {
    return spec.access === 'write' ? cfg.claude.implementTimeoutMs : cfg.claude.planTimeoutMs;
  }
  return cfg.codex.timeoutMs;
}
