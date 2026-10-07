import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from '@src/serve.js';
import { decode } from '@src/protocol.js';
import type { Session } from '@src/serve.js';
import type { Outbound } from '@src/protocol.js';
import type { GateContext } from '@src/host.js';

/**
 * Holding at the next boundary, asked for mid-run (#210).
 *
 * `AGENTS.md` has said since the app landed that pausing is free - the app runs
 * the loop in its own process, so a hold is an `await` at a boundary the loop
 * was crossing anyway and both agent sessions stay warm. **The mechanism was
 * real and the control did not exist**: the only way to make a run hold was to
 * hand-edit `cfg.gates` before starting it.
 *
 * The claim worth the most here is that a request is taken **once**. A pause
 * left armed after a boundary that ran through would hold at some later
 * boundary nobody was looking at, which is indistinguishable from a stall.
 */

const line = (v: unknown): string => JSON.stringify(v);
const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

const ctx: GateContext = {
  boundary: 'plan-approved',
  phase: 'planning',
  planRound: 0,
  questionRound: 0,
  reviewRound: 0,
  verifyRound: 0,
};

/** A session with nothing running, for asking about `takePause` directly. */
function idle(): { sent: Outbound[]; session: Session } {
  const sent: Outbound[] = [];
  return {
    sent,
    session: createSession((m) => void sent.push(m), { invoke: () => Promise.resolve(0) }),
  };
}

test('a pause frame is a request this version understands', () => {
  const read = decode(line({ type: 'pause', id: 3 }));
  assert.equal(read.ok, true);
  assert.deepEqual(read.ok ? read.message : null, { type: 'pause', id: 3 });
});

test('a pause with no id is refused, like every other unanswerable frame', () => {
  // The id is what a reply is matched to. Refusing it *to its sender* is
  // impossible without one, so saying so is the honest failure.
  const read = decode(line({ type: 'pause' }));
  assert.equal(read.ok, false);
  assert.match(read.ok === false ? read.reason : '', /carried no id/);
});

test('a pause is acknowledged at once, because accepted is not honoured', () => {
  // The same split a `shutdown` makes: the frame answers "was the request
  // taken", and the `ask` that follows is what says a hold happened.
  const { sent, session } = idle();
  session.receive(line({ type: 'pause', id: 5 }));
  assert.deepEqual(sent, [{ type: 'result', id: 5, exit: 0 }]);
});

test('the hold is taken exactly once, and clears itself', async () => {
  // The claim this file exists for. A request left armed would hold at a later
  // boundary nobody was looking at.
  const { session } = idle();
  session.receive(line({ type: 'pause', id: 1 }));

  assert.equal(session.host.takePause?.(), true, 'the first boundary takes it');
  assert.equal(session.host.takePause?.(), false, 'and the next one finds nothing');

  await settle();
});

test('two pauses before a boundary are one hold, not two', async () => {
  // Pressing it twice is the same request twice. Holding twice for it would be
  // the app deciding a person meant something they did not say.
  const { session } = idle();
  session.receive(line({ type: 'pause', id: 1 }));
  session.receive(line({ type: 'pause', id: 2 }));

  assert.equal(session.host.takePause?.(), true);
  assert.equal(session.host.takePause?.(), false);

  await settle();
});

test('a pause asked for before a run starts is kept, not refused', async () => {
  // Somebody who presses pause a moment before the run begins meant to hold
  // that run. Refusing it would be this seam deciding their timing was wrong,
  // and it costs nothing because the first boundary clears it either way.
  const { sent, session } = idle();
  session.receive(line({ type: 'pause', id: 1 }));
  session.receive(line({ type: 'invoke', id: 2, argv: ['run', 'x'] }));
  await settle();

  assert.equal(session.host.takePause?.(), true);
  assert.deepEqual(
    sent.map((m) => m.type),
    ['result', 'result'],
  );

  session.receive(line({ type: 'shutdown', id: 3 }));
  await session.finished();
});

test('a gate still asks the same question whether or not a pause opened it', async () => {
  // The pause decides *whether* the loop holds. It does not change what a hold
  // is, what may be answered, or what an answer means - `host.ts` owns that and
  // #210 deliberately adds no member to `Decision`.
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), { invoke: () => Promise.resolve(0) });

  const answered = session.host.decide(ctx);
  const ask = sent.find((m) => m.type === 'ask');
  assert.equal(ask?.type, 'ask');
  if (ask?.type !== 'ask') return;
  assert.deepEqual(ask.context, ctx);

  session.receive(line({ type: 'answer', id: ask.id, decision: { kind: 'continue' } }));
  assert.deepEqual(await answered, { kind: 'continue' });

  session.shutdown();
  await session.finished();
});
