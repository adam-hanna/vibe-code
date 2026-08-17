import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a command, feeding `input` on stdin. Never uses a shell unless forced to
 * by a `.cmd` shim.
 *
 * Passing the prompt via stdin rather than argv is load-bearing: Claude's
 * variadic flags such as --tools and --allowedTools otherwise swallow a
 * positional prompt argument.
 */
export function run(bin: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const { input, cwd, timeoutMs, onLine } = options;

  return new Promise<RunResult>((resolve, reject) => {
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

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        settle(() => reject(new Error(`${path.basename(bin)} timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
    }

    child.on('error', (err: Error) => settle(() => reject(err)));
    child.on('close', (code: number | null) => {
      // Before `settle`: a single-line output with no trailing newline must
      // still reach the hook, while on the timeout path `settled` is already
      // true and this emits nothing.
      drain(true);
      settle(() => resolve({ code, stdout, stderr }));
    });

    if (input !== undefined) child.stdin.write(input, 'utf8');
    child.stdin.end();
  });
}
