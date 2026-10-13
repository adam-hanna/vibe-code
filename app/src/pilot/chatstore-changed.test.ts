import { afterEach, expect, test, vi } from 'vitest';

/**
 * Another client's save reaches this window's conversation cache (#354).
 *
 * The same rules as the window's memory: re-read and replace the key, keep a
 * local value whose save is debounced or in flight, and reconcile what was
 * announced while loading. One rule is the chat store's own: it skips a save
 * whose value it last confirmed, and after another client wrote, that skip
 * would leave the cache and the host disagreeing - so it is forgotten.
 */

class FakeStorage {
  readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

interface FakeHost {
  stored: Map<string, string>;
  saves: [string, string | null][];
  hold: Map<string, Promise<void>>;
  readFails: boolean;
}

function fakeHost(entries: Record<string, string> = {}): FakeHost {
  return { stored: new Map(Object.entries(entries)), saves: [], hold: new Map(), readFails: false };
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const K = 'vibe.chat./r::none';
const OTHER = 'vibe.chat./r::run-1';

async function load(storage: FakeStorage, fake: FakeHost) {
  vi.resetModules();
  vi.stubGlobal('localStorage', storage);
  vi.doMock('../host', () => ({
    inShell: () => true,
    chats: () =>
      fake.readFails
        ? Promise.reject(new Error('host is not running'))
        : Promise.resolve([...fake.stored].map(([key, value]) => ({ key, value }))),
    saveChat: async (key: string, value: string | null) => {
      fake.saves.push([key, value]);
      await fake.hold.get(key);
      if (value === null) fake.stored.delete(key);
      else fake.stored.set(key, value);
    },
  }));
  return import('./chatstore');
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('../host');
});

test("another client's save replaces the cached conversation, and a removal removes it", async () => {
  const fake = fakeHost({ [K]: 'A', [OTHER]: 'X' });
  const c = await load(new FakeStorage(), fake);
  await c.loadChats();

  fake.stored.set(K, 'B');
  await c.chatChanged(K);
  expect(c.getChat(K)).toBe('B');

  fake.stored.delete(OTHER);
  await c.chatChanged(OTHER);
  expect(c.getChat(OTHER)).toBeNull();
  expect(fake.saves).toEqual([]);
});

test('a conversation with a debounced save keeps its local value, and that save lands', async () => {
  vi.useFakeTimers();
  const fake = fakeHost({ [K]: 'A' });
  const c = await load(new FakeStorage(), fake);
  await c.loadChats();

  c.putChat(K, 'mine');
  fake.stored.set(K, 'B');
  await c.chatChanged(K);
  expect(c.getChat(K)).toBe('mine');
  await vi.runAllTimersAsync();
  expect(fake.stored.get(K)).toBe('mine');
});

test('a conversation whose save is sent and not yet confirmed keeps its local value', async () => {
  vi.useFakeTimers();
  const fake = fakeHost({ [K]: 'A' });
  const c = await load(new FakeStorage(), fake);
  await c.loadChats();

  const held = gate();
  fake.hold.set(K, held.promise);
  c.putChat(K, 'mine');
  await vi.runAllTimersAsync();
  expect(fake.saves).toEqual([[K, 'mine']]);

  fake.stored.set(K, 'B');
  await c.chatChanged(K);
  expect(c.getChat(K)).toBe('mine');

  held.open();
  await vi.runAllTimersAsync();
  expect(fake.stored.get(K)).toBe('mine');

  fake.stored.set(K, 'C');
  await c.chatChanged(K);
  expect(c.getChat(K)).toBe('C');
});

test('a save announced while the conversations are still loading is in the cache once they have loaded', async () => {
  const ls = new FakeStorage();
  ls.setItem(OTHER, 'migrating');
  const fake = fakeHost();
  const held = gate();
  fake.hold.set(OTHER, held.promise);
  const c = await load(ls, fake);
  const loading = c.loadChats();
  await Promise.resolve();

  fake.stored.set(K, 'phone');
  await c.chatChanged(K);
  held.open();
  await loading;

  expect(c.getChat(K)).toBe('phone');
  expect(c.getChat(OTHER)).toBe('migrating');
});

test('a migration racing a foreign save is last-write-wins, and the cache says which won', async () => {
  const ls = new FakeStorage();
  ls.setItem(OTHER, 'migrating');
  ls.setItem(K, 'old');
  const fake = fakeHost();
  const held = gate();
  fake.hold.set(OTHER, held.promise);
  const c = await load(ls, fake);
  const loading = c.loadChats();
  await Promise.resolve();

  fake.stored.set(K, 'phone');
  await c.chatChanged(K);
  held.open();
  await loading;

  expect(fake.stored.get(K)).toBe('old');
  expect(c.getChat(K)).toBe(fake.stored.get(K));
});

test('a pending save of the value last confirmed is still sent after a foreign save', async () => {
  // The store skips a save of the value it last confirmed. After another client
  // wrote B, a pending save of A is no longer a repeat - skipping it would
  // leave the cache at A and the host at B.
  vi.useFakeTimers();
  const fake = fakeHost();
  const c = await load(new FakeStorage(), fake);
  await c.loadChats();
  c.putChat(K, 'A');
  await vi.runAllTimersAsync();
  expect(fake.saves).toEqual([[K, 'A']]);

  c.putChat(K, 'A');
  fake.stored.set(K, 'B');
  await c.chatChanged(K);
  expect(c.getChat(K)).toBe('A');
  await vi.runAllTimersAsync();
  expect(fake.saves).toEqual([[K, 'A'], [K, 'A']]);
  expect(fake.stored.get(K)).toBe('A');
});

test('the same, when the re-read fails', async () => {
  vi.useFakeTimers();
  const fake = fakeHost();
  const c = await load(new FakeStorage(), fake);
  await c.loadChats();
  c.putChat(K, 'A');
  await vi.runAllTimersAsync();

  c.putChat(K, 'A');
  fake.stored.set(K, 'B');
  fake.readFails = true;
  await c.chatChanged(K);
  await vi.runAllTimersAsync();
  expect(fake.saves).toEqual([[K, 'A'], [K, 'A']]);
  expect(fake.stored.get(K)).toBe('A');
});

test('after a refresh to another value, writing the old one back is sent', async () => {
  vi.useFakeTimers();
  const fake = fakeHost();
  const c = await load(new FakeStorage(), fake);
  await c.loadChats();
  c.putChat(K, 'A');
  await vi.runAllTimersAsync();

  fake.stored.set(K, 'B');
  await c.chatChanged(K);
  expect(c.getChat(K)).toBe('B');

  c.putChat(K, 'A');
  await vi.runAllTimersAsync();
  expect(fake.saves).toEqual([[K, 'A'], [K, 'A']]);
  expect(fake.stored.get(K)).toBe('A');
});

test("a refresh that matches this window's last save still dedupes a repeat of it", async () => {
  // The marker is restored by a successful re-read, so the skip that existed
  // before #354 still works when nothing actually moved.
  vi.useFakeTimers();
  const fake = fakeHost();
  const c = await load(new FakeStorage(), fake);
  await c.loadChats();
  fake.stored.set(K, 'B');
  await c.chatChanged(K);
  c.putChat(K, 'B');
  await vi.runAllTimersAsync();
  expect(fake.saves).toEqual([]);
});
