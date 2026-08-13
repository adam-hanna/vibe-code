import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { detectPathStyle, pathListSeparator, toAgentPath } from '@src/pathstyle.js';
import type { PathStyle } from '@src/pathstyle.js';
import { hostDirectoryFor } from '@src/hosttools.js';
import type {
  AgentAdapter,
  AgentRuntime,
  AgentShell,
  Platform,
  PreparedEnvironment,
  ProbeContext,
  RepairVerification,
  ToolchainContract,
} from '@src/runtime.js';
import { envFromRecord, parseKeyValueRecord, toolsFromRecord } from '@src/runtime.js';

/**
 * Runs one throwaway Claude turn and returns its stdout.
 *
 * Injected so the adapter stays testable and does not reach into the
 * orchestrator. `probeRuntime` ignores the return value - its results arrive
 * out-of-band in the artifact the hook writes - but `verifyRepair` needs it.
 */
export type ClaudeProbeExecutor = (input: {
  args: readonly string[];
  prompt: string;
  cwd: string;
  timeoutMs: number;
}) => Promise<string>;

const PROBE_FILE = 'claude-probe.txt';
const PROBE_HOOK_FILE = 'claude-probe-hook.sh';
const PROBE_SETTINGS_FILE = 'claude-probe-settings.json';
const REPAIR_HOOK_FILE = 'claude-repair-hook.sh';
const REPAIR_SETTINGS_FILE = 'claude-repair-settings.json';
const RECEIPT_FILE = 'claude-repair-receipt.txt';

const BEGIN = 'VIBE-PROBE-BEGIN';
const END = 'VIBE-PROBE-END';

