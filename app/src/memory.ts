import { useSyncExternalStore } from 'react';
import * as host from './host';

/**
 * What the window remembers between launches (#223): files the host writes,
 * held here as a synchronous cache that is filled **before the cockpit mounts**.
 *
 * The projects, pins, run and project names, drafts, the prompt library, the
 * type scale, the pilot's books and ceiling, the gate watcher and where the
 * window was pointed. All of them were `localStorage`, and the chats had already
 * left it for `pilot/chatstore.ts`'s reason. These followed for a sharper one,
 * measured on 2026-10-06: deleting the migrated chat keys left WebKit's storage
 * file at 5,267,456 bytes holding 29 KB of live data, since sqlite never
 * shrinks a file on its own - and WebKit refuses an origin's **whole** storage
 * once that file passes its 5 MiB quota. Every read came back empty and the app
 * came up looking factory-reset, with all eleven keys still on disk. The page
 * cannot compact that file, so nothing the product needs may live there.
 *
 * **Why a cache in front, and why it loads first.** Every reader is a
 * `useState` initialiser or an effect that wants the value now, and twelve call
 * sites rewritten around a promise would be twelve chances to render a default
 * and then save it over the real value - the chats' "saving an empty
 * conversation over one not yet read" arriving by a new road. So `main.tsx`
 * awaits `loadMemory()` and then renders, and `memory` keeps `localStorage`'s
 * three-method shape so each call site changes by one word.
 *
 * **When the host cannot be read, the window falls back to `localStorage` and
 * says so.** That is exactly the old behaviour, so a host that failed to start
 * costs this launch's persistence and never a value already stored: nothing is
 * written to the host until it has been read. The sidebar draws the failure.
 *
 * In a browser preview there is no host, and `localStorage` is simply the
 * store, as it always was.
 */

/** The window's namespace, minus the conversations, which have a store of their own. */
const PREFIX = 'vibe.';
const CHAT_PREFIX = 'vibe.chat.';
/** A setting is small and rewritten whole, so a burst of changes is one write. */
const DEBOUNCE_MS = 200;
/** The host is spawned before the window loads; these cover it still starting. */
const ATTEMPTS = 4;
const RETRY_MS = 500;

type Mode = 'loading' | 'hosted' | 'local';

const cache = new Map<string, string>();
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; value: string | null }>();
let mode: Mode = 'loading';
let failure: string | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function setFailure(next: string | null): void {
  if (next === failure) return;
  failure = next;
  for (const l of listeners) l();
}

function local(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/** Whether a key is the window's own and not a conversation. */
export function isMemoryKey(key: string): boolean {
  return key.startsWith(PREFIX) && !key.startsWith(CHAT_PREFIX);
}

function localKeys(): string[] {
  const store = local();
  const keys: string[] = [];
  if (store === null) return keys;
  try {
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key !== null && isMemoryKey(key)) keys.push(key);
    }
  } catch {
    // Storage switched off: nothing to move.
  }
  return keys;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read the window's memory, once. In the app this also **moves** whatever is
 * still in `localStorage` to the host and removes each key only after the host
 * has confirmed it. An entry the host already has wins, since it is the one
 * written since. Never rejects: a failure is a mode and a sentence.
 */
export function loadMemory(): Promise<void> {
  loading ??= (async () => {
    if (!host.inShell()) {
      mode = 'local';
      return;
    }
    let entries: Awaited<ReturnType<typeof host.memory>> | null = null;
    let last = '';
    for (let attempt = 0; attempt < ATTEMPTS && entries === null; attempt += 1) {
      try {
        entries = await host.memory();
      } catch (err: unknown) {
        last = err instanceof Error ? err.message : String(err);
        if (attempt < ATTEMPTS - 1) await wait(RETRY_MS);
      }
    }
    if (entries === null) {
      mode = 'local';
      setFailure(`this window's settings could not be read from the app's files, so changes this session stay in this window only: ${last}`);
      return;
    }
    for (const { key, value } of entries) cache.set(key, value);

    // One entry that will not move must not hold the rest hostage: it is used
    // from localStorage this launch, stays there, and the sidebar says so.
    const store = local();
    const stuck: string[] = [];
    for (const key of localKeys()) {
      const value = store?.getItem(key) ?? null;
      if (value === null) continue;
      try {
        if (!cache.has(key)) {
          await host.saveMemory(key, value);
          cache.set(key, value);
        }
        store?.removeItem(key);
      } catch {
        cache.set(key, value);
        stuck.push(key);
      }
    }
    mode = 'hosted';
    if (stuck.length > 0) {
      setFailure(`${String(stuck.length)} setting(s) could not be moved to the app's files and are still in this window's storage`);
    }
  })();
  return loading;
}

function write(key: string, value: string | null): void {
  const held = pending.get(key);
  if (held !== undefined) clearTimeout(held.timer);
  pending.set(key, {
    value,
    timer: setTimeout(() => flushOne(key), DEBOUNCE_MS),
  });
}

function flushOne(key: string): void {
  const held = pending.get(key);
  if (held === undefined) return;
  clearTimeout(held.timer);
  pending.delete(key);
  host
    .saveMemory(key, held.value)
    .then(() => {
      if (failure !== null && pending.size === 0 && mode === 'hosted') setFailure(null);
    })
    .catch((err: unknown) =>
      setFailure(`a setting is not being saved: ${err instanceof Error ? err.message : String(err)}`),
    );
}

/** Send every write still waiting out its debounce. Called as the page goes away. */
export function flushMemory(): void {
  for (const key of [...pending.keys()]) flushOne(key);
}

/**
 * `localStorage`'s three methods over the window's memory. A read before
 * `loadMemory` has finished answers from `localStorage`, which is the one store
 * that could already hold the value; nothing is written to the host before it.
 */
export const memory = {
  getItem(key: string): string | null {
    if (mode === 'hosted') return cache.get(key) ?? null;
    return local()?.getItem(key) ?? null;
  },
  setItem(key: string, value: string): void {
    if (mode === 'hosted') {
      cache.set(key, value);
      write(key, value);
      return;
    }
    // A browser preview, or a host that could not be read: the old behaviour,
    // including its throw on a full store, which every caller already catches.
    local()?.setItem(key, value);
  },
  removeItem(key: string): void {
    if (mode === 'hosted') {
      cache.delete(key);
      write(key, null);
      return;
    }
    local()?.removeItem(key);
  },
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Why the window's settings are not being kept, or null while they are. */
export function memoryFailure(): string | null {
  return failure;
}

/** The same, for a component that has to redraw when it changes. */
export function useMemoryFailure(): string | null {
  return useSyncExternalStore(subscribe, memoryFailure);
}
