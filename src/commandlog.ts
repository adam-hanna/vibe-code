import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * A command's output, kept on disk as it is written (#223).
 *
 * `commands.ts` holds a command in memory, and the host is the only thing that
 * held it - so a relaunch emptied the Commands tab, and a dev server that fell
 * over in the night took the only record of *why* with the process that read
 * it. The answer to *"what else are we storing in memory that should be
 * persisted to disk?"* was this first.
 *
 * **Still not run state**, for the reason `chatstore.ts` gives: a command is
 * started from the window and outlives runs, so its log lives under the app's
 * own data directory and never under `.vibe/runs/<id>`.
 *
 * Two files per command. `<id>.log` is every byte the command wrote, appended as
 * it arrives and **never capped**: the in-memory buffer drops from the front
 * because a reader wants the recent end, and the file is for the reader who
 * wants the rest. `<id>.json` is the record without its output, rewritten
 * whole - tmp then rename - at start and at end.
 */

/** Where the logs live, or null when this process was not told. */
export function commandLogDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = env['VIBE_APP_DATA'];
  return base === undefined || base === '' ? null : path.join(base, 'commands');
}

/**
 * How many past commands are kept.
 *
 * **A retention choice, and allowed to be one**, with the standing of
 * `OUTPUT_KEEP_BYTES` beside it: nothing decides anything from it. It bounds a
 * directory that otherwise grows by one log per button press for ever, and it
 * counts commands rather than bytes because a reader looks for *the one from
 * last night*, not for a size.
 */
export const COMMAND_LOGS_KEPT = 50;

/** What a command was, without its output. The window's `Command` minus the text. */
export interface CommandMeta {
  id: string;
  program: string;
  args: readonly string[];
  resolved: string;
  dir: string;
  startedAt: number;
  endedAt: number | null;
  code: number | null;
  signal: string | null;
  stopped: boolean;
  /**
   * The process, and on POSIX the process group it leads (#223). What lets a
   * later launch find a command still running and pick it back up. Null on a
   * record written before the field, and on a spawn that never got one.
   */
  pid: number | null;
  /**
   * Picked up by a launch that did not start it, so its exit code can never be
   * seen: it is not that process's child. An ending with no code is then a
   * fact about who was watching, not a command that died without one.
   */
  adopted: boolean;
}

/** A past command as a window reads it back. */
export interface PastCommand extends CommandMeta {
  /** The end of the log, at most `keep` characters of it. */
  output: string;
  /** True when the log holds more than `output`. */
  truncated: boolean;
  /**
   * How much the command wrote. The kept tail is counted in characters, as a
   * live command's cursor is, and anything before it in bytes - it is only ever
   * the base `missed` is measured from, and nothing more will be appended.
   */
  bytes: number;
  /**
   * Not running, and its ending was never seen: the host went away while it was
   * running and the process is gone too - it ended while the app was closed,
   * or (with no `pid`) a host that died took it down. `endedAt` stays null and
   * this says why rather than drawing it as live. A command that is still
   * running when a launch reads this is picked back up instead (`commands.ts`).
   */
  lost: boolean;
}

/** The number in `cmd-<n>`, or null. Ids are allocated by `commands.ts`. */
export function idNumber(id: string): number | null {
  const m = /^cmd-(\d+)$/.exec(id);
  return m === null ? null : Number(m[1]);
}

