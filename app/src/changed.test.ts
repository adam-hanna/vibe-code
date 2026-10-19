import { expect, test } from 'vitest';
import { isOwn, reread, showsConfig } from './changed';

/**
 * The three decisions a `changed` frame rests on (#354), as pure functions.
 */

test('an id is this window\'s own only between 1 and the highest it handed out', () => {
  expect(isOwn(1, 5)).toBe(true);
  expect(isOwn(5, 5)).toBe(true);
  expect(isOwn(0, 5)).toBe(false);
  expect(isOwn(6, 5)).toBe(false);
  // A phone connection counts from a multiple of 2^40 (#343).
  expect(isOwn(2 ** 40 + 3, 5)).toBe(false);
  expect(isOwn(1, 0)).toBe(false);
});

test('a re-read replaces, removes, or keeps a key with a write of its own still to land', () => {
  const entries = [{ key: 'vibe.repo', value: '/phone' }];
  expect(reread('vibe.repo', entries, false)).toEqual({ kind: 'set', value: '/phone' });
  expect(reread('vibe.pinned', entries, false)).toEqual({ kind: 'remove' });
  expect(reread('vibe.repo', entries, true)).toEqual({ kind: 'keep' });
  expect(reread('vibe.pinned', entries, true)).toEqual({ kind: 'keep' });
});

test('a settings screen refreshes only for the scope it shows, comparing directories through dirKey', () => {
  expect(showsConfig('global', 'global', '/repo')).toBe(true);
  expect(showsConfig('/repo', 'global', '/repo')).toBe(false);
  expect(showsConfig('C:\\Repo\\', 'project', 'c:/repo')).toBe(true);
  expect(showsConfig('/other', 'project', '/repo')).toBe(false);
  // Inherited global values are not redrawn live (#354).
  expect(showsConfig('global', 'project', '/repo')).toBe(false);
});
