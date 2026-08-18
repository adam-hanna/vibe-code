import { ANSWERS_SCHEMA, FINDINGS_SCHEMA } from '@src/schemas.js';
import type { AgentProvider } from '@src/runtime.js';
import type { Config, PermissionMode, Sandbox } from '@src/types.js';

/** Whether a turn may change the working tree. The one place that intent is stated. */
export type Access = 'read-only' | 'write';

export type Role = 'planner' | 'implementer' | 'critic' | 'answerer' | 'reviewer';

type RoleSpec =
  | { provider: 'claude'; access: Access }
  | { provider: 'codex'; access: Access; schema: object };

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
