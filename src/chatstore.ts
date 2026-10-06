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

function fileFor(dir: string, key: string): string {
  return path.join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
}

/** Every stored conversation. A file that does not parse is skipped, never fatal. */
export function listChats(dir: string): { key: string; value: string }[] {
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
 * Store one conversation, or remove it with null.
 *
 * Written to a temporary file and renamed over the old one, so a process killed
 * mid-write leaves the previous version rather than half of the new one.
 */
export function saveChat(dir: string, key: string, value: string | null): void {
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
