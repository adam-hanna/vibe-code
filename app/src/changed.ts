import { dirKey } from './cockpit/projects';
import { phoneOf } from './remote/origin';

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
 * The size of each client's range of request ids (#343): the desktop window
 * counts from 1, and each phone connection from the `idBase` its `Welcome`
 * carried, a multiple of this. `ID_RANGE` in `app/remote/src/control.rs` is the
 * same number.
 */
export const ID_RANGE = 2 ** 40;

/**
 * Whether a request id is one this client allocated.
 *
 * A client counts up from just past its base, so "above my base and no higher
 * than the highest I have handed out" is exactly "mine". Every client sees
 * every answer, so this is what keeps a phone's answers from being taken as the
 * window's, and the other way round.
 */
export function isOwn(id: number, highest: number, base = 0): boolean {
  return Number.isInteger(id) && id > base && id <= highest;
}

/** One client's request ids: where they come from, and which are its own. */
export interface RequestIds {
  next(): number;
  own(id: number): boolean;
}

/**
 * The ids a client allocates, counting from `base + 1`. The window's base is 0;
 * a phone's is its connection's `idBase`. A base that is not a range this wire
 * hands out is refused, as is one whose range a JavaScript number cannot count
 * exactly.
 */
export function requestIds(base = 0): RequestIds {
  if (
    !Number.isSafeInteger(base) ||
    base < 0 ||
    base % ID_RANGE !== 0 ||
    base + ID_RANGE - 1 > Number.MAX_SAFE_INTEGER
  ) {
    throw new Error(`${base} is not a request-id range`);
  }
  let highest = base;
  return {
    next: () => (highest += 1),
    own: (id) => isOwn(id, highest, base),
  };
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

/**
 * Who saved the file this settings screen shows, when another client did
 * (#365): null when the `changed` is not about this screen at all, otherwise the
 * phone's name - or null inside, for a write no phone made.
 *
 * Only a phone is named, by `decidedFrom`'s rule and through `phoneOf`, the
 * app's one spelling of `phone:`. A write with no origin is another client the
 * desktop cannot name, and it still answers `{ phone: null }` rather than being
 * ignored: it clears an earlier phone's note, because the file on screen is no
 * longer the one that phone wrote.
 */
export function configWriteFor(
  c: { what: string; key: string; origin?: string },
  scope: 'project' | 'global',
  dir: string,
): { phone: string | null } | null {
  if (c.what !== 'config' || !showsConfig(c.key, scope, dir)) return null;
  return { phone: phoneOf(c.origin) };
}
