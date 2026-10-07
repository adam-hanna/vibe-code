import { describe, expect, test } from 'vitest';
import pane from './PilotPane.tsx?raw';
import { readChat, writable } from './saved';
import {
  adoptSession,
  ask,
  clearContext,
  compact,
  COMPACT_PROMPT,
  contextNow,
  describeContext,
  emptyConversation,
  heldSession,
  measure,
  reduce,
  withCarry,
} from './transcript';
import type { Backend } from './backend';
import type { Conversation } from './transcript';

/**
 * The pilot's context: how full it is, and compacting or clearing it (#223).
 *
 * *"Can we report context remaining for the pilot and offer some way to compact
 * it."* Neither CLI compacts on its headless road, so compaction is the loop's
 * own shape - the model writes a handoff, the next turn starts a new
 * conversation holding it. And the session moved into the conversation, which
 * is what the reading is about and what fixed two defects on the way.
 */

/** One finished turn on `backend`, as the frames for it would fold. */
function turn(
  conversation: Conversation,
  backend: Backend,
  n: number,
  opts: { text?: string; session?: string; context?: { tokens: number; window: number | null } } = {},
): Conversation {
  let c = ask(conversation, `message ${String(n)}`, n, backend, 0);
  c = reduce(c, { kind: 'text', turn: n, delta: opts.text ?? 'reply' });
  if (opts.session !== undefined) c = adoptSession(c, n, opts.session);
  if (opts.context !== undefined) c = measure(c, n, opts.context);
  return reduce(c, { kind: 'ended', turn: n, stop: null });
}

describe('a conversation keeps the session that remembers it', () => {
  test('the session is the CLI that held it, and only that CLI resumes it', () => {
    const c = turn(emptyConversation(), 'subscription', 1, { session: 's-1' });
    expect(heldSession(c, 'subscription')).toBe('s-1');
    expect(heldSession(c, 'codex')).toBeNull();
  });

  test('it survives a relaunch, which used to forget it', () => {
    const c = turn(emptyConversation(), 'codex', 1, { session: 'th-1' });
    expect(heldSession(readChat(writable(c)), 'codex')).toBe('th-1');
  });

  test('a stored session that is not one is no session', () => {
    const bad = JSON.stringify({ messages: [{ role: 'user', content: 'x' }], replies: [], session: { backend: 'nope', id: 'x' } });
    expect(readChat(bad).session).toBeNull();
    expect(readChat(JSON.stringify({ messages: [{ role: 'user', content: 'x' }], replies: [] })).session).toBeNull();
  });

  test('a turn taken on another backend retires it, because that session never saw it', () => {
    let c = turn(emptyConversation(), 'subscription', 1, { session: 's-1' });
    c = turn(c, 'anthropic', 2);
    expect(c.session).toBeNull();
  });

  test('the pane resumes from the conversation, never from a ref of its own', () => {
    expect(pane).not.toMatch(/session\.current/);
    expect(pane).toMatch(/heldSession\(held\.current, provider\)/);
  });
});

describe('the reading', () => {
  test('a CLI turn is measured by what the CLI said, against its window', () => {
    const c = turn(emptyConversation(), 'subscription', 1, { session: 's', context: { tokens: 41_000, window: 200_000 } });
    expect(contextNow(c, 'subscription')).toEqual({ kind: 'measured', context: { tokens: 41_000, window: 200_000 } });
    expect(describeContext(contextNow(c, 'subscription'), true)).toEqual({
      text: 'context 41k of 200k · 80% left',
      alarm: false,
    });
  });

  test('past 80% used it is drawn as an alarm', () => {
    const c = turn(emptyConversation(), 'codex', 1, { session: 't', context: { tokens: 210_000, window: 258_400 } });
    expect(describeContext(contextNow(c, 'codex'), true)).toEqual({
      text: 'context 210k of 258k · 19% left',
      alarm: true,
    });
  });

  test('a malformed measurement off the wire is no measurement', () => {
    const c = turn(emptyConversation(), 'subscription', 1, {
      session: 's',
      context: { tokens: Number.NaN, window: 200_000 },
    });
    expect(contextNow(c, 'subscription')).toEqual({ kind: 'unmeasured' });
  });

  test('a CLI chat with no session is empty, whatever the log says', () => {
    // A chat saved by an older build: the transcript is there and no session is.
    const c = { ...turn(emptyConversation(), 'subscription', 1, { context: { tokens: 9, window: 10 } }), session: null };
    expect(contextNow(c, 'subscription')).toEqual({ kind: 'fresh' });
  });

  test('an API turn is its prompt, nested the way each vendor nests it, with no window', () => {
    const spent = (backend: Backend) => {
      let c = ask(emptyConversation(), 'q', 1, backend, 0);
      c = reduce(c, { kind: 'text', turn: 1, delta: 'a' });
      c = reduce(c, { kind: 'spent', turn: 1, usage: { input: 100, output: 5, cache_read: 1_000, cache_write: 10 } });
      return contextNow(reduce(c, { kind: 'ended', turn: 1, stop: 'end_turn' }), backend);
    };
    // Anthropic reports cache reads beside the input; OpenAI's are inside it.
    expect(spent('anthropic')).toEqual({ kind: 'measured', context: { tokens: 1_110, window: null } });
    expect(spent('openai')).toEqual({ kind: 'measured', context: { tokens: 100, window: null } });
    expect(describeContext({ kind: 'measured', context: { tokens: 1_110, window: null } }, false).text).toBe(
      'context 1k tokens · window not reported',
    );
  });

  test('a turn on another backend says nothing about this one', () => {
    const c = turn(emptyConversation(), 'subscription', 1, { session: 's', context: { tokens: 9, window: 10 } });
    expect(contextNow(c, 'anthropic')).toEqual({ kind: 'unmeasured' });
  });
});

