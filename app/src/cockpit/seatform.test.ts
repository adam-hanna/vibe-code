import { describe, expect, test } from 'vitest';
import { blankRow, quorumPatch, readSeats, ready, seatsPatch, toRow, toSeat, UNCONFIRMED_P0_CHOICES } from './seatform';
import type { SeatRow } from './seatform';

/**
 * The review seats' decisions (#388): what is sent, in the shape a hand-written
 * `vibe.config.json` would hold, and nothing the core would refuse invented by
 * the form itself.
 */

const typed = (row: SeatRow, change: Partial<SeatRow>): SeatRow => ({ ...row, ...change });

describe('which rows are sent', () => {
  test('a new row waits for an agent; a saved row always goes', () => {
    expect(ready(blankRow())).toBe(false);
    expect(ready(typed(blankRow(), { provider: 'codex' }))).toBe(true);
    expect(ready(typed(toRow({ provider: 'claude' }), { provider: '' }))).toBe(true);
  });

  test('the whole list goes out, in order, and an empty one is [] rather than nothing', () => {
    const rows = [toRow({ provider: 'codex' }), blankRow(), typed(blankRow(), { provider: 'claude' })];
    expect(seatsPatch('verifiers', rows)).toEqual({
      review: { verifiers: [{ provider: 'codex' }, { provider: 'claude' }] },
    });
    expect(seatsPatch('finders', [])).toEqual({ review: { finders: [] } });
  });
});

describe('a row as the file holds it', () => {
  test('blank fields are omitted, not sent empty', () => {
    expect(toSeat(typed(blankRow(), { provider: 'codex' }), 'finders')).toEqual({ provider: 'codex' });
  });

  test('every field the form edits, with minutes in milliseconds', () => {
    const row = typed(blankRow(), {
      provider: 'claude',
      model: ' opus ',
      effort: 'high',
      minutes: '30',
      focus: ' concurrency ',
    });
    expect(toSeat(row, 'finders')).toEqual({
      provider: 'claude',
      model: 'opus',
      effort: 'high',
      timeoutMs: 30 * 60_000,
      focus: 'concurrency',
    });
  });

  test('a verifier never carries a focus, and a blank focus is absent - the shared prompt', () => {
    const row = typed(blankRow(), { provider: 'codex', focus: 'security' });
    expect(toSeat(row, 'verifiers')).toEqual({ provider: 'codex' });
    expect(toSeat(typed(row, { focus: '   ' }), 'finders')).toEqual({ provider: 'codex' });
  });

  test('what the form does not edit is kept, and an untouched timeout is not rounded', () => {
    const row = toRow({ provider: 'codex', timeoutMs: 90_500, mcpServers: ['github'] });
    expect(row.minutes).toBe('2');
    expect(toSeat(row, 'verifiers')).toEqual({ provider: 'codex', timeoutMs: 90_500, mcpServers: ['github'] });
    expect(toSeat(typed(row, { minutes: '3' }), 'verifiers')).toEqual({
      provider: 'codex',
      timeoutMs: 180_000,
      mcpServers: ['github'],
    });
  });

  test('junk in the minutes is sent as typed, for the core to refuse in its own words', () => {
    expect(toSeat(typed(blankRow(), { provider: 'codex', minutes: 'soon' }), 'finders')).toEqual({
      provider: 'codex',
      timeoutMs: 'soon',
    });
  });
});

describe('reading what is in force', () => {
  test('a bare provider name is a seat, and anything that is not an entry is skipped', () => {
    expect(readSeats(['codex', { provider: 'claude', focus: 'tests' }, 3, null])).toEqual([
      { provider: 'codex' },
      { provider: 'claude', focus: 'tests' },
    ]);
    expect(readSeats(undefined)).toEqual([]);
  });
});

describe('the quorum and the P0 choices', () => {
  test('blank is a majority, a number is a number, and junk goes as typed', () => {
    expect(quorumPatch('  ')).toEqual({ review: { quorum: null } });
    expect(quorumPatch('2')).toEqual({ review: { quorum: 2 } });
    expect(quorumPatch('two')).toEqual({ review: { quorum: 'two' } });
  });

  test('the three values the core accepts, each with a meaning', () => {
    expect(UNCONFIRMED_P0_CHOICES.map((c) => c.value)).toEqual(['block', 'halt', 'demote']);
    for (const c of UNCONFIRMED_P0_CHOICES) expect(c.meaning).not.toBe('');
  });
});
