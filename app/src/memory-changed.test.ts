import { afterEach, expect, test, vi } from 'vitest';

/**
 * Another client's write reaches this window's memory cache (#354).
 *
 * A phone will save to the same host as this window, and the host says
 * `changed` after each write. The cache re-reads and replaces that key - unless
 * this window has a write of its own for it still to land, debounced or already
 * sent, in which case the local value stays, because that write is about to win
 * and announce itself. These drive the real module against a fake host.
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
  /** A save of this key waits for the promise before it lands. */
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

async function load(storage: FakeStorage, fake: FakeHost) {
  vi.resetModules();
  vi.stubGlobal('localStorage', storage);
  vi.doMock('./host', () => ({
    inShell: () => true,
    memory: () =>
      fake.readFails
        ? Promise.reject(new Error('host is not running'))
        : Promise.resolve([...fake.stored].map(([key, value]) => ({ key, value }))),
    saveMemory: async (key: string, value: string | null) => {
      fake.saves.push([key, value]);
      await fake.hold.get(key);
      if (value === null) fake.stored.delete(key);
      else fake.stored.set(key, value);
    },
  }));
  return import('./memory');
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('./host');
});

test("another client's write replaces the cached key, and a deletion removes it", async () => {
  const fake = fakeHost({ 'vibe.projects': '["/a"]', 'vibe.repo': '/a' });
  const m = await load(new FakeStorage(), fake);
  await m.loadMemory();

  fake.stored.set('vibe.projects', '["/a","/phone"]');
  await m.memoryChanged('vibe.projects');
  expect(m.memory.getItem('vibe.projects')).toBe('["/a","/phone"]');

  fake.stored.delete('vibe.repo');
  await m.memoryChanged('vibe.repo');
  expect(m.memory.getItem('vibe.repo')).toBeNull();
  // A re-read writes nothing back.
  expect(fake.saves).toEqual([]);
});

test('a key with a debounced write keeps its local value', async () => {
  vi.useFakeTimers();
  const fake = fakeHost({ 'vibe.repo': '/a' });
  const m = await load(new FakeStorage(), fake);
  await m.loadMemory();

  m.memory.setItem('vibe.repo', '/mine');
  fake.stored.set('vibe.repo', '/phone');
  await m.memoryChanged('vibe.repo');
  expect(m.memory.getItem('vibe.repo')).toBe('/mine');

  // And that write then lands, so cache and disk agree: the last write won.
  await vi.runAllTimersAsync();
  expect(fake.stored.get('vibe.repo')).toBe('/mine');
});

test('a key whose write is sent and not yet confirmed keeps its local value', async () => {
  vi.useFakeTimers();
  const fake = fakeHost({ 'vibe.repo': '/a' });
  const m = await load(new FakeStorage(), fake);
  await m.loadMemory();

  const held = gate();
  fake.hold.set('vibe.repo', held.promise);
  m.memory.setItem('vibe.repo', '/mine');
  await vi.runAllTimersAsync();
  expect(fake.saves).toEqual([['vibe.repo', '/mine']]);

  // The phone's write is what the host holds while ours is in flight; the
  // re-read answers in that window and must not take it.
  fake.stored.set('vibe.repo', '/phone');
  await m.memoryChanged('vibe.repo');
  expect(m.memory.getItem('vibe.repo')).toBe('/mine');

  held.open();
  await vi.runAllTimersAsync();
  expect(fake.stored.get('vibe.repo')).toBe('/mine');

  // Once confirmed, the next announcement is taken as it stands.
  fake.stored.set('vibe.repo', '/phone-again');
  await m.memoryChanged('vibe.repo');
  expect(m.memory.getItem('vibe.repo')).toBe('/phone-again');
});

test('a failed re-read keeps the cache, and a key not the window\'s own is ignored', async () => {
  const fake = fakeHost({ 'vibe.repo': '/a' });
  const m = await load(new FakeStorage(), fake);
  await m.loadMemory();
  fake.stored.set('vibe.repo', '/phone');
  fake.readFails = true;
  await m.memoryChanged('vibe.repo');
  expect(m.memory.getItem('vibe.repo')).toBe('/a');

  fake.readFails = false;
  await m.memoryChanged('vibe.chat./r::none');
  expect(m.memory.getItem('vibe.repo')).toBe('/a');
});

test('a write announced while the memory is still loading is in the cache once it has loaded', async () => {
  // The snapshot is taken, then the migration out of localStorage awaits a
  // save - and another client writes in between.
  const ls = new FakeStorage();
  ls.setItem('vibe.typescale', '1.2');
  const fake = fakeHost();
  const held = gate();
  fake.hold.set('vibe.typescale', held.promise);
  const m = await load(ls, fake);
  const loading = m.loadMemory();
  await Promise.resolve();

  fake.stored.set('vibe.projects', '["/phone"]');
  await m.memoryChanged('vibe.projects');
  held.open();
  await loading;

  expect(m.memory.getItem('vibe.projects')).toBe('["/phone"]');
  expect(m.memory.getItem('vibe.typescale')).toBe('1.2');
});

test('a migration racing a foreign write is last-write-wins, and the cache says which won', async () => {
  // This window's localStorage still holds an old value for the key the phone
  // writes. The migration's save lands after the phone's, so the host holds
  // the old value - two writes to one key, the last wins - and what matters is
  // that the cache agrees with the host rather than holding the phone's.
  const ls = new FakeStorage();
  ls.setItem('vibe.typescale', '1.2');
  ls.setItem('vibe.projects', '["/old"]');
  const fake = fakeHost();
  const held = gate();
  fake.hold.set('vibe.typescale', held.promise);
  const m = await load(ls, fake);
  const loading = m.loadMemory();
  await Promise.resolve();

  fake.stored.set('vibe.projects', '["/phone"]');
  await m.memoryChanged('vibe.projects');
  held.open();
  await loading;

  expect(fake.stored.get('vibe.projects')).toBe('["/old"]');
  expect(m.memory.getItem('vibe.projects')).toBe(fake.stored.get('vibe.projects'));
});
