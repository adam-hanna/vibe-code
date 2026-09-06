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
  /**
   * What to preserve when this gate FAILS. Empty for a gate that named nothing
   * and for the synthesized legacy gate, which has no key that could name any.
   *
   * Resolved here rather than looked up again in the orchestrator, so a gate's
   * effective settings still come from exactly one place (#47).
   */
  artifacts: readonly string[];
}

/**
 * What one execution of a gate's command did (#135).
 *
 * The whole of the per-run record, and deliberately no more: an exit code and
 * whether it was zero. Naming *which test* failed would mean parsing somebody's
 * reporter, and vibe parses no output formats - it reads exit codes. Option 3 of
 * the three #135 offered is a standing maintenance liability taken on for a
 * table in a UI, where option 1 is what changes the fixer's behaviour.
 */
export interface GateAttempt {
  /** 1-based, matching `failedRun`. */
  run: number;
  ok: boolean;
  exitCode: number | null;
}

export interface VerifyResult {
  /** Which gate this describes, so a failure can be filed under its own id. */
  name: string;
  ok: boolean;
  command: string | null;
  /** Which attempt failed FIRST, 1-based. Null when every attempt passed. */
  failedRun: number | null;
  runs: number;
  /**
   * What every attempt did, in order (#135).
   *
   * `failedRun` says which attempt failed; this says what the others did, which
   * is the difference between "this suite is broken" and "this suite is not
   * deterministic". Empty when the gate never ran - unavailable, disabled, or a
   * result built before this field existed.
   */
  attempts: readonly GateAttempt[];
  exitCode: number | null;
  /** Combined stdout/stderr of the FIRST failing attempt, tail-trimmed. */
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
        // Nothing: a legacy config has no key that could name an artifact, so
        // an empty list is the observation rather than a default (#62).
        artifacts: [],
      },
    ];
  }

  return cfg.gates.map((gate) => ({
    name: gate.name,
    command: usable(gate.command),
    runs: gate.runs ?? cfg.runs,
    timeoutMs: gate.timeoutMs ?? cfg.timeoutMs,
    required: gate.required ?? true,
    artifacts: gate.artifacts ?? [],
  }));
}

/**
 * Run one gate's command.
 *
 * Executed by vibe rather than by an agent. An agent reporting "tests pass" is
 * a claim; this is an observation, and it is the only thing in the loop that
 * distinguishes code that works from code that reads as though it does.
 *
 * ## Why a failure runs the rest of the attempts (#135)
 *
 * `verify.runs` has always defaulted to 3, and `config.ts` explains it as a coin
 * flip: a racy lock failed roughly half its executions and a single sample called
 * it green twice running. That reasoning is about **catching** a flake. Until
 * this change nothing **identified** one - the loop returned on the first
 * non-zero exit, so `runs: 3` meant *up to* three and **a run that failed had
 * exactly one sample**.
 *
 * What that cost is a whole implementer turn against `maxVerifyRounds`, chasing
 * something that was never wrong: the fixer was handed a failure and told to fix
 * it, with no way to know whether the test was broken or noisy. A flaky suite
 * also produces exactly the pattern `guardProgress` reads as the fixer making no
 * progress, without any of the fixes being wrong.
 *
 * So: **the pass path keeps its short-circuit and costs exactly what it costs
 * today** - three green runs and nothing changed. The failure path runs the
 * remaining attempts and reports what each one did. A failing gate is then up to
 * `runs` times more expensive, and only while it is already failing; against a
 * wasted implementer turn that is not a close call. The ceiling is real and
 * worth knowing: with the default `timeoutMs` of 15 minutes, three attempts that
 * all time out is 45 minutes.
 *
 * **Except when the command never started.** No amount of re-running makes a
 * mistyped path resolve, so `unlaunchable` returns immediately - the same
 * reasoning `runGate` applies one level up when it refuses to send that to the
 * fixer at all.
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
    attempts: [],
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
  const wanted = Math.max(1, gate.runs);
  const attempts: GateAttempt[] = [];
  /** The first failure, which is the one every existing caller means. */
  let first: { run: number; exitCode: number | null; output: string } | null = null;

  for (let run = 1; run <= wanted; run += 1) {
    const result = await execute(command, cwd, env, gate.timeoutMs);
    const ok = result.code === 0;
    attempts.push({ run, ok, exitCode: result.code });

    if (ok) continue;
    if (first === null) first = { run, exitCode: result.code, output: result.output };

    const unlaunchable = launchFailure(result.output, result.code, command);
    if (unlaunchable !== null) {
      return {
        ...base,
        ok: false,
        failedRun: first.run,
        runs: attempts.length,
        attempts,
        exitCode: first.exitCode,
        output: tail(first.output),
        unlaunchable,
      };
    }
  }

  if (first === null) return { ...base, runs: wanted, attempts };

  return {
    ...base,
    ok: false,
    failedRun: first.run,
    runs: attempts.length,
    attempts,
    exitCode: first.exitCode,
    output: tail(first.output),
    unlaunchable: null,
  };
}

