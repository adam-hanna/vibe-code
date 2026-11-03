import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  /** Whether this gate runs once against the start tree (#484). */
  baseline: boolean;
  /** Whether this gate runs in a replay of edited tests' earlier versions (#486). */
  replay: boolean;
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
  /**
   * Combined stdout/stderr of the FIRST failing attempt, cut by `excerpt` to
   * its head and its tail (#248).
   */
  output: string;
  /**
   * The whole combined output of every attempt, in order, index-aligned with
   * `attempts` (#248). Empty when nothing ran.
   *
   * **Never put on an event.** `attempts` lands on the durable `verify_failed`
   * and in `state.events`, and an attempt's output can be megabytes - which is
   * exactly what #133 protects the run's memory from. The caller writes these to
   * files and puts the files' names on the event instead.
   */
  outputs: readonly string[];
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
  /**
   * Set when an attempt timed out and one of its processes was still holding
   * the gate's output after every kill (#486): vibe could not confirm the gate
   * had stopped. Absent otherwise, so every result built before it reads the
   * same. The replay stops the run on it rather than going on beside a process
   * that may still be using the tree.
   */
  escaped?: true;
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
        baseline: cfg.baseline,
        replay: cfg.replay,
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
    baseline: gate.baseline ?? cfg.baseline,
    replay: gate.replay ?? cfg.replay,
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
    outputs: [],
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
  const outputs: string[] = [];
  /** The first failure, which is the one every existing caller means. */
  let first: { run: number; exitCode: number | null; output: string } | null = null;
  let escaped = false;

  for (let run = 1; run <= wanted; run += 1) {
    const result = await runUserCommand(command, cwd, env, gate.timeoutMs);
    if (result.escaped === true) escaped = true;
    const ok = result.code === 0;
    attempts.push({ run, ok, exitCode: result.code });
    outputs.push(result.output);

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
        output: excerpt(first.output, null),
        outputs,
        unlaunchable,
        ...(escaped ? { escaped: true as const } : {}),
      };
    }
  }

  if (first === null) return { ...base, runs: wanted, attempts, outputs };

  return {
    ...base,
    ok: false,
    failedRun: first.run,
    runs: attempts.length,
    attempts,
    exitCode: first.exitCode,
    output: excerpt(first.output, null),
    outputs,
    unlaunchable: null,
    ...(escaped ? { escaped: true as const } : {}),
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
 * Adds the host directories of contracted tools for the same reason the
 * agents need repairing: vibe may itself be running under a shell whose PATH
 * cannot resolve node, and a verification step that fails with ENOENT would
 * be indistinguishable from a genuine test failure.
 *
 * **Only for a tool the gate's PATH cannot already find, and appended, never
 * prepended** (#251). Putting the directories first also decided WHICH tool
 * ran: with `/usr/bin` at the front, a suite on an nvm Node ran under the
 * system's, and one test of this repo's own failed under it. So the gate ran
 * something its author's terminal never runs, failed 3 of 3, and the fixer -
 * whose shell had the normal PATH - could not reproduce it, round after round.
 * A repair is for a tool that is missing; a tool that is present is the
 * person's choice, and the gate runs their toolchain.
 */
export function verificationEnv(
  contract: ToolchainContract,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const separator = process.platform === 'win32' ? ';' : ':';
  const current = env['PATH'] ?? '';
  const dirs: string[] = [];
  for (const tool of Object.keys(contract)) {
    if (findsOnPath(tool, current, env)) continue;
    const dir = hostDirectoryFor(tool);
    if (dir !== null && !dirs.includes(dir)) dirs.push(dir);
  }
  if (dirs.length === 0) return { ...env };
  // An empty entry means the working directory on POSIX, so none is introduced.
  const entries = [...current.split(separator).filter((e) => e !== ''), ...dirs];
  return { ...env, PATH: entries.join(separator) };
}

/** Whether a directory on `pathVar` holds `tool`, as a shell's lookup would find it. */
function findsOnPath(tool: string, pathVar: string, env: NodeJS.ProcessEnv): boolean {
  const win = process.platform === 'win32';
  const names = win
    ? ['', ...(env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';')].map((ext) => tool + ext.toLowerCase())
    : [tool];
  for (const dir of pathVar.split(win ? ';' : ':')) {
    if (dir === '') continue;
    for (const name of names) if (existsSync(path.join(dir, name))) return true;
  }
  return false;
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

export interface ExecResult {
  code: number | null;
  /** stdout and stderr interleaved, as a reader of a terminal sees them. */
  output: string;
  /**
   * Set when a timed-out command's processes could not all be confirmed gone:
   * one was still holding its output after every kill (#486). See `stopGate`.
   */
  escaped?: true;
}

/**
 * Run the command through a shell.
 *
 * A shell is appropriate here and nowhere else in vibe: this string comes from
 * configuration the user wrote, not from model output. Model-authored text is
 * never passed to a shell.
 *
 * **Exported since #223, and shared rather than copied.** `git.worktree.command`
 * is the second setting in the same category - a line a person wrote into their
 * own committed config, whose whole purpose is to be a sequence - and the
 * Windows branch below is the reason this must not be written twice: `shell:
 * true` expands to `cmd.exe /d /s /c "<command>"`, and that extra layer of
 * quoting mangles a command whose own arguments are quoted. A second copy would
 * be a second place for that to be got wrong, and "a shell is used in exactly
 * one place" would stop being true of the product.
 */
export function runUserCommand(
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
    // Every process this command starts inherits the token, including one that
    // leaves the gate's process group (#486). A timeout finds those by it. See
    // `stopGate`.
    const token = randomUUID();
    const tagged: NodeJS.ProcessEnv = { ...env, [GATE_TOKEN]: token };
    const child =
      process.platform === 'win32'
        ? spawn(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/c', command], {
            cwd,
            env: tagged,
            windowsHide: true,
            windowsVerbatimArguments: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          })
        : // A process group of its own, which the shell leads (#486). Membership
          // is fixed at fork and survives everything a runner can do short of
          // leaving on purpose: its parent exiting, a reparent to init, a worker
          // started with an environment allowlist. See `stopGate`.
          spawn('/bin/sh', ['-c', command], {
            cwd,
            env: tagged,
            windowsHide: true,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
    const group = process.platform !== 'win32' && child.pid !== undefined ? child.pid : null;
    if (group !== null) forwardTo(group);

    let output = '';
    let settled = false;
    let timedOut = false;
    let grace: NodeJS.Timeout | null = null;
    const timeoutNote = (): string => `${output}\n[vibe] verification timed out after ${timeoutMs}ms`;
    const timer = setTimeout(() => {
      // Every process the gate started, not the shell alone (#486), and this
      // resolves only once its pipes close: `node slow.mjs && echo done` makes
      // the shell a parent, and killing only it left the runner alive, still
      // reading and writing the tree after this resolved - while the replay put
      // its tests back, or the next turn began.
      timedOut = true;
      // Asked of the shell before its pid is used (Windows): one that has
      // already exited may have had its pid handed to an unrelated process.
      stopGate(group, child.exitCode === null && child.signalCode === null ? child.pid : undefined, token);
      // A process that left the group on purpose (`setsid`) and kept the pipe
      // holds `close` back for ever, and is out of reach of every kill here.
      // After this long the timeout is reported anyway, and says so in
      // `escaped`: teardown was not confirmed, so a caller that must not go on
      // beside the gate's processes - the replay - stops instead.
      grace = setTimeout(() => finish(null, `${timeoutNote()}\n[vibe] ${ESCAPED_NOTE}`, true), KILL_GRACE_MS);
    }, timeoutMs);

    const finish = (code: number | null, text: string, escaped = false): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (grace !== null) clearTimeout(grace);
      if (group !== null) unforward(group);
      if (escaped) {
        // The escaped process still holds the write ends, so this side's pipes
        // would never close and would keep vibe's event loop alive: the run
        // would print its ending and then hang until that process exited.
        // Nothing more is read from them, so they are let go.
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
      }
      resolve(escaped ? { code, output: text, escaped: true } : { code, output: text });
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
    child.on('close', (code: number | null) => finish(timedOut ? null : code, timedOut ? timeoutNote() : output));
  });
}

/** How long a killed gate's pipes may stay open before its timeout is reported anyway. */
const KILL_GRACE_MS = 5_000;

/** Appended to a timed-out gate's output when teardown could not be confirmed. */
const ESCAPED_NOTE =
  'a process it started was still holding its output after every process vibe could find was killed; it may still be running';

/**
 * Kill every process a timed-out gate started (#486). Never throws.
 *
 * **POSIX: the gate's process group, and the token.** The shell leads a group
 * of its own (`detached`), and everything it starts is in it unless it leaves
 * on purpose. A group is signalled atomically, and a fork racing the signal is
 * restarted by the kernel rather than leaving a child outside it, so one
 * `SIGKILL` to the group takes all of it - the runner, a worker whose runner
 * exited and was reparented to init, a worker started with a filtered
 * environment. A group's id cannot be reused while any member lives, so this
 * reaches only the gate's own processes. No pid is signalled by itself: the
 * shell may have exited and been reaped, and its pid handed to an unrelated
 * process.
 *
 * On Linux, a process that left the group (`setsid`) but kept the environment
 * still carries the token, and is found in `/proc/<pid>/environ` and killed.
 * Each scan kills what it finds; a process cannot fork once killed, so a scan
 * that finds nothing new has found everything.
 *
 * What neither reaches - a process that left the group and cleared its
 * environment, or left the group outside Linux - and kept the pipes is what the
 * grace period in `runUserCommand` reports as `escaped`.
 *
 * **Windows: `taskkill /T`**, as `src/appserver.ts` uses for the same reason,
 * and only while the shell is alive (`root`), because it addresses a pid.
 */
function stopGate(group: number | null, root: number | undefined, token: string): void {
  if (process.platform === 'win32') {
    if (root === undefined) return;
    try {
      const taskkill = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      spawnSync(taskkill, ['/PID', String(root), '/T', '/F'], { windowsHide: true });
    } catch {
      // Fall through to the direct kill.
    }
    signal(root, 'SIGKILL');
    return;
  }
  if (group !== null) signal(-group, 'SIGKILL');
  const killed = new Set<number>();
  for (;;) {
    const fresh = tagged(token).filter((p) => !killed.has(p) && p !== process.pid);
    if (fresh.length === 0) break;
    for (const p of fresh) {
      killed.add(p);
      signal(p, 'SIGKILL');
    }
  }
}

/** The variable each gate's processes inherit, holding that run's token. */
const GATE_TOKEN = 'VIBE_GATE_RUN';

/**
 * The pids whose environment holds this gate run's token, on Linux; nothing
 * elsewhere. Unreadable entries - another user's process, one that has just
 * exited - are skipped: there is nothing to say about them and nothing to kill.
 * A token is a fresh UUID per run, so a pid found here is this gate's.
 */
function tagged(token: string): number[] {
  if (process.platform !== 'linux') return [];
  const needle = Buffer.from(`\0${GATE_TOKEN}=${token}\0`);
  const first = Buffer.from(`${GATE_TOKEN}=${token}\0`);
  let entries: string[];
  try {
    entries = readdirSync('/proc');
  } catch {
    return [];
  }
  const out: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const environ = readFileSync(`/proc/${entry}/environ`);
      if (environ.includes(needle) || environ.subarray(0, first.length).equals(first)) out.push(Number(entry));
    } catch {
      // Gone, or not ours.
    }
  }
  return out;
}

