import { describe, expect, test } from 'vitest';
import pilotPane from './PilotPane.tsx?raw';
import { chatKey, readChat, worthSaving, writable } from './saved';
import { emptyConversation } from './transcript';
import type { Conversation } from './transcript';

/**
 * A conversation, kept between launches (#223).
 *
 * Opening a past run used to show an empty pane beside six full ones: the
 * plans, the reports and the transcript all come back because they are files
 * the run wrote, and the conversation *about* the run is the one thing nothing
 * writes down.
 */

const reply = (turn: number, text: string): Conversation['replies'][number] =>
  ({
    turn,
    provider: 'subscription',
    model: 'claude-opus-5',
    text,
    calls: [],
    usage: null,
    outcome: { kind: 'done' },
    startedAt: null,
  }) as unknown as Conversation['replies'][number];

const had = (text: string): Conversation => ({
  messages: [{ role: 'user', content: text }] as Conversation['messages'],
  replies: [reply(1, 'an answer')],
  live: null,
  unknown: 0,
});

describe('a conversation belongs to a run, inside a project', () => {
  test('the key carries both, because a run id is unique only in one archive', () => {
    expect(chatKey('/p/one', 'r1')).not.toBe(chatKey('/p/two', 'r1'));
    expect(chatKey('/p/one', 'r1')).not.toBe(chatKey('/p/one', 'r2'));
  });

  test('one repository typed two ways is one key', () => {
    // The same normalising the project list uses, for the same reason: a chat
    // that vanished because a path was typed with a trailing slash would look
    // exactly like a chat that was lost.
    expect(chatKey('C:\\Users\\me\\repo', 'r1')).toBe(chatKey('c:/users/me/repo/', 'r1'));
  });

  test('the un-launched conversation has a key of its own', () => {
    // The one that will propose a run. It has to be storable before the run it
    // is about exists, or the exchange that decided what to build is the thing
    // that gets dropped.
    expect(chatKey('/p', null)).not.toBe(chatKey('/p', 'r1'));
    expect(chatKey('/p', null)).toContain('none');
  });
});

describe('what comes back, and what deliberately does not', () => {
  test('a round trip keeps the messages and the replies', () => {
    const restored = readChat(writable(had('build a todo app')));
    expect(restored.messages).toHaveLength(1);
    expect(restored.replies).toHaveLength(1);
    expect(restored.replies[0]?.text).toBe('an answer');
  });

  test('a turn that was streaming is never restored', () => {
    // It has no vendor behind it any more. Restoring it would draw a pulsing
    // card for a request nobody is waiting on — which is the stall the thinking
    // indicator exists to avoid claiming.
    const live: Conversation = { ...had('x'), live: reply(2, 'half a sen') };
    expect(writable(live)).not.toContain('half a sen');
    expect(readChat(writable(live)).live).toBeNull();
  });

  test('an unrecognised-event count is not carried across sessions', () => {
    // It is a warning about THIS window being older than the app. A stored one
    // describes a session that has ended.
    const stored = JSON.stringify({ messages: [], replies: [reply(1, 'a')], unknown: 9 });
    expect(readChat(stored).unknown).toBe(0);
  });
});

describe('every failure is an empty conversation', () => {
  test('nothing stored, and values somebody else wrote', () => {
    // `localStorage` is one namespace for the whole origin, and a pane that
    // threw on a key that is not ours would take the window with it. The cost
    // of being wrong here is a chat that starts fresh.
    for (const raw of [null, 'not json', '7', '"a string"', '[]', '{}']) {
      expect(readChat(raw)).toEqual(emptyConversation());
    }
  });

  test('a stored shape with neither half is empty rather than half-restored', () => {
    expect(readChat('{"messages":"no","replies":3}')).toEqual(emptyConversation());
  });
});

describe('an empty conversation is not written', () => {
  test('worthSaving is what stops a blank chat overwriting a real one', () => {
    expect(worthSaving(emptyConversation())).toBe(false);
    expect(worthSaving(had('x'))).toBe(true);
    // A turn in flight and nothing settled yet is still nothing to keep: the
    // writer drops `live`, so saving here would store an empty object.
    expect(worthSaving({ ...emptyConversation(), live: reply(1, 'mid') })).toBe(false);
  });
});

describe('a run adopts the conversation that proposed it', () => {
  test('the pane moves the un-launched chat rather than restoring over it', () => {
    // Source-read, because the claim is about an effect's control flow. A run
    // starting changes the key from the project's bucket to the run's; reading
    // the run's (empty) conversation at that moment would throw away the
    // exchange that decided what to build, at the exact moment it succeeded.
    expect(pilotPane).toMatch(/before === chatKey\(dir, null\)/);
    expect(pilotPane).toMatch(/localStorage\.removeItem\(before\)/);
  });

  test('the loader keys on the run, never on the conversation', () => {
    // A conversation in those deps would re-run the loader on every reply, and
    // a loader that runs mid-conversation replaces it with itself-from-disk.
    const from = pilotPane.indexOf('const key = chatKey(dir, runId);');
    const deps = pilotPane.slice(from, pilotPane.indexOf('}, [', from) + 20);
    expect(deps).toMatch(/\}, \[dir, runId\]\)/);
  });
});
