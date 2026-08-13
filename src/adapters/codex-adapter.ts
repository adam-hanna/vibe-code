import { detectPathStyle, toAgentPath } from '@src/pathstyle.js';
import type {
  AccessPolicy,
  AgentAdapter,
  AgentRuntime,
  AgentShell,
  Platform,
  PreparedEnvironment,
  ProbeContext,
  ToolchainContract,
} from '@src/runtime.js';
import { envFromRecord, parseKeyValueRecord, toolsFromRecord } from '@src/runtime.js';
import type { Sandbox } from '@src/types.js';

/**
 * Runs one throwaway `codex exec` turn and returns its stdout.
 *
 * Unlike Claude's, this executor's *return value* is the probe: Codex exposes
 * no hook system, so the only channel into its shell is a model turn.
 */
export type CodexProbeExecutor = (input: {
  prompt: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}) => Promise<string>;

/** Delimiters that let vibe find the record inside the model's prose. */
const BEGIN = 'VIBE-PROBE-BEGIN';
const END = 'VIBE-PROBE-END';

/**
 * Codex adapter.
 *
 * Verified behaviour this encodes:
 * - Codex executes commands in **PowerShell** on Windows, not Bash, so its path
 *   style is `win32` while Claude's on the same host is `msys`.
 * - `shell_environment_policy.set.FOO` delivers arbitrary variables but, like
 *   Claude's `--settings` env, silently ignores `PATH`.
 * - Codex inherits the *parent process* environment, `PATH` included, which is
 *   the mechanism that does work. MSYS converts POSIX PATH entries to Windows
 *   form on exec, so vibe sets PATH host-natively and it arrives correct.
 * - The failure that looked like a PATH problem was a **sandbox** problem:
 *   `$env:PATH` contained the Node directory, `PATHEXT` was intact, and
 *   `Test-Path` on the binary returned `Access is denied`. Sandbox policy and
 *   spawn PATH are both required; neither alone is sufficient.
 * - Failures are silent here too - exit code 0 with the error only inside the
 *   transcript text.
 */
export class CodexAdapter implements AgentAdapter {
  readonly provider = 'codex' as const;
  /** No hooks. The model is transport only: fixed script in, verbatim out. */
  readonly probeChannel = 'model-turn' as const;

  constructor(
    private readonly execute: CodexProbeExecutor,
    private readonly sandbox: Sandbox,
  ) {}

  async probeRuntime(ctx: ProbeContext): Promise<AgentRuntime> {
    const stdout = await this.execute({
      prompt: renderProbePrompt(ctx.contract),
      args: ['-s', this.sandbox, '--skip-git-repo-check'],
      cwd: ctx.cwd,
      timeoutMs: ctx.timeoutMs,
    });

    const record = extractRecord(stdout);
    if (record === null) {
      throw new Error(
        `The Codex probe returned no ${BEGIN} block. Codex reports environment ` +
          'failures with exit code 0, so the block is the only reliable signal.',
      );
    }
    return parseProbeRecord(record, ctx.cwd, this.sandbox);
  }

  async prepareEnvironment(
    runtime: AgentRuntime,
    contract: ToolchainContract,
  ): Promise<PreparedEnvironment> {
    await Promise.resolve();

    const unreachable = Object.entries(contract).some(([tool]) => {
      const resolution = runtime.tools[tool];
      return resolution !== undefined && !resolution.available && isDenial(resolution.failure);
    });

    const inherited = process.env['PATH'] ?? '';

    return {
      // PATH rides in on process inheritance because the documented env policy
      // drops it. Set host-natively: MSYS rewrites it on exec.
      spawnEnv: { PATH: inherited },
      extraArgs: ['-s', this.sandbox],
      artifacts: [],
      promptHint: unreachable
        ? 'Some required tools are outside the sandbox. Do not attempt to work ' +
          'around this; report it instead.'
        : null,
      // Both rungs, in order. A denial needs the sandbox widened; PATH alone
      // was verified insufficient.
      mechanisms: unreachable ? ['sandbox-policy', 'spawn-env'] : ['spawn-env'],
    };
  }

