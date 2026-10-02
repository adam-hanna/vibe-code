import { describe, expect, test } from 'vitest';
import pane from './PilotPane.tsx?raw';
import { readChat, replyKey, writable } from './saved';
import { needsFollow } from './transcript';
import type { Conversation, Reply } from './transcript';

const reply: Reply = {
  turn: 1, provider: 'subscription', model: null, text: 'Reading the project',
  calls: [{ id: 'read-1', name: 'read_run', arguments: '{}', input: {}, unreadable: null, settlement: null }],
  usage: null, outcome: { kind: 'ended', stop: null },
  asked: 'Help me with this project', woke: null, startedAt: 1000,
};
const conversation: Conversation = {
  messages: [{ role: 'tool', id: 'read-1', name: 'read_run', content: 'The run record' }],
  replies: [reply], live: null, unknown: 0,
};

describe('reopening a conversation is read only', () => {
  test('a saved tool result does not start another vendor turn', () => {
    const back = readChat(writable(conversation));
    expect(needsFollow(back, back.messages.length)).toBe(false);
  });

  test('a new tool result still continues the attended exchange', () => {
    expect(needsFollow(conversation, 0)).toBe(true);
  });

  test('a live turn and an unanswered proposal each prevent a follow-up', () => {
    expect(needsFollow({ ...conversation, live: reply }, 0)).toBe(false);
    expect(needsFollow({ ...conversation, messages: [] }, -1)).toBe(false);
  });

  test('a new request with a reused turn id can be charged independently', () => {
    expect(replyKey(reply)).not.toBe(replyKey({ ...reply, startedAt: 2000 }));
    const completed = { ...reply, text: 'A completed reply' };
    expect(replyKey(reply)).toBe(replyKey(completed));
  });

  test('legacy replies without a timestamp have a stable identity', () => {
    expect(replyKey({ ...reply, startedAt: null })).toBe('subscription:1:legacy');
  });

  test('the loader marks historical usage and message count before restoring', () => {
    const loader = pane.slice(pane.indexOf('const back = readChat(stored)'), pane.indexOf('dispatch({ type: \'restore\', conversation: back })'));
    expect(loader).toContain('counted.current.add(replyKey(reply))');
    expect(loader).toContain('sentAt.current = back.messages.length');
    expect(pane).toContain('!counted.current.has(replyKey(reply))');
  });
});
