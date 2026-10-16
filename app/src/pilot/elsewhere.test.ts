import { describe, expect, test } from 'vitest';
import { asReply, foldElsewhere, holdsComposer, letGo, LINGER_MS, startElsewhere } from './elsewhere';

/**
 * A pilot turn another client started, drawn where its conversation is open
 * (#371). Reported as *"The phone shows thinking but nothing is showing on the
 * desktop"*: the reply streamed to every client and only the asker could tell
 * which conversation it was for.
 */
const CHAT = 'vibe.chat./repo::run-1';
const ANNOUNCED = { id: 900_001, chat: CHAT, asked: 'pr?', startedAt: 1_000 };
const notMine = (): boolean => false;

describe("another client's pilot turn", () => {
  test('is drawn only in the conversation it continues, and never by the client that asked', () => {
    expect(startElsewhere(ANNOUNCED, CHAT, notMine)).toMatchObject({ id: 900_001, asked: 'pr?', text: '', endedAt: null });
    expect(startElsewhere(ANNOUNCED, 'vibe.chat./repo::run-2', notMine)).toBeNull();
    expect(startElsewhere(ANNOUNCED, null, notMine)).toBeNull();
    expect(startElsewhere(ANNOUNCED, CHAT, () => true)).toBeNull();
  });

  test('a client joining mid-turn starts from the text so far', () => {
    expect(startElsewhere({ ...ANNOUNCED, text: 'so far' }, CHAT, notMine)?.text).toBe('so far');
  });

  test('folds its own deltas and ending, and nothing of any other turn', () => {
    let t = startElsewhere(ANNOUNCED, CHAT, notMine)!;
    t = foldElsewhere(t, { type: 'pilot_delta', id: 900_001, text: 'No, ' }, 2_000);
    t = foldElsewhere(t, { type: 'pilot_delta', id: 7, text: 'someone else' }, 2_000);
    t = foldElsewhere(t, { type: 'pilot_delta', id: 900_001, text: 'not yet.' }, 2_000);
    expect(t.text).toBe('No, not yet.');
    expect(holdsComposer(t)).toBe(true);
    t = foldElsewhere(t, { type: 'pilot_reply', id: 900_001, text: 'No, PR #371 is open.' }, 3_000);
    expect(t).toMatchObject({ text: 'No, PR #371 is open.', endedAt: 3_000, ending: 'answered' });
    expect(holdsComposer(t)).toBe(false);
    // Nothing after its ending moves it.
    expect(foldElsewhere(t, { type: 'pilot_delta', id: 900_001, text: '!' }, 4_000)).toBe(t);
  });

  test('a stop and a failure end it as themselves', () => {
    const t = startElsewhere(ANNOUNCED, CHAT, notMine)!;
    expect(foldElsewhere(t, { type: 'pilot_stopped', id: 900_001 }, 5).ending).toBe('stopped');
    expect(foldElsewhere(t, { type: 'error', id: 900_001 }, 5).ending).toBe('failed');
    expect(asReply(foldElsewhere(t, { type: 'error', id: 900_001 }, 5), 'subscription').outcome?.kind).toBe('failed');
  });

  test("stays until the asker's save lands, or until it has waited long enough", () => {
    const running = startElsewhere(ANNOUNCED, CHAT, notMine)!;
    expect(letGo(running, true, 1e12)).toBe(false);
    const ended = foldElsewhere(running, { type: 'pilot_reply', id: 900_001, text: 'done' }, 10_000);
    expect(letGo(ended, false, 10_000 + LINGER_MS - 1)).toBe(false);
    expect(letGo(ended, true, 10_001)).toBe(true);
    expect(letGo(ended, false, 10_000 + LINGER_MS)).toBe(true);
  });

  test('is drawn as the card the asker draws: what was sent, and a live reply', () => {
    const reply = asReply(startElsewhere({ ...ANNOUNCED, text: 'hi' }, CHAT, notMine)!, 'subscription');
    expect(reply).toMatchObject({ turn: 900_001, asked: 'pr?', text: 'hi', outcome: null, startedAt: 1_000, calls: [] });
    expect(asReply(startElsewhere({ ...ANNOUNCED, asked: '' }, CHAT, notMine)!, 'subscription').asked).toBeNull();
  });
});