/**
 * What the attempts add up to (#135).
 *
 * `flaky` needs two things and neither is optional: at least one failure, and at
 * least one pass **of the same command against the same tree**. That is the one
 * inference available without parsing anybody's reporter, and it is a strong one
 * - the code did not change between runs, so something other than the code
 * decided the outcome.
 *
 * `unrun` covers a gate that never executed and, deliberately, one recorded
 * before `attempts` existed: the archive is full of those, and "no attempts
 * recorded" must read as "cannot tell" rather than as a verdict. A gate with
 * `runs: 1` that failed is `failing` and never `flaky`, because one sample says
 * nothing about determinism - calling it either way would be the invented number
 * this repo does not write.
 */
export type GateVerdict = 'passed' | 'failing' | 'flaky' | 'unrun';

export function verdictOf(result: VerifyResult): GateVerdict {
  if (result.attempts.length === 0) return 'unrun';
  if (result.ok) return 'passed';
  return result.attempts.some((a) => a.ok) ? 'flaky' : 'failing';
}

/** How many attempts failed. Zero for a gate that never ran. */
export function failedRuns(result: VerifyResult): number {
  return result.attempts.filter((a) => !a.ok).length;
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

/** "runs 1 and 3 passed, run 2 exited 1" - what actually happened, per attempt. */
function perRun(result: VerifyResult): string {
  const passed = result.attempts.filter((a) => a.ok).map((a) => a.run);
  const failed = result.attempts.filter((a) => !a.ok);
  const parts: string[] = [];
  if (passed.length > 0) {
    parts.push(`run${passed.length === 1 ? '' : 's'} ${list(passed)} passed`);
  }
  for (const a of failed) {
    parts.push(`run ${a.run} exited ${a.exitCode ?? 'abnormally'}`);
  }
  return parts.join(', ');
}

function list(ns: readonly number[]): string {
  if (ns.length <= 1) return String(ns[0] ?? '');
  return `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`;
}

/**
 * Render a failure as prose the fix prompt can act on - and say which kind of
 * failure it is (#135).
 *
 * The data alone changes nothing. What saves the round is that a suite which
 * failed 1 of 3 is described as **not deterministic**, in those words, rather
 * than as a defect handed over with an instruction to repair it. A suite that
 * failed every run is described as failing, which is what it is.
 *
 * A single-run gate says only what it saw. One sample cannot distinguish the
 * two, and saying "it failed" when that is the whole of the evidence is the
 * honest version.
 */
export function describeFailure(result: VerifyResult): string {
  const command = `\`${result.command ?? 'verification'}\``;
  const gate = `Gate \`${result.name}\``;
  const detail = perRun(result);
  const trailer = detail === '' ? '' : ` (${detail})`;

  const headline =
    verdictOf(result) === 'flaky'
      ? `${gate}: ${command} **is not deterministic**. It failed ` +
        `${failedRuns(result)} of ${result.runs} runs of the same command against the same ` +
        `tree${trailer}. The output below is from the first failing run.`
      : result.runs > 1
        ? `${gate}: ${command} failed every one of ${result.runs} runs, exiting ` +
          `${result.exitCode ?? 'abnormally'}${trailer}.`
        : // The gate is named, not just the command: with a list, "it exited 1"
          // does not say which check the fixer has to make pass (#47, problem 2).
          `${gate}: ${command} exited ${result.exitCode ?? 'abnormally'}. It was run once, ` +
          'so there is no second sample and nothing here says whether it is deterministic.';

  return `${headline}\n\n\`\`\`\n${result.output}\n\`\`\``;
}

/**
 * What the fixer is asked to do about it (#135).
 *
 * Two different jobs, and conflating them is what bought the wasted round. The
 * old text carried the flaky case as a conditional - *"if it fails only
 * sometimes, the defect is a race"* - which is the right advice offered to a
 * reader who had no way to evaluate the condition. Now the run has evaluated it.
 *
 * The three things it forbids are the three cheap ways to make a flaky gate go
 * green, and all of them hide the race rather than removing it. They are named
 * explicitly because a model asked to make a command pass will find them.
 */
export function suggestedFix(result: VerifyResult): string {
  if (verdictOf(result) === 'flaky') {
    return (
      `The \`${result.name}\` gate is not deterministic: the same command, on the same tree, ` +
      'both passed and failed. Nothing about the behaviour under test changed between those ' +
      'runs, so the defect is in what makes the outcome depend on something other than the ' +
      'code - ordering between tests, a shared temp path or port, a real clock, an unawaited ' +
      'promise, a resource one test leaves behind. Find that and remove it. Do NOT loosen or ' +
      'delete the assertion, do NOT add a retry, and do NOT add a sleep: all three make the ' +
      'gate green while leaving the race in the product.'
    );
  }
  return (
    `Make the ${result.name} gate's command pass. If it fails only sometimes, the defect ` +
    'is a race - fix the underlying synchronisation rather than retrying or loosening ' +
    'the test.'
  );
}