  /** Extra `-c` overrides for variables the policy *will* carry. */
  static envPolicyArgs(vars: Readonly<Record<string, string>>): string[] {
    return Object.entries(vars).flatMap(([key, value]) => [
      '-c',
      `shell_environment_policy.set.${key}=${value}`,
    ]);
  }
}

/**
 * The probe prompt.
 *
 * Constrained deliberately: the model runs fixed commands and echoes raw output
 * between sentinels. It is not asked to interpret anything, because an
 * interpreting probe is a probe that can be wrong.
 */
export function renderProbePrompt(contract: ToolchainContract): string {
  const checks = Object.entries(contract)
    .map(([tool, requirement]) => `${tool}\t${requirement.probe}`)
    .join('\n');

  return [
    'Environment diagnostic. Do not modify any files.',
    '',
    'Run each command below in your shell and report the results verbatim.',
    `Print one line per field between ${BEGIN} and ${END}, in key=value form,`,
    'with no commentary, no code fences and no interpretation:',
    '',
    '  shell=<the shell you execute commands in>',
    '  uname=<uname -s, or "Windows">',
    '  path=<the full PATH>',
    '  pathext=<PATHEXT if set, else empty>',
    '  cwd=<current directory>',
    '',
    'Then for each tool below, run its command and report three lines:',
    '  tool.<name>.exit=<exit code>',
    '  tool.<name>.out=<first line of output, verbatim, including any error>',
    '  tool.<name>.which=<resolved path, or empty>',
    '',
    checks,
  ].join('\n');
}

/** Pull the sentinel-delimited block out of the transcript. */
export function extractRecord(stdout: string): string | null {
  const start = stdout.indexOf(BEGIN);
  const end = stdout.indexOf(END, start + 1);
  if (start < 0 || end < 0) return null;
  return stdout.slice(start + BEGIN.length, end).trim();
}

export function parseProbeRecord(raw: string, hostCwd: string, sandbox: Sandbox): AgentRuntime {
  const record = parseKeyValueRecord(raw);
  const shellRaw = record.get('shell') ?? '';
  const lower = shellRaw.toLowerCase();
  const shell: AgentShell = lower.includes('powershell') || lower.includes('pwsh')
    ? 'powershell'
    : lower.includes('cmd')
      ? 'cmd'
      : lower.includes('bash')
        ? 'bash'
        : lower.includes('zsh')
          ? 'zsh'
          : 'unknown';

  const uname = record.get('uname') ?? '';
  const platform: Platform =
    shell === 'powershell' || shell === 'cmd' || /windows|mingw|msys/i.test(uname)
      ? 'windows'
      : uname === 'Darwin'
        ? 'darwin'
        : 'linux';

  return {
    provider: 'codex',
    platform,
    shell,
    pathStyle: detectPathStyle({ platform, shell: shellRaw, pathSample: record.get('path') }),
    cwd: hostCwd,
    access: accessFor(sandbox, hostCwd),
    tools: toolsFromRecord(record),
    env: envFromRecord(record),
    probedAt: new Date().toISOString(),
    sessionId: null,
  };
}

/**
 * Sandbox mode translated into the access dimension.
 *
 * `read-only` is the mode that produced `UnauthorizedAccessException` on a
 * binary that was present and on PATH, so its read scope is workspace, not full.
 */
function accessFor(sandbox: Sandbox, cwd: string): AccessPolicy {
  switch (sandbox) {
    case 'danger-full-access':
      return { read: 'full', write: 'full', execRoots: ['/'], networkAllowed: true };
    case 'workspace-write':
      return {
        read: 'workspace',
        write: 'workspace',
        execRoots: [toAgentPath(cwd, 'win32')],
        networkAllowed: false,
      };
    case 'read-only':
      return { read: 'workspace', write: 'none', execRoots: [], networkAllowed: false };
  }
}

function isDenial(failure: string | null): boolean {
  return /access is denied|unauthorized|permission denied|eacces|eperm/i.test(failure ?? '');
}