describe('compacting', () => {
  const before = turn(emptyConversation(), 'subscription', 1, { session: 's-1', context: { tokens: 150_000, window: 200_000 } });

  test('it asks for the summary as a turn of its own, which says what it is', () => {
    const c = compact(before, 2, 'subscription', 0);
    expect(c.live?.compacts).toBe(true);
    expect(c.live?.asked).toBeNull();
    expect(c.messages[c.messages.length - 1]).toEqual({ role: 'user', content: COMPACT_PROMPT });
  });

  test('a CLI chat gives up its session and carries the summary into the next one', () => {
    let c = compact(before, 2, 'subscription', 0);
    c = reduce(c, { kind: 'text', turn: 2, delta: 'SUMMARY' });
    c = adoptSession(c, 2, 's-1');
    c = reduce(c, { kind: 'ended', turn: 2, stop: null });
    expect(c.session).toBeNull();
    expect(c.carry).toBe('SUMMARY');
    expect(c.replies).toHaveLength(2);
    expect(contextNow(c, 'subscription')).toEqual({ kind: 'compacted' });

    // The next session opens with it, and taking a session is what delivers it.
    expect(withCarry(c.carry, 'next')).toMatch(/SUMMARY[\s\S]*next$/);
    let next = ask(c, 'next', 3, 'subscription', 0);
    next = adoptSession(next, 3, 's-2');
    expect(next.carry).toBeNull();
    expect(heldSession(next, 'subscription')).toBe('s-2');
  });

  test('an API chat replaces what it re-sends with the request and the summary', () => {
    let c = turn(emptyConversation(), 'anthropic', 1);
    c = compact(c, 2, 'anthropic', 0);
    c = reduce(c, { kind: 'text', turn: 2, delta: 'SUMMARY' });
    c = reduce(c, { kind: 'ended', turn: 2, stop: 'end_turn' });
    expect(c.messages).toEqual([
      { role: 'user', content: COMPACT_PROMPT },
      { role: 'assistant', content: 'SUMMARY' },
    ]);
    expect(c.carry).toBeNull();
    expect(contextNow(c, 'anthropic')).toEqual({ kind: 'compacted' });
  });

  test('one that failed, said nothing or called a tool did not compact', () => {
    const failed = reduce(compact(before, 2, 'subscription', 0), { kind: 'failed', turn: 2, message: 'x' });
    expect(failed.session).toEqual(before.session);
    expect(failed.carry).toBeNull();
    let called = compact(before, 2, 'subscription', 0);
    called = reduce(called, { kind: 'tool_call', turn: 2, id: 'c', name: 'read_run', arguments: '{}' });
    called = reduce(called, { kind: 'ended', turn: 2, stop: null });
    expect(called.carry).toBeNull();
    expect(called.messages.length).toBeGreaterThan(2);
  });
});

describe('clearing', () => {
  test('the pilot forgets, the log stays, and a divider says where', () => {
    const c = clearContext(turn(emptyConversation(), 'subscription', 1, { session: 's-1' }));
    expect(c.messages).toEqual([]);
    expect(c.session).toBeNull();
    expect(c.replies).toHaveLength(2);
    expect(c.replies[1]?.cleared).toBe(true);
    expect(contextNow(c, 'anthropic')).toEqual({ kind: 'fresh' });
  });

  test('nothing is cleared under a turn that is still running', () => {
    const live = ask(emptyConversation(), 'q', 1, 'subscription', 0);
    expect(clearContext(live)).toBe(live);
  });
});
