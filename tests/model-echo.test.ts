import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptySnapshot, parseClaudeLine, parseCodexLine } from '@src/progress.js';

/**
 * The agent's own prose, on the stream that carried everything but (#223).
 *
 * `lastActivity` is a tool name - `Read src/gates.ts` - so the output pane could
 * say what vibe was doing and which tools ran, and never what the model was
 * reasoning about. Reported exactly: *"Output needs to be more verbose about the
 * model and what it's thinking. Right now it's more like what vibe is doing. I
 * want to see the actual model output."*
 *
 * **The parsers collect; they do not narrate.** `onLine` is documented as the
 * only site in `progress.ts` that emits, so what these cases pin is the
 * collection - the buffer, what goes in it, and what does not.
 */

const claude = (content: unknown[], id = 'msg_1'): string =>
  JSON.stringify({ type: 'assistant', message: { id, content } });

test('a text block is collected whole, and a tool block is not', () => {
  const snapshot = emptySnapshot();
  parseClaudeLine(snapshot, claude([{ type: 'text', text: 'I will read the gate matrix.' }]));
  parseClaudeLine(
    snapshot,
    claude([{ type: 'tool_use', name: 'Read', input: { file_path: 'src/gates.ts' } }], 'msg_2'),
  );

  assert.deepEqual(snapshot.said, ['I will read the gate matrix.']);
  // The tool is still tallied exactly as it was: this walk gained a branch and
  // changed nothing about the one that was there.
  assert.equal(snapshot.lastActivity, 'Read src/gates.ts');
  assert.equal(snapshot.toolItems, 1);
});

test('the paragraph is passed through untouched, uncapped and unreflowed', () => {
  // The owner's decision: no cap. A model that writes four thousand words puts
  // four thousand words in the pane, because a truncated thought is the half
  // that is not worth reading - and a character limit is a number with nothing
  // behind it.
  const long = `# A heading\n\n${'word '.repeat(4000)}\n\n- a bullet`;
  const snapshot = emptySnapshot();
  parseClaudeLine(snapshot, claude([{ type: 'text', text: long }]));
  assert.deepEqual(snapshot.said, [long]);
});

test('whitespace is not something the model said', () => {
  const snapshot = emptySnapshot();
  parseClaudeLine(snapshot, claude([{ type: 'text', text: '   \n\t ' }]));
  parseClaudeLine(snapshot, claude([{ type: 'text', text: '' }], 'msg_2'));
  parseClaudeLine(snapshot, claude([{ type: 'text', text: 42 }], 'msg_3'));
  assert.deepEqual(snapshot.said, []);
});

test('Codex says it on the completed item, and only agent_message does', () => {
  const snapshot = emptySnapshot();
  const item = (type: string, text: string, phase = 'item.completed'): string =>
    JSON.stringify({ type: phase, item: { type, text } });

  // `item.started` carries a partial message, and reading both would collect the
  // same message twice - once half-written.
  parseCodexLine(snapshot, item('agent_message', 'partial', 'item.started'));
  parseCodexLine(snapshot, item('agent_message', 'The plan cites a file that does not exist.'));
  // `reasoning` is the other non-tool kind and is deliberately left alone: it has
  // never been seen carrying text on this stream, so reading a field off it
  // would be guessing at a shape rather than reading one.
  parseCodexLine(snapshot, item('reasoning', 'thinking about it'));
  parseCodexLine(snapshot, item('command_execution', 'npm test'));

  assert.deepEqual(snapshot.said, ['The plan cites a file that does not exist.']);
});

test('a malformed line adds nothing and does not throw', () => {
  const snapshot = emptySnapshot();
  for (const line of ['', 'not json', '{}', '{"type":"assistant"}', JSON.stringify({ type: 'assistant', message: 7 })]) {
    parseClaudeLine(snapshot, line);
    parseCodexLine(snapshot, line);
  }
  assert.deepEqual(snapshot.said, []);
});

test('an empty snapshot starts with an empty buffer, never undefined', () => {
  // Every consumer splices it. A field that could be absent would make the one
  // site that drains it responsible for a case nothing else in this file has.
  assert.deepEqual(emptySnapshot().said, []);
});
