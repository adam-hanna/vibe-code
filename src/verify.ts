import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { hostDirectoryFor } from '@src/hosttools.js';
import type { ToolchainContract } from '@src/runtime.js';
import type { VerifyConfig } from '@src/types.js';

/**
 * One gate with every default filled in - what actually gets run.
 *
 * Produced by `resolveGates`, which is the single place migration from the
 * legacy `verify.command` and auto-detection happen (#47).
 */
export interface ResolvedGate {
  name: string;
  /** Null means unavailable: the gate is enabled and there is nothing to run. */
  command: string | null;
  runs: number;
  timeoutMs: number;
  required: boolean;
}

export interface VerifyResult {
  /** Which gate this describes, so a failure can be filed under its own id. */
  name: string;
  ok: boolean;
  command: string | null;
  /** Which attempt failed, 1-based. Null when every attempt passed. */
  failedRun: number | null;
  runs: number;
  exitCode: number | null;
  /** Combined stdout/stderr of the failing attempt, tail-trimmed. */
  output: string;
  /**
   * Set when the gate could not run at all, as distinct from failing.
   *
   * Named `unavailable` since #47: "skipped" reads as a decision somebody made,
   * and this is the absence of one - an enabled gate with nothing to run, which
   * is not a pass and may cost the run its exit code.
   */
  unavailable: string | null;
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
/** `cmd.exe` returns this when the command name cannot be resolved. */
const WINDOWS_NOT_FOUND = 9009;
/** POSIX shells return this for the same condition. */
const POSIX_NOT_FOUND = 127;

const NOT_RECOGNIZED_RE = /'([^']+)' is not recognized as an internal or external command/i;
const MISSING_MODULE_RE = /Cannot find module '([^']+)'/i;

const normalise = (s: string): string => s.replace(/\\/g, '/').replace(/^"|"$/g, '').toLowerCase();

/**
 * Distinguish "the command never ran" from "the project failed its checks".
 *
 * Matched against the *command being run*, never against its output alone. An
 * earlier version pattern-matched the output and misfired on nested noise:
 * `npm.cmd` on Windows prints "'DOSKEY' is not recognized as an internal or
 * external command" while running a perfectly normal suite, which turned a
 * genuine test failure into a configuration error and would have halted a run
 * that should have continued. A false positive here is worse than a false
 * negative - it stops correct work, where the miss only costs a fix round.
 */
function launchFailure(output: string, exitCode: number | null, command: string): string | null {
  if (exitCode === POSIX_NOT_FOUND || exitCode === WINDOWS_NOT_FOUND) {
    return 'the command was not found';
  }

  const target = normalise(command.trim().split(/\s+/)[0] ?? '');

  const notRecognized = NOT_RECOGNIZED_RE.exec(output);
  if (notRecognized?.[1] !== undefined) {
    const named = normalise(notRecognized[1]);
    // Only when the shell is complaining about *our* command, not something
    // it shelled out to.
    if (named === target || target.endsWith(`/${named}`)) {
      return `the command "${notRecognized[1]}" was not found`;
    }
  }

  const missingModule = MISSING_MODULE_RE.exec(output);
  if (missingModule?.[1] !== undefined) {
    // Only when the missing module is one this command actually named - an
    // interpreter that started but could not find its own script. The file
    // name is compared as well as the full path, because a POSIX path handed
    // to a Windows interpreter is reported back resolved against the current
    // drive (`/c/dir/x.mjs` becomes `C:\c\dir\x.mjs`) and so never matches the
    // command verbatim. That form is the likeliest way to mistype this
    // setting, so it is worth catching.
    const missing = normalise(missingModule[1]);
    const fileName = missing.slice(missing.lastIndexOf('/') + 1);

    // Compared token by token, and the bare file name only counts when it
    // looks like a file. Substring matching was too loose in both directions:
    // node reports a missing directory as `Cannot find module '<dir>/test'`,
    // and that basename `test` is a substring of the entirely ordinary command
    // `npm test` - which would have turned a real suite failure into a
    // configuration error and stopped the run.
    const tokens = normalise(command)
      .split(/\s+/)
      .map((t) => t.replace(/^"+|"+$/g, ''));
    const mentions = (needle: string): boolean =>
      needle !== '' && tokens.some((t) => t === needle || t.endsWith(`/${needle}`));

    if (mentions(missing) || (fileName.includes('.') && mentions(fileName))) {
      return `the script "${missingModule[1]}" does not exist`;
    }
  }

  return null;
}

