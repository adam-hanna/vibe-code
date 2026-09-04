import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLineReader, decode, encode, PROTOCOL_VERSION } from '@src/protocol.js';
import type { Inbound, Outbound } from '@src/protocol.js';

/**
 * The wire, on its own (#153).
 *
 * Everything here is about a frame that a host could misread. The rule the file
 * follows is the one `readDecision` established: **refuse, never repair.** A
 * request this version cannot parse is reported back to the id that sent it, so
 * the sender stops waiting - which is the difference between a rejected request
 * and a hung app.
 */

function inbound(v: unknown): string {
  return JSON.stringify(v);
}

test('a frame is one line, whatever is inside the message', () => {
  // The one property the whole transport rests on. A narration message can hold
  // anything the loop said, including a multi-line plan summary, and if that
  // reached the wire raw it would split into frames that parse as neither.
  const msg: Outbound = {
    type: 'narration',
    level: 'info',
    message: 'line one\nline two\r\nline three',
    id: null,
    data: { note: 'has a \n in it too' },
  };
  const line = encode(msg);
  assert.equal(line.split('\n').length, 2, 'exactly one newline, at the end');
  assert.equal(line.endsWith('\n'), true);
  assert.deepEqual(JSON.parse(line.trim()) as unknown, msg);
});

test('a request that cannot be parsed is refused, and never guessed at', () => {
  const refusals: readonly [string, string][] = [
    ['', 'empty line'],
    ['not json at all', 'not JSON'],
    ['[1,2,3]', 'not a JSON object'],
    [inbound({ id: 1 }), 'no type'],
    [inbound({ type: 'invoke', id: 1 }), 'invoke carried no argv'],
    [inbound({ type: 'invoke', id: 1, argv: 'run' }), 'invoke carried no argv'],
    [
      inbound({ type: 'invoke', id: 1, argv: ['run', 7] }),
      'invoke argv held something that was not a string',
    ],
  ];
  for (const [line, reason] of refusals) {
    const read = decode(line);
    assert.equal(read.ok, false, `should have refused: ${line}`);
    assert.equal(read.ok === false && read.reason, reason);
  }
});

test('a request with no usable id is refused as unanswerable', () => {
  // The id is what a reply is matched to, so a frame without one cannot be
  // refused *to its sender* - only dropped. Saying so is the honest failure.
  for (const bad of [undefined, null, 'one', 1.5, -1]) {
    const read = decode(inbound({ type: 'invoke', id: bad, argv: ['run', 'x'] }));
    assert.equal(read.ok, false, `id ${String(bad)} should not be usable`);
    assert.equal(read.ok === false && read.id, null);
    assert.match(read.ok === false ? read.reason : '', /cannot be answered/);
  }
});

test('an unknown request type is refused to the id that sent it', () => {
  // The half that matters: a newer app asking for something this version does
  // not have gets an error carrying its own id, so it can report which of its
  // requests was rejected rather than timing out.
  const read = decode(inbound({ type: 'teleport', id: 42 }));
  assert.equal(read.ok, false);
  assert.equal(read.ok === false && read.id, 42);
  assert.match(read.ok === false ? read.reason : '', /not a request this version understands/);
});

test('the three requests decode into the closed vocabulary', () => {
  const cases: readonly [unknown, Inbound][] = [
    [
      { type: 'invoke', id: 0, argv: ['run', 'a task', '-C', '/repo'] },
      { type: 'invoke', id: 0, argv: ['run', 'a task', '-C', '/repo'] },
    ],
    [
      { type: 'answer', id: 3, decision: { kind: 'continue' } },
      { type: 'answer', id: 3, decision: { kind: 'continue' } },
    ],
    [{ type: 'shutdown', id: 9 }, { type: 'shutdown', id: 9 }],
  ];
  for (const [raw, expected] of cases) {
    const read = decode(inbound(raw));
    assert.equal(read.ok, true);
    assert.deepEqual(read.ok === true ? read.message : null, expected);
  }
});

test("a decision is carried through unchecked, because it is readDecision's to judge", () => {
  // Deliberate: checking the shape here as well would be two definitions of a
  // legal decision, in two files, and they would disagree eventually. A
  // nonsense decision reaches `readDecision`, which refuses it toward `stop`.
  const read = decode(inbound({ type: 'answer', id: 1, decision: 'teleport' }));
  assert.equal(read.ok, true);
  assert.equal(read.ok === true && read.message.type === 'answer' && read.message.decision, 'teleport');
});

test('a chunk boundary is not a frame boundary', () => {
  // A pipe splits wherever it likes. The whole job of the reader is that this
  // is invisible to everything above it.
  const seen: string[] = [];
  const write = createLineReader((line) => void seen.push(line));
  const whole = `${inbound({ type: 'shutdown', id: 1 })}\n${inbound({ type: 'shutdown', id: 2 })}\n`;
  for (const ch of whole) write(ch);
  assert.equal(seen.length, 2);
  assert.deepEqual(
    seen.map((l) => (decode(l).ok ? 'ok' : 'refused')),
    ['ok', 'ok'],
  );
});

test('a sender that never sends a newline is dropped, and told', () => {
  // Without a ceiling this is an unbounded allocation in the process holding the
  // run. Reported rather than swallowed, because a silently discarded request
  // is one the app waits on for ever.
  const seen: string[] = [];
  let dropped: number | null = null;
  const write = createLineReader(
    (line) => void seen.push(line),
    (bytes) => {
      dropped = bytes;
    },
    16,
  );
  write('x'.repeat(40));
  assert.equal(seen.length, 0);
  assert.equal(dropped, 40);
  // And the buffer is genuinely cleared, so the next complete line still works.
  write('{"type":"shutdown","id":1}\n');
  assert.equal(seen.length, 1);
});

test('the protocol version is a number the ready frame states', () => {
  const ready: Outbound = { type: 'ready', protocol: PROTOCOL_VERSION, pid: 1 };
  assert.equal(typeof PROTOCOL_VERSION, 'number');
  const parsed = JSON.parse(encode(ready).trim()) as { protocol: number };
  assert.equal(parsed.protocol, PROTOCOL_VERSION);
});
