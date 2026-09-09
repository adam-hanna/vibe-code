import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { expandHome } from '@src/proc.js';
import type { ChildProcess } from 'node:child_process';

/**
 * Running a command a person pressed, and nothing else (#211).
 *
 * ## What changed, and what did not
 *
 * `AGENTS.md` has said since the app landed that *"there is deliberately no
 * command that takes a program name — the pilot chat can drive the session, and
 * 'run this program' must never be in reach of it"*, and `pilotchat.ts` explains
 * why `Bash` is absent from the pilot where a *run's* read-only seats have it:
 * *"That set is read-only in the sense a run's seats are - a shell under a
 * sandbox, in work a person launched. This is a chat surface the model drives
 * turn by turn."*
 *
 * That was written when the pilot was a tab beside a launch form. It is now the
 * front door: it proposes the run, reads the archive and explains the outcome -
 * and it could not check whether the thing it just built starts, so it answered
 * *"here is exactly what to type"* and handed the last mile back to a terminal.
 *
 * **What is reversed is narrow, and the rest of the rule is intact.** The model
 * still cannot run anything: `run_command` is a *proposal*, drawn with the exact
 * program and arguments, and a person presses it. That is the same shape
 * `start_run` and `answer_gate` already take, and it is #144's decision 1
 * unchanged. What is new is that the proposal, once accepted, reaches a runner.
 *
 * **The webview still has no shell.** It sends a frame to this process, which is
 * Node and already spawns children - the same road `invoke` and `diff` take.
 * Rust is still transport, and the window's own command control exists too, so
 * this stays a host request the app makes rather than a pilot-only power.
 *
 * ## The one invariant
 *
 * **What runs is what was displayed.** Everything below serves that:
 *
 * - **No shell. Ever.** `verify.ts` states the rule at the one place a shell is
 *   used at all - *"Model-authored text is never passed to a shell"* - and this
 *   is model-authored text. `program` and `args` are separate from the start and
 *   are never joined into a string, so there is no line for a `;` or a backtick
 *   to be in.
 * - **A shim is refused rather than shelled.** On Windows `npm` is `npm.cmd`,
 *   and running a `.cmd` means `cmd.exe`, which means quoting rules that decide
 *   what the arguments were. `nodeEntry` resolves the Node-family CLIs to the
 *   JavaScript they are, so `npm install` is spawned as `node .../npm-cli.js
 *   install` with no interpreter in between. Anything else that resolves to a
 *   `.cmd` or `.bat` is refused with its reason, because a command whose
 *   arguments could be re-read is not the command anybody pressed.
 * - **It runs where the window said.** The directory is the repository the
 *   person chose, checked to exist first, and never a default.
 */

const isWin = process.platform === 'win32';

/**
 * How many bytes of one command's output are kept.
 *
 * **A display choice, and allowed to be one**, exactly as `OUTPUT_KEEP` is in
 * the cockpit: a dev server left up for an afternoon writes more than anybody
 * reads, and what a reader wants is the recent end of it. Nothing decides
 * anything from this figure - it bounds a buffer, and the pane says when it has
 * dropped something rather than presenting a tail as the whole.
 */
export const OUTPUT_KEEP_BYTES = 256 * 1024;

/** What a running or finished command looks like to a reader. */
export interface CommandRecord {
  id: string;
  program: string;
  args: readonly string[];
  /** What was actually spawned, when it differs. See `nodeEntry`. */
  resolved: string;
  dir: string;
  startedAt: number;
  /** Null while it is still running. */
  endedAt: number | null;
  /** Null while running, and on a child that died without one. */
  code: number | null;
  signal: string | null;
  /** stdout and stderr interleaved, as a reader sees a terminal. */
  output: string;
  /** True when output was dropped from the front. See `OUTPUT_KEEP_BYTES`. */
  truncated: boolean;
  /** Whether a person stopped it, as opposed to it ending on its own. */
  stopped: boolean;
}

interface Live {
  record: CommandRecord;
  child: ChildProcess | null;
}

