import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHeartbeat,
  emptySnapshot,
  parseClaudeLine,
  parseCodexLine,
} from '@src/progress.js';
import type { RepeatingTimer, TimerApi } from '@src/progress.js';

/**
 * The per-turn tally: what it counts, and what it refuses to count (#66).
 *
 * Everything here is driven by recorded stream lines, in the shape each CLI
 * actually emits them, because the rule the tally feeds is keyed on a
 * *vocabulary* and a fixture that invented one would pin nothing. The Codex
 * kinds below are the whole observed census across 23 archived transcripts -
 * `command_execution` (1628), `agent_message` (58), `web_search` (10) - and the
 * Claude shape is `assistant` events carrying content blocks and repeated usage.
 *
 * The rule itself is `inert-review.test.ts`; this file is only about whether
 * what it reads is true.
 */

/** A timer that never fires: nothing here is about cadence. */
const idleTimers: TimerApi = {
  repeat: (): RepeatingTimer => ({ unref: () => {}, cancel: () => {} }),
};

function codexItem(phase: 'item.started' | 'item.completed', type: string): string {
  return JSON.stringify({ type: phase, item: { id: `item_${type}`, type } });
}

function assistantLine(message: Record<string, unknown>): string {
  return JSON.stringify({ type: 'assistant', message });
}

const USAGE = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

// ---- Codex ------------------------------------------------------------------

test('a codex item enters the tally when it completes, not when it starts', () => {
  const snapshot = emptySnapshot();

  parseCodexLine(snapshot, codexItem('item.started', 'command_execution'));

  assert.equal(snapshot.items.size, 0, 'a started item has happened once, and not yet');
  assert.equal(snapshot.toolItems, 0);

  parseCodexLine(snapshot, codexItem('item.completed', 'command_execution'));

  assert.deepEqual([...snapshot.items], [['command_execution', 1]]);
  assert.equal(snapshot.toolItems, 1);
});

test('the display counter and the record disagree by design', () => {
  const snapshot = emptySnapshot();

  // One command, as the stream reports one: started, then completed.
  parseCodexLine(snapshot, codexItem('item.started', 'command_execution'));
  parseCodexLine(snapshot, codexItem('item.completed', 'command_execution'));

  // `activities` is a liveness counter and must move on the start, or a
  // three-minute `npm test` freezes the heartbeat. The tally is a record of what
  // happened, and one command happened once. On the #65 run's review turn the
  // last heartbeat read `61 events` for 30 commands: 61 = 2 x 30 + 1.
  assert.equal(snapshot.activities, 2);
  assert.equal(snapshot.items.get('command_execution'), 1);
});

test('a command and a web search are tool items; a message and reasoning are not', () => {
  const snapshot = emptySnapshot();

  for (const kind of ['command_execution', 'web_search', 'agent_message', 'reasoning']) {
    parseCodexLine(snapshot, codexItem('item.completed', kind));
  }

  assert.equal(snapshot.items.size, 4, 'every kind is recorded, tool or not');
  // The deny-list is two entries and both are observed: `agent_message` on the
  // stream, `reasoning` in the rollout.
  assert.equal(snapshot.toolItems, 2);
});

test('an unrecognised item kind counts as a tool item, which is the fail-open direction', () => {
  const snapshot = emptySnapshot();

  // A kind no rollout and no transcript in the archive contains. The two
  // vocabularies in play do not agree - the stream is snake_case and has
  // `web_search`, the rollout is PascalCase and does not - so a kind vibe has
  // never seen must make a turn look ACTIVE. That loses a detection; the other
  // direction downgrades a true finding.
  parseCodexLine(snapshot, codexItem('item.completed', 'mcp_tool_call'));

  assert.equal(snapshot.toolItems, 1);
});

test('a codex item with no usable type is not tallied under an invented one', () => {
  const snapshot = emptySnapshot();

  parseCodexLine(snapshot, JSON.stringify({ type: 'item.completed', item: { id: 'x' } }));
  parseCodexLine(snapshot, JSON.stringify({ type: 'item.completed', item: { type: '' } }));

  assert.equal(snapshot.items.size, 0);
  assert.equal(snapshot.toolItems, 0);
  // Still liveness, because something arrived: the two numbers answer different
  // questions and this is exactly where they part company.
  assert.equal(snapshot.activities, 2);
});