/**
 * Claude Code adapter.
 *
 * Verified behaviour this encodes:
 * - `--settings` `env` passes arbitrary variables through but silently drops
 *   `PATH`, so PATH repair must go through `CLAUDE_ENV_FILE`.
 * - A `SessionStart` hook writes to `$CLAUDE_ENV_FILE`, which Claude Code runs
 *   as a script preamble before every Bash command. Setting `PATH` there works:
 *   `command -v node` went from not-found to `/c/Program Files/nodejs/node`.
 * - `SessionStart` fires under `claude -p` and again on `--resume` (`source` is
 *   `"startup"` then `"resume"`), so the repair survives every turn and every
 *   session rotation without further work.
 * - Each hook gets its own numbered env file under
 *   `~/.claude/session-env/<session-id>/`, so writing with `>` cannot clobber a
 *   user's existing direnv hook.
 * - A failing hook is completely silent: empty stderr, `is_error: false`,
 *   `subtype: "success"`, exit 0. Nothing may be inferred from a turn
 *   succeeding; verification is vibe's job and is done against artifacts.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly provider = 'claude' as const;
  /** Hooks give a deterministic channel: vibe's own script, no model tokens. */
  readonly probeChannel = 'hook' as const;

  private repairSettingsPath: string | null = null;

  constructor(
    private readonly execute: ClaudeProbeExecutor,
    private readonly workDir: string,
  ) {}

  /** Settings arguments callers must pass on every real turn once prepared. */
  get turnArgs(): readonly string[] {
    return this.repairSettingsPath === null ? [] : ['--settings', this.repairSettingsPath];
  }

  async probeRuntime(ctx: ProbeContext): Promise<AgentRuntime> {
    mkdirSync(this.workDir, { recursive: true });

    const probePath = path.join(this.workDir, PROBE_FILE);
    const hookPath = path.join(this.workDir, PROBE_HOOK_FILE);
    const settingsPath = path.join(this.workDir, PROBE_SETTINGS_FILE);

    // The hook runs in the agent's shell, so its own paths must already be in
    // the agent's convention. The style is not known until the probe returns,
    // and Claude uses a POSIX shell on every platform it supports, so msys is
    // the safe assumption for this one bootstrap file.
    writeFileSync(hookPath, renderProbeHook(toAgentPath(probePath, 'msys'), ctx.contract), 'utf8');
    writeFileSync(settingsPath, renderHookSettings([toAgentPath(hookPath, 'msys')]), 'utf8');
    writeFileSync(probePath, '', 'utf8');

    await this.execute({
      args: ['--settings', settingsPath],
      prompt: 'Reply with the single word: ok',
      cwd: ctx.cwd,
      timeoutMs: ctx.timeoutMs,
    });

    const raw = readFileSync(probePath, 'utf8');
    if (!raw.trim()) {
      throw new Error(
        'The Claude SessionStart probe hook produced no output. Hook failures are ' +
          'silent by design, so an empty artifact is the only signal available. ' +
          `Check that bash can execute ${hookPath}.`,
      );
    }
    return parseProbeRecord(raw, ctx.cwd);
  }

  /**
   * Write a `SessionStart` hook that repairs PATH for every Bash command.
   *
   * Only tools the probe found broken are repaired, and only by *prepending*
   * their host directory - the agent's own PATH entries stay intact and the
   * repair only has to win the lookup.
   */
  async prepareEnvironment(
    runtime: AgentRuntime,
    contract: ToolchainContract,
  ): Promise<PreparedEnvironment> {
    await Promise.resolve();
    mkdirSync(this.workDir, { recursive: true });

    const broken = Object.keys(contract).filter((tool) => runtime.tools[tool]?.available !== true);
    const unreachable = broken.filter((tool) => isDenial(runtime.tools[tool]?.failure ?? null));
    const repairable = broken.filter((tool) => !unreachable.includes(tool));

    const prepend = dedupe(
      repairable
        .map((tool) => hostDirectoryFor(tool))
        .filter((dir): dir is string => dir !== null)
        .map((dir) => toAgentPath(dir, runtime.pathStyle)),
    );

    // A denial is not a PATH problem and prepending a directory cannot fix it.
    // Say so rather than silently producing a repair that will not work.
    const promptHint =
      unreachable.length > 0
        ? `These tools exist but are not accessible to you: ${unreachable.join(', ')}. ` +
          'Do not attempt to work around this; report it instead.'
        : null;

    if (prepend.length === 0) {
      this.repairSettingsPath = null;
      return {
        spawnEnv: {},
        extraArgs: [],
        artifacts: [],
        promptHint,
        mechanisms: unreachable.length > 0 ? ['prompt-hint'] : ['none'],
      };
    }

    const receiptPath = path.join(this.workDir, RECEIPT_FILE);
    const hookPath = path.join(this.workDir, REPAIR_HOOK_FILE);
    const settingsPath = path.join(this.workDir, REPAIR_SETTINGS_FILE);
    const payload = renderEnvFile(prepend, {}, runtime.pathStyle);

    writeFileSync(
      hookPath,
      renderRepairHook(payload, toAgentPath(receiptPath, 'msys')),
      'utf8',
    );
    writeFileSync(settingsPath, renderHookSettings([toAgentPath(hookPath, 'msys')]), 'utf8');
    writeFileSync(receiptPath, '', 'utf8');
    this.repairSettingsPath = settingsPath;

    return {
      spawnEnv: {},
      extraArgs: ['--settings', settingsPath],
      artifacts: [receiptPath, hookPath, settingsPath],
      promptHint,
      mechanisms: unreachable.length > 0 ? ['claude-env-file', 'prompt-hint'] : ['claude-env-file'],
    };
  }

  /**
   * Confirm the repair reached the place that matters.
   *
   * Deliberately a Bash-tool turn rather than another hook: hooks and Bash tool
   * calls are different processes, and only the latter gets the
   * `CLAUDE_ENV_FILE` preamble. A hook-based re-probe would report the
   * unrepaired baseline and pass nothing useful. This is the one place the
   * model is used as transport - fixed commands in, verbatim output out.
   */
  async verifyRepair(ctx: ProbeContext): Promise<RepairVerification> {
    if (this.repairSettingsPath === null) {
      return { ok: true, sessionId: null, detail: 'No repair was prepared.' };
    }

    const receiptPath = path.join(this.workDir, RECEIPT_FILE);
    const stdout = await this.execute({
      args: ['--settings', this.repairSettingsPath],
      prompt: renderVerifyPrompt(ctx.contract),
      cwd: ctx.cwd,
      timeoutMs: ctx.timeoutMs,
    });

    const receipt = parseKeyValueRecord(readFileSync(receiptPath, 'utf8'));
    const sessionId = receipt.get('session') ?? null;
    if (receipt.get('wrote') !== 'ok') {
      return {
        ok: false,
        sessionId,
        detail: `The repair hook did not write ${receiptPath}. Hook failures are silent, so this is the only signal.`,
      };
    }

    const block = extractBlock(stdout);
    if (block === null) {
      return { ok: false, sessionId, detail: 'The verification turn returned no probe block.' };
    }

    const tools = toolsFromRecord(parseKeyValueRecord(block));
    const stillBroken = Object.keys(ctx.contract).filter((tool) => tools[tool]?.available !== true);
    return stillBroken.length === 0
      ? { ok: true, sessionId, detail: 'All contracted tools run in the agent shell.' }
      : {
          ok: false,
          sessionId,
          detail: `Still unavailable after repair: ${stillBroken.join(', ')}.`,
        };
  }
}

