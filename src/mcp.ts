import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentEnv } from '@src/auth.js';
import type { RunFn } from '@src/proc.js';
import { mcpServersFor, roleEnabled, ROLE_NAMES } from '@src/roles.js';
import type { Role, RoleTable } from '@src/roles.js';
import type { Config } from '@src/types.js';

/**
 * Which MCP servers a run's children reach: none, unless a role names one (#138).
 *
 * Before this module every `claude` and `codex` child a run spawned read the
 * user's own MCP configuration, so every role - the read-only critic, answerer
 * and reviewer included - could reach every server the person had configured
 * for themselves: a mailbox, a calendar, a GitHub token, a docs store. No
 * archived run had ever called one; the implementer reaches GitHub through `gh`.
 * So the default is all off for every role, and `roles.<role>.mcpServers` is the
 * one way back in.
 *
 * Each provider is closed by its own mechanism, and the two are not the same
 * strength, which is why the wording below says so rather than calling both
 * "off":
 *
 * - **Claude is replaced.** `--strict-mcp-config` ignores every MCP source the
 *   CLI would otherwise read, and a granted server is handed back through
 *   `--mcp-config` from a definition vibe read itself. Nothing is merged.
 * - **Codex is disabled by name.** There is no replace. Measured on codex-cli
 *   0.157.1 in a throwaway `CODEX_HOME`: `-c 'mcp_servers={}'` MERGES into the
 *   configured table - both test servers stayed enabled - while
 *   `-c mcp_servers.<name>.enabled=false` disables that one server. So every
 *   Codex child is preceded by `codex mcp list --json` in the child's own cwd,
 *   which lists user-level and trusted-project (`.codex/config.toml`) servers,
 *   and every listed server the role was not granted is switched off. That is a
 *   deny-list, and its residual weakness is stated wherever it is described: a
 *   server Codex does not list cannot be disabled. `--ignore-user-config` would
 *   be a true replace and is deliberately not used for runs: it discards the
 *   person's whole Codex config - model providers, profiles, sandbox settings -
 *   to close one table in it. (The pilot uses it, because the pilot wants none
 *   of that config; a run does.)
 */

/**
 * How each provider enforces the closure, in the words `vibe doctor` prints and
 * the settings matrix (#138 run 2) will reuse. One place, so the two surfaces
 * cannot describe the same mechanism differently.
 */
export const MCP_ENFORCEMENT = {
  claude: 'replaced (--strict-mcp-config)',
  codex: 'disabled by name',
} as const;

/** What "disabled by name" cannot do, said beside it every time. */
export const CODEX_MCP_CAVEAT = 'a deny-list: a server Codex does not list cannot be disabled';

/** A provider's enforcement as one labelled phrase: `Codex: disabled by name`. */
function enforcementLabel(provider: 'claude' | 'codex'): string {
  return provider === 'claude'
    ? `Claude: ${MCP_ENFORCEMENT.claude}`
    : `Codex: ${MCP_ENFORCEMENT.codex}`;
}

/**
 * Each role's effective servers and how its provider enforces them, then the
 * two mechanisms with the Codex caveat. Lines, unindented, for a caller to
 * place.
 */
export function describeMcp(roles: RoleTable): string[] {
  // `role:` rather than doctor's bare `role` column, so the line that states a
  // seat's model and timeout stays the only one that starts with its name.
  const width = Math.max(...ROLE_NAMES.map((role) => role.length)) + 1;
  const lines = ROLE_NAMES.map((role) => {
    const granted = mcpServersFor(role, roles);
    const named = granted.length === 0 ? 'none' : granted.join(', ');
    return `${`${role}:`.padEnd(width)}  ${named}  (${enforcementLabel(roles[role].provider)})`;
  });
  return [
    ...lines,
    enforcementLabel('claude'),
    `${enforcementLabel('codex')} - ${CODEX_MCP_CAVEAT}`,
  ];
}

// ---- Claude -----------------------------------------------------------------

/**
 * A claude.ai connector, as `claude mcp list` names one ("claude.ai Gmail").
 *
 * These are refused as grants, by name: their definitions live on the account,
 * not in any file vibe can read, so under `--strict-mcp-config` there is nothing
 * to hand back.
 */
