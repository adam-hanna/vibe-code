import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promptContext } from '@src/claude.js';
import { pilotChat } from '@src/pilotchat.js';
import { pilotCodex, rolloutContext } from '@src/pilotcodex.js';
import type { RunFn } from '@src/proc.js';
import type { PilotChatOptions } from '@src/pilotchat.js';

/**
 * How full a pilot conversation is (#223).
 *
 * *"Can we report context remaining for the pilot"* - and the figure that was
 * already on the reply, `tokens`, is the wrong one: it is what the turn moved,
 * summed over every request in it. These pin that the occupancy is the LAST
 * prompt, from the place each CLI actually says it, and that a window nobody
 * reported stays null rather than being guessed.
 */

const line = (v: unknown): string => JSON.stringify(v);

const OPTIONS: PilotChatOptions = {
  prompt: 'hello',
  system: 'you are the pilot',
  sessionId: 'thread-1',
  resume: false,
  model: 'opus',
  cwd: '/repo',
  timeoutMs: 1000,
};

const assistant = (input: number, cacheRead: number, cacheCreation: number): string =>
  line({
    type: 'assistant',
    message: {
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreation,
      },
    },
  });

const result = (modelUsage: unknown): string =>
  line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    session_id: 's-1',
    // The aggregate: four requests' worth, which must NOT be the occupancy.
    usage: { input_tokens: 40, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0 },
    modelUsage,
  });

test("Claude's occupancy is the last request's prompt, against the window the envelope names", () => {
  const stdout = [
    assistant(5, 10_000, 200),
    assistant(3, 20_000, 1_000),
    result({ 'claude-opus-5': { contextWindow: 200_000 } }),
  ].join('\n');
  assert.deepEqual(promptContext(stdout), { tokens: 21_003, window: 200_000 });
});

test('a Claude turn that names no window is a count with no share, never a guessed one', () => {
  assert.deepEqual(promptContext([assistant(1, 2, 3), result(undefined)].join('\n')), {
    tokens: 6,
    window: null,
  });
  assert.equal(promptContext(result({ m: { contextWindow: 1 } })), null, 'no message, no measurement');
});

test('the Claude pilot reply carries the occupancy beside what the turn moved', async () => {
  const stdout = [assistant(1, 999, 0), result({ m: { contextWindow: 1_000_000 } })].join('\n');
  const exec: RunFn = () => Promise.resolve({ code: 0, signal: null, stdout, stderr: '' });
  const reply = await pilotChat(OPTIONS, exec);
  assert.deepEqual(reply.context, { tokens: 1_000, window: 1_000_000 });
  assert.notEqual(reply.tokens.total, 1_000, 'tokens is the aggregate and stays that');
});

/** A `$CODEX_HOME` with one rollout per entry, each under its own day. */
function codexHome(files: Record<string, readonly string[]>): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'vibe-codex-home-'));
  for (const [day, lines] of Object.entries(files)) {
    const [y, m, d, name] = day.split('/');
    const dir = path.join(home, 'sessions', y ?? '', m ?? '', d ?? '');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, name ?? ''), lines.join('\n'), 'utf8');
  }
  return home;
}

const tokenCount = (last: number, window: number | undefined): string =>
  line({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: last * 3 },
        last_token_usage: { input_tokens: last, cached_input_tokens: last - 1 },
        ...(window === undefined ? {} : { model_context_window: window }),
      },
    },
  });

test("Codex's occupancy is read from its own rollout, the last token_count in it", () => {
  const home = codexHome({
    // The thread was created on an earlier day and resumed since: the file
    // stays where it was made, so the search cannot stop at the newest day.
    '2026/09/30/rollout-2026-09-30T10-00-00-th-1.jsonl': [
      tokenCount(10_000, 258_400),
      tokenCount(14_280, 258_400),
    ],
    '2026/10/02/rollout-2026-10-02T10-00-00-other.jsonl': [tokenCount(1, 2)],
  });
  assert.deepEqual(rolloutContext('th-1', home), { tokens: 14_280, window: 258_400 });
});

test('a rollout that cannot be found or read is no measurement, never the turn aggregate', () => {
  const home = codexHome({
    '2026/10/01/rollout-x-th-2.jsonl': ['not json', line({ type: 'event_msg', payload: { type: 'other' } })],
    '2026/10/01/rollout-x-th-3.jsonl': [tokenCount(500, undefined)],
  });
  assert.equal(rolloutContext('th-missing', home), null);
  assert.equal(rolloutContext('th-2', home), null);
  assert.deepEqual(rolloutContext('th-3', home), { tokens: 500, window: null });
  assert.equal(rolloutContext('th-1', path.join(home, 'nowhere')), null);
});

test('the Codex pilot reads the context of the thread it ran on, which a resume names', async () => {
  const asked: string[] = [];
  const read = (thread: string) => {
    asked.push(thread);
    return { tokens: 7, window: 70 };
  };
  const out = (thread: boolean): RunFn => (_bin, _args, options) => {
    const lines = [
      ...(thread ? [line({ type: 'thread.started', thread_id: 'th-new' })] : []),
      line({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }),
      line({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }),
    ];
    for (const l of lines) options?.onLine?.(l);
    return Promise.resolve({ code: 0, signal: null, stdout: lines.join('\n'), stderr: '' });
  };
  assert.deepEqual((await pilotCodex(OPTIONS, out(true), read)).context, { tokens: 7, window: 70 });
  await pilotCodex({ ...OPTIONS, resume: true, sessionId: 'th-old' }, out(false), read);
  // A new thread that never named itself has nothing to look up.
  assert.equal((await pilotCodex(OPTIONS, out(false), read)).context, null);
  assert.deepEqual(asked, ['th-new', 'th-old']);
});
