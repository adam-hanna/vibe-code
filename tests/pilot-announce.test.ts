import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from '@src/protocol.js';
import { createSession } from '@src/serve.js';
import type { Outbound } from '@src/protocol.js';
import type { PilotChatOptions, PilotChatResult } from '@src/pilotchat.js';

/**
 * A pilot turn is said to every client (#371).
 *
 * A message sent from the phone was answered on the desktop's host and drawn on
 * the phone alone: the desktop showed nothing until the reply was saved, and
 * then only after somebody switched chats. The deltas already reached every
 * client; what none of them could tell was which conversation a turn belonged
 * to. So a turn that names its conversation is announced, a client that joins
 * mid-turn can ask what is in flight, and one conversation takes one turn at a
 * time - two turns resuming one session would each answer blind to the other.
 */

const line = (v: unknown): string => JSON.stringify(v);
const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));
const TOKENS = { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 };

const REQUEST = {
  type: 'pilot',
  id: 1,
  prompt: 'pr?',
  system: 'you are the pilot',
  model: 'default',
  sessionId: 'abc',
  dir: '/repo',
  resume: false,
  chat: 'vibe.chat./repo::run-1',
  asked: 'pr?',
};

/** Turns that each say `hello` and then wait until they are let go. */
function held(): { sent: Outbound[]; receive: (l: string) => void; release: () => void } {
  const sent: Outbound[] = [];
  const waiting: (() => void)[] = [];
  const pilot = (options: PilotChatOptions): Promise<PilotChatResult> =>
    new Promise((resolve) => {
      options.onDelta?.('hel');
      options.onDelta?.('lo');
      waiting.push(() => resolve({ text: 'hello', sessionId: 's', tokens: TOKENS, context: null }));
    });
  const session = createSession((m) => void sent.push(m), { invoke: () => Promise.resolve(0), pilot });
  // Lets go of every turn still waiting.
  const release = (): void => {
    for (const go of waiting.splice(0)) go();
  };
  return { sent, receive: (l) => session.receive(l), release };
}

test('a conversation and what was sent travel together, or not at all', () => {
  assert.equal(decode(line(REQUEST)).ok, true);
  const { chat: _c, asked: _a, ...bare } = REQUEST;
  assert.equal(decode(line(bare)).ok, true, 'an older window sends neither');
  const half = decode(line({ ...bare, chat: REQUEST.chat }));
  assert.equal(half.ok, false);
  const empty = decode(line({ ...REQUEST, chat: '' }));
  assert.equal(empty.ok, false);
});

test('a turn that names its conversation is announced before its first delta', async () => {
  const { sent, receive, release } = held();
  receive(line(REQUEST));
  await settle();
  const started = sent.findIndex((m) => m.type === 'pilot_started');
  const delta = sent.findIndex((m) => m.type === 'pilot_delta');
  assert.ok(started >= 0 && started < delta, 'announced, and first');
  assert.deepEqual(
    { ...sent[started], startedAt: 0 },
    { type: 'pilot_started', id: 1, chat: REQUEST.chat, asked: 'pr?', startedAt: 0 },
  );
  release();
  await settle();
});

test('a turn with no conversation named is not announced', async () => {
  const { sent, receive, release } = held();
  const { chat: _c, asked: _a, ...bare } = REQUEST;
  receive(line(bare));
  await settle();
  assert.equal(sent.some((m) => m.type === 'pilot_started'), false);
  release();
  await settle();
});

test('a client that joins mid-turn is told what is in flight, with the text so far', async () => {
  const { sent, receive, release } = held();
  receive(line(REQUEST));
  await settle();
  receive(line({ type: 'pilot_turns', id: 2 }));
  const answer = sent.find((m) => m.type === 'pilot_turns');
  assert.ok(answer !== undefined && answer.type === 'pilot_turns');
  assert.equal(answer.turns.length, 1);
  assert.equal(answer.turns[0]?.chat, REQUEST.chat);
  assert.equal(answer.turns[0]?.text, 'hello');
  release();
  await settle();
  receive(line({ type: 'pilot_turns', id: 3 }));
  const after = sent.filter((m) => m.type === 'pilot_turns').at(-1);
  assert.ok(after !== undefined && after.type === 'pilot_turns');
  assert.deepEqual(after.turns, [], 'a settled turn is no longer in flight');
});

test('one conversation takes one turn at a time, and another conversation is not held up', async () => {
  const { sent, receive, release } = held();
  receive(line(REQUEST));
  await settle();
  receive(line({ ...REQUEST, id: 4, prompt: 'and again?', asked: 'and again?' }));
  await settle();
  const refused = sent.find((m) => m.type === 'error' && m.id === 4);
  assert.ok(refused !== undefined && refused.type === 'error');
  assert.match(refused.message, /already being written in this conversation/);

  receive(line({ ...REQUEST, id: 5, chat: 'vibe.chat./repo::run-2' }));
  await settle();
  assert.equal(sent.some((m) => m.type === 'error' && m.id === 5), false);
  release();
  await settle();
  // Once the first has settled, the conversation takes a turn again.
  receive(line({ ...REQUEST, id: 6 }));
  await settle();
  assert.equal(sent.some((m) => m.type === 'error' && m.id === 6), false);
  release();
  await settle();
});