// ---- Claude -----------------------------------------------------------------

test('claude tool_use blocks are tool items and the message they rode in on is not', () => {
  const snapshot = emptySnapshot();

  parseClaudeLine(
    snapshot,
    assistantLine({
      id: 'msg_1',
      usage: USAGE,
      content: [
        { type: 'text', text: 'I will look.' },
        { type: 'tool_use', name: 'Read', input: { file_path: 'src/run.ts' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
      ],
    }),
  );

  assert.deepEqual(Object.fromEntries(snapshot.items), { Read: 1, Bash: 1, message: 1 });
  assert.equal(snapshot.toolItems, 2);
});

test('one message id across several assistant events adds one message item, not three', () => {
  const snapshot = emptySnapshot();

  // Claude emits one `assistant` event per content block, each repeating the
  // whole message's usage. The tally follows the dedupe the tokens already use
  // rather than adding a second one.
  for (let i = 0; i < 3; i += 1) {
    parseClaudeLine(snapshot, assistantLine({ id: 'msg_1', usage: USAGE, content: [] }));
  }

  assert.equal(snapshot.items.get('message'), 1);
});

test('a claude turn that used no tools is measured and inert, not unmeasured', () => {
  const snapshot = emptySnapshot();

  parseClaudeLine(
    snapshot,
    assistantLine({ id: 'msg_1', usage: USAGE, content: [{ type: 'text', text: 'Looks wrong to me.' }] }),
  );

  // The load-bearing half of the Claude side: without the `message` item this
  // tally would be empty, and an empty tally is "nothing was observed", which is
  // never inert. A Claude reviewer that ran nothing would then be invisible.
  assert.deepEqual(Object.fromEntries(snapshot.items), { message: 1 });
  assert.equal(snapshot.toolItems, 0);
});

// ---- What the heartbeat hands out -------------------------------------------

function heartbeat(): ReturnType<typeof createHeartbeat> {
  return createHeartbeat({
    label: 'fixture',
    intervalMs: 30_000,
    parse: parseCodexLine,
    unit: 'event',
    provider: 'codex',
    timers: idleTimers,
    emit: () => {},
  });
}

test('activity is undefined before any line arrives', () => {
  // An unmeasured turn and an idle one are different facts, and this is the
  // seam that keeps them apart: `isInert` reads undefined as "not inert".
  assert.equal(heartbeat().activity(), undefined);
});

test('activity is a copy, so what was recorded cannot be edited afterwards', () => {
  const h = heartbeat();
  h.onLine(codexItem('item.completed', 'agent_message'));

  const first = h.activity();
  assert.deepEqual(first, { items: { agent_message: 1 }, tool: 0 });

  // The adapter reads this once and the object is then stored on the turn
  // result, in the event log and in the downgrade decision.
  first!.items['agent_message'] = 99;
  first!.tool = 99;

  assert.deepEqual(h.activity(), { items: { agent_message: 1 }, tool: 0 });
});

test('a line arriving after the read does not edit the object already handed out', () => {
  const h = heartbeat();
  h.onLine(codexItem('item.completed', 'agent_message'));
  const taken = h.activity();

  h.onLine(codexItem('item.completed', 'command_execution'));

  assert.deepEqual(taken, { items: { agent_message: 1 }, tool: 0 });
  assert.deepEqual(h.activity(), { items: { agent_message: 1, command_execution: 1 }, tool: 1 });
});

test('activity still answers after the turn has been stopped', () => {
  // The adapters read it inside `withHeartbeat`'s work, but a read is a question
  // about what already happened and must not depend on the teardown order.
  const h = heartbeat();
  h.onLine(codexItem('item.completed', 'command_execution'));
  h.stop();

  assert.deepEqual(h.activity(), { items: { command_execution: 1 }, tool: 1 });
});
