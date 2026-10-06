import { describe, expect, test } from 'vitest';
import cockpit from './Cockpit.tsx?raw';
import { NOWHERE, readWhere, writableWhere } from './where';

/**
 * Where the window was pointed, kept between launches (#223). Every relaunch
 * used to land on the pilot with no run open.
 */

const AT = { tab: 'critique' as const, viewing: { dir: '/repo', runId: '20261006-run', task: 'build it' }, draftId: null };

describe('where the window was', () => {
  test('round-trips', () => {
    expect(readWhere(writableWhere(AT))).toEqual(AT);
  });

  test('nothing stored, or nothing readable, is a fresh window', () => {
    expect(readWhere(null)).toEqual(NOWHERE);
    expect(readWhere('{half')).toEqual(NOWHERE);
    expect(readWhere('7')).toEqual(NOWHERE);
  });

  test('each field fails on its own', () => {
    // A tab this build no longer has must not cost the run that was open.
    expect(readWhere(JSON.stringify({ ...AT, tab: 'findings' }))).toEqual({ ...AT, tab: 'pilot' });
    expect(readWhere(JSON.stringify({ ...AT, viewing: { dir: '/repo' } }))).toEqual({ ...AT, viewing: null });
    expect(readWhere(JSON.stringify({ ...AT, draftId: 3 }))).toEqual(AT);
  });

  test('the cockpit starts from it and writes it back as it moves', () => {
    expect(cockpit).toMatch(/useState<Viewing \| null>\(\(\) => storedWhere\(\)\.viewing\)/);
    expect(cockpit).toMatch(/\(\(\) => storedWhere\(\)\.tab\)/);
    expect(cockpit).toMatch(/writableWhere\(\{ tab, viewing, draftId \}\)/);
  });
});
