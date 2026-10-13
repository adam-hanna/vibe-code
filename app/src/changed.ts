import { dirKey } from './cockpit/projects';

/**
 * What a cache does when another client wrote (#354), as pure functions.
 *
 * The service host says `changed` after every memory, chat and config write, to
 * every client. A window that holds a cache re-reads rather than trusting a
 * value on the frame - the frame carries none - and these are the three
 * decisions that re-read rests on, kept here so they can be tested without a
 * webview.
 */

/**
 * Whether a request id is one this window allocated.
 *
 * The window counts from 1 (`nextRequestId`), and each phone connection will
 * count from a multiple of 2^40 (#343), so "between 1 and the highest I have
 * handed out" is exactly "mine".
 */
export function isOwn(id: number, highest: number): boolean {
  return Number.isInteger(id) && id >= 1 && id <= highest;
}

export type Reread = { kind: 'keep' } | { kind: 'set'; value: string } | { kind: 'remove' };

/**
 * What a re-read means for one key.
 *
 * `held` is whether this window has a write of its own for the key that has not
 * been confirmed yet - debounced or already sent. That write is about to land
 * and be announced itself, so the local value stays; taking the other client's
 * here would leave the cache holding theirs while disk ends up holding ours.
 * Asked when the re-read ANSWERS, because a local write can start in between.
 */
export function reread(
  key: string,
  entries: readonly { key: string; value: string }[],
  held: boolean,
): Reread {
  if (held) return { kind: 'keep' };
  const found = entries.find((e) => e.key === key);
  return found === undefined ? { kind: 'remove' } : { kind: 'set', value: found.value };
}

/**
 * Whether a config `changed` is about what this settings screen shows.
 *
 * `key` is `'global'` or the project directory exactly as the writer named it,
 * so a project is compared through `dirKey`, the window's one normaliser. A
 * global change does not refresh a project screen: only the cache has to be
 * right here, and inherited values are not redrawn live (#354).
 */
export function showsConfig(key: string, scope: 'project' | 'global', dir: string): boolean {
  if (scope === 'global') return key === 'global';
  return key !== 'global' && dirKey(key) === dirKey(dir);
}
