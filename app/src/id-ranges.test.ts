import { expect, test } from 'vitest';
import { ID_RANGE, requestIds } from './changed';
import hostTs from './host.ts?raw';

/**
 * Every client sees every answer, so each counts its request ids in a range of
 * its own (#343): the desktop window from 1, each phone connection from the
 * `idBase` its `Welcome` carried. These pin that two clients with overlapping
 * counters never take each other's answers.
 */

test('two clients counting at once never allocate, or claim, each other\'s ids', () => {
  const window = requestIds(0);
  const phone = requestIds(ID_RANGE);
  const mine = Array.from({ length: 50 }, () => window.next());
  const theirs = Array.from({ length: 50 }, () => phone.next());

  // The window still counts from 1.
  expect(mine[0]).toBe(1);
  expect(theirs[0]).toBe(ID_RANGE + 1);
  for (const id of mine) {
    expect(window.own(id)).toBe(true);
    expect(phone.own(id)).toBe(false);
  }
  for (const id of theirs) {
    expect(phone.own(id)).toBe(true);
    expect(window.own(id)).toBe(false);
  }
});

test('an answer from a third client\'s range belongs to neither, nor does one not yet allocated', () => {
  const window = requestIds(0);
  const phone = requestIds(ID_RANGE);
  window.next();
  phone.next();
  const other = requestIds(2 * ID_RANGE);
  const id = other.next();
  expect(window.own(id)).toBe(false);
  expect(phone.own(id)).toBe(false);
  // Ahead of the counter is nobody's yet, and a reconnect's range is new.
  expect(window.own(2)).toBe(false);
  expect(phone.own(ID_RANGE + 2)).toBe(false);
  expect(phone.own(ID_RANGE)).toBe(false);
});

test('a base that is not a range is refused', () => {
  for (const bad of [-ID_RANGE, 1, ID_RANGE + 1, 0.5, Number.NaN, 8192 * ID_RANGE]) {
    expect(() => requestIds(bad)).toThrow();
  }
  // The last range a JavaScript number counts exactly.
  expect(() => requestIds(8191 * ID_RANGE)).not.toThrow();
});

test('the wire carries the base and host.ts counts from it', () => {
  // The phone's transport calls this with the Welcome's idBase (#346); the
  // window never does, so it keeps counting from 1.
  expect(hostTs).toContain('export function startRequestIds(base: number): void');
  expect(hostTs).toContain('let ids: RequestIds = requestIds(0);');
});
