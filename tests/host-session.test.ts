import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSession, installProtocolStdout } from '@src/serve.js';
import { orchestrate } from '@src/orchestrator.js';
import * as log from '@src/log.js';
import { encode } from '@src/protocol.js';
import type { Send, Session } from '@src/serve.js';
import type { Outbound } from '@src/protocol.js';
import type { RunState } from '@src/types.js';
import {
  agents,
  committing,
  config,
  freshRun,
  planFixture,
  report,
  verifying,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';

/**
 * The session: what the host process does with a frame once it has one (#153).
 *
 * The claims worth the most here are the last few. **Every byte on stdout parses
 * as NDJSON** is the one that fails silently in production if it is wrong - the
 * packaging spike reproduced exactly that failure, with two `log.*` lines
 * landing inside the protocol stream. And **a gate is an await** is the reason
 * the app links this source rather than shelling out to `vibe`.
 */

const line = (v: unknown): string => JSON.stringify(v);
const last = (sent: readonly Outbound[]): Outbound | undefined => sent[sent.length - 1];

/** A session whose frames are collected, with nothing answering them. */
function collecting(exit = 0): { sent: Outbound[]; session: Session } {
  const sent: Outbound[] = [];
  return {
    sent,
    session: createSession((m) => void sent.push(m), { invoke: () => Promise.resolve(exit) }),
  };
}

/** Let queued microtasks and `.finally` handlers run. */
const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

test('a request is answered with the exit code the same command would have returned', async () => {
  const { sent, session } = collecting(3);
  session.receive(line({ type: 'invoke', id: 7, argv: ['run', 'a task'] }));
  await settle();
  session.receive(line({ type: 'shutdown', id: 8 }));
  await session.finished();

  assert.deepEqual(sent, [
    { type: 'result', id: 7, exit: 3 },
    { type: 'result', id: 8, exit: 0 },
  ]);
});

test('the argv reaches the CLI untouched, because it is the CLI that defines it', async () => {
  // The load-bearing decision in this seam. A structured {task, model, ...}
  // request would be a second definition of what a legal invocation is, drifting
  // from `parseArgs` on the next flag anybody adds.
  const sent: Outbound[] = [];
  let seen: readonly string[] | null = null;
  const session = createSession((m) => void sent.push(m), {
    invoke: (argv) => {
      seen = argv;
      return Promise.resolve(0);
    },
  });
  const argv = ['run', 'a task', '-C', '/repo', '--max-tokens', '5000000'];
  session.receive(line({ type: 'invoke', id: 1, argv }));
  assert.deepEqual(seen, argv);

  await settle();
  session.receive(line({ type: 'shutdown', id: 2 }));
  await session.finished();
});

test('a request whose command threw is an error, not a result with a code', async () => {
  // A `result` would claim the command ran and returned that exit code, and it
  // did neither. `main` catches internally, so reaching here means something
  // escaped it entirely.
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => Promise.reject(new Error('the run directory vanished')),
  });
  session.receive(line({ type: 'invoke', id: 1, argv: ['run', 'x'] }));
  await settle();
  session.shutdown();
  await session.finished();

  const first = sent[0];
  assert.equal(first?.type, 'error');
  assert.match(first?.type === 'error' ? first.message : '', /the run directory vanished/);
});

test('a second request while one is running is refused with a reason, not queued', async () => {
  // Refused rather than queued because a queue leaves the app waiting with no
  // way to know it is waiting. `src/lock.ts` expects one process per run, and
  // two runs interleaving their narration on a wire that carries no run id would
  // be unreadable at the other end.
  const sent: Outbound[] = [];
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session = createSession((m) => void sent.push(m), { invoke: () => held.then(() => 0) });

  session.receive(line({ type: 'invoke', id: 1, argv: ['run', 'first'] }));
  session.receive(line({ type: 'invoke', id: 2, argv: ['run', 'second'] }));

  assert.deepEqual(sent, [
    { type: 'error', id: 2, message: 'request 1 is still running; one run at a time' },
  ]);

  release();
  await settle();
  session.receive(line({ type: 'shutdown', id: 3 }));
  await session.finished();
});

test('an answer to a gate nobody is holding is an error, never a silent drop', async () => {
  // The two sides disagreeing about what the loop is doing is worth saying out
  // loud: a host that is told stops waiting for something that is not coming.
  const { sent, session } = collecting();
  session.receive(line({ type: 'answer', id: 99, decision: { kind: 'continue' } }));
  assert.deepEqual(sent, [{ type: 'error', id: 99, message: 'no gate is waiting on that id' }]);
  session.shutdown();
  await session.finished();
});

