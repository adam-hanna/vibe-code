import { useSyncExternalStore } from 'react';
import * as host from '../host';
import { reread } from '../changed';

/**
 * Where the pilot's conversations are kept (#223): files the host writes, held
 * here as a synchronous cache.
 *
 * They were `localStorage`, which WebKit caps at about 5 MB per origin. A chat
 * that reads files and runs commands grows by tool results, and at 5.24 MB
 * every save failed inside a `try` that said nothing - so for three days each
 * reply lived only in memory, and a click on another run replaced it with the
 * last copy that had saved: *"Have I lost my pilot chats?!"* `src/chatstore.ts`
 * has the files; this has the cache the pane reads synchronously, the debounced
 * writes, and **a failure that is shown** rather than swallowed.
 *
 * Loading is once per window, after the host is up. Until it finishes the pane
 * neither restores nor saves, because saving an empty conversation over one
 * that has not been read yet is the same loss arriving by a new road.
 */

const PREFIX = 'vibe.chat.';
/** A conversation is rewritten whole, so a burst of changes is one write. */
const DEBOUNCE_MS = 400;

const cache = new Map<string, string>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
const written = new Map<string, string | null>();
/** Saves sent and not yet confirmed, by key: still about to land (#354). */
const inflight = new Map<string, number>();
/** Keys another client wrote while the store was still loading (#354). */
const dirty = new Set<string>();
let state: { ready: boolean; failure: string | null } = { ready: false, failure: null };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: Partial<typeof state>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

/** Whether the store is backed by the host, or by `localStorage` in a browser preview. */
function hosted(): boolean {
  return host.inShell();
}

function localKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key !== null && key.startsWith(PREFIX)) keys.push(key);
    }
  } catch {
    // Storage switched off: nothing to migrate.
  }
  return keys;
}

/**
 * Read every conversation, once. In the app this also **moves** whatever is
 * still in `localStorage` to the host, and only removes each one after the host
 * has confirmed it - which is what frees the quota the other settings share.
 * A conversation the host already has wins: it is the one written since.
 */
export function loadChats(): Promise<void> {
  loading ??= (async () => {
    if (!hosted()) {
      for (const key of localKeys()) {
        const value = localStorage.getItem(key);
        if (value !== null) cache.set(key, value);
      }
      set({ ready: true });
      return;
    }
    try {
      for (const { key, value } of await host.chats()) cache.set(key, value);
    } catch (err: unknown) {
      // Not ready, and said: the pane shows it and keeps what is on screen.
      loading = null;
      set({ failure: `conversations could not be read: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    // One conversation that will not move must not hold the rest hostage: it
    // stays in localStorage, still readable from there, and the pane says so.
    const stuck: string[] = [];
    for (const key of localKeys()) {
      const value = localStorage.getItem(key);
      if (value === null) continue;
      try {
        if (!cache.has(key)) {
          await host.saveChat(key, value);
          cache.set(key, value);
        }
        localStorage.removeItem(key);
      } catch {
        cache.set(key, value);
        stuck.push(key);
      }
    }
    // Another client may have written since the read above (#354): each such
    // key is read again until none are left, and the store goes ready in the
    // same turn. A migration racing one of them is two writes to one key and
    // the last wins; what this guarantees is that the cache says which.
    while (dirty.size > 0) {
      const keys = [...dirty];
      dirty.clear();
      try {
        await refresh(keys);
      } catch {
        break;
      }
    }
    set({
      ready: true,
      failure:
        stuck.length === 0
          ? null
          : `${String(stuck.length)} saved conversation(s) could not be moved to the app's files and are still in this window's storage`,
    });
  })();
  return loading;
}

/** A stored conversation, or null. Only meaningful once `ready`. */
export function getChat(key: string): string | null {
  return cache.get(key) ?? null;
}

/**
 * Store a conversation, or remove it with null. The cache moves now; the host
 * write follows, debounced per key, and a failure is shown until one succeeds.
 */
export function putChat(key: string, value: string | null): void {
  if (value === null) cache.delete(key);
  else cache.set(key, value);
  const timer = pending.get(key);
  if (timer !== undefined) clearTimeout(timer);
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key);
      if (written.get(key) === value) return;
      const write = hosted()
        ? host.saveChat(key, value)
        : Promise.resolve().then(() => {
            if (value === null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
          });
      inflight.set(key, (inflight.get(key) ?? 0) + 1);
      write
        .finally(() => {
          const left = (inflight.get(key) ?? 1) - 1;
          if (left > 0) inflight.set(key, left);
          else inflight.delete(key);
        })
        .then(() => {
          written.set(key, value);
          if (state.failure !== null) set({ failure: null });
        })
        .catch((err: unknown) =>
          set({ failure: `this conversation is not being saved: ${err instanceof Error ? err.message : String(err)}` }),
        );
    }, DEBOUNCE_MS),
  );
}

/**
 * Read the host again and replace the named conversations in the cache (#354),
 * except one with a save of this window's own still to land - decided when the
 * read answers. `written` follows what the host was seen to hold, so a later
 * save of the value this window last wrote is not skipped as already there.
 */
async function refresh(keys: readonly string[]): Promise<void> {
  const entries = await host.chats();
  for (const key of keys) {
    const next = reread(key, entries, pending.has(key) || inflight.has(key));
    if (next.kind === 'set') {
      cache.set(key, next.value);
      written.set(key, next.value);
    } else if (next.kind === 'remove') {
      cache.delete(key);
      written.set(key, null);
    }
  }
}

/**
 * Another client saved this conversation (#354).
 *
 * The first thing it does is forget what this window last saved for the key,
 * because that is no longer known to be what the host holds: a save of the same
 * value, pending now or made later, must reach the host rather than be skipped
 * as a repeat - whether or not the re-read below succeeds.
 */
export async function chatChanged(key: string): Promise<void> {
  if (!hosted() || !key.startsWith(PREFIX)) return;
  written.delete(key);
  if (!state.ready) {
    dirty.add(key);
    return;
  }
  try {
    await refresh([key]);
  } catch {
    // The cache stays as it was; the next announcement reads again.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether conversations have loaded, and why saving is failing if it is. */
export function useChats(): { ready: boolean; failure: string | null } {
  return useSyncExternalStore(subscribe, () => state);
}
