import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { appendLog, highestId, logFile, pastCommands, prune, tailOf, writeMeta } from '@src/commandlog.js';
import { expandHome } from '@src/proc.js';
import type { CommandMeta, PastCommand } from '@src/commandlog.js';
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
  /** The process, once spawned. See `CommandMeta.pid`. */
  pid: number | null;
  /** Started by an earlier launch and picked back up. See `CommandMeta.adopted`. */
  adopted: boolean;
}

interface Live {
  record: CommandRecord;
  /** Null for a command this process did not spawn, and once it has ended. */
  child: ChildProcess | null;
  /**
   * The process group a detached command leads, which is what a stop signals
   * so `npm run dev` takes Vite with it. Null for a piped one.
   */
  group: number | null;
  /** Every character written, dropped ones included: the window's cursor. */
  bytes: number;
  /** Stops following the log. Null for a piped command. */
  unfollow: (() => void) | null;
}

/**
 * Whether a command can outlive the host that started it (#223).
 *
 * **A dev server survives a relaunch now, and the rule it reverses is
 * recorded.** The host used to kill every command on its way out, on the
 * reasoning that *"a server left listening on 5173 after its window has gone is
 * a port nobody can find the owner of."* That was true while nothing could find
 * it again. Since the log is on disk the next launch can: the pid is in the
 * record, the output is in the file, and `keepCommandLogs` takes it back. What
 * a relaunch cost instead was every server the pilot had started, with the
 * pilot then correctly reporting *"they stopped when the previous session
 * ended"* - and rebuilding the app is exactly when somebody wants them up.
 *
 * So a command is spawned **detached, writing straight into its log file**, and
 * nothing in it depends on this process staying alive: no pipe to break, no
 * parent to take it down. This process follows the file to stream it.
 *
 * **Only with a log directory, and not on Windows.** Without the file there is
 * nothing for a later launch to follow, so a detached command would be the
 * ownerless port the old rule was about. On Windows the host's children sit in
 * the app's job object (`reaper.rs`), and leaving it needs a breakaway this has
 * not been measured against - so there it is piped and killed on exit, as
 * before.
 */
function detaches(): boolean {
  return logDir !== null && !isWin;
}

/**
 * How often a detached command's log is read for new output.
 *
 * A display latency, and allowed to be one: it decides how soon a line reaches
 * the window, never what the line was.
 */
const FOLLOW_MS = 200;

/**
 * How far a running process's start may be from the record's `startedAt` and
 * still be the same process.
 *
 * A pid is reused, so a live pid alone could adopt a stranger and a stop would
 * then signal it. `ps` reports start time to the second, and the spawn happens
 * within milliseconds of the stamp, so the real gap is under a second; this is
 * that second plus room for a loaded machine, and far short of the time a pid
 * takes to come round again.
 */
const ADOPT_SLACK_MS = 5_000;

/**
 * Whether `pid` is alive and started when the record says it did. False
 * whenever that cannot be checked - adopting a process this cannot identify is
 * signalling a stranger on the next stop.
 */
export function sameProcess(pid: number, startedAt: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const ps = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    windowsHide: true,
  });
  if (ps.status !== 0) return false;
  const at = Date.parse(ps.stdout.trim());
  return Number.isFinite(at) && Math.abs(at - startedAt) <= ADOPT_SLACK_MS;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // EPERM is somebody else's process under our pid, which is not ours either.
    return false;
  }
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
 * Where each command's output is also written, or null (#223, `commandlog.ts`).
 *
 * A module latch for the registry's own reason. Null in tests and under the CLI,
 * where nothing outlives the process anyway; the host sets it once at start-up.
 */
let logDir: string | null = null;