/**
 * The terminal's signals, passed on to every live gate's group (#486).
 *
 * A gate in a group of its own is out of the terminal's foreground group, so
 * Ctrl-C, Ctrl-\\ and a closed terminal would reach vibe and not the gate - the
 * one thing that made a group the wrong choice before. So while a gate is
 * live, those three are forwarded to it, and then **vibe ends exactly as it
 * would have**: the listener removes itself first, and when no other listener
 * is left it re-raises the signal against the default disposition, the way
 * `installEndingStamp` does. It is prepended so that it runs before that
 * stamp's own handler, which then does the re-raising.
 *
 * Ctrl-Z is not forwarded: a suspended vibe waits on the gate either way, and
 * reads nothing until it is resumed. SIGTERM is not either; it never reached a
 * gate before, from another process or a terminal.
 */
const FORWARDED: readonly NodeJS.Signals[] = ['SIGINT', 'SIGQUIT', 'SIGHUP'];
const liveGroups = new Set<number>();
let armed = false;

function onForwarded(sig: NodeJS.Signals): void {
  for (const g of liveGroups) signal(-g, sig);
  // Disarmed before the re-raise, and not re-armed here: a listener still in
  // place would catch the re-raise, and a stamp handler after this one would
  // then exit with a code instead of the signal. The next gate re-arms it.
  disarm();
  if (process.listenerCount(sig) === 0) signal(process.pid, sig);
}