function metaOf(row: unknown): CommandMeta | null {
  if (typeof row !== 'object' || row === null) return null;
  const r = row as Record<string, unknown>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (typeof r['id'] !== 'string' || idNumber(r['id']) === null) return null;
  if (typeof r['program'] !== 'string' || typeof r['resolved'] !== 'string' || typeof r['dir'] !== 'string') return null;
  if (!Array.isArray(r['args']) || !r['args'].every((a) => typeof a === 'string')) return null;
  if (!num(r['startedAt'])) return null;
  const endedAt = r['endedAt'] === null ? null : num(r['endedAt']) ? r['endedAt'] : undefined;
  const code = r['code'] === null ? null : num(r['code']) ? r['code'] : undefined;
  const signal = r['signal'] === null || typeof r['signal'] === 'string' ? r['signal'] : undefined;
  if (endedAt === undefined || code === undefined || signal === undefined) return null;
  return {
    id: r['id'],
    program: r['program'],
    args: r['args'] as string[],
    resolved: r['resolved'],
    dir: r['dir'],
    startedAt: r['startedAt'],
    endedAt,
    code,
    signal,
    stopped: r['stopped'] === true,
    pid: typeof r['pid'] === 'number' && Number.isInteger(r['pid']) && r['pid'] > 0 ? r['pid'] : null,
    adopted: r['adopted'] === true,
  };
}

/** Every readable record, oldest first. A file that does not parse is skipped. */
function metas(dir: string): CommandMeta[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: CommandMeta[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const meta = metaOf(JSON.parse(readFileSync(path.join(dir, name), 'utf8')));
      if (meta !== null) out.push(meta);
    } catch {
      // Half-written by a killed process. One bad record must not hide the rest.
    }
  }
  return out.sort((a, b) => (idNumber(a.id) ?? 0) - (idNumber(b.id) ?? 0));
}

/** The highest id number on disk, so a new process does not reuse one. 0 when none. */
export function highestId(dir: string): number {
  return metas(dir).reduce((n, m) => Math.max(n, idNumber(m.id) ?? 0), 0);
}

/** Write the record. Atomic, so a kill mid-write leaves the previous one. */
export function writeMeta(dir: string, meta: CommandMeta): void {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${meta.id}.json`);
  const temp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temp, JSON.stringify(meta), 'utf8');
  renameSync(temp, file);
}

/** Where one command's output is kept. */
export function logFile(dir: string, id: string): string {
  return path.join(dir, `${id}.log`);
}

/** Append output as it arrives. */
export function appendLog(dir: string, id: string, chunk: string): void {
  appendFileSync(logFile(dir, id), chunk, 'utf8');
}

/** The last `keep` bytes of a log, cut at a character boundary, and the file's size. */
export function tailOf(file: string, keep: number): { text: string; size: number } {
  let fd: number;
  try {
    fd = openSync(file, 'r');
  } catch {
    return { text: '', size: 0 };
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, keep);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    // A cut inside a multi-byte character leaves continuation bytes at the front.
    let start = 0;
    while (start < buf.length && length < size && ((buf[start] ?? 0) & 0xc0) === 0x80) start += 1;
    return { text: buf.subarray(start).toString('utf8'), size };
  } finally {
    closeSync(fd);
  }
}

/**
 * Every past command, oldest first, each with the end of its log.
 *
 * Called once a process starts, before it has started anything, so any record
 * still marked running belongs to a host that is gone: it is `lost` here, and
 * `keepCommandLogs` takes back the ones whose process is still alive.
 */
export function pastCommands(dir: string, keep: number): PastCommand[] {
  return metas(dir).map((meta) => {
    const { text, size } = tailOf(path.join(dir, `${meta.id}.log`), keep);
    const truncated = size > Buffer.byteLength(text, 'utf8');
    return {
      ...meta,
      output: text,
      truncated,
      bytes: size - Buffer.byteLength(text, 'utf8') + text.length,
      lost: meta.endedAt === null,
    };
  });
}

/** Drop all but the newest `kept` commands. Returns how many were removed. */
export function prune(dir: string, kept: number = COMMAND_LOGS_KEPT): number {
  const all = metas(dir);
  const drop = all.slice(0, Math.max(all.length - kept, 0));
  for (const meta of drop) {
    rmSync(path.join(dir, `${meta.id}.json`), { force: true });
    rmSync(path.join(dir, `${meta.id}.log`), { force: true });
  }
  return drop.length;
}
