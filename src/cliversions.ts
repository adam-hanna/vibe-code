import { realpathSync } from 'node:fs';
import { claudeBin } from '@src/claude.js';
import { codexBin, parseOptionTokens } from '@src/codex.js';
import { TESTED_CLI_VERSIONS } from '@src/config.js';
import { run } from '@src/proc.js';
import type { RunFn } from '@src/proc.js';
import { compareVersions, versionOf } from '@src/runtime.js';
import type { AgentProvider } from '@src/runtime.js';
import type { CliVersions } from '@src/types.js';

/**
 * Which `claude` and `codex` this machine has, and whether they still take
 * every flag vibe passes (#298).
 *
 * vibe inherits whatever versions are installed, and an upstream change - a
 * removed flag, a changed event shape - used to fail late: a turn broke after
 * it was spawned, or a parser quietly read nothing. Three rules, all settled
 * with the owner:
 *
 * - **Tested, not a floor.** `TESTED_CLI_VERSIONS` is what this build was
 *   tested against. A different version warns, names the command that moves to
 *   the tested one, and the run continues. There is no minimum and no ceiling:
 *   being older is not evidence of breakage, and a ceiling would refuse every
 *   user the day a vendor ships.
 * - **Refuse only on a missing capability.** The evidence is the CLI's own
 *   `--help`: a flag vibe passes that the help does not declare. Help that
 *   cannot be read is not evidence that a flag is missing - `forkHelp`'s rule in
 *   `src/codex.ts`, carried over unchanged - so it warns and never refuses.
 * - **A plain child process from vibe's own process.** Not a model turn and
 *   not the toolchain contract: `ToolRequirement.minVersion` is for tools the
 *   agents probe inside their own shells, which is a different mechanism.
 *
 * Every read is cached once per process, like `forkHelp`.
 */

const PROVIDERS: readonly AgentProvider[] = ['claude', 'codex'];

/** How each binary is found. Injected by the tests, which spawn nothing. */
export type CliBins = Readonly<Record<AgentProvider, () => string>>;

const REAL_BINS: CliBins = { claude: claudeBin, codex: codexBin };

let versionsPromise: Promise<CliVersions> | null = null;
const helpCache = new Map<string, Promise<string | null>>();

/** Exported for the tests, which must not inherit another case's reads. */
export function resetCliProbes(): void {
  versionsPromise = null;
  helpCache.clear();
}

function binOf(bins: CliBins, cli: AgentProvider): string | null {
  try {
    return bins[cli]();
  } catch {
    return null;
  }
}

async function versionFor(exec: RunFn, bin: string | null): Promise<string | null> {
  if (bin === null) return null;
  try {
    const { code, stdout, stderr } = await exec(bin, ['--version']);
    return code === 0 ? versionOf(`${stdout}\n${stderr}`) : null;
  } catch {
    return null;
  }
}

/**
 * `<bin> --version` for both CLIs, read once per process. A version that could
 * not be run or read is null - "not known", never a guessed value and never a
 * refusal. Never throws.
 */
export function detectCliVersions(exec: RunFn = run, bins: CliBins = REAL_BINS): Promise<CliVersions> {
  versionsPromise ??= (async () => ({
    claude: await versionFor(exec, binOf(bins, 'claude')),
    codex: await versionFor(exec, binOf(bins, 'codex')),
  }))();
  return versionsPromise;
}

// ---- Install method, and the command that moves to the tested version ------

export type InstallMethod = 'native' | 'npm' | 'unknown';

/**
 * How a CLI was installed, read off where its binary resolves. Measured on the
 * owner's machine: the native installer puts `claude` under
 * `~/.local/share/claude/versions/<v>`, and an npm global resolves into
 * `node_modules/@openai/codex` (or `@anthropic-ai/claude-code`). Anything else
 * is `unknown`, and is said as such rather than guessed.
 */
export function installMethod(cli: AgentProvider, resolvedPath: string): InstallMethod {
  let real = resolvedPath;
  try {
    real = realpathSync(resolvedPath);
  } catch {
    // The path as given: a binary that cannot be followed can still be classified.
  }
  if (cli === 'claude' && /[\\/]\.local[\\/]share[\\/]claude[\\/]versions[\\/]/.test(real)) return 'native';
  const pkg = cli === 'claude' ? /node_modules[\\/]@anthropic-ai[\\/]claude-code/ : /node_modules[\\/]@openai[\\/]codex/;
  if (pkg.test(real)) return 'npm';
  return 'unknown';
}

