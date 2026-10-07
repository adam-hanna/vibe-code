import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The pilot's conversations, kept as files rather than in the webview (#223).
 *
 * They were `localStorage`, which WebKit caps at about five megabytes per
 * origin, and a pilot chat that reads files and runs commands grows by tool
 * results: one ERM chat alone reached 2.16 MB. At 5.24 MB every save failed, the
 * window caught the failure and said nothing - *"Have I lost my pilot chats?!"*
 * - and for three days every reply lived only in memory, until a click on
 * another run replaced it with the last copy that had saved. Files have no
 * quota, and a failed write here is an `error` frame the window shows.
 *
 * **Still not run state.** These are the window's memory, under the app's own
 * data directory, and never under a run's `.vibe/runs/<id>` - `saved.ts` states
 * why, and moving the bytes does not change the answer.
 *
 * One file per conversation, named by a hash of its key so a key never becomes
 * a path: a key holds a repository's absolute path, which is not a file name on
 * any platform. The key is stored inside the file, so a listing needs no index.
 */

/** Where the files live, or null when this process was not told. */
export function chatDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = env['VIBE_APP_DATA'];
  return base === undefined || base === '' ? null : path.join(base, 'chats');
}

/**
 * Where the rest of the window's memory lives (#223): the projects, the pins,
 * the names, the drafts, the type scale, the pilot's books and where the window
 * was pointed. Same files, same rules, a directory of its own.
 *
 * They followed the chats out of `localStorage` for a reason measured on
 * 2026-10-06, after the chats had already gone. Deleting the migrated chat keys
 * left the storage file at 5,267,456 bytes holding 29 KB of live data, because
 * sqlite never shrinks a file on its own - and WebKit refuses an origin's whole
 * storage once the **file** is past its 5 MiB quota, so every read came back
 * empty and the app looked factory-reset with all eleven keys still on disk.
 * The page cannot compact that file, so the only durable answer is for nothing
 * the product needs to live there.
 *
 * A separate directory rather than the chats', so the `chats` read stays a
 * listing of conversations and a pane restoring one never sees a pin.
 */
export function memoryDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const base = env['VIBE_APP_DATA'];
  return base === undefined || base === '' ? null : path.join(base, 'memory');
}

function fileFor(dir: string, key: string): string {
  return path.join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
}

/** Every stored entry. A file that does not parse is skipped, never fatal. */
export function listEntries(dir: string): { key: string; value: string }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { key: string; value: string }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const row = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as unknown;
      if (typeof row !== 'object' || row === null) continue;
      const { key, value } = row as Record<string, unknown>;
      if (typeof key === 'string' && typeof value === 'string') out.push({ key, value });
    } catch {
      // A half-written file from a killed process, or somebody's edit. One
      // unreadable conversation must not hide the others.
    }
  }
  return out;
}

/**
 * Store one entry, or remove it with null.
 *
 * Written to a temporary file and renamed over the old one, so a process killed
 * mid-write leaves the previous version rather than half of the new one.
 */
export function saveEntry(dir: string, key: string, value: string | null): void {
  const file = fileFor(dir, key);
  if (value === null) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(dir, { recursive: true });
  const temp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(temp, JSON.stringify({ key, value }), 'utf8');
  renameSync(temp, file);
}

/** The conversations' names for the two, which every caller already uses. */
export const listChats = listEntries;
export const saveChat = saveEntry;