export function isClaudeAiConnector(name: string): boolean {
  return name.startsWith('claude.ai ');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A JSON file's contents, or null for one that is missing or unreadable. */
function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** The `mcpServers` table off a parsed object, keeping only object-valued entries. */
function serversIn(v: unknown): [string, Record<string, unknown>][] {
  if (!isRecord(v)) return [];
  const table = v['mcpServers'];
  if (!isRecord(table)) return [];
  return Object.entries(table).filter((entry): entry is [string, Record<string, unknown>] =>
    isRecord(entry[1]),
  );
}

export interface ClaudeMcpSources {
  /** The turn's working directory - the worktree, when the run has one. */
  cwd: string;
  /** The repository the run belongs to (`state.targetDir`). */
  repoDir: string;
  home: string;
  /** `CLAUDE_CONFIG_DIR`, which moves `.claude.json` when set. */
  configDir?: string | undefined;
}

/**
 * Every MCP server definition vibe can read for a turn in `cwd`, by name.
 *
 * The sources are the ones the brief names and no others, highest precedence
 * first, following Claude's own scopes (local over project over user):
 *
 * 1. `.claude.json`'s per-project entry - for `cwd`, then for `repoDir`;
 * 2. `.mcp.json` - in `cwd`, then in `repoDir`;
 * 3. `.claude.json`'s top-level `mcpServers`.
 *
 * `repoDir` is read as well as `cwd` because with `git.worktree` on, a turn runs
 * in `.worktrees/<id>` while the repository's own `.mcp.json` - and its
 * `.claude.json` project entry - sit at the repository root.
 *
 * A file that is missing or does not parse contributes nothing, and a grant that
 * then resolves nowhere is refused by name: guessing a definition would be the
 * never-invent-a-number rule broken for a command line.
 */
export function claudeMcpDefinitions(sources: ClaudeMcpSources): Map<string, Record<string, unknown>> {
  const dirs = [...new Set([path.resolve(sources.cwd), path.resolve(sources.repoDir)])];
  const claudeJson = readJson(path.join(sources.configDir ?? sources.home, '.claude.json'));
  const projects = isRecord(claudeJson) && isRecord(claudeJson['projects']) ? claudeJson['projects'] : {};

  const layers: [string, Record<string, unknown>][][] = [
    ...dirs.map((dir) => serversIn(projects[dir])),
    ...dirs.map((dir) => serversIn(readJson(path.join(dir, '.mcp.json')))),
    serversIn(claudeJson),
  ];

  const found = new Map<string, Record<string, unknown>>();
  for (const layer of layers) {
    for (const [name, def] of layer) if (!found.has(name)) found.set(name, def);
  }
  return found;
}

/**
 * The definitions a Claude role's grant re-supplies, or a refusal naming the
 * role and the server. Exact names only: a near miss is a refusal, not a match.
 */
export function resolveClaudeGrants(
  role: Role,
  granted: readonly string[],
  definitions: ReadonlyMap<string, Record<string, unknown>>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of granted) {
    if (isClaudeAiConnector(name)) {
      throw new Error(
        `roles.${role}.mcpServers names "${name}", a claude.ai connector. Its definition is in ` +
          'no file vibe can read, so it cannot be re-supplied under --strict-mcp-config.',
      );
    }
    const def = definitions.get(name);
    if (def === undefined) {
      throw new Error(
        `roles.${role}.mcpServers names "${name}", which is in none of ~/.claude.json (user ` +
          'or this project) or .mcp.json.',
      );
    }
    out[name] = def;
  }
  return out;
}

/**
 * The flags that close a Claude child's MCP access, re-supplying `definitions`.
 *
 * `--strict-mcp-config` always, so every MCP source the CLI would read on its
 * own - user, project, local, and the account's claude.ai connectors - is
 * ignored. A grant goes back in through `--mcp-config` as a FILE rather than
 * inline JSON: server definitions routinely carry secrets in `env`, and argv is
 * readable by anyone who can list processes. The file is 0600 in a directory of
 * its own, and `cleanup` removes both once the child has exited.
 */
