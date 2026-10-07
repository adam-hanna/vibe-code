import { afterEach, describe, expect, test, vi } from 'vitest';

/**
 * The window's memory as host files (#223). WebKit refuses an origin's whole
 * `localStorage` once its sqlite file passes 5 MiB, and deleting the migrated
 * chat keys left that file at 5,267,456 bytes holding 29 KB - the app came up
 * looking factory-reset with every key still on disk. These drive the real
 * module against a fake host and a fake `localStorage`.
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
  readFails: number;
  refuse: Set<string>;
}

async function load(storage: FakeStorage, fake: FakeHost, inShell = true) {
  vi.resetModules();
  vi.stubGlobal('localStorage', storage);
  vi.doMock('./host', () => ({
    inShell: () => inShell,
    memory: () => {
      if (fake.readFails > 0) {
        fake.readFails -= 1;
        return Promise.reject(new Error('host is not running'));
      }
      return Promise.resolve([...fake.stored].map(([key, value]) => ({ key, value })));
    },
    saveMemory: (key: string, value: string | null) => {
      if (fake.refuse.has(key)) return Promise.reject(new Error('disk full'));
      fake.saves.push([key, value]);
      if (value === null) fake.stored.delete(key);
      else fake.stored.set(key, value);
      return Promise.resolve();
    },
  }));
  return import('./memory');
}

function host(entries: Record<string, string> = {}): FakeHost {
  return { stored: new Map(Object.entries(entries)), saves: [], readFails: 0, refuse: new Set() };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('./host');
});

describe('loading', () => {
  test('what the host holds is what the window reads', async () => {
    const m = await load(new FakeStorage(), host({ 'vibe.projects': '["/r"]' }));
    await m.loadMemory();
    expect(m.memory.getItem('vibe.projects')).toBe('["/r"]');
    expect(m.memory.getItem('vibe.pinned')).toBeNull();
  });

  test('localStorage moves to the host, and leaves only once the host has it', async () => {
    const ls = new FakeStorage();
    ls.setItem('vibe.projects', '["/r"]');
    ls.setItem('vibe.typescale', '1.2');
    ls.setItem('vibe.chat./r::none', 'a conversation');
    ls.setItem('someone.else', 'x');
    const fake = host();
    const m = await load(ls, fake);
    await m.loadMemory();
    expect(Object.fromEntries(fake.stored)).toEqual({ 'vibe.projects': '["/r"]', 'vibe.typescale': '1.2' });
    expect([...ls.map.keys()].sort()).toEqual(['someone.else', 'vibe.chat./r::none']);
    expect(m.memory.getItem('vibe.typescale')).toBe('1.2');
  });

  test('an entry the host already has wins, and the stale copy still leaves', async () => {
    const ls = new FakeStorage();
    ls.setItem('vibe.repo', '/old');
    const fake = host({ 'vibe.repo': '/new' });
    const m = await load(ls, fake);
    await m.loadMemory();
    expect(m.memory.getItem('vibe.repo')).toBe('/new');
    expect(fake.saves).toEqual([]);
    expect(ls.getItem('vibe.repo')).toBeNull();
  });

  test('an entry that will not move stays in localStorage, is still read, and is said', async () => {
    const ls = new FakeStorage();
    ls.setItem('vibe.pinned', '[1]');
    ls.setItem('vibe.projects', '[2]');
    const fake = host();
    fake.refuse.add('vibe.pinned');
    const m = await load(ls, fake);
    await m.loadMemory();
    expect(ls.getItem('vibe.pinned')).toBe('[1]');
    expect(ls.getItem('vibe.projects')).toBeNull();
    expect(m.memory.getItem('vibe.pinned')).toBe('[1]');
    expect(m.memoryFailure()).toMatch(/1 setting\(s\) could not be moved to the app's files/);
  });

  test('a host still starting is retried, and one that never answers falls back to localStorage', async () => {
    vi.useFakeTimers();
    const retried = host({ 'vibe.repo': '/r' });
    retried.readFails = 2;
    const a = await load(new FakeStorage(), retried);
    const loadingA = a.loadMemory();
    await vi.runAllTimersAsync();
    await loadingA;
    expect(a.memory.getItem('vibe.repo')).toBe('/r');
    expect(a.memoryFailure()).toBeNull();

    const ls = new FakeStorage();
    ls.setItem('vibe.repo', '/kept');
    const dead = host({ 'vibe.repo': '/never-read' });
    dead.readFails = 99;
    const b = await load(ls, dead);
    const loadingB = b.loadMemory();
    await vi.runAllTimersAsync();
    await loadingB;
    // The old behaviour exactly: localStorage is the store, and the host is
    // never written, because it was never read.
    expect(b.memory.getItem('vibe.repo')).toBe('/kept');
    expect(b.memoryFailure()).toMatch(/could not be read from the app's files.*host is not running/);
    b.memory.setItem('vibe.repo', '/typed');
    await vi.runAllTimersAsync();
    expect(ls.getItem('vibe.repo')).toBe('/typed');
    expect(dead.saves).toEqual([]);
  });

  test('a browser preview has no host, and localStorage is simply the store', async () => {
    const ls = new FakeStorage();
    ls.setItem('vibe.repo', '/r');
    const fake = host();
    const m = await load(ls, fake, false);
    await m.loadMemory();
    expect(m.memory.getItem('vibe.repo')).toBe('/r');
    m.memory.setItem('vibe.where', 'x');
    expect(ls.getItem('vibe.where')).toBe('x');
    expect(fake.saves).toEqual([]);
  });
});

describe('writing', () => {
  test('a burst of changes to one key is one write of the last value, and the read is immediate', async () => {
    vi.useFakeTimers();
    const fake = host();
    const m = await load(new FakeStorage(), fake);
    await m.loadMemory();
    m.memory.setItem('vibe.where', 'a');
    m.memory.setItem('vibe.where', 'b');
    m.memory.setItem('vibe.where', 'c');
    expect(m.memory.getItem('vibe.where')).toBe('c');
    expect(fake.saves).toEqual([]);
    await vi.runAllTimersAsync();
    expect(fake.saves).toEqual([['vibe.where', 'c']]);
  });

  test('a removal is sent as null, and a flush sends what is still waiting', async () => {
    vi.useFakeTimers();
    const fake = host({ 'vibe.pinned': '[]' });
    const m = await load(new FakeStorage(), fake);
    await m.loadMemory();
    m.memory.removeItem('vibe.pinned');
    expect(m.memory.getItem('vibe.pinned')).toBeNull();
    m.flushMemory();
    await Promise.resolve();
    expect(fake.saves).toEqual([['vibe.pinned', null]]);
  });
});

describe('the boundary', () => {
  test('a conversation key is not the window memory\'s, so the two stores never share one', async () => {
    const m = await load(new FakeStorage(), host());
    expect(m.isMemoryKey('vibe.projects')).toBe(true);
    expect(m.isMemoryKey('vibe.chat./r::none')).toBe(false);
    expect(m.isMemoryKey('other')).toBe(false);
  });
});

describe('nothing else reaches for localStorage', () => {
  // Globbed rather than named, for `audit:contrast`'s reason: a named list is
  // one somebody has to remember to extend, and a new setting written straight
  // to localStorage is the factory-reset window arriving by a new road.
  const sources = import.meta.glob(['./**/*.ts', './**/*.tsx', '!./**/*.test.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;

  test('only the two stores and the ledger\'s test fallback touch it', () => {
    const allowed = new Set(['./memory.ts', './pilot/chatstore.ts', './pilot/ledger.ts']);
    const offenders = Object.entries(sources)
      .filter(([file]) => !allowed.has(file))
      .filter(([, text]) => /\blocalStorage\s*\.\s*(getItem|setItem|removeItem|key|clear)\b|\blocalStorage\s*\[/.test(text))
      .map(([file]) => file);
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    expect(offenders).toEqual([]);
  });
});
