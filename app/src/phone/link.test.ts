import { describe, expect, test } from 'vitest';
import { lockGate, resync } from './link';
import type { Session } from './link';

/**
 * The webview's half of a reconnect (#346): the cockpit counts its request ids
 * from the newest connection's range and only then releases its held events.
 * Reads can land out of order, so the rule is monotonic.
 */

function rig() {
  const log: string[] = [];
  let current: Session = { generation: 1, idBase: 1 << 20 };
  const pending: (() => void)[] = [];
  const deps = {
    session: () =>
      new Promise<Session>((resolve) => {
        const answer = { ...current };
        pending.push(() => resolve(answer));
      }),
    startIds: (base: number) => log.push(`start ${String(base)}`),
    release: (g: number) => {
      log.push(`release ${String(g)}`);
      return Promise.resolve();
    },
  };
  return {
    log,
    set: (s: Session) => {
      current = s;
    },
    /** Answer the session reads in the order given. */
    answer: (...order: number[]) => {
      const all = pending.splice(0);
      for (const i of order) all[i]?.();
    },
    link: resync(deps),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the reconnect resync is monotonic', () => {
  test('prepare starts the range and releases nothing; listening releases', async () => {
    const r = rig();
    const prepared = r.link.prepare();
    r.answer(0);
    await prepared;
    expect(r.log).toEqual([`start ${String(1 << 20)}`]);
    const listening = r.link.listening();
    r.answer(0);
    await listening;
    expect(r.log).toEqual([`start ${String(1 << 20)}`, 'release 1']);
  });

  test('out of order, only generation 2 is started and released, and only connected(2) settles', async () => {
    const r = rig();
    r.set({ generation: 1, idBase: 1 << 20 });
    const one = r.link.connected(1);
    r.set({ generation: 2, idBase: 2 << 20 });
    const two = r.link.connected(2);
    // The newer read lands first.
    r.answer(1, 0);
    const [a, b] = await Promise.all([one, two]);
    await flush();
    expect(b).toBe(true);
    expect(a).toBe(false);
    expect(r.log.filter((l) => l.startsWith('start'))).toEqual([`start ${String(2 << 20)}`]);
    expect(r.log).not.toContain('release 1');
  });

  test('a stale connected for an older generation never settles', async () => {
    const r = rig();
    r.set({ generation: 3, idBase: 3 << 20 });
    const three = r.link.connected(3);
    r.answer(0);
    expect(await three).toBe(true);
    // A late event for generation 2, read while 3 is current.
    const two = r.link.connected(2);
    r.answer(0);
    expect(await two).toBe(false);
  });
});

describe('a reconnect under the lock', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  test('starts locked, and asks nothing until it is unlocked', async () => {
    const gate = lockGate();
    const asked: string[] = [];
    const answer = gate.when(() => {
      asked.push('session');
      return Promise.resolve(7);
    });
    await flush();
    expect(gate.locked()).toBe(true);
    expect(asked).toEqual([]);
    gate.set(false);
    await expect(answer).resolves.toBe(7);
    expect(asked).toEqual(['session']);
  });

  test('a session and a release read while locked wait: only the unlock lets the replay through', async () => {
    const gate = lockGate();
    gate.set(false);
    gate.set(true);
    const log: string[] = [];
    const link = resync({
      session: () => gate.when(() => Promise.resolve({ generation: 2, idBase: 2 << 20 })),
      startIds: (base) => log.push(`start ${String(base)}`),
      release: (g) => gate.when(() => Promise.resolve(void log.push(`release ${String(g)}`))),
    });
    const connected = link.connected(2);
    await flush();
    expect(log).toEqual([]);
    gate.set(false);
    await expect(connected).resolves.toBe(true);
    expect(log).toEqual([`start ${String(2 << 20)}`, 'release 2']);
  });

  test('a refusal because the lock came down mid-ask waits for the next unlock; any other failure is thrown', async () => {
    const gate = lockGate();
    gate.set(false);
    let calls = 0;
    const answer = gate.when(() => {
      calls += 1;
      if (calls === 1) {
        gate.set(true);
        return Promise.reject(new Error('The app is locked.'));
      }
      return Promise.resolve('ok');
    });
    await flush();
    expect(calls).toBe(1);
    gate.set(false);
    await expect(answer).resolves.toBe('ok');
    expect(calls).toBe(2);

    await expect(gate.when(() => Promise.reject(new Error('no session')))).rejects.toThrow('no session');
  });
});
