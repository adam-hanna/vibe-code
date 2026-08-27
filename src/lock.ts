import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';

/**
 * Whether a run is being worked on right now, and by whom.
 *
 * A leaf, for the reason `@src/charge.js` gives for being one: `run.ts` owns run
 * state and `cli.ts` owns the commands, but neither owns the question "is
 * another process already driving this run", and answering it inside either
 * would put a filesystem probe on a path that has to keep other promises -
 * `listRuns` never throws and never writes, and `loadRun` must be able to say
 * nothing was rewritten. This imports nothing from either.
 *
 * **The lock is the verdict; the timestamps are colour.** `lastActivityAt` and
 * its two neighbours can only say *quiet*, and quiet is not dead: the
 * verification gate runs the project's test command three times at up to fifteen
 * minutes each, entirely outside any heartbeat, so a perfectly healthy run is
 * routinely silent for far longer than any staleness threshold would tolerate.
 * A pid can say *gone*. Neither alone is an answer; together they are one.
 *
 * **The lock is a refusal, not a mutex.** `--force` exists, a foreign host
 * cannot be probed at all, and nothing here serialises anything. What it buys is
 * that vibe declines to start a second writer over a run it can see is live,
 * and says why.
 */

/** What a live process writes about itself into the run directory. */
export interface RunLock {
  pid: number;
  host: string;
  startedAt: string;
  id: string;
  /**
   * Unique per acquisition, so a release can prove the lock it is removing is
   * the one it took. A pid alone cannot: this process may acquire, release and
   * acquire again, and the first handle's exit listener would otherwise unlink
   * the second handle's lock.
   */
  token: string;
}

export type Liveness = 'running' | 'interrupted' | 'not-running' | 'unknown';

export interface LivenessVerdict {
  liveness: Liveness;
  lock: RunLock | null;
  /**
   * How long since vibe last observed anything at all, from `lastActivityAt`.
   *
   * Null whenever that field is absent - a run whose progress heartbeat was
   * disabled maintains none of the liveness timestamps, and reporting "quiet for
   * 0m" over an absent field would be a measurement nobody took. Reported as a
   * fact about output, never as a verdict about life.
   */
  quietMs: number | null;
}

export interface LockHandle {
  /** The verdict as it stood *before* this acquisition overwrote anything. */
  verdict: LivenessVerdict;
  /** Whether this lock was taken over a verdict that would otherwise refuse. */
  forced: boolean;
  /** Idempotent, and never removes a lock this handle did not write. */
  release: () => void;
}

export const LOCK_FILE = 'run.lock';

export function lockPath(dir: string): string {
  return path.join(dir, LOCK_FILE);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The lock in a run directory, or null. Never throws.
 *
 * A file that cannot be read or does not parse returns null, and the caller
 * turns that into `unknown` rather than into `not-running`: this is the one
 * place where "I could not tell" and "there is nothing here" must not collapse
 * into the same answer, because one of them licenses a second writer.
 */
export function readLock(dir: string): RunLock | null {
  const read = readLockFile(dir);
  return read.kind === 'lock' ? read.lock : null;
}

/**
 * The same read, with the distinction `readLock` cannot express in `null`.
 *
 * `ENOENT` is the only error that means *there is no lock*. Every other failure -
 * `EACCES`, `EPERM`, `EBUSY`, `EIO`, a directory where the file should be - means
 * vibe could not find out, and a lock it could not read cannot rule out a live
 * process. Collapsing those into "absent" is precisely what would license a
 * second writer over a running run, so they come back as `unreadable` and the
 * caller turns that into `unknown`.
 */
type LockRead =
  | { kind: 'absent' }
  | { kind: 'unreadable' }
  | { kind: 'lock'; lock: RunLock };

function readLockFile(dir: string): LockRead {
  let text: string;
  try {
    text = readFileSync(lockPath(dir), 'utf8');
  } catch (err: unknown) {
    return (err as { code?: unknown } | null)?.code === 'ENOENT'
      ? { kind: 'absent' }
      : { kind: 'unreadable' };
  }
  const lock = parseLock(text);
  // Present and readable but not a lock: a torn or hand-edited file. Unreadable,
  // never absent, for the reason above.
  return lock === null ? { kind: 'unreadable' } : { kind: 'lock', lock };
}

function parseLock(text: string): RunLock | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  const { pid, host, startedAt, id, token } = raw;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof host !== 'string' || host === '') return null;
  if (typeof startedAt !== 'string' || startedAt === '') return null;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof token !== 'string' || token === '') return null;
  return { pid, host, startedAt, id, token };
}

