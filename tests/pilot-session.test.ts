import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from '@src/protocol.js';
import { createSession } from '@src/serve.js';
import type { Outbound } from '@src/protocol.js';
import type { PilotChatOptions, PilotChatResult } from '@src/pilotchat.js';
import type { Session } from '@src/serve.js';

/**
 * A pilot turn on the subscription, over the host's wire (#193).
 *
 * `src/pilotchat.ts` shipped as groundwork with nothing calling it. This is what
 * calls it, and the claim worth the most is the one about **where** a pilot turn
 * sits: it is not a run. It takes no lock, writes no state and narrates nothing,
 * so `serve.ts`'s one-at-a-time rule - which exists because `src/lock.ts`
 * expects one process per run - must not apply to it. A conversation about a run
 * is most useful *during* one, and refusing it then would refuse it exactly when
 * it is wanted.
 */

const line = (v: unknown): string => JSON.stringify(v);
const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

const REQUEST = {
  type: 'pilot',
  id: 1,
  prompt: 'what is this run doing',
  system: 'you are the pilot',
  model: 'claude-opus-5',
  sessionId: 'abc',
  resume: false,
};

const TOKENS = { input: 100, output: 20, cacheRead: 5, cacheCreation: 0, total: 125 };

/** A session whose pilot turn is a function rather than a `claude` child. */
function withPilot(
  chat: (options: PilotChatOptions) => Promise<PilotChatResult>,
): { sent: Outbound[]; session: Session } {
  const sent: Outbound[] = [];
  return {
    sent,
    session: createSession((m) => void sent.push(m), {
      invoke: () => Promise.resolve(0),
      pilot: chat,
    }),
  };
}

const replies = (text: string): ((o: PilotChatOptions) => Promise<PilotChatResult>) => {
  return (options) => {
    options.onDelta?.(text);
    return Promise.resolve({ text, sessionId: 'from-the-cli', tokens: TOKENS });
  };
};

test('a pilot frame decodes, and every field is required', () => {
  const read = decode(line(REQUEST));
  assert.equal(read.ok, true);

  // Not argv: an `invoke` hands its strings to `parseArgs`, which is the one
  // definition of a legal invocation. There is nothing below this to catch a
  // missing model or an empty prompt, so it is caught here.
  for (const field of ['prompt', 'system', 'model', 'sessionId']) {
    const bad = decode(line({ ...REQUEST, [field]: '' }));
    assert.equal(bad.ok, false, `an empty ${field} was accepted`);
    assert.match(bad.ok === false ? bad.reason : '', new RegExp(field));
  }
  const noResume = decode(line({ ...REQUEST, resume: 'yes' }));
  assert.equal(noResume.ok, false);
});

test('the reply carries the tokens and no money, because there is none to carry', async () => {
  // A subscription turn bills nothing at all, so a dollar figure would have no
  // quantity to be an estimate OF - the same sentence that makes Codex cost
  // unreportable. `PilotChatResult` has no cost field and there is nowhere here
  // to invent one.
  const { sent, session } = withPilot(replies('it is planning'));
  session.receive(line(REQUEST));
  await settle();

  assert.deepEqual(sent, [
    { type: 'pilot_delta', id: 1, text: 'it is planning' },
    {
      type: 'pilot_reply',
      id: 1,
      text: 'it is planning',
      sessionId: 'from-the-cli',
      tokens: TOKENS,
    },
  ]);
  const reply = sent[1];
  assert.equal(reply?.type, 'pilot_reply');
  assert.deepEqual(Object.keys(reply ?? {}).sort(), ['id', 'sessionId', 'text', 'tokens', 'type']);
});

test('the session id the CLI reports wins over the one that was proposed', async () => {
  // The caller allocates one so the id exists before the first turn, and the CLI
  // is authoritative over it. A window that kept its own would resume a
  // conversation the CLI does not have.
  const { sent, session } = withPilot(replies('hello'));
  session.receive(line(REQUEST));
  await settle();

  const reply = sent.find((m) => m.type === 'pilot_reply');
  assert.equal(reply?.type === 'pilot_reply' ? reply.sessionId : null, 'from-the-cli');
});

test('a pilot turn runs beside a run rather than through the one-at-a-time gate', async () => {
  // The claim this file exists for. That rule is about RUNS: it exists because
  // `src/lock.ts` expects one process per run and two runs would interleave
  // their narration. A pilot turn takes no lock and writes no state.
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    // A run that never finishes, so the gate is definitely closed.
    invoke: () => new Promise<number>(() => undefined),
    pilot: replies('during the run'),
  });

  session.receive(line({ type: 'invoke', id: 1, argv: ['run', 'x'] }));
  session.receive(line({ ...REQUEST, id: 2 }));
  await settle();

  assert.equal(
    sent.some((m) => m.type === 'error'),
    false,
    'the pilot turn was refused while a run was going',
  );
  assert.equal(
    sent.some((m) => m.type === 'pilot_reply'),
    true,
  );
});

test('a second invoke is still refused, so the rule that does apply still does', async () => {
  // The other direction, and it is what keeps the exemption honest: a pilot turn
  // being exempt must not exempt a second run.
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => new Promise<number>(() => undefined),
    pilot: replies('x'),
  });

  session.receive(line({ type: 'invoke', id: 1, argv: ['run', 'first'] }));
  session.receive(line({ type: 'invoke', id: 2, argv: ['run', 'second'] }));
  await settle();

  assert.deepEqual(sent, [
    { type: 'error', id: 2, message: 'request 1 is still running; one run at a time' },
  ]);
});

test('a turn that could not run is an error, never an empty reply', async () => {
  // An empty `pilot_reply` would look like a model that had nothing to say, and
  // this is a turn that did not happen. A `RateLimitError` arrives here as
  // itself, which is what `pilotchat.ts` raised it for.
  const { sent, session } = withPilot(() => Promise.reject(new Error('claude is not on PATH')));
  session.receive(line(REQUEST));
  await settle();

  assert.deepEqual(sent, [{ type: 'error', id: 1, message: 'claude is not on PATH' }]);
});

test('a pilot turn does not hold the process open, and does not close it either', async () => {
  // Deliberately outside `finished()`. A quit should not wait on a chat turn -
  // #206 already decided a supervisor going away abandons work rather than
  // finishing it - and a chat turn must not settle the shutdown either.
  // A no-op initializer rather than `null`: the executor runs synchronously and
  // always assigns, but the compiler cannot see that through a callback and
  // narrows the variable to its initial type at every use. `serve.ts` does the
  // same thing for the same reason.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => Promise.resolve(0),
    pilot: () => held.then(() => ({ text: 'late', sessionId: 's', tokens: TOKENS })),
  });

  session.receive(line(REQUEST));
  session.receive(line({ type: 'shutdown', id: 2 }));

  // Settles with the chat turn still in flight, which is the point.
  await session.finished();
  release();
  await settle();
});