function disarm(): void {
  if (!armed) return;
  for (const s of FORWARDED) process.removeListener(s, onForwarded);
  armed = false;
}

function forwardTo(group: number): void {
  liveGroups.add(group);
  if (armed) return;
  for (const s of FORWARDED) process.prependListener(s, onForwarded);
  armed = true;
}

function unforward(group: number): void {
  liveGroups.delete(group);
  if (liveGroups.size === 0) disarm();
}

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    // Gone already is the outcome wanted.
  }
}

/**
 * How much of a failing gate's output the fixer is handed inline: the first
 * 2,000 characters and the last 6,000 (#248).
 *
 * **The same 8,000 the old tail kept, split.** This is a truncation in the same
 * standing as `PREVIEW` in the app, not a measurement, and no new budget is
 * introduced: the old `tail()` kept the last 8,000 alone, and in the #169 run
 * that held `# fail 2` and none of the failures. The head is what catches a
 * compile error or a crash, which a runner prints first and then buries.
 *
 * **Head and tail together still cannot show a failure printed mid-stream** -
 * a TAP runner writes each `not ok` where it happens and only a count at the
 * end, which is exactly the #169 case. What fixes that case is the full log,
 * written beside the run and named in the marker, and `describeFailure` tells
 * the fixer to search it.
 */