/**
 * What a pid probe can honestly conclude - three answers, not two.
 *
 * `process.kill(pid, 0)` sends no signal and only asks. Success and `EPERM` both
 * mean the process exists (`EPERM` is someone else's process, which is still
 * alive). **Only `ESRCH` means it is gone.** Anything else - a platform that
 * refuses the probe, an error with no code at all - is a question vibe could not
 * answer, and answering it "gone" is what would let a resume start a second
 * writer over a live run. Works on Windows.
 *
 * **Pid reuse is real and is not solved here.** A recycled pid makes a dead
 * run's lock read as `running`, which refuses a resume that should have been
 * allowed. That is the safe direction - the alternative is two processes
 * writing one run - and `--force` is the way out. There is deliberately no
 * heuristic guessing around it: every candidate (start time, process name,
 * command line) is another platform-specific probe that can be wrong in the
 * unsafe direction.
 */
function probePid(pid: number): 'running' | 'interrupted' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'running';
  } catch (err: unknown) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'EPERM') return 'running';
    if (code === 'ESRCH') return 'interrupted';
    return 'unknown';
  }
}

/**
 * Whether the run's stored config had the progress heartbeat switched off.
 *
 * The quiet figure is measured from `lastActivityAt`, which only the heartbeat
 * advances - so with progress disabled the timestamp is either absent or frozen
 * at whenever it was last enabled, and reporting an ever-growing "quiet for 3h"
 * off a field nothing is updating would be a measurement nobody is taking. The
 * timestamp alone cannot say this: `resumeConfig` can turn progress off on a run
 * that already recorded activity, leaving the stale value behind.
 *
 * Absent or unrecognisable config means the default, read from `DEFAULTS` rather
 * than restated here.
 */
function progressDisabled(raw: unknown): boolean {
  if (!isRecord(raw)) return !DEFAULTS.progress.enabled;
  const config = raw['config'];
  if (!isRecord(config)) return !DEFAULTS.progress.enabled;
  const progress = config['progress'];
  if (!isRecord(progress)) return !DEFAULTS.progress.enabled;
  const enabled = progress['enabled'];
  if (typeof enabled !== 'boolean') return !DEFAULTS.progress.enabled;
  return !enabled;
}

function quietSince(raw: unknown): number | null {
  if (!isRecord(raw)) return null;
  if (progressDisabled(raw)) return null;
  const last = raw['lastActivityAt'];
  if (typeof last !== 'string') return null;
  const at = Date.parse(last);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Date.now() - at);
}

/**
 * What a run directory says about whether anyone is working on it.
 *
 * **Never throws and never writes**, both of which `listRuns` depends on: it is
 * on the planner's path since #52, and one unreadable run must not take out the
 * listing of every healthy one beside it.
 *
 * `raw` is the parsed `state.json` when the caller already has it, and is only
 * used for the quiet figure. Omitting it costs the colour, never the verdict.
 */
export function livenessOf(dir: string, raw?: unknown): LivenessVerdict {
  const quietMs = quietSince(raw);
  const read = readLockFile(dir);

  // The only reading that means nobody claims this run: the file is genuinely
  // not there. One read, so there is no gap between "does it exist" and "what
  // does it say" for another process to acquire in - and no `existsSync`, which
  // reports an unreadable file and an absent one with the same `false`.
  if (read.kind === 'absent') return { liveness: 'not-running', lock: null, quietMs };

  // Present but unreadable, unparseable or malformed. Fails closed: a lock vibe
  // cannot read cannot rule out a live process, and treating it as absent is
  // what would let a torn write or a permission error license a second writer.
  if (read.kind === 'unreadable') return { liveness: 'unknown', lock: null, quietMs };

  const { lock } = read;
  // Another machine cannot be probed at all, so there is no verdict to give.
  if (lock.host !== os.hostname()) return { liveness: 'unknown', lock, quietMs };

  // Tri-state on purpose: a probe that failed for any reason other than "no such
  // process" is `unknown`, which refuses, rather than `interrupted`, which
  // proceeds. See `probePid`.
  return { liveness: probePid(lock.pid), lock, quietMs };
}

