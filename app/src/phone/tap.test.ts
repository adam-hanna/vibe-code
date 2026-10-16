import { describe, expect, test } from 'vitest';
import { tap } from './tap';
import phoneApp from './PhoneApp.tsx?raw';
import hostSource from '../host.ts?raw';

/**
 * A phone released its connection only once the cockpit mounted, and the
 * cockpit mounts only after the memory is read - an ask answered by an event
 * the release lets through. On a real phone that was a minute of nothing after
 * pressing Open, then a cockpit with no projects and none of the desktop's runs.
 */
describe("a phone's early events", () => {
  test('what arrives before the cockpit listens is handed to it first, in order, once', () => {
    const t = tap<'a' | 'b'>();
    t.push('a', 1);
    t.push('b', 2);
    const seen: [string, unknown][] = [];
    t.attach((k, p) => seen.push([k, p]));
    t.push('a', 3);
    expect(seen).toEqual([
      ['a', 1],
      ['b', 2],
      ['a', 3],
    ]);
  });

  test('nothing is held again once a sink has been attached, and a detach stops delivery', () => {
    const t = tap<'a'>();
    const first: unknown[] = [];
    const stop = t.attach((_, p) => first.push(p));
    stop();
    t.push('a', 1);
    const second: unknown[] = [];
    t.attach((_, p) => second.push(p));
    t.push('a', 2);
    expect(first).toEqual([]);
    expect(second).toEqual([2]);
  });

  test('a stale detach does not take the sink that replaced it', () => {
    const t = tap<'a'>();
    const old = t.attach(() => undefined);
    const seen: unknown[] = [];
    t.attach((_, p) => seen.push(p));
    old();
    t.push('a', 1);
    expect(seen).toEqual([1]);
  });

  test('the phone catches, then releases, then reads the memory, then draws the cockpit', () => {
    expect(phoneApp).toMatch(
      /await host\.catchEarly\(\);\s*await link\.current\.listening\(\);[\s\S]*await prepareCockpit\(\);\s*setScreen\('cockpit'\);/,
    );
  });

  test('connect takes the caught events through the tap rather than a second listener', () => {
    expect(hostSource).toMatch(/caught !== null\s*\?\s*\[Promise\.resolve\(caught\.attach\(take\)\)\]/);
  });
});
