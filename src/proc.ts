import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// The one import, and it points the other way from everything else here:
// `cancel.ts` is a leaf that imports only this module's types, so the kill
// mechanism lives beside the spawn rather than being threaded down to it.
import { Cancelled, CANCEL_ENDING, cancelRequested, registerInterruptible } from '@src/cancel.js';

const isWin = process.platform === 'win32';

export function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export interface ResolveOptions {
  envVar?: string;
  fallbacks?: readonly string[];
  /**
   * Paths matching this are skipped when scanning PATH, but still honoured as
   * explicit fallbacks. For install layouts that put a non-functional helper
   * copy of a CLI on PATH ahead of the real one.
   */
  deprioritize?: RegExp;
}

/**
 * Resolve a CLI to an absolute executable path.
 *
 * A real `.exe` always wins over a `.cmd`/`.ps1` shim: spawning a shim on
 * Windows requires `shell: true`, which drags in quoting rules we do not want
 * anywhere near model-authored text. npm-installed CLIs put only a shim on
 * PATH while the real binary sits in node_modules, so the known fallback paths
 * are checked before settling for one.
 */
export function resolveBin(name: string, options: ResolveOptions = {}): string {
  const { envVar, fallbacks = [], deprioritize } = options;

  const override = envVar ? process.env[envVar] : undefined;
  if (override) {
    const expanded = expandHome(override);
    if (!existsSync(expanded)) {
      throw new Error(`${envVar} points at a missing file: ${expanded}`);
    }
    return expanded;
  }

  // Absolute path, not a bare name: this resolver has to work *in* the broken
  // environments it exists to diagnose. On the host that motivated this,
  // System32 appears on PATH only as an unresolvable `/cygdrive/c/...` entry,
  // so spawning a bare `where.exe` fails and every lookup silently returns
  // "not found" - including the ones used to repair the environment.
  const finder = isWin
    ? path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'where.exe')
    : 'which';
  const found = spawnSync(finder, [name], { encoding: 'utf8' });
  const allHits =
    found.status === 0
      ? found.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : [];
  const hits = deprioritize ? allHits.filter((h) => !deprioritize.test(h)) : allHits;

  const exe = hits.find((h) => h.toLowerCase().endsWith('.exe'));
  if (exe) return exe;

  for (const candidate of fallbacks) {
    const expanded = expandHome(candidate);
    if (expanded.includes('*')) {
      const hit = scanVersionedDir(expanded);
      if (hit) return hit;
    } else if (existsSync(expanded)) {
      return expanded;
    }
  }

  const shim = hits.find((h) => /\.(cmd|bat)$/i.test(h));
  if (shim) return shim;
  if (!isWin && hits[0]) return hits[0];

  throw new Error(
    `Could not locate "${name}". Set ${envVar ?? 'its path'} or add it to PATH. ` +
      `Run "vibe doctor" for details.`,
  );
}

/** Resolve a single-`*` path such as `<root>/bin/(*)/codex.exe` to the newest match. */
function scanVersionedDir(pattern: string): string | null {
  const idx = pattern.indexOf('*');
  const head = pattern.slice(0, idx);
  // When `*` is a whole segment (`.../bin/*/codex.exe`) the directory to scan
  // is `head` itself once its trailing separator is dropped. Using dirname
  // unconditionally climbs one level too far and the pattern silently matches
  // nothing - which reads as "not installed" rather than as a bad pattern.
  const root = /[\\/]$/.test(head) ? head.replace(/[\\/]+$/, '') : path.dirname(head);
  const tail = pattern.slice(idx + 1).replace(/^[\\/]/, '');
  if (!existsSync(root)) return null;

  let best: { candidate: string; mtime: number } | null = null;
  for (const entry of readdirSync(root)) {
    const candidate = path.join(root, entry, tail);
    if (!existsSync(candidate)) continue;
    const mtime = statSync(candidate).mtimeMs;
    if (!best || mtime > best.mtime) best = { candidate, mtime };
  }
  return best ? best.candidate : null;
}

export interface RunOptions {
  input?: string | undefined;
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  /**
   * Called with each complete stdout line as it arrives, and never after the
   * returned promise settles. Buffering is unchanged: `stdout` is still
   * returned in full. A throwing hook is swallowed - this is a progress
   * signal, and losing it must never cost the turn.
   */
  onLine?: ((line: string) => void) | undefined;
  /**
   * Whether a cancel may kill this child (#209).
   *
   * **Off by default, and the default is the safe one.** The two agent adapters
   * set it and nothing else does: `git`, the verification gate and the
   * app-server client all come through here, and none of them is something
   * "stop the turn" gives permission to kill. A `git commit` killed mid-write
   * leaves an index a later resume has to recover from, and the verification
   * gate is the *user's own command* - a suite killed half-way is a `failing`
   * verdict about a run nobody completed (#135).
   */
  interruptible?: boolean | undefined;
}