/**
 * A command string that can actually be run, or null.
 *
 * Blank is null. An empty string reached the shell, exited 0 and was reported as
 * a pass - a gate that never ran, indistinguishable from one that did (#47).
 * Config validation refuses it; this is the second answer, because a guard that
 * cannot read its input treats it as absent rather than as fine.
 */
function usable(command: string | null): string | null {
  return command !== null && command.trim() !== '' ? command : null;
}

/**
 * The gates this config asks for, in the order they run.
 *
 * The one place migration and detection happen. An absent `gates` synthesizes
 * the gate every config before #47 described - named `verification`, so its
 * finding id stays `verification-failing` with no special case anywhere.
 *
 * Detection belongs to that legacy gate ALONE. A listed gate with no command is
 * unavailable and nothing is guessed: a gate named `qa` that silently ran `npm
 * test` because the project happens to have one would report QA as passing when
 * no QA ran. A *blank* legacy command does not detect either - the user wrote
 * something, and guessing past it runs a command they never named.
 */
export function resolveGates(cfg: VerifyConfig, cwd: string): ResolvedGate[] {
  if (cfg.gates === null || cfg.gates === undefined) {
    return [
      {
        name: 'verification',
        command: cfg.command === null ? detectCommand(cwd) : usable(cfg.command),
        runs: cfg.runs,
        timeoutMs: cfg.timeoutMs,
        required: true,
      },
    ];
  }

  return cfg.gates.map((gate) => ({
    name: gate.name,
    command: usable(gate.command),
    runs: gate.runs ?? cfg.runs,
    timeoutMs: gate.timeoutMs ?? cfg.timeoutMs,
    required: gate.required ?? true,
  }));
}

/**
 * Run one gate's command.
 *
 * Executed by vibe rather than by an agent. An agent reporting "tests pass" is
 * a claim; this is an observation, and it is the only thing in the loop that
 * distinguishes code that works from code that reads as though it does.
 */
export async function runGateCommand(
  cwd: string,
  gate: ResolvedGate,
  contract: ToolchainContract,
): Promise<VerifyResult> {
  const command = gate.command;
  const base: VerifyResult = {
    name: gate.name,
    ok: true,
    command,
    failedRun: null,
    runs: 0,
    exitCode: null,
    output: '',
    unavailable: null,
    unlaunchable: null,
  };

  if (command === null) {
    return {
      ...base,
      unavailable:
        gate.name === 'verification'
          ? 'no verification command configured and none could be detected'
          : `no command configured for the ${gate.name} gate`,
    };
  }

  const env = verificationEnv(contract);
  const attempts = Math.max(1, gate.runs);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await execute(command, cwd, env, gate.timeoutMs);
    if (result.code !== 0) {
      return {
        ...base,
        ok: false,
        failedRun: attempt,
        runs: attempt,
        exitCode: result.code,
        output: tail(result.output),
        unlaunchable: launchFailure(result.output, result.code, command),
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
    // The shell is invoked explicitly rather than via `shell: true`, which on
    // Windows expands to `cmd.exe /d /s /c "<command>"`. That extra layer of
    // quoting mangles a command whose arguments are themselves quoted:
    // `node "C:\dir\file.mjs"` fails to launch, while the unquoted and
    // forward-slash forms succeed. A quoted Windows path is the obvious thing
    // to write, so it has to work.
    const child =
      process.platform === 'win32'
        ? spawn(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/c', command], {
            cwd,
            env,
            windowsHide: true,
            windowsVerbatimArguments: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : spawn('/bin/sh', ['-c', command], {
            cwd,
            env,
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
  // The gate is named, not just the command: with a list, "it exited 1" does not
  // say which check the fixer has to make pass (#47, problem 2).
  return (
    `Gate \`${result.name}\`: \`${result.command ?? 'verification'}\` exited ` +
    `${result.exitCode ?? 'abnormally'}${attempt}.\n\n` +
    `\`\`\`\n${result.output}\n\`\`\``
  );
}
