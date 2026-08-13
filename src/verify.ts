import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { hostDirectoryFor } from '@src/hosttools.js';
import type { ToolchainContract } from '@src/runtime.js';
import type { VerifyConfig } from '@src/types.js';

export interface VerifyResult {
  ok: boolean;
  command: string | null;
  /** Which attempt failed, 1-based. Null when every attempt passed. */
  failedRun: number | null;
  runs: number;
  exitCode: number | null;
  /** Combined stdout/stderr of the failing attempt, tail-trimmed. */
  output: string;
  /** Set when verification could not run at all, as distinct from failing. */
  skipped: string | null;
  /**
   * Set when the command itself could not start, as distinct from the project
   * failing its own checks.
   */
  unlaunchable: string | null;
}

/**
 * A command that never ran looks exactly like a failing test suite from the
 * outside, and the fix loop cannot repair it - no source change will make a
 * mistyped path resolve. Observed costing two fix rounds and two commits'
 * worth of agent time on a `--verify-command` given a POSIX path on Windows.
 */
const LAUNCH_FAILURE_RE =
  /\bMODULE_NOT_FOUND\b|cannot find module|is not recognized as an internal or external command|command not found|\bENOENT\b|no such file or directory/i;

function launchFailure(output: string, exitCode: number | null): string | null {
  if (exitCode === 127) return 'the command was not found';
  const hit = LAUNCH_FAILURE_RE.exec(output);
  return hit ? `the command could not start (${hit[0]})` : null;
}

/**
 * Run the project's own verification command.
 *
 * Executed by vibe rather than by an agent. An agent reporting "tests pass" is
 * a claim; this is an observation, and it is the only thing in the loop that
 * distinguishes code that works from code that reads as though it does.
 */
export async function runVerification(
  cwd: string,
  cfg: VerifyConfig,
  contract: ToolchainContract,
): Promise<VerifyResult> {
  const command = cfg.command ?? detectCommand(cwd);
  const base: VerifyResult = {
    ok: true,
    command,
    failedRun: null,
    runs: 0,
    exitCode: null,
    output: '',
    skipped: null,
    unlaunchable: null,
  };

  if (command === null) {
    return { ...base, skipped: 'no verification command configured and none could be detected' };
  }

  const env = verificationEnv(contract);
  const attempts = Math.max(1, cfg.runs);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await execute(command, cwd, env, cfg.timeoutMs);
    if (result.code !== 0) {
      return {
        ...base,
        ok: false,
        failedRun: attempt,
        runs: attempt,
        exitCode: result.code,
        output: tail(result.output),
        unlaunchable: launchFailure(result.output, result.code),
      };
    }
  }

  return { ...base, runs: attempts };
}

/**
 * PATH for the verification command.
 *
 * Prepends the host directories of contracted tools for the same reason the
 * agents need repairing: vibe may itself be running under a shell whose PATH
 * cannot resolve node, and a verification step that fails with ENOENT would
 * be indistinguishable from a genuine test failure.
 */
function verificationEnv(contract: ToolchainContract): NodeJS.ProcessEnv {
  const dirs: string[] = [];
  for (const tool of Object.keys(contract)) {
    const dir = hostDirectoryFor(tool);
    if (dir !== null && !dirs.includes(dir)) dirs.push(dir);
  }
  if (dirs.length === 0) return { ...process.env };

  const separator = process.platform === 'win32' ? ';' : ':';
  return { ...process.env, PATH: `${dirs.join(separator)}${separator}${process.env['PATH'] ?? ''}` };
}

/** `npm test` when the project defines one. Deliberately conservative. */
export function detectCommand(cwd: string): string | null {
  const pkgPath = path.join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as unknown;
    if (typeof pkg !== 'object' || pkg === null) return null;
    const scripts = (pkg as Record<string, unknown>)['scripts'];
    if (typeof scripts !== 'object' || scripts === null) return null;
    const test = (scripts as Record<string, unknown>)['test'];
    return typeof test === 'string' && test.trim() !== '' ? 'npm test' : null;
  } catch {
    return null;
  }
}

interface ExecResult {
  code: number | null;
  output: string;
}

/**
 * Run the command through a shell.
 *
 * A shell is appropriate here and nowhere else in vibe: this string comes from
 * configuration the user wrote, not from model output. Model-authored text is
 * never passed to a shell.
 */
function execute(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(null, `${output}\n[vibe] verification timed out after ${timeoutMs}ms`);
    }, timeoutMs);

    const finish = (code: number | null, text: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output: text });
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      output += d;
    });
    child.stderr.on('data', (d: string) => {
      output += d;
    });
    child.on('error', (err: Error) => finish(null, `${output}\n[vibe] ${err.message}`));
    child.on('close', (code: number | null) => finish(code, output));
  });
}

function tail(text: string, max = 8000): string {
  return text.length <= max ? text : `...\n${text.slice(-max)}`;
}

/** Render a failure as prose the fix prompt can act on. */
export function describeFailure(result: VerifyResult): string {
  const attempt =
    result.runs > 1
      ? ` on attempt ${result.failedRun ?? '?'} of ${result.runs}`
      : '';
  return (
    `\`${result.command ?? 'verification'}\` exited ${result.exitCode ?? 'abnormally'}${attempt}.\n\n` +
    `\`\`\`\n${result.output}\n\`\`\``
  );
}