export interface RunResult {
  code: number | null;
  /**
   * The signal that ended the child, or null when it exited under its own power.
   *
   * `close` has always carried this and it was always thrown away, so a turn
   * whose child was killed and one whose child exited non-zero arrived here as
   * the same fact - `code: null` - and the run record could not tell them apart
   * (#131). Exactly one of the two is ever set: Node gives `(code, null)` on an
   * exit and `(null, signal)` on a signal death, and both null is the shape a
   * child that could not be spawned at all leaves behind, which never reaches
   * `close`.
   *
   * Required rather than optional, so every producer - including a test's fake
   * transport - has to say which it observed. An absent signal defaulted to
   * `null` would read as "exited normally" on a killed turn, which is the one
   * claim this field exists to stop being made.
   *
   * **`signal === null` does not mean the child was not killed, on Windows.**
   * Windows has no signals: an outside kill - Task Manager, `Stop-Process`, a
   * parent that did not spawn this child - becomes `TerminateProcess`, and the
   * child closes with an exit code and no signal at all. Only a kill vibe sends
   * to its *own* child handle, as the timeout path does, survives as a signal
   * there. So this field is the sharper answer where it is available and never
   * the complete one, which is why `isAbnormal` and not `signal !== null` is
   * what the recording site asks - and why #131's other half stamps the parent.
   */
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/**
 * How a child process ended, keyed by the error raised because it ended that
 * way.
 *
 * A side table for the reason `SPENT` in `src/charge.ts` is one, and modelled on
 * it deliberately: every error raised today must still be raised with the same
 * type and reach the same handler, and this value has to ride on a
 * `RateLimitError` as readily as on a plain `Error`. Nothing in `err.message`,
 * `err.stack` or the `error` event changes.
 *
 * Unlike `SPENT`, an ending of "exit 0, no signal" is still recorded when a
 * throw site attaches one. The accounting can treat a spend of nothing as
 * nothing to say; a *cause of death* has no equivalent zero, and "the child
 * exited cleanly and the adapter rejected its output anyway" is a different
 * finding from "the child was killed", which is the distinction #131 exists to
 * preserve.
 */
const ENDED = new WeakMap<object, ChildEnding>();

/** What `close` reported about a child, carried out on the error it caused. */
export interface ChildEnding {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Record how the child ended on the error that ends this turn. Returns `err`,
 * so a throw site can attach and throw in one expression.
 */
export function attachEnding<E>(err: E, ending: ChildEnding): E {
  if (typeof err === 'object' && err !== null) ENDED.set(err, ending);
  return err;
}

/**
 * How the child behind this error ended, or null when nobody attached one.
 *
 * Null is a real answer and is not the same as `{code: null, signal: null}`: it
 * means this failure did not come from a child ending at all - a rate limit
 * detected mid-stream, a schema the adapter refused - so the reader must not
 * report an ending for it. Read without consuming, because unlike a spend an
 * ending is not paid and cannot be double-counted.
 */
export function endingOf(err: unknown): ChildEnding | null {
  if (typeof err !== 'object' || err === null) return null;
  return ENDED.get(err) ?? null;
}

/** Whether an ending is worth a reader's attention: a signal, or a bad exit. */
export function isAbnormal(ending: ChildEnding): boolean {
  return ending.signal !== null || ending.code !== 0;
}

/** "killed by SIGKILL", "exit 1", or "neither an exit code nor a signal". */
export function describeEnding(ending: ChildEnding): string {
  if (ending.signal !== null) return `killed by ${ending.signal}`;
  if (ending.code !== null) return `exit ${ending.code}`;
  // Not reachable from `close`, which always supplies one of the two - but a
  // caller may construct an ending from a source that observed neither, and
  // saying so is the point of the issue rather than an oversight in it.
  return 'neither an exit code nor a signal';
}

/**
 * The shape of `run`, so an adapter can take it as an injected dependency and
 * be driven by a test without spawning an agent.
 */
export type RunFn = (
  bin: string,
  args: readonly string[],
  options?: RunOptions,
) => Promise<RunResult>;

/**
 * Run a command, feeding `input` on stdin. Never uses a shell unless forced to
 * by a `.cmd` shim.
 *
 * Passing the prompt via stdin rather than argv is load-bearing: Claude's
 * variadic flags such as --tools and --allowedTools otherwise swallow a
 * positional prompt argument.
 */
export function run(bin: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const { input, cwd, timeoutMs, onLine, interruptible } = options;

  return new Promise<RunResult>((resolve, reject) => {
    // Before the spawn, and the ordering is the fail-closed half of #209. A
    // cancelled turn's error has to travel up through the retry logic and the
    // loop's own handlers, any one of which could plausibly decide to have
    // another go; refusing here means the next agent child does not start at
    // all, rather than every layer in between having to remember not to.
    const stopped = interruptible === true ? cancelRequested() : null;
    if (stopped !== null) {
      reject(new Cancelled(stopped));
      return;
    }

    const needsShell = isWin && /\.(cmd|bat)$/i.test(bin);
    const child = spawn(bin, [...args], {
      ...(cwd === undefined ? {} : { cwd }),
      shell: needsShell,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let pending = '';
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    // Gated on `settled`, not just on the close path: a timed-out child is
    // killed *after* the promise has rejected, and both its final `data` and
    // its `close` would otherwise deliver progress for a turn the caller has
    // already given up on. One helper, so there is no second place to forget
    // the guard.
    const emitLine = (line: string): void => {
      if (settled || onLine === undefined || line === '') return;
      try {
        onLine(line);
      } catch {
        // A progress hook must never take down a run.
      }
    };
    const drain = (final: boolean): void => {
      let idx = pending.indexOf('\n');
      while (idx >= 0) {
        emitLine(pending.slice(0, idx).replace(/\r$/, ''));
        pending = pending.slice(idx + 1);
        idx = pending.indexOf('\n');
      }
      if (final && pending !== '') {
        emitLine(pending);
        pending = '';
      }
    };

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      stdout += d;
      if (onLine === undefined) return;
      pending += d;
      drain(false);
    });
    child.stderr.on('data', (d: string) => {
      stderr += d;
    });

    // Unregistered on every path out, in `settle`, so a child that ended on its
    // own is never in the set when a later cancel walks it - a stale entry is a
    // kill aimed at a pid the OS may have handed to somebody else by then.
    let unregister: (() => void) | null = null;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unregister?.();
      fn();
    };

    if (interruptible === true) {
      unregister = registerInterruptible(() => {
        child.kill('SIGKILL');
        // Rejected here rather than left to `close`, for the reason the timeout
        // path settles itself: the caller has been given up on, and a `close`
        // arriving afterwards would resolve a turn somebody stopped as though
        // it had merely exited. `Cancelled` is a class rather than a message so
        // the layers above can tell it from an ordinary failure without
        // matching English - a turn that failed may be worth retrying, and a
        // turn somebody stopped never is.
        settle(() =>
          reject(attachEnding(new Cancelled(cancelRequested() ?? 'asked to stop'), CANCEL_ENDING)),
        );
      });
    }

    // The accumulated `stdout` dies with this closure, and that is deliberate.
    // A timed-out turn's usage is not a number worth charging: Codex reports
    // usage only on `turn.completed`, which a killed turn never emits, so there
    // is literally nothing to recover; and Claude's timed-out stream has no
    // `result` envelope, leaving only the per-message `usage` blocks that
    // claude.ts's `extractUsage` already documents as unsummable - their cache
    // reads repeat the whole prompt per request. Either figure would put a
    // number in `state.tokensUsed` that nobody could trace to a source, against
    // a ceiling that stops runs. Carrying the partial output out would also
    // change this boundary for git, verify and the app-server, which do not
    // want it.
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        // The SIGKILL is attached even though vibe sent it, and that is not a
        // false alarm: the reader of a run record wants to know the child died
        // on a signal, and the message beside it already says who sent it and
        // why. An ending omitted here because "we know this one" is a hole the
        // next reader has to know about (#131).
        settle(() =>
          reject(
            attachEnding(new Error(`${path.basename(bin)} timed out after ${timeoutMs}ms`), {
              code: null,
              signal: 'SIGKILL',
            }),
          ),
        );
      }, timeoutMs);
    }

    child.on('error', (err: Error) => settle(() => reject(err)));
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      // Before `settle`: a single-line output with no trailing newline must
      // still reach the hook, while on the timeout path `settled` is already
      // true and this emits nothing.
      drain(true);
      settle(() => resolve({ code, signal, stdout, stderr }));
    });

    if (input !== undefined) child.stdin.write(input, 'utf8');
    child.stdin.end();
  });
}