export const EXCERPT_HEAD = 2000;
export const EXCERPT_TAIL = 6000;

/**
 * `text` within `EXCERPT_HEAD + EXCERPT_TAIL`, with the cut stated (#248).
 *
 * Output within the budget comes back byte-identical, with no marker. Past it,
 * the elided middle is replaced by one line saying how much was dropped and -
 * when the caller has written it - where the whole of it is.
 */
export function excerpt(text: string, full: string | null): string {
  const budget = EXCERPT_HEAD + EXCERPT_TAIL;
  if (text.length <= budget) return text;
  const omitted = text.length - budget;
  const where = full === null ? '' : `; the full output is ${full}`;
  return (
    `${text.slice(0, EXCERPT_HEAD)}\n[vibe] … ${omitted} characters omitted${where} …\n` +
    text.slice(-EXCERPT_TAIL)
  );
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
export function describeFailure(
  result: VerifyResult,
  /**
   * The full log of every FAILED attempt, by absolute path (#248). The excerpt
   * above it is bounded and the log is not, so this is where the failures are
   * when the runner printed them mid-stream.
   */
  logs: readonly { run: number; path: string }[] = [],
): string {
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

  const fenced = `${headline}\n\n\`\`\`\n${result.output}\n\`\`\``;
  if (logs.length === 0) return fenced;
  // Named for every failed attempt, and the instruction travels with them: the
  // reporter is not parsed (#135), so the fixer is told where to look and what a
  // runner usually does with failures rather than being handed a list of them.
  const named = logs.map((l) => `- run ${l.run}: ${l.path}`).join('\n');
  return (
    `${fenced}\n\nThe full output of each failed run is on disk:\n${named}\n\n` +
    'A test runner usually prints each failure where it happens and only a count at the ' +
    'end, so the excerpt above may not contain the failures. Search the full log (for ' +
    'example for `not ok`, `✖`, `Error`, `FAIL`) before changing code, rather than ' +
    're-running the suite by hand to find them.'
  );
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