/**
 * Every command this process has started, newest last.
 *
 * A module-level registry, for the reason `cancel.ts` gives for its latch: one
 * host process serves one window, and threading a registry through every layer
 * between the frame and the spawn is a place for a call site to forget it.
 */
const commands = new Map<string, Live>();

/** Ids allocated here, so a caller cannot collide two commands on one name. */
let next = 0;

/**
 * The Node-family CLIs, and the file each one really is.
 *
 * **This is what makes `npm install` runnable without a shell.** `npm` on PATH
 * is `npm.cmd`, a batch shim; running it means `cmd.exe`, and cmd.exe's quoting
 * is the thing that decides whether the arguments a person read are the
 * arguments that ran. Every one of these is a JavaScript program, so it can be
 * spawned as `node <entry>` instead, with the arguments passed straight through
 * and nothing in between to re-read them.
 *
 * Resolved from the shim's own directory rather than a hardcoded path: an nvm
 * install, a Program Files install and a corepack shim all put the entry
 * somewhere different, and the shim is the thing PATH already found.
 */
const NODE_CLIS: Readonly<Record<string, readonly string[]>> = {
  npm: ['node_modules/npm/bin/npm-cli.js'],
  npx: ['node_modules/npm/bin/npx-cli.js'],
  yarn: ['node_modules/yarn/bin/yarn.js'],
  pnpm: ['node_modules/pnpm/bin/pnpm.cjs'],
};

/** Where `name` resolves on PATH, or null. Shims included: the caller decides. */
function onPath(name: string): string | null {
  const finder = isWin
    ? path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'where.exe')
    : 'which';
  const found = spawnSync(finder, [name], { encoding: 'utf8' });
  if (found.status !== 0) return null;
  const hits = found.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  // An `.exe` first, exactly as `resolveBin` prefers one: a real executable
  // needs no interpreter and no quoting rules.
  return hits.find((h) => h.toLowerCase().endsWith('.exe')) ?? hits[0] ?? null;
}

/**
 * The JavaScript a Node-family CLI actually is, or null if this is not one.
 *
 * Walks up from the shim looking for the entry, because the layouts differ:
 * `C:\Program Files\nodejs\npm.cmd` has it under `node_modules/npm/...` beside
 * it, and a Unix install has it a directory up under `lib/`.
 */