function formatQuiet(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins >= 60) return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`;
  if (mins >= 1) return `${mins}m`;
  return `${Math.floor(ms / 1000)}s`;
}

/**
 * The verdict as a sentence, for a refusal or a listing.
 *
 * The quiet clause is phrased as an observation - "vibe last observed activity
 * 14m ago" - and never as a conclusion. It is there so a user deciding whether
 * to force has the same facts vibe has, not to hint at an answer: `lastActivityAt`
 * advances through silent reasoning blocks and stops entirely between turns, so
 * a large figure means the run is between turns at least as often as it means
 * anything is wrong.
 */
export function describeLiveness(verdict: LivenessVerdict): string {
  const { lock, liveness, quietMs } = verdict;
  const quiet = quietMs === null ? '' : ` vibe last observed activity ${formatQuiet(quietMs)} ago.`;
  if (lock === null) {
    return liveness === 'not-running'
      ? `no run.lock: no process claims this run.${quiet}`
      : `run.lock could not be read, so vibe cannot tell whether a process still owns this run.${quiet}`;
  }
  const who = `pid ${lock.pid} on ${lock.host}, started ${lock.startedAt}`;
  if (liveness === 'running') return `held by a live process: ${who}.${quiet}`;
  if (liveness === 'interrupted') {
    return `held by ${who}, which is no longer running - it was interrupted.${quiet}`;
  }
  // `unknown` with a readable lock has two causes: another machine, or a pid
  // probe on this one that failed for a reason other than "no such process".
  // They are named apart because the way out differs - one is a stale foreign
  // lock to delete by hand, the other is a local condition to look into.
  return lock.host === os.hostname()
    ? `held by ${who}, and vibe could not determine whether that process is still running.${quiet}`
    : `held by ${who}, which is on another machine and cannot be probed from here.${quiet}`;
}

/** Verdicts under which a run may be started without `--force`. */
function permits(liveness: Liveness): boolean {
  return liveness === 'not-running' || liveness === 'interrupted';
}

/**
 * Take the run's lock, or refuse.
 *
 * Takes a **directory and id rather than a `RunState`**, so it can be called
 * before `loadRun` and before any state exists at all. That ordering is the
 * point: `loadRun` writes (it records repairs and ensures the ignore file), and
 * a resume that loaded before it asked permission would have mutated a run
 * another process was in the middle of.
 *
 * The `exit` listener is a backstop for the paths that leave without unwinding -
 * an escalation that returns an exit code from deep in the stack still runs the
 * command's `finally`, but a `process.exitCode` set and returned through main
 * does not run anything else. It is removed on release, and it checks the token
 * for the reason `RunLock.token` gives.
 *
 * There is deliberately **no SIGINT handler**: Node runs no `exit` listeners on
 * signal termination, so Ctrl-C leaves the lock behind with a pid that is now
 * dead - which reads as `interrupted`, which is exactly what happened and the
 * case the whole design is built around. Installing one would change how the
 * process exits and what code it returns, to make a stale lock slightly tidier.
 */
export function acquireLock(
  dir: string,
  id: string,
  force: boolean,
): { ok: boolean; verdict: LivenessVerdict; handle: LockHandle | null } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')) as unknown;
  } catch {
    // No state yet (a fresh `vibe run`) or an unreadable one. Either way the
    // quiet figure is simply absent, which is what it is for.
    raw = undefined;
  }
  const verdict = livenessOf(dir, raw);
  if (!permits(verdict.liveness) && !force) return { ok: false, verdict, handle: null };

  const lock: RunLock = {
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
    id,
    token: randomUUID(),
  };
  try {
    writeFileSync(lockPath(dir), JSON.stringify(lock, null, 2), 'utf8');
  } catch (err: unknown) {
    // A run that cannot record its own lock cannot save its own state either, so
    // this is refused rather than waved through: proceeding would produce a run
    // whose every write is about to fail, several minutes and one agent turn
    // later.
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not write ${lockPath(dir)} (${why}); the run cannot be started.`);
  }

  let released = false;
  const onExit = (): void => {
    release();
  };
  const release = (): void => {
    if (released) return;
    released = true;
    process.removeListener('exit', onExit);
    // Re-read before unlinking: between acquisition and here, a `--force` from
    // another process may have taken this run over, and removing its lock would
    // hand the run to a third. Only the writer of this exact token may remove it.
    const current = readLock(dir);
    if (current === null || current.token !== lock.token) return;
    if (current.pid !== lock.pid || current.host !== lock.host) return;
    try {
      rmSync(lockPath(dir), { force: true });
    } catch {
      // A lock left behind reads as `interrupted` on the next run, which is a
      // recoverable state. Failing the run over it would not be.
    }
  };
  process.on('exit', onExit);

  return { ok: true, verdict, handle: { verdict, forced: !permits(verdict.liveness), release } };
}