const NPM_PACKAGE: Readonly<Record<AgentProvider, string>> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
};

/**
 * The command(s) that move a CLI to `version`. One command only when the
 * install method is known; otherwise every method, each labelled, because one
 * guessed command presented as *the* command is worse than a choice.
 */
export function moveCommands(cli: AgentProvider, method: InstallMethod, version: string): string[] {
  const npm = `npm i -g ${NPM_PACKAGE[cli]}@${version}`;
  if (method === 'npm') return [npm];
  if (cli === 'claude') {
    if (method === 'native') return [`claude install ${version}`];
    return [`if installed with the native installer: claude install ${version}`, `if installed with npm: ${npm}`];
  }
  return [`if installed with npm: ${npm}`, `if installed another way, reinstall ${version} by that method`];
}

function moveSentence(cli: AgentProvider, bin: string | null, version: string): string {
  const method = bin === null ? 'unknown' : installMethod(cli, bin);
  const commands = moveCommands(cli, method, version);
  return commands.length === 1
    ? `To move to the tested version: ${commands[0]}`
    : `To move to the tested version - ${commands.join('; ')}`;
}

/** What one installed version says against the tested one. */
export interface VersionFinding {
  /** The installed version matches: a line to print at most, never a warning. */
  confirm: string | null;
  warning: string | null;
}

export function versionFinding(
  cli: AgentProvider,
  installed: string | null,
  tested: string,
  bin: string | null,
): VersionFinding {
  if (installed === null) {
    return {
      confirm: null,
      warning:
        `${cli}: the installed version could not be read (\`${cli} --version\`), so it cannot be ` +
        `compared with the tested ${tested}. Continuing.`,
    };
  }
  const order = compareVersions(installed, tested);
  if (order === 0) return { confirm: `${cli} ${installed} (tested ${tested})`, warning: null };
  const relation = order === null ? 'not comparable with' : order < 0 ? 'older than' : 'newer than';
  return {
    confirm: null,
    warning:
      `${cli} ${installed} is installed, ${relation} the tested ${tested}. Continuing - a ` +
      `version is not evidence of breakage. ${moveSentence(cli, bin, tested)}`,
  };
}

// ---- The flags vibe passes, and the help that has to declare them ----------

/**
 * One help text and the flags vibe passes to that command.
 *
 * `run` flags are on some run turn's argv and refuse when missing; `pilot` flags
 * are passed only by the pilot (`src/pilotchat.ts`, `src/pilotcodex.ts`) and only
 * warn, because a run never passes them. `commands` are subcommands the help
 * must list. `tests/cli-flags-source.test.ts` reads the adapter sources and
 * fails on a flag literal missing from these lists, so they cannot drift from
 * the call sites.
 *
 * `codex exec fork` is not here: its own `forkHelp` probe in `src/codex.ts`
 * already decides between the direct vector and the fallback.
 */
export interface CliFlagRequirement {
  cli: AgentProvider;
  /** The arguments after the binary that print the help. */
  help: readonly string[];
  run: readonly string[];
  pilot: readonly string[];
  commands?: readonly string[];
}

const CODEX_PILOT = ['--ignore-user-config', '--disable', '--dangerously-bypass-approvals-and-sandbox'];

export const CLI_FLAG_REQUIREMENTS: readonly CliFlagRequirement[] = [
  {
    cli: 'claude',
    help: ['--help'],
    run: [
      '-p', '--output-format', '--verbose', '--permission-mode', '--append-system-prompt',
      '--resume', '--fork-session', '--session-id', '--model', '--effort', '--json-schema',
      '--tools', '--strict-mcp-config', '--mcp-config', '--settings',
    ],
    pilot: ['--include-partial-messages', '--restricted', '--system-prompt', '--add-dir', '--allowedTools'],
  },
  {
    cli: 'codex',
    help: ['exec', '--help'],
    run: ['--json', '-m', '-c', '-s', '--skip-git-repo-check', '-C', '--output-schema', '-o'],
    pilot: CODEX_PILOT,
    commands: ['resume'],
  },
  {
    // `resume` takes neither -s nor -C, and vibe passes neither to it.
    cli: 'codex',
    help: ['exec', 'resume', '--help'],
    run: ['--json', '-m', '-c', '--skip-git-repo-check', '--output-schema', '-o'],
    pilot: CODEX_PILOT,
  },
];