export function claudeMcpArgs(definitions: Readonly<Record<string, Record<string, unknown>>>): {
  args: string[];
  cleanup: () => void;
} {
  if (Object.keys(definitions).length === 0) {
    return { args: ['--strict-mcp-config'], cleanup: () => undefined };
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibe-mcp-'));
  const file = path.join(dir, 'mcp.json');
  writeFileSync(file, JSON.stringify({ mcpServers: definitions }), { encoding: 'utf8', mode: 0o600 });
  return {
    args: ['--strict-mcp-config', '--mcp-config', file],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ---- Codex ------------------------------------------------------------------

/**
 * `codex mcp list --json` with the `-c` overrides the protected child carries,
 * so the listing describes the configuration that child will actually load.
 */
export function codexMcpListArgs(overrides: readonly string[]): string[] {
  return ['mcp', 'list', '--json', ...overrides];
}

/** The `-c` pair every turn and probe carries; the listing must carry it too. */
export function codexEffortOverride(effort: string): string[] {
  return ['-c', `model_reasoning_effort="${effort}"`];
}

/**
 * The listing, or null when it is not one. Not a promised interface, so the
 * parse is strict: an array of objects each with a string `name`, or nothing.
 */
export function parseCodexMcpList(stdout: string): { name: string; enabled: boolean }[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: { name: string; enabled: boolean }[] = [];
  for (const item of parsed) {
    if (!isRecord(item) || typeof item['name'] !== 'string') return null;
    out.push({ name: item['name'], enabled: item['enabled'] !== false });
  }
  return out;
}

/** How long a listing may take. It reads config and starts nothing. */
const LIST_TIMEOUT_MS = 30_000;

/**
 * The names of every MCP server Codex reports for a child in `cwd`, or a throw.
 *
 * Fails closed: a listing that could not be run, exited non-zero, or did not
 * parse refuses the child before it spawns - the same bargain as
 * `gitPrecondition`. Spawning anyway would run the turn with every server the
 * person configured, which is the state this module exists to end.
 */
export async function listCodexMcpServers(
  exec: RunFn,
  bin: string,
  cwd: string,
  overrides: readonly string[],
): Promise<string[]> {
  const refuse = (why: string): Error =>
    new Error(
      `codex mcp list could not be read in ${cwd} (${why}); refusing to spawn codex with MCP ` +
        'servers open',
    );
  let result;
  try {
    result = await exec(bin, codexMcpListArgs(overrides), {
      cwd,
      timeoutMs: LIST_TIMEOUT_MS,
      env: agentEnv('codex'),
    });
  } catch (err) {
    throw refuse(err instanceof Error ? err.message : String(err));
  }
  if (result.code !== 0) {
    throw refuse(`exit ${String(result.code)}: ${result.stderr.trim().slice(-500) || 'no error output'}`);
  }
  const listed = parseCodexMcpList(result.stdout);
  if (listed === null) throw refuse(`unreadable output: ${result.stdout.trim().slice(0, 200)}`);
  return listed.map((server) => server.name);
}

/** A name a dotted `-c` path can address without quoting. */
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * `-c mcp_servers.<name>.enabled=false` for every listed server not granted.
 *
 * Every listed server, enabled or not: switching off one that is already off
 * costs nothing, and it keeps the argv a function of the listing alone. A name
 * that is not a bare TOML key is refused rather than quoted - a dotted path that
 * addressed the wrong table would leave the real server enabled with nothing
 * saying so.
 */
export function codexMcpDisableArgs(listed: readonly string[], granted: readonly string[]): string[] {
  const args: string[] = [];
  for (const name of listed) {
    if (granted.includes(name)) continue;
    if (!BARE_KEY.test(name)) {
      throw new Error(
        `codex mcp list reports a server named ${JSON.stringify(name)}, which cannot be addressed ` +
          'by -c mcp_servers.<name>.enabled=false; refusing to spawn codex with it open',
      );
    }
    args.push('-c', `mcp_servers.${name}.enabled=false`);
  }
  return args;
}

// ---- Before the first turn --------------------------------------------------

export interface McpRefusalContext {
  /** Where the run's children work - the worktree when there is one. */
  cwd: string;
  /** The repository the run belongs to. */
  repoDir: string;
  exec: RunFn;
  /** The codex binary, resolved by the caller (this module stays a leaf). */
  codexBin: () => string;
  home?: string | undefined;
  configDir?: string | undefined;
}

/**
 * Every grant that cannot be honoured, worded for a user. Empty means the run's
 * grants all resolve.
 *
 * Asked before the first turn, so a mistyped name costs a sentence rather than
 * a run. Only enabled roles that named servers are asked about; a table naming
 * none spawns nothing here, so the default run pays no extra child.
 */
export async function mcpRefusals(cfg: Config, roles: RoleTable, ctx: McpRefusalContext): Promise<string[]> {
  const refusals: string[] = [];
  const asking = ROLE_NAMES.filter(
    (role) => roleEnabled(role, cfg) && mcpServersFor(role, roles).length > 0,
  );
  if (asking.length === 0) return refusals;

  const claudeRoles = asking.filter((role) => roles[role].provider === 'claude');
  if (claudeRoles.length > 0) {
    const definitions = claudeMcpDefinitions({
      cwd: ctx.cwd,
      repoDir: ctx.repoDir,
      home: ctx.home ?? os.homedir(),
      configDir: ctx.configDir ?? process.env['CLAUDE_CONFIG_DIR'],
    });
    for (const role of claudeRoles) {
      for (const name of mcpServersFor(role, roles)) {
        try {
          resolveClaudeGrants(role, [name], definitions);
        } catch (err) {
          refusals.push(err instanceof Error ? err.message : String(err));
        }
      }
    }
  }

  const codexRoles = asking.filter((role) => roles[role].provider === 'codex');
  if (codexRoles.length > 0) {
    let listed: string[] | null = null;
    try {
      listed = await listCodexMcpServers(ctx.exec, ctx.codexBin(), ctx.cwd, codexEffortOverride(cfg.codex.effort));
    } catch (err) {
      refusals.push(err instanceof Error ? err.message : String(err));
    }
    if (listed !== null) {
      for (const role of codexRoles) {
        for (const name of mcpServersFor(role, roles)) {
          if (!listed.includes(name)) {
            refusals.push(
              `roles.${role}.mcpServers names "${name}", which codex mcp list does not report in ` +
                `${ctx.cwd}.`,
            );
          }
        }
      }
    }
  }
  return refusals;
}
