import { describe, expect, test } from 'vitest';
import { RESET_HINT_AFTER_MS, rowStatus, sentence } from './sentences';
import type { LinkInfo, Reason } from './reason';

/**
 * Every way a connection ends has a sentence (#346), from the product spec's
 * "What the phone says when it cannot connect".
 */

const NOW = Date.UTC(2026, 9, 14, 12, 0);
const ALL: Reason[] = [
  { kind: 'notPaired' },
  { kind: 'remoteOff' },
  { kind: 'versionMismatch', desktopAppVersion: '1.7.0', phoneAppVersion: '1.8.0' },
  { kind: 'unreachable' },
  { kind: 'offline' },
  { kind: 'relaysUnreachable' },
  { kind: 'pairRefused', reason: 'the code has already been used' },
  { kind: 'pairDeclined' },
  { kind: 'pairCancelled' },
  { kind: 'phoneListUnreadable', why: 'bad JSON' },
  { kind: 'pairedNotSaved', desktopName: 'Studio', why: 'disk full' },
];

describe('each close reads as its sentence', () => {
  test('every kind has a sentence', () => {
    for (const r of ALL) expect(sentence(r, 'Studio', NOW, NOW).text.length, r.kind).toBeGreaterThan(10);
  });

  test('NOT_PAIRED: removed this phone, with Pair again', () => {
    expect(sentence({ kind: 'notPaired' }, 'Studio', NOW, NOW)).toEqual({ text: 'Studio removed this phone.', action: 'pairAgain' });
  });

  test('VERSION_MISMATCH names both versions, or says which to update when it cannot', () => {
    const both = sentence(ALL[2]!, 'Studio', null, NOW).text;
    expect(both).toContain('1.7.0');
    expect(both).toContain('1.8.0');
    const unknown = sentence({ kind: 'versionMismatch', desktopAppVersion: null, phoneAppVersion: '1.8.0' }, 'Studio', null, NOW).text;
    expect(unknown).toContain('Update whichever is older');
  });

  test('REMOTE_OFF: remote access is off', () => {
    expect(sentence({ kind: 'remoteOff' }, 'Studio', NOW, NOW).text).toBe(
      'Remote access is off on Studio. Turn it on in Settings → Remote access.',
    );
  });

  test("unreachable: can't reach, with last seen, and 'or it was reset' only after a long time", () => {
    const recent = sentence({ kind: 'unreachable' }, 'Studio', NOW - 60_000, NOW).text;
    expect(recent).toMatch(/^Can't reach Studio\./);
    expect(recent).toContain('Last seen');
    expect(recent).not.toContain('reset');
    const long = sentence({ kind: 'unreachable' }, 'Studio', NOW - RESET_HINT_AFTER_MS, NOW).text;
    expect(long).toContain('or it was reset');
    expect(sentence({ kind: 'unreachable' }, 'Studio', null, NOW).text).toContain('Never connected.');
    expect(RESET_HINT_AFTER_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test('offline and the relays have their own', () => {
    expect(sentence({ kind: 'offline' }, 'Studio', NOW, NOW).text).toBe('This phone is offline.');
    expect(sentence({ kind: 'relaysUnreachable' }, 'Studio', NOW, NOW).text).toBe(
      "Can't reach the relay servers. Connections on the same network still work.",
    );
  });

  test('a cancelled pairing and an unsaved one say how to recover', () => {
    expect(sentence({ kind: 'pairCancelled' }, 'Studio', null, NOW).text).toContain('remove it there or pair again');
    expect(sentence(ALL[10]!, 'x', null, NOW).text).toMatch(/^Studio paired with this phone, but this phone could not save it \(disk full\)/);
    expect(sentence(ALL[9]!, 'x', null, NOW).text).toContain('nothing was paired');
  });
});

describe('every row has a status', () => {
  const link = (over: Partial<LinkInfo>): LinkInfo => ({ id: 'd', phase: 'up', reason: null, path: 'direct', connectMs: 40, ...over });

  test('a connected link, direct or relayed, is never an error', () => {
    for (const path of ['direct', 'relayed'] as const) {
      const s = rowStatus({ state: 'open' }, link({ path }), 'Studio', NOW, NOW);
      expect(s.error).toBe(false);
      expect(s.text).toMatch(/^Connected/);
    }
  });

  test('the open desktop shows its link; a down link its sentence', () => {
    expect(rowStatus({ state: 'open' }, link({ phase: 'connecting' }), 'Studio', NOW, NOW).text).toBe('Connecting…');
    const down = rowStatus({ state: 'open' }, link({ phase: 'down', reason: { kind: 'notPaired' } }), 'Studio', NOW, NOW);
    expect(down).toEqual({ text: 'Studio removed this phone.', error: true, action: 'pairAgain' });
  });

  test('every other row: not checked, checking, reachable, or down with its sentence', () => {
    expect(rowStatus({ state: 'unchecked' }, null, 'S', NOW, NOW).text).toBe('Not checked yet');
    expect(rowStatus({ state: 'checking' }, null, 'S', NOW, NOW).text).toBe('Checking…');
    expect(rowStatus({ state: 'reachable' }, null, 'S', NOW, NOW)).toEqual({ text: 'Reachable', error: false, action: null });
    const down = rowStatus({ state: 'down', reason: { kind: 'offline' } }, null, 'S', NOW, NOW);
    expect(down).toEqual({ text: 'This phone is offline.', error: true, action: null });
  });
});