/**
 * Body of the file a `SessionStart` hook writes to `$CLAUDE_ENV_FILE`.
 *
 * `PATH` is prepended, never replaced: the agent's shell needs its own entries
 * to keep working. Written for a POSIX shell because that is what Claude uses
 * for Bash tool calls on every platform, including Windows.
 */
export function renderEnvFile(
  prependPath: readonly string[],
  vars: Readonly<Record<string, string>> = {},
  style: PathStyle = 'msys',
): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(vars)) {
    lines.push(`export ${key}='${value.replace(/'/g, `'\\''`)}'`);
  }
  if (prependPath.length > 0) {
    const separator = pathListSeparator(style);
    lines.push(`export PATH="${prependPath.join(separator)}${separator}$PATH"`);
  }
  return `${lines.join('\n')}\n`;
}

/** Settings fragment registering `SessionStart` command hooks, in order. */
export function renderHookSettings(hookCommands: readonly string[]): string {
  return `${JSON.stringify(
    {
      hooks: {
        SessionStart: [
          { hooks: hookCommands.map((command) => ({ type: 'command', command: `bash "${command}"` })) },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * The repair hook.
 *
 * The payload is emitted through a quoted heredoc so `$PATH` survives into the
 * env file unexpanded - it must expand later, in the agent's shell, against the
 * agent's own PATH. Expanding it here would bake in the hook process's PATH,
 * which is a different environment.
 */
export function renderRepairHook(envPayload: string, receiptPath: string): string {
  return [
    '#!/bin/bash',
    '# Generated by vibe. Repairs the agent shell environment.',
    `RECEIPT="${receiptPath}"`,
    'payload=$(cat)',
    `session=$(printf %s "$payload" | sed -n 's/.*"session_id":"\\([^"]*\\)".*/\\1/p')`,
    ': > "$RECEIPT"',
    'echo "session=$session" >> "$RECEIPT"',
    'if [ -z "$CLAUDE_ENV_FILE" ]; then',
    '  echo "wrote=no-env-file" >> "$RECEIPT"',
    '  exit 0',
    'fi',
    "cat > \"$CLAUDE_ENV_FILE\" <<'VIBE_ENV_EOF'",
    envPayload.trimEnd(),
    'VIBE_ENV_EOF',
    'echo "wrote=ok" >> "$RECEIPT"',
    'echo "target=$CLAUDE_ENV_FILE" >> "$RECEIPT"',
    'exit 0',
    '',
  ].join('\n');
}

/**
 * The probe script.
 *
 * Emits flat `key=value` records rather than JSON: assembling correct JSON in
 * shell is a bug farm and the parser on the other side is ours. Every tool is
 * *executed*, because a tool can be on PATH, have a valid `PATHEXT`, and still
 * be refused by a sandbox.
 */
export function renderProbeHook(outputPath: string, contract: ToolchainContract): string {
  const lines: string[] = [
    '#!/bin/bash',
    '# Generated by vibe. Reports the agent shell it runs inside.',
    `OUT="${outputPath}"`,
    ': > "$OUT"',
    'payload=$(cat)',
    `echo "session=$(printf %s "$payload" | sed -n 's/.*"session_id":"\\([^"]*\\)".*/\\1/p')" >> "$OUT"`,
    'echo "shell=${SHELL:-unknown}" >> "$OUT"',
    'echo "msystem=${MSYSTEM:-}" >> "$OUT"',
    'echo "uname=$(uname -s 2>/dev/null || echo unknown)" >> "$OUT"',
    'echo "path=$PATH" >> "$OUT"',
    'echo "pathext=${PATHEXT:-}" >> "$OUT"',
    'echo "cwd=$(pwd)" >> "$OUT"',
  ];

  for (const [tool, requirement] of Object.entries(contract)) {
    const safe = tool.replace(/[^A-Za-z0-9_-]/g, '');
    lines.push(
      `out=$(${requirement.probe} 2>&1); code=$?`,
      `echo "tool.${safe}.exit=$code" >> "$OUT"`,
      `echo "tool.${safe}.out=$(printf %s "$out" | head -1 | tr -d '\\r')" >> "$OUT"`,
      `echo "tool.${safe}.which=$(command -v ${safe} 2>/dev/null || echo '')" >> "$OUT"`,
    );
  }

  lines.push('exit 0', '');
  return lines.join('\n');
}

/** Verification prompt. The model runs fixed commands and echoes raw output. */
export function renderVerifyPrompt(contract: ToolchainContract): string {
  const checks = Object.entries(contract)
    .map(([tool, requirement]) => `${tool}\t${requirement.probe}`)
    .join('\n');

  return [
    'Environment check. Do not modify any files.',
    '',
    'Run each command below with the Bash tool and report the results verbatim',
    `between ${BEGIN} and ${END}, one key=value per line, no commentary:`,
    '',
    '  tool.<name>.exit=<exit code>',
    '  tool.<name>.out=<first line of output, including any error>',
    '  tool.<name>.which=<resolved path, or empty>',
    '',
    checks,
  ].join('\n');
}

/** Pull the sentinel-delimited block out of a turn's output. */
export function extractBlock(stdout: string): string | null {
  const start = stdout.indexOf(BEGIN);
  const end = stdout.indexOf(END, start + 1);
  if (start < 0 || end < 0) return null;
  return stdout.slice(start + BEGIN.length, end).trim();
}

/** Parse the hook's `key=value` output into a runtime snapshot. */
export function parseProbeRecord(raw: string, hostCwd: string): AgentRuntime {
  const record = parseKeyValueRecord(raw);

  const uname = record.get('uname') ?? '';
  const platform: Platform = /mingw|msys|cygwin|windows/i.test(uname)
    ? 'windows'
    : uname === 'Darwin'
      ? 'darwin'
      : 'linux';

  const shellRaw = record.get('shell') ?? '';
  const shell: AgentShell = shellRaw.includes('bash')
    ? 'bash'
    : shellRaw.includes('zsh')
      ? 'zsh'
      : shellRaw === ''
        ? 'unknown'
        : 'sh';

  return {
    provider: 'claude',
    platform,
    shell,
    pathStyle: detectPathStyle({
      platform,
      shell: shellRaw,
      msystem: record.get('msystem'),
      cwdSample: record.get('cwd'),
      pathSample: record.get('path'),
    }),
    cwd: hostCwd,
    // Claude's Bash tool is not sandboxed the way Codex's is: permission mode
    // governs tool use, not filesystem reach, so nothing is denied at the OS
    // level. `execRoots` stays empty because no restriction applies.
    access: { read: 'full', write: 'workspace', execRoots: [], networkAllowed: true },
    tools: toolsFromRecord(record),
    env: envFromRecord(record),
    probedAt: new Date().toISOString(),
    sessionId: record.get('session') ?? null,
  };
}

/**
 * Where vibe's own process finds a tool - the source of the repair.
 *
 * This is the one place vibe's environment is legitimately authoritative: it is
 * being used to locate a binary on disk, not to predict what the agent can see.
 */
function isDenial(failure: string | null): boolean {
  return /access is denied|unauthorized|permission denied|eacces|eperm/i.test(failure ?? '');
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}