/**
 * Keep every command's output on disk under `dir`, and read back the ones a
 * previous process left there.
 *
 * **Numbering continues from the highest id on disk**, which is what makes an
 * id mean one command across launches: a pilot conversation is restored with
 * its `read_command` calls in it, and `cmd-3` reached from one of those has to
 * be the command it was about rather than whatever this process started third.
 *
 * Never throws. A log directory that cannot be read is a host that keeps its
 * commands in memory, as it always did, and the caller is told by the empty
 * history rather than by a crash at start-up.
 */
export function keepCommandLogs(dir: string, handlers: Handlers = {}): readonly PastCommand[] {
  try {
    prune(dir);
    next = Math.max(next, highestId(dir));
    logDir = dir;
    return pastCommands(dir, OUTPUT_KEEP_BYTES).map((past) => adopt(dir, past, handlers));
  } catch {
    logDir = null;
    return [];
  }
}

/**
 * Take back a command an earlier launch left running (#223), or return it as
 * it was. Only one whose process is still the one the record names: anything
 * else is left `lost`, which is what it is.
 *
 * Followed from the end of its log as it is now, so nothing already in the
 * returned tail arrives a second time as output.
 */
function adopt(dir: string, past: PastCommand, handlers: Handlers): PastCommand {
  if (!past.lost || past.pid === null || isWin || !sameProcess(past.pid, past.startedAt)) return past;
  const file = logFile(dir, past.id);
  const { text, size } = tailOf(file, OUTPUT_KEEP_BYTES);
  const kept = Buffer.byteLength(text, 'utf8');
  const record: CommandRecord = {
    ...past,
    output: text,
    truncated: size > kept,
    adopted: true,
  };
  const live: Live = { record, child: null, group: past.pid, bytes: size - kept + text.length, unfollow: null };
  commands.set(past.id, live);
  persist(record);
  follow(live, file, size, handlers);
  return snapshot(live);
}

/** One live command as the window's `commands_past` carries it. */
function snapshot(live: Live): PastCommand {
  const { record } = live;
  return { ...metaOf(record), output: record.output, truncated: record.truncated, bytes: live.bytes, lost: false };
}

/**
 * A command this process picked back up, as it stands now - so a window asking
 * after the output has moved on is given the output as it is, not as it was at
 * start-up. Null for anything else.
 */
export function adoptedSnapshot(id: string): PastCommand | null {
  const live = commands.get(id);
  return live !== undefined && live.record.adopted ? snapshot(live) : null;
}

function metaOf(record: CommandRecord): CommandMeta {
  const { output: _output, truncated: _truncated, ...meta } = record;
  return meta;
}