test('a gate that outlived its run cannot be answered by the next one', async () => {
  // An `ask` left in the map after its run ended would be resolved by a later
  // `answer`, settling a promise nobody awaits - and consuming an id the next
  // gate could reuse.
  const sent: Outbound[] = [];
  let session: Session | null = null;
  session = createSession((m) => void sent.push(m), {
    invoke: () => {
      void session?.host.decide({
        boundary: 'plan-approved',
        phase: 'planning',
        planRound: 0,
        reviewRound: 0,
        verifyRound: 0,
      });
      return Promise.resolve(0);
    },
  });

  session.receive(line({ type: 'invoke', id: 1, argv: ['run', 'x'] }));
  await settle();

  const ask = sent.find((m) => m.type === 'ask');
  assert.equal(ask?.type, 'ask');
  session.receive(
    line({ type: 'answer', id: ask?.type === 'ask' ? ask.id : 0, decision: { kind: 'continue' } }),
  );
  assert.equal(last(sent)?.type, 'error');

  session.shutdown();
  await session.finished();
});

test('a shutdown is acknowledged at once, and finishing waits for the run', async () => {
  // The frame answers "was the request accepted", not "is the process gone".
  const sent: Outbound[] = [];
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session = createSession((m) => void sent.push(m), { invoke: () => held.then(() => 0) });

  session.receive(line({ type: 'invoke', id: 1, argv: ['run', 'x'] }));
  session.receive(line({ type: 'shutdown', id: 2 }));

  let done = false;
  void session.finished().then(() => {
    done = true;
  });
  await settle();
  assert.equal(done, false, 'a shutdown must not abandon a run mid-flight');
  assert.deepEqual(sent, [{ type: 'result', id: 2, exit: 0 }]);

  release();
  await session.finished();
  assert.deepEqual(last(sent), { type: 'result', id: 1, exit: 0 });
});

test('a request arriving after a shutdown is refused rather than started', async () => {
  const { sent, session } = collecting();
  session.receive(line({ type: 'shutdown', id: 1 }));
  session.receive(line({ type: 'invoke', id: 2, argv: ['run', 'x'] }));
  await session.finished();
  assert.deepEqual(last(sent), {
    type: 'error',
    id: 2,
    message: 'shutting down; not accepting new requests',
  });
});

test('a stream split anywhere still delivers whole requests', async () => {
  const { sent, session } = collecting();
  const stream = `${line({ type: 'invoke', id: 1, argv: ['run', 'x'] })}\n${line({ type: 'shutdown', id: 2 })}\n`;
  for (const ch of stream) session.write(ch);
  await session.finished();
  assert.deepEqual(
    sent.map((m) => m.type),
    ['result', 'result'],
  );
});

// ---------------------------------------------------------------------------
// The claims that are the point of the issue: a real pass, over the wire.
// ---------------------------------------------------------------------------

function passing(state: RunState): Handlers {
  return {
    claude: (label) =>
      label === 'plan' || label.startsWith('revise-') ? planFixture() : work(state, `${label}.txt`),
    codex: () => report([]),
  };
}

/**
 * A full `orchestrate` pass with the session's sink installed and its host
 * answering every gate.
 *
 * The answer is sent from inside `send`, which is the tightest schedule a host
 * could keep and the one most likely to expose a reentrancy bug in the gate
 * bookkeeping.
 */
async function drive(
  prefix: string,
  answer: () => unknown,
): Promise<{ sent: Outbound[]; state: RunState; stopped: Error | null }> {
  const state = freshRun({ prefix, task: 'wire', planOnly: false, git: true, commit: true });
  const sent: Outbound[] = [];
  let session: Session | null = null;
  const send: Send = (m) => {
    sent.push(m);
    if (m.type === 'ask') {
      session?.receive(line({ type: 'answer', id: m.id, decision: answer() }));
    }
  };
  session = createSession(send, { invoke: () => Promise.resolve(0) });

  const realLog = console.log;
  const realError = console.error;
  let stopped: Error | null = null;
  log.setSink(session.sink);
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(
      state,
      config({}, { ...committing(), ...verifying(state) }),
      false,
      agents(passing(state), []),
      session.host,
    );
  } catch (err) {
    // A host that stops the run raises the same `Escalation` a round cap does -
    // caught here rather than in each caller, because it is an ending this
    // helper has to be able to describe, not a failure of the pass.
    stopped = err instanceof Error ? err : new Error(String(err));
  } finally {
    console.log = realLog;
    console.error = realError;
    log.setSink(null);
  }
  return { sent, state, stopped };
}

test('every frame a real pass puts on the wire parses as one JSON line', async () => {
  // The claim the packaging spike proved cannot be assumed. It reproduced two
  // `log.*` lines landing inside the protocol stream, and one `log.step()` is
  // all it takes to make a frame unparseable.
  const { sent } = await drive('vibe-wire-ndjson-', () => ({ kind: 'continue' }));
  assert.ok(sent.length > 0);

  const lines = sent.map(encode).join('').split('\n');
  assert.equal(lines[lines.length - 1], '', 'the stream ends on a newline');
  for (const l of lines.slice(0, -1)) {
    assert.doesNotThrow(() => JSON.parse(l) as unknown, `not a frame: ${l.slice(0, 80)}`);
  }
  assert.equal(lines.length - 1, sent.length, 'one line per frame, no more and no fewer');
});

