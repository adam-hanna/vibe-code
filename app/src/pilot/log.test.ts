import { describe, expect, test } from 'vitest';
import { interleave } from './log';
import type { RoundCard } from '../cockpit/rounds';
import type { Reply } from './transcript';

/**
 * Rounds and conversation in one scroll (hi-fi 5, #223).
 *
 * The rule under test is the asymmetry: **replies keep their order and cards are
 * placed among them**, never the other way round. `Reply.startedAt` is nullable
 * by design — a reply from a build older than the field has none — so a sort over
 * a key half the list lacks would reorder somebody's conversation to make a card
 * fit.
 */

const card = (startedAt: number, phase = 'planning'): RoundCard => ({
  key: `k${String(startedAt)}`,
  cycle: 'plan',
  phase,
  phaseId: startedAt,
  round: 0,
  turns: [],
  gates: [],
  startedAt,
  endedAt: null,
  work: null,
  verify: null,
  census: null,
  commit: null,
});

const reply = (turn: number, startedAt: number | null): Reply => ({
  turn,
  provider: 'subscription',
  model: null,
  text: '',
  calls: [],
  usage: null,
  outcome: null,
  asked: null,
  woke: null,
  startedAt,
});

const shape = (entries: ReturnType<typeof interleave>): string[] =>
  entries.map((e) => (e.kind === 'round' ? `round:${e.card.key}` : `reply:${String(e.reply.turn)}`));

describe('placing rounds in a conversation', () => {
  test('a card goes above the first reply opened after it', () => {
    const out = interleave([card(50), card(150)], [reply(1, 100), reply(2, 200)]);
    expect(shape(out)).toEqual(['round:k50', 'reply:1', 'round:k150', 'reply:2']);
  });

  test('a card newer than every reply lands at the end', () => {
    // Which is where the newest thing belongs anyway, so a card with nowhere
    // obvious to go costs nothing.
    const out = interleave([card(900)], [reply(1, 100)]);
    expect(shape(out)).toEqual(['reply:1', 'round:k900']);
  });

  test('a reply with no start time decides nothing and holds nothing back', () => {
    // It cannot say whether a card belongs above or below it, so it declines -
    // and the card is placed by the next reply that can. What must not happen is
    // the reply being moved.
    const out = interleave([card(150)], [reply(1, null), reply(2, 200)]);
    expect(shape(out)).toEqual(['reply:1', 'round:k150', 'reply:2']);
  });

  test('a conversation with no times at all still comes out in order', () => {
    const out = interleave([card(10), card(20)], [reply(1, null), reply(2, null)]);
    expect(shape(out)).toEqual(['reply:1', 'reply:2', 'round:k10', 'round:k20']);
  });

  test('every reply survives, and exactly once', () => {
    // The property that matters most: this function may reorder nothing in the
    // conversation and may drop nothing from it.
    const replies = [reply(1, 100), reply(2, null), reply(3, 300)];
    const out = interleave([card(50), card(200), card(400)], replies);
    expect(out.filter((e) => e.kind === 'reply').map((e) => shape([e])[0])).toEqual([
      'reply:1',
      'reply:2',
      'reply:3',
    ]);
    expect(out.filter((e) => e.kind === 'round')).toHaveLength(3);
  });

  test('a run with no rounds is the conversation, unchanged', () => {
    const out = interleave([], [reply(1, 100)]);
    expect(shape(out)).toEqual(['reply:1']);
  });

  test('rounds with no conversation are all of it', () => {
    expect(shape(interleave([card(1), card(2)], []))).toEqual(['round:k1', 'round:k2']);
  });
});