/** Best effort: a log that cannot be written must not stop the command. */
function persist(record: CommandRecord, chunk?: string): void {
  if (logDir === null) return;
  try {
    if (chunk === undefined) writeMeta(logDir, metaOf(record));
    else appendLog(logDir, record.id, chunk);
  } catch {
    // A full disk, a removed directory. The window still has the stream.
  }
}

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
  // `windowsHide` here as well as on the long-lived spawns, and it is not
  // cosmetic since #223. The host is spawned `DETACHED_PROCESS`, so it holds no
  // console at all - which means a console-subsystem child spawned WITHOUT this
  // flag allocates a fresh console of its own, and a fresh console comes with a
  // visible window. `where.exe` runs for a few milliseconds and the window
  // flashes for exactly that long, once per binary this resolves. Reported as
  // *"there are a whole bunch of windows that popup and quickly disappear when
  // I run"*, which is precisely the count: claude, codex, git, node.
  //
  // Before the detach it inherited the host's own (window-less) console and
  // nothing showed, so this is the second half of that change rather than a new
  // defect - the same reasoning `host.rs` records for why `CREATE_NO_WINDOW` is
  // the wrong flag there and the right one here.
  const found = spawnSync(finder, [name], { encoding: 'utf8', windowsHide: true });
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
 *
 * **A Unix shim is usually a symlink to the entry itself, so its target is
 * asked first** (#251). Fedora's `/usr/bin/npm` links to
 * `/usr/lib/node_modules_22/npm/bin/npm-cli.js`, a directory name no walk from
 * `/usr/bin` would guess, so `npm` fell through to being spawned as the link -
 * which is a shell script's interpreter line deciding what runs, and failed the
 * gate's own test of this function. nvm's and Homebrew's links point at the
 * entry too. The walk stays for the layouts with a real shim, Windows' among
 * them, and it now starts from the target as well as the link.
 */
function nodeEntry(program: string): string | null {
  const relatives = NODE_CLIS[program];
  if (relatives === undefined) return null;
  const shim = onPath(program);
  if (shim === null) return null;
  let real = shim;
  try {
    real = realpathSync(shim);
  } catch {
    // A link that cannot be resolved is searched as the path PATH gave.
  }
  for (const relative of relatives) {
    // `node_modules/npm/bin/npm-cli.js` -> `npm/bin/npm-cli.js`: the part of the
    // entry's path that every layout agrees on, whatever its node_modules is called.
    const tail = relative.split('/').slice(1).join(path.sep);
    if (real !== shim && real.endsWith(path.sep + tail) && existsSync(real)) return real;
  }
  for (const start of real === shim ? [shim] : [real, shim]) {
    let dir = path.dirname(start);
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

export interface Handlers {
  /** Called as output arrives, so a window can stream it. */
  onOutput?: ((id: string, chunk: string) => void) | undefined;
  /** Called once, when it ends. */
  onEnd?: ((record: CommandRecord) => void) | undefined;
  now?: (() => number) | undefined;
}

export interface StartOptions extends Handlers {
  program: string;
  args: readonly string[];
  dir: string;
}

/** Keep `chunk` in the bounded buffer and pass it on. Output is never decided on. */
function take(live: Live, chunk: string, handlers: Handlers): void {
  let output = live.record.output + chunk;
  let truncated = live.record.truncated;
  if (output.length > OUTPUT_KEEP_BYTES) {
    output = output.slice(output.length - OUTPUT_KEEP_BYTES);
    truncated = true;
  }
  live.record = { ...live.record, output, truncated };
  live.bytes += chunk.length;
  handlers.onOutput?.(live.record.id, chunk);
}

/** Record the ending, once. Every road to an ending comes through here. */
function finish(live: Live, code: number | null, signal: string | null, handlers: Handlers): void {
  if (live.record.endedAt !== null) return;
  live.unfollow?.();
  live.unfollow = null;
  live.child = null;
  live.record = { ...live.record, endedAt: (handlers.now ?? (() => Date.now()))(), code, signal };
  persist(live.record);
  handlers.onEnd?.(live.record);
}

/**
 * Read a detached command's log as it grows, from byte `from`.
 *
 * For a command this process did not spawn, the same tick is also how its end
 * is noticed: there is no `exit` event for a process that is not our child, so
 * the pid going away is the ending, and its code is not something anybody here
 * can see.
 */
function follow(live: Live, file: string, from: number, handlers: Handlers): void {
  let position = from;
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.alloc(64 * 1024);
  const drain = (): void => {
    let fd: number;
    try {
      fd = openSync(file, 'r');
    } catch {
      return;
    }
    try {
      for (;;) {
        const n = readSync(fd, buffer, 0, buffer.length, position);
        if (n <= 0) break;
        position += n;
        const text = decoder.write(buffer.subarray(0, n));
        if (text !== '') take(live, text, handlers);
      }
    } finally {
      closeSync(fd);
    }
  };
  const tick = (): void => {
    drain();
    if (live.child === null && live.group !== null && !alive(live.group)) {
      drain();
      finish(live, null, null, handlers);
    }
  };
  const timer = setInterval(tick, FOLLOW_MS);
  // A follower must never be what keeps the host alive: on its way out the
  // host leaves detached commands running, and this is only watching them.
  timer.unref();
  live.unfollow = () => {
    clearInterval(timer);
    drain();
  };
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
    pid: null,
    adopted: false,
  };
  const live: Live = { record, child: null, group: null, bytes: 0, unfollow: null };
  commands.set(id, live);
  const handlers: Handlers = { ...options, now };

  const detached = detaches() && logDir !== null ? logDir : null;
  let child: ChildProcess;
  let out: number | null = null;
  try {
    if (detached !== null) {
      mkdirSync(detached, { recursive: true });
      out = openSync(logFile(detached, id), 'a');
    }
    child = spawn(plan.file, [...plan.argv], {
      cwd: dir,
      // **Never a shell.** The whole module depends on this line.
      shell: false,
      windowsHide: true,
      // Detached, it writes into its own log and leads its own process group,
      // so it outlives this process; see `detaches`.
      detached: out !== null,
      stdio: out === null ? ['ignore', 'pipe', 'pipe'] : ['ignore', out, out],
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    live.record = { ...record, endedAt: now(), output: message };
    persist(live.record, message);
    persist(live.record);
    return live.record;
  } finally {
    // The child holds its own copy; this one is only ever ours to close.
    if (out !== null) closeSync(out);
  }
  live.child = child;
  live.record = { ...live.record, pid: child.pid ?? null };
  persist(live.record);

  if (detached !== null) {
    live.group = child.pid ?? null;
    child.unref();
    follow(live, logFile(detached, id), 0, handlers);
    child.on('error', (err: Error) => {
      persist(live.record, `\n${err.message}\n`);
      finish(live, null, null, handlers);
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => finish(live, code, signal, handlers));
    return live.record;
  }

  const append = (chunk: string): void => {
    persist(live.record, chunk);
    take(live, chunk, handlers);
  };
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  // Interleaved, because that is what a person reading a terminal sees and the
  // ordering between the two streams is the thing that makes a failure legible.
  child.stdout?.on('data', (d: string) => append(d));
  child.stderr?.on('data', (d: string) => append(d));
  child.on('error', (err: Error) => append(`\n${err.message}\n`));
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => finish(live, code, signal, handlers));

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
 *
 * A detached command is stopped by its **group**: it leads one, so `npm run
 * dev` takes the Vite and the watcher it started with it, which killing the one
 * pid would not.
 */
export function stopCommand(id: string): boolean {
  const live = commands.get(id);
  if (live === undefined || live.record.endedAt !== null) return false;
  if (live.group === null && live.child === null) return false;
  live.record = { ...live.record, stopped: true };
  if (live.group !== null) {
    try {
      process.kill(-live.group, 'SIGTERM');
    } catch {
      try {
        process.kill(live.group, 'SIGTERM');
      } catch {
        return false;
      }
    }
    return true;
  }
  live.child?.kill();
  return true;
}

/**
 * Stop what cannot outlive this process. Returns how many were killed.
 *
 * The host calls this on its way out and `process.exit` follows at once. A
 * **detached** command is left running - that is the point of it, and the next
 * launch picks it up (see `detaches`) - and its record is left saying it is
 * running, which is true. A piped one would die with its pipes anyway, so it is
 * stopped and written as stopped now: no `close` handler will run, and
 * otherwise it would come back as `lost`, which is the word for a host that
 * died without saying anything.
 */
export function stopTiedCommands(now: () => number = () => Date.now()): number {
  let killed = 0;
  for (const [id, live] of commands) {
    if (live.group !== null) {
      live.unfollow?.();
      continue;
    }
    if (!stopCommand(id)) continue;
    killed += 1;
    persist({ ...live.record, endedAt: now() });
  }
  return killed;
}

/** Test seam: forget every command. Never called by the product. */
export function clearCommands(): void {
  // Detached ones would outlive the test that started them.
  for (const [id, live] of commands) {
    stopCommand(id);
    live.unfollow?.();
  }
  commands.clear();
  next = 0;
  logDir = null;
}