test('narration arrives flat, carrying the id and data a host acts on', async () => {
  const { sent } = await drive('vibe-wire-narr-', () => ({ kind: 'continue' }));
  const narration = sent.filter((m) => m.type === 'narration');
  assert.ok(narration.length > 0);

  // Flat rather than nested under a wrapper: a host switching on `type` and then
  // on `id` should not have to reach through one for the second.
  for (const n of narration) {
    assert.equal(typeof (n as unknown as { level: string }).level, 'string');
    assert.equal(typeof (n as unknown as { message: string }).message, 'string');
  }
  const ids = narration
    .map((n) => (n as unknown as { id: string | null }).id)
    .filter((i): i is string => i !== null);
  // The loop is legible end to end without a sentence being read, and the gate
  // ids sit among the phase ids rather than on a channel of their own.
  assert.equal(ids.includes('phase_started'), true);
  assert.equal(ids.includes('turn_started'), true);
  assert.equal(ids.includes('gate_waiting'), true);
  assert.equal(ids.includes('gate_released'), true);
  assert.equal(ids.includes('review_approved'), true);
});

test('a gate is an await: the loop holds, the host answers, and the run finishes', async () => {
  // The reason the app links this source instead of shelling out to `vibe`. The
  // CLI's only gate is exit-and-resume, which re-sends context every time; here
  // the process never left, so the session it continues on is the one it had.
  const { sent, state, stopped } = await drive('vibe-wire-gate-', () => ({ kind: 'continue' }));
  const asks = sent.filter((m) => m.type === 'ask');
  assert.ok(asks.length > 0, 'a clean pass should reach at least one gated boundary');
  assert.equal(stopped, null);
  assert.equal(state.status, 'done');

  // Every gate says where in the run it is. A boundary alone does not:
  // `review-round` is reached up to `maxReviewRounds` times.
  for (const ask of asks) {
    assert.equal(ask.type, 'ask');
    if (ask.type !== 'ask') continue;
    assert.equal(typeof ask.context.boundary, 'string');
    assert.equal(typeof ask.context.planRound, 'number');
    assert.equal(typeof ask.context.reviewRound, 'number');
    assert.equal(typeof ask.context.verifyRound, 'number');
  }
});

test('a host that answers nonsense stops the run rather than continuing it', async () => {
  // Fails closed, and the direction matters: continuing on an instruction nobody
  // could parse spends tokens on the strength of a message that may have said
  // the opposite. `readDecision` owns that judgement; this proves the wire
  // reaches it rather than bypassing it.
  const { sent, state, stopped } = await drive('vibe-wire-refuse-', () => 'teleport');
  assert.equal(sent.filter((m) => m.type === 'ask').length, 1, 'it stops at the first gate');

  // The SAME resumable ending a round cap produces: the `Escalation` that
  // `execute` turns into `needs-input` plus a NEEDS-INPUT.md, and not a crash.
  // An app whose user sent a frame this version could not read gets the run
  // back, not a lost one. The status itself is `execute`'s to set - this drives
  // the loop directly, so the durable record is what there is to check here.
  assert.match(stopped?.message ?? '', /the host answered with no decision/);
  assert.equal(
    (state.events ?? []).some((e) => e.type === 'gate_stopped'),
    true,
    'a stop is a transition, so it is recorded and not merely said',
  );

  // And the refusal is on the wire as well as in the file, so a cockpit can show
  // what happened without reading the run directory.
  const narration = sent.filter((m) => m.type === 'narration');
  assert.equal(
    narration.some((n) => (n as unknown as { id: string | null }).id === 'gate_stopped'),
    true,
  );
});

test('installProtocolStdout puts frames on stdout and the console on stderr', () => {
  // `log.ts` says this is the process's decision to make rather than its own,
  // and this is the process making it.
  const realLog = console.log;
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  const out: string[] = [];
  const err: string[] = [];
  process.stdout.write = ((s: string) => {
    out.push(s);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((s: string) => {
    err.push(s);
    return true;
  }) as typeof process.stderr.write;

  try {
    const send = installProtocolStdout();
    log.step('a sentence a human reads');
    send({ type: 'ready', protocol: 1, pid: 1 });
  } finally {
    console.log = realLog;
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }

  assert.equal(out.length, 1, 'only the frame reached stdout');
  assert.doesNotThrow(() => JSON.parse(out[0] ?? '') as unknown);
  assert.equal(
    err.some((s) => s.includes('a sentence a human reads')),
    true,
    'the prose went to stderr, where a supervisor can still read it',
  );
});