/** `forkHelp`'s rule: exit 0 and something said is the help; anything else is null. */
function readHelp(exec: RunFn, bin: string, args: readonly string[]): Promise<string | null> {
  const key = `${bin}\0${args.join('\0')}`;
  let cached = helpCache.get(key);
  if (cached === undefined) {
    cached = (async () => {
      try {
        const { code, stdout, stderr } = await exec(bin, args);
        const text = `${stdout}\n${stderr}`;
        return code === 0 && text.trim() !== '' ? text : null;
      } catch {
        return null;
      }
    })();
    helpCache.set(key, cached);
  }
  return cached;
}

/** The subcommands a clap-style `Commands:` section lists. */
export function helpCommands(help: string): Set<string> {
  const found = new Set<string>();
  const lines = help.split(/\r?\n/);
  const start = lines.findIndex((line) => /^Commands:\s*$/.test(line));
  if (start < 0) return found;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break;
    const m = /^\s{2,}(\w[\w-]*)(?:\s|$)/.exec(line);
    if (m?.[1] !== undefined) found.add(m[1]);
  }
  return found;
}

export interface CliCheck {
  versions: CliVersions;
  /** Lines that say all is as tested. Never warnings. */
  confirmations: string[];
  warnings: string[];
  /** A flag or subcommand a run passes is missing from help that was read. */
  blocking: string[];
}

/**
 * Detect both versions and read the three help texts. Pure reporting: the
 * caller decides what a blocking reason does, and preflight refuses on one.
 */
export async function checkClis(exec: RunFn = run, bins: CliBins = REAL_BINS): Promise<CliCheck> {
  const versions = await detectCliVersions(exec, bins);
  const out: CliCheck = { versions, confirmations: [], warnings: [], blocking: [] };

  for (const cli of PROVIDERS) {
    const found = versionFinding(cli, versions[cli], TESTED_CLI_VERSIONS[cli], binOf(bins, cli));
    if (found.confirm !== null) out.confirmations.push(found.confirm);
    if (found.warning !== null) out.warnings.push(found.warning);
  }

  for (const req of CLI_FLAG_REQUIREMENTS) {
    const command = `${req.cli} ${req.help.join(' ')}`;
    const bin = binOf(bins, req.cli);
    const help = bin === null ? null : await readHelp(exec, bin, req.help);
    if (help === null) {
      out.warnings.push(
        `\`${command}\` could not be read, so the flags vibe passes were not checked against it. ` +
          'That is not evidence a flag is missing; continuing.',
      );
      continue;
    }
    const options = parseOptionTokens(help);
    const commands = helpCommands(help);
    const missing = [
      ...req.run.filter((flag) => !options.has(flag)),
      ...(req.commands ?? []).filter((name) => !commands.has(name)).map((name) => `the \`${name}\` subcommand`),
    ];
    const installed = versions[req.cli] ?? 'version unknown';
    const tested = TESTED_CLI_VERSIONS[req.cli];
    for (const what of missing) {
      out.blocking.push(
        `${req.cli} no longer declares ${what}: \`${command}\` does not list it, and vibe passes it on ` +
          `run turns. Installed ${req.cli} ${installed}, tested with ${tested}. ` +
          `${moveSentence(req.cli, bin, tested)}`,
      );
    }
    const pilotMissing = req.pilot.filter((flag) => !options.has(flag));
    if (pilotMissing.length > 0) {
      out.warnings.push(
        `\`${command}\` does not declare ${pilotMissing.join(', ')}, which only the pilot passes. ` +
          `Runs are unaffected; the pilot on ${req.cli} will fail until it is moved. ` +
          `Installed ${req.cli} ${installed}, tested with ${tested}.`,
      );
    }
    if (missing.length === 0 && pilotMissing.length === 0) {
      const count = req.run.length + req.pilot.length + (req.commands?.length ?? 0);
      out.confirmations.push(`${command}: all ${count} flags and subcommands vibe passes are declared`);
    }
  }
  return out;
}
