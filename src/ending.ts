import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * How the vibe process itself ended, written by the process on its way out.
 *
 * A leaf, for the reason `@src/lock.js` gives for being one, and a sibling of
 * it: the lock says *a process holds this run*, and this says *the process that
 * held it said goodbye*. Neither is a fact about the loop, so neither belongs in
 * `run.ts`, and both have to be writable from paths that hold no `RunState` at
 * all. This imports nothing from either.
 *
 * **Why the pair matters more than either half.** Three v1.3 issues exist
 * because a process was stopped mid-turn, and every one of them repairs what the
 * stop left behind rather than recording the stop (#131). A lock left behind by
 * a dead pid reads as `interrupted`, and `interrupted` has always meant two
 * completely different things at once: *vibe chose to stop and did not get to
 * tidy up*, and *something outside vibe killed it*. With a stamp beside the
 * lock those separate:
 *
 * | lock | ending | what happened |
 * |---|---|---|
 * | dead pid | present | the process ended under its own control; the lock is litter |
 * | dead pid | absent  | something terminated it without running a line of its code |
 * | live pid | absent  | a run is going on right now |
 *
 * Row two is the whole issue. It is not a diagnosis - it does not say *what*
 * terminated the process - but it rules out every ending vibe is capable of
 * choosing, which is the class of causes the #87 investigation could not
 * eliminate and therefore could not look past.
 *
 * **A separate file, not a field on `state.json`.** The stamp is written from a
 * signal handler, which runs between ticks and cannot interleave with a
 * synchronous write - but it is also written when the process is already
 * failing, and a read-modify-write over the run's only durable record is the
 * wrong thing to attempt at that moment. A torn `ending.json` costs this
 * finding; a torn `state.json` costs the run. The lock made the same trade for
 * the same reason.
 */

/** What a departing process writes about its own ending. */
export interface RunEnding {
  /**
   * Which process this describes. A run resumed on the same machine reuses the
   * directory, not the pid, so a stamp whose pid does not match the lock beside
   * it is a stamp from an earlier process - see `installEndingStamp`, which
   * clears one rather than leaving a reader to work that out.
   */
  pid: number;
  host: string;
  at: string;
  /**
   * `exit` - the event loop drained, `process.exit()` was called, or an
   * uncaught exception took the default path. Every ending vibe chooses,
   * including all eight of its exit codes, arrives here.
   *
   * `signal` - one of the signals this process listens for arrived. See
   * `STAMPED_SIGNALS` for which, and for the one that is deliberately missing.
   */
  how: 'exit' | 'signal';
  /**
   * The process's own exit code at the moment it stamped, or null.
   *
   * Null on the signal path, where the code is not yet decided, and null on an
   * exit whose code was never set - which Node reports as 0 and this does not,
   * because "nobody set one" and "somebody set zero" are the same outcome and
   * different facts. A reader wanting the outcome has `how`.
   */
  code: number | null;
  /** The signal that arrived, or null on the exit path. */
  signal: string | null;
}

export const ENDING_FILE = 'ending.json';

export function endingPath(dir: string): string {
  return path.join(dir, ENDING_FILE);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The ending stamp in a run directory, or null. Never throws.
 *
 * Null covers absent, unreadable and malformed alike, and that collapse is
 * safe here where the same collapse is refused in `readLock`: a lock that
 * cannot be read must not license a second writer, so its failures have to stay
 * distinguishable. Nothing is licensed by this file. A stamp vibe cannot read
 * is a stamp it does not have, and the reader's fallback - *no ending was
 * recorded* - is already the honest thing to say about it.
 */
export function readEnding(dir: string): RunEnding | null {
  let text: string;
  try {
    text = readFileSync(endingPath(dir), 'utf8');
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const { pid, host, at, how, code, signal } = raw;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof host !== 'string' || host === '') return null;
  if (typeof at !== 'string' || at === '') return null;
  if (how !== 'exit' && how !== 'signal') return null;
  // Both are nullable and both must be *stated*: a stamp missing the field is
  // one this build did not write, and reading a missing `signal` as null would
  // report an unknown shape as an ordinary exit.
  if (code !== null && (typeof code !== 'number' || !Number.isInteger(code))) return null;
  if (signal !== null && (typeof signal !== 'string' || signal === '')) return null;
  return { pid, host, at, how, code, signal };
}

/** The stamp as a sentence, for a listing or a refusal. */
export function describeEnding(ending: RunEnding): string {
  const who = `pid ${ending.pid} on ${ending.host}`;
  if (ending.how === 'signal') {
    return `${who} was sent ${ending.signal ?? 'a signal'} and recorded it before going, at ${ending.at}`;
  }
  const code = ending.code === null ? 'no exit code set' : `exit ${ending.code}`;
  return `${who} exited under its own control (${code}) at ${ending.at}`;
}

/**
 * Signals that get a stamp, and the one that does not.
 *
 * **`SIGINT` is deliberately absent.** Ctrl-C has to keep working exactly as it
 * does - `acquireLock` says so in the same words and for the same reason - and
 * on Windows the re-raise below is emulated by `TerminateProcess`, so a handler
 * here would change the exit code a Ctrl-C produces on the platform this repo
 * is developed on. The three that remain cannot arrive from a keyboard: SIGTERM
 * is another process asking, SIGBREAK is Ctrl-Break, and SIGHUP on Windows is
 * the console window being closed - which is one of the plausible causes of the
 * two #87 stops and, until now, indistinguishable from every other cause.
 *
 * Windows delivers none of these as real signals; Node emulates all three. So
 * there is no "terminated by signal" wait status to preserve on the platform
 * where the re-raise is least faithful, and nothing is lost by it there.
 */
const STAMPED_SIGNALS: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGBREAK', 'SIGHUP'];

/** Seam for the tests: the real hooks are process-global and unrunnable twice. */
export interface ProcessHooks {
  pid: number;
  exitCode: () => number | undefined;
  onExit: (fn: () => void) => void;
  offExit: (fn: () => void) => void;
  onceSignal: (signal: NodeJS.Signals, fn: () => void) => void;
  offSignal: (signal: NodeJS.Signals, fn: () => void) => void;
  raise: (signal: NodeJS.Signals) => void;
}

export const nodeHooks: ProcessHooks = {
  pid: process.pid,
  exitCode: () => process.exitCode as number | undefined,
  onExit: (fn) => {
    process.on('exit', fn);
  },
  offExit: (fn) => {
    process.removeListener('exit', fn);
  },
  onceSignal: (signal, fn) => {
    process.once(signal, fn);
  },
  offSignal: (signal, fn) => {
    process.removeListener(signal, fn);
  },
  raise: (signal) => {
    process.kill(process.pid, signal);
  },
};

export interface EndingStamp {
  /** The stamp this installation displaced, so the caller can record it. */
  previous: RunEnding | null;
  /** Idempotent. Removes the hooks; leaves any stamp already written in place. */
  uninstall: () => void;
}

/**
 * Stamp this process's ending into the run directory as it leaves.
 *
 * Returns the stamp it displaced, because installing destroys it: the previous
 * process's ending is the record this issue exists to create, and a resume that
 * silently overwrote it would delete the evidence on the way to investigating
 * it. The caller records it against the run once state is loaded.
 *
 * **The signal path re-raises rather than exiting.** The listener is removed
 * before it runs, so `raise` finds the default disposition and the process dies
 * exactly as it would have - same wait status on POSIX, same timing to within a
 * write. That is the whole difference between this and the SIGINT handler
 * `acquireLock` refuses: that one would have changed how the process exits in
 * order to tidy a lock, and this one changes nothing in order to record a fact
 * that is otherwise unobtainable. If the re-raise is ever removed, this becomes
 * that, and the refusal in `acquireLock` applies to it.
 *
 * Nothing here throws. A run that cannot write its ending has lost this
 * finding, and losing a finding must never be what ends a run - least of all
 * from inside the handler that is already ending it.
 */
export function installEndingStamp(dir: string, hooks: ProcessHooks = nodeHooks): EndingStamp {
  const previous = readEnding(dir);
  try {
    rmSync(endingPath(dir), { force: true });
  } catch {
    // A stamp that could not be cleared is about to be overwritten anyway. The
    // only cost is that a reader between now and then sees the old process's
    // ending beside this process's live lock, which the pid on it contradicts.
  }

  let stamped = false;
  const write = (ending: RunEnding): void => {
    // First writer wins. Both paths are reachable in one teardown on some
    // platforms, and the first is the one that says what actually happened.
    if (stamped) return;
    stamped = true;
    try {
      writeFileSync(endingPath(dir), JSON.stringify(ending, null, 2), 'utf8');
    } catch {
      // See the note above: never from in here.
    }
  };

  const onExit = (): void => {
    const code = hooks.exitCode();
    write({
      pid: hooks.pid,
      host: os.hostname(),
      at: new Date().toISOString(),
      how: 'exit',
      code: typeof code === 'number' ? code : null,
      signal: null,
    });
  };

  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of STAMPED_SIGNALS) {
    const handler = (): void => {
      write({
        pid: hooks.pid,
        host: os.hostname(),
        at: new Date().toISOString(),
        how: 'signal',
        code: null,
        signal,
      });
      hooks.raise(signal);
    };
    handlers.set(signal, handler);
    hooks.onceSignal(signal, handler);
  }
  hooks.onExit(onExit);

  let removed = false;
  return {
    previous,
    uninstall: () => {
      if (removed) return;
      removed = true;
      hooks.offExit(onExit);
      for (const [signal, handler] of handlers) hooks.offSignal(signal, handler);
    },
  };
}
