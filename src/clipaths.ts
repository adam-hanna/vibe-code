import { existsSync, statSync } from 'node:fs';
import { readGlobalConfig } from '@src/config.js';
import { expandHome } from '@src/proc.js';
import { claudeBin } from '@src/claude.js';
import { codexBin } from '@src/codex.js';
import type { CliStatus } from '@src/protocol.js';

/**
 * Where the two CLIs are, when the person says so (#223).
 *
 * `claudeBin` and `codexBin` have always looked in three places, in this order:
 * an environment variable (`VIBE_CLAUDE_BIN`, `VIBE_CODEX_BIN`), the PATH -
 * preferring a real executable over a `.cmd` shim - and a short list of known
 * install locations. That is right on most machines and invisible on the rest,
 * and the only way to point at a CLI somewhere else was an environment variable
 * a desktop app launched from a menu never sees.
 *
 * So the settings for all projects can name each one: `cli.claude`, `cli.codex`.
 * The environment variable still wins, because it is the more specific act - set
 * for one shell, one invocation - and a setting that silently overrode it would
 * break somebody's script. Then the setting, then the search.
 *
 * **Machine-only, like `pilot`.** A path to an executable is a fact about one
 * machine, and `vibe.config.json` is committed - and a repository naming the
 * binary every agent turn is spawned from is a repository choosing what runs
 * on your machine. `loadConfig` refuses a project file that sets `cli`.
 *
 * Not part of `Config`, for `pilot`'s reason: a run's `state.json` stores its
 * config, and a resume on another machine must not inherit this one's paths.
 */

export type Cli = 'claude' | 'codex';

export const CLI_ENV: Readonly<Record<Cli, string>> = {
  claude: 'VIBE_CLAUDE_BIN',
  codex: 'VIBE_CODEX_BIN',
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The global file's `cli` section, or a refusal naming the field. */
export function readCliPaths(globalRaw: Readonly<Record<string, unknown>>): Record<Cli, string | null> {
  const out: Record<Cli, string | null> = { claude: null, codex: null };
  const section = globalRaw['cli'];
  if (section === undefined) return out;
  if (!isRecord(section)) throw new Error('cli must be an object');
  for (const key of Object.keys(section)) {
    if (key !== 'claude' && key !== 'codex') {
      throw new Error(`cli.${key} is not a setting; the two are claude and codex`);
    }
    const value = section[key];
    // Null or empty is "search for it", which is what clearing the field means.
    if (value === null || value === '') continue;
    if (typeof value !== 'string') throw new Error(`cli.${key} must be a path to the ${key} executable`);
    out[key] = value.trim();
  }
  return out;
}

/** Refuse a project file that names `cli` (see the module comment). */
export function refuseProjectCli(raw: Readonly<Record<string, unknown>>, label: string): void {
  if (raw['cli'] === undefined) return;
  throw new Error(
    `${label} sets cli, and only your settings for all projects can: a path to an executable ` +
      'is a fact about one machine, and this file is committed',
  );
}

/**
 * The path the settings name for one CLI, checked to exist, or null when they
 * name none. Throws with the setting's name when the file is not there, rather
 * than falling through to the search - a person who typed a path meant that one.
 *
 * Read on every call. It is one small file, and reading it each time is what
 * lets a change in Settings reach the next turn without restarting the host.
 */
export function configuredBin(cli: Cli): string | null {
  let configured: string | null;
  try {
    configured = readCliPaths(readGlobalConfig())[cli];
  } catch {
    // An unreadable settings file is reported where settings are read; here it
    // must not stop a run from finding a CLI that is on PATH.
    return null;
  }
  if (configured === null) return null;
  const at = expandHome(configured);
  if (!existsSync(at) || statSync(at).isDirectory()) {
    throw new Error(`cli.${cli} in your settings points at ${at}, and there is no ${cli} executable there`);
  }
  return at;
}

/**
 * Where one CLI is right now, and which of the three looks found it - for the
 * settings screen, which explains the search and has to show its answer. Never
 * throws: not finding it is an answer, in the resolver's own sentence.
 */
export function cliStatus(cli: Cli): CliStatus {
  let configured: string | null = null;
  try {
    configured = readCliPaths(readGlobalConfig())[cli];
  } catch {
    configured = null;
  }
  const via: CliStatus['via'] = process.env[CLI_ENV[cli]] ? 'env' : configured !== null ? 'settings' : 'search';
  try {
    return { configured, via, found: cli === 'claude' ? claudeBin() : codexBin(), problem: null };
  } catch (err: unknown) {
    return { configured, via, found: null, problem: err instanceof Error ? err.message : String(err) };
  }
}
