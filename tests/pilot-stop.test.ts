import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from '@src/protocol.js';
import { Cancelled } from '@src/cancel.js';
import { run } from '@src/proc.js';
import { createSession } from '@src/serve.js';
import type { Outbound } from '@src/protocol.js';
import type { PilotChatOptions, PilotChatResult } from '@src/pilotchat.js';

/**
 * The pilot's stop button stops the pilot (#223).
 *
 * Reported as *"The stop button on the pilot chat doesn't actually do
 * anything"*, and it did not: a subscription turn is a `claude` child of the
 * HOST, and the button called the Rust pilot's cancel, which only knows
 * API-backed turns. Rust refused, the window swallowed the refusal, and the
 * child ran to the end. `pilot_stop` is the host's half, and these cases pin
 * the three things it has to be: it kills that child, it says the turn was
 * stopped rather than that it failed, and it touches nothing else.
 */

const line = (v: unknown): string => JSON.stringify(v);
const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

const REQUEST = {
  type: 'pilot',
  id: 7,
  prompt: 'keep going',
  system: 'you are the pilot',
  model: 'claude-opus-5',
  sessionId: 'abc',
  dir: '/repo',
  resume: false,
};

/** A pilot turn that never finishes on its own, only when its signal fires. */
function untilStopped(seen: { signal: AbortSignal | undefined }) {
  return (options: PilotChatOptions): Promise<PilotChatResult> => {
    seen.signal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Cancelled('stopped from the window')));
    });
  };
}

test('pilot_stop is a frame the host reads, naming the turn', () => {
  const ok = decode(line({ type: 'pilot_stop', id: 2, turn: 7 }));
  assert.equal(ok.ok, true);
  const bad = decode(line({ type: 'pilot_stop', id: 2 }));
  assert.equal(bad.ok, false, 'a stop that names no turn is refused');
});

test('stopping a turn aborts its child and says it was stopped, not that it failed', async () => {
  const sent: Outbound[] = [];
  const seen: { signal: AbortSignal | undefined } = { signal: undefined };
  const session = createSession((m) => void sent.push(m), {
    invoke: () => Promise.resolve(0),
    pilot: untilStopped(seen),
  });
  session.receive(line(REQUEST));
  await settle();
  assert.ok(seen.signal, 'the turn was handed an off switch');
  assert.equal(seen.signal.aborted, false);

  session.receive(line({ type: 'pilot_stop', id: 8, turn: 7 }));
  await settle();
  await settle();

  assert.equal(seen.signal.aborted, true);
  assert.ok(sent.some((f) => f.type === 'pilot_stopped' && f.id === 7));
  assert.ok(
    !sent.some((f) => f.type === 'error' && f.id === 7),
    'a turn somebody stopped is not drawn as a failure',
  );
  assert.ok(sent.some((f) => f.type === 'result' && f.id === 8), 'the stop request is answered');
});

test('stopping a turn that already ended is answered and changes nothing', async () => {
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => Promise.resolve(0),
    pilot: () => Promise.resolve({ text: 'done', sessionId: 's', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total: 2 } }),
  });
  session.receive(line(REQUEST));
  await settle();
  session.receive(line({ type: 'pilot_stop', id: 9, turn: 7 }));
  await settle();
  // The click raced the reply; the reply stands.
  assert.ok(sent.some((f) => f.type === 'pilot_reply' && f.id === 7));
  assert.ok(!sent.some((f) => f.type === 'pilot_stopped'));
  assert.ok(sent.some((f) => f.type === 'result' && f.id === 9));
});

test('a signal kills that child, at once, as a Cancelled', async () => {
  // A real child that would otherwise run for a minute.
  const stopper = new AbortController();
  const started = Date.now();
  const pending = run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    timeoutMs: 120_000,
    signal: stopper.signal,
  });
  setTimeout(() => stopper.abort(), 50);
  await assert.rejects(pending, (err: unknown) => err instanceof Cancelled);
  assert.ok(Date.now() - started < 30_000, 'it settled when stopped, not when the child would have exited');
});