function nodeEntry(program: string): string | null {
  const relatives = NODE_CLIS[program];
  if (relatives === undefined) return null;
  const shim = onPath(program);
  if (shim === null) return null;
  let dir = path.dirname(shim);
  for (let up = 0; up < 4; up += 1) {
    for (const relative of relatives) {
      for (const base of [dir, path.join(dir, 'lib')]) {
        const candidate = path.join(base, relative);
        if (existsSync(candidate)) return candidate;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface Refusal {
  refused: string;
}

export function refused(v: unknown): v is Refusal {
  return typeof v === 'object' && v !== null && 'refused' in v;
}

/** What will be spawned for this program, or why it will not be. */
export function resolveCommand(
  program: string,
  args: readonly string[],
): { file: string; argv: readonly string[]; resolved: string } | Refusal {
  const name = program.trim();
  if (name === '') return { refused: 'no program was named.' };
  // A path separator means the caller is pointing at a file rather than naming
  // a program. Allowed - a repository's own script is a legitimate thing to run
  // - but it has to exist, and it is still spawned without a shell.
  if (name.includes('/') || name.includes('\\')) {
    const file = expandHome(name);
    if (!existsSync(file)) return { refused: `there is no file at ${file}.` };
    return { file, argv: args, resolved: file };
  }

  const entry = nodeEntry(name);
  if (entry !== null) {
    // `process.execPath` rather than `node` from PATH: this is the runtime
    // already running, so it is the one version that is known to exist.
    return { file: process.execPath, argv: [entry, ...args], resolved: `node ${entry}` };
  }

  const found = onPath(name);
  if (found === null) {
    return { refused: `"${name}" is not on PATH, so there is nothing to run.` };
  }
  if (/\.(cmd|bat|ps1)$/i.test(found)) {
    // Refused rather than shelled. Running a shim means an interpreter, and an
    // interpreter re-reads the arguments - so what ran would no longer be
    // provably what was displayed, which is the one property this module has.
    return {
      refused:
        `"${name}" resolves to ${found}, which is a script shim rather than a program. ` +
        'Running it would need a shell, and a shell re-reads the arguments - so what ran ' +
        'could differ from what you approved. Name the executable directly, or use one of ' +
        `the Node CLIs this build resolves without a shell: ${Object.keys(NODE_CLIS).join(', ')}.`,
    };
  }
  return { file: found, argv: args, resolved: found };
}

export interface StartOptions {
  program: string;
  args: readonly string[];
  dir: string;
  /** Called as output arrives, so a window can stream it. */
  onOutput?: ((id: string, chunk: string) => void) | undefined;
  /** Called once, when it ends. */
  onEnd?: ((record: CommandRecord) => void) | undefined;
  now?: (() => number) | undefined;
}

/** Start one, or say why not. Never throws: a refusal is an answer. */
export function startCommand(options: StartOptions): CommandRecord | Refusal {
  const now = options.now ?? (() => Date.now());
  const dir = expandHome(options.dir.trim());
  if (dir === '') return { refused: 'no directory was named.' };
  try {
    if (!statSync(dir).isDirectory()) return { refused: `${dir} is not a directory.` };
  } catch {
    return { refused: `${dir} does not exist, so there is nowhere to run this.` };
  }

  const plan = resolveCommand(options.program, options.args);
  if (refused(plan)) return plan;

  const id = `cmd-${String((next += 1))}`;
  const record: CommandRecord = {
    id,
    program: options.program.trim(),
    args: [...options.args],
    resolved: plan.resolved,
    dir,
    startedAt: now(),
    endedAt: null,
    code: null,
    signal: null,
    output: '',
    truncated: false,
    stopped: false,
  };
  const live: Live = { record, child: null };
  commands.set(id, live);

  let child: ChildProcess;
  try {
    child = spawn(plan.file, [...plan.argv], {
      cwd: dir,
      // **Never a shell.** The whole module depends on this line.
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    live.record = {
      ...record,
      endedAt: now(),
      output: err instanceof Error ? err.message : String(err),
    };
    return live.record;
  }
  live.child = child;

  const append = (chunk: string): void => {
    let output = live.record.output + chunk;
    let truncated = live.record.truncated;
    if (output.length > OUTPUT_KEEP_BYTES) {
      output = output.slice(output.length - OUTPUT_KEEP_BYTES);
      truncated = true;
    }
    live.record = { ...live.record, output, truncated };
    options.onOutput?.(id, chunk);
  };

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  // Interleaved, because that is what a person reading a terminal sees and the
  // ordering between the two streams is the thing that makes a failure legible.
  child.stdout?.on('data', (d: string) => append(d));
  child.stderr?.on('data', (d: string) => append(d));
  child.on('error', (err: Error) => append(`\n${err.message}\n`));
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    live.child = null;
    live.record = { ...live.record, endedAt: now(), code, signal };
    options.onEnd?.(live.record);
  });

  return live.record;
}

/** One command as it stands, or null. */
export function readCommand(id: string): CommandRecord | null {
  return commands.get(id)?.record ?? null;
}

/** Every command this process started, oldest first. */
export function listCommands(): readonly CommandRecord[] {
  return [...commands.values()].map((live) => live.record);
}

/**
 * Stop one. True if there was something to stop.
 *
 * `stopped` is set before the kill so the record says a person did this even if
 * the close event arrives first - a command that was stopped and one that
 * exited on its own are different outcomes, and the exit code cannot tell them
 * apart on Windows, where there are no signals (#131).
 */
export function stopCommand(id: string): boolean {
  const live = commands.get(id);
  if (live === undefined || live.child === null) return false;
  live.record = { ...live.record, stopped: true };
  live.child.kill();
  return true;
}

/** Stop everything still running. Returns how many were killed. */
export function stopAllCommands(): number {
  let killed = 0;
  for (const id of commands.keys()) if (stopCommand(id)) killed += 1;
  return killed;
}

/** Test seam: forget every command. Never called by the product. */
export function clearCommands(): void {
  commands.clear();
  next = 0;
}
