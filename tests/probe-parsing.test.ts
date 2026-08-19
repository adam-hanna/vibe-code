import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProbeTurn } from '@src/claude.js';
import { parseProbeStream } from '@src/codex.js';
import {
  BEGIN,
  END,
  extractRecord,
  renderProbePrompt,
  selectProbeTranscript,
} from '@src/adapters/codex-adapter.js';
import type { ToolchainContract } from '@src/runtime.js';

/**
 * What a probe turn reports, and which string the record is read out of.
 *
 * Both probes now run in the mode that reports usage - `--output-format
 * stream-json` for Claude, `--json` for Codex - which changes what their
 * executors hand back to the adapters. These pin both halves: the figure that
 * gets charged, and the transcript the adapter still has to be able to parse.
 *
 * Nothing is spawned: every case is a fixture of what the CLI prints.
 */

const CONTRACT: ToolchainContract = {
  node: { probe: 'node --version', phases: ['implement'] },
};

/** A probe record the adapter can actually use. */
const RECORD = ['shell=powershell', 'uname=Windows', 'tool.node.exit=0'].join('\n');
const BLOCK = `${BEGIN}\n${RECORD}\n${END}`;

function jsonl(...events: unknown[]): string {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function agentMessage(text: string): unknown {
  return { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text } };
}

// ---- Claude: the stream-json envelope ---------------------------------------

test('a claude probe turn reports its text and what it spent', () => {
  const stdout = jsonl(
    { type: 'assistant', message: { usage: { input_tokens: 5, output_tokens: 1 } } },
    {
      type: 'result',
      subtype: 'success',
      result: BLOCK,
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 1000,
        output_tokens: 200,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 5,
      },
    },
  );

  const turn = parseProbeTurn(stdout);

  // The final message, not the raw stream: the adapter reads its block out of it.
  assert.equal(turn.text, BLOCK);
  assert.equal(turn.usage?.costUsd, 0.0123);
  assert.equal(turn.usage?.tokens.total, 1235);
});

test('a claude probe turn with no result event reports no usage and the raw output', () => {
  const stdout = 'not json at all\n';

  const turn = parseProbeTurn(stdout);

  assert.equal(turn.text, stdout);
  assert.equal(turn.usage, null);
  // Nothing to charge, and nothing invented in its place.
});

test('a claude probe turn that failed after spending still reports the spend', () => {
  // The one place claude.ts does not apply its own "what counts as a failed
  // turn" rule: the probe's verdict comes from its artifacts, and a turn that
  // failed after the tokens moved has still moved them.
  const stdout = jsonl({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    result: 'something went wrong',
    total_cost_usd: 0.004,
    usage: { input_tokens: 700, output_tokens: 100 },
  });

  const turn = parseProbeTurn(stdout);

  assert.equal(turn.usage?.tokens.total, 800);
  assert.equal(turn.usage?.costUsd, 0.004);
});

// ---- Codex: the JSONL event stream -----------------------------------------

test('a codex probe stream reports usage the way a codex turn does', () => {
  const stdout = jsonl(
    { type: 'thread.started', thread_id: 'abc' },
    agentMessage(BLOCK),
    {
      type: 'turn.completed',
      usage: { input_tokens: 29_163, cached_input_tokens: 13_056, output_tokens: 59 },
    },
  );

  const stream = parseProbeStream(stdout);

  // Codex's nesting: cached is a subset of input, so the total is input+output.
  assert.equal(stream.tokens?.total, 29_222);
  assert.equal(stream.tokens?.cacheRead, 13_056);
});

test('a codex stream with no turn.completed reports no usage', () => {
  const stream = parseProbeStream(jsonl(agentMessage(BLOCK)));

  assert.equal(stream.tokens, null);
});

test('a codex stream marks partials and input strings, and keeps non-JSON lines', () => {
  const stdout = [
    'codex session id: 123',
    JSON.stringify({ type: 'item.updated', item: { text: 'half of ' } }),
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', command: 'echo hi', aggregated_output: 'hi' },
    }),
    '',
  ].join('\n');

  const stream = parseProbeStream(stdout);

  assert.equal(stream.plain, 'codex session id: 123');
  assert.ok(stream.strings.some((s) => s.value === 'half of ' && s.partial));
  assert.ok(stream.strings.some((s) => s.value === 'echo hi' && s.meta));
  // The envelope's own names are metadata too, or they would be spliced between
  // the fragments of a streamed reply.
  assert.ok(stream.strings.some((s) => s.value === 'command_execution' && s.meta));
  assert.ok(stream.strings.some((s) => s.value === 'hi' && !s.meta && !s.partial));
});

// ---- Codex: choosing which string holds the record --------------------------

/** What the adapter would go on to do with the selected string. */
function recordFrom(stdout: string, prompt = ''): string | null {
  const stream = parseProbeStream(stdout);
  return extractRecord(selectProbeTranscript(stream.strings, stream.plain, prompt));
}

test('an echo of the prompt does not beat the answer, though it holds both sentinels', () => {
  // renderProbePrompt names BEGIN and END in its own instructions, and
  // extractRecord takes the FIRST pair it finds - so an echoed prompt would
  // otherwise be parsed as the probe record and report a runtime nobody probed.
  const prompt = renderProbePrompt(CONTRACT);
  assert.ok(prompt.includes(BEGIN) && prompt.includes(END), 'the prompt names both sentinels');

  const stdout = jsonl(
    { type: 'item.completed', item: { type: 'user_message', text: prompt } },
    agentMessage(BLOCK),
  );

  assert.equal(recordFrom(stdout, prompt), RECORD);
});

test('a command that mentions the sentinels does not beat the answer', () => {
  const stdout = jsonl(
    {
      type: 'item.completed',
      item: { type: 'command_execution', command: `echo ${BEGIN} && echo ${END}`, aggregated_output: '' },
    },
    agentMessage(BLOCK),
  );

  assert.equal(recordFrom(stdout), RECORD);
});

test('a truncated earlier candidate does not beat the complete one', () => {
  const stdout = jsonl(
    agentMessage(`${BEGIN}\nshell=truncated`),
    agentMessage(BLOCK),
  );

  assert.equal(recordFrom(stdout), RECORD);
});

test('a streaming partial does not beat the completed item', () => {
  const stdout = jsonl(
    { type: 'item.updated', item: { type: 'agent_message', text: `${BEGIN}\nshell=partial\n${END}` } },
    agentMessage(BLOCK),
  );

  assert.equal(recordFrom(stdout), RECORD);
});

test('a block that only ever appears in a partial is still found', () => {
  const stdout = jsonl({ type: 'item.updated', item: { type: 'agent_message', text: BLOCK } });

  assert.equal(recordFrom(stdout), RECORD);
});

test('a block split across delta fragments is reassembled, not discarded', () => {
  // A stream that streams its reply is a legitimate stream: no single string
  // holds both sentinels, and dropping the fragments would fail a probe that
  // answered correctly.
  const stdout = jsonl(
    { type: 'item.output_text.delta', delta: `${BEGIN}\n` },
    { type: 'item.output_text.delta', delta: 'shell=powershell\n' },
    { type: 'item.output_text.delta', delta: 'uname=Windows\n' },
    { type: 'item.output_text.delta', delta: 'tool.node.exit=0\n' },
    { type: 'item.output_text.delta', delta: END },
  );

  assert.equal(recordFrom(stdout), RECORD);
});

test('a block split across line-wise fragments is reassembled too', () => {
  const stdout = jsonl(
    { type: 'item.updated', item: { text: BEGIN } },
    { type: 'item.updated', item: { text: 'shell=powershell' } },
    { type: 'item.updated', item: { text: 'uname=Windows' } },
    { type: 'item.updated', item: { text: 'tool.node.exit=0' } },
    { type: 'item.updated', item: { text: END } },
  );

  assert.equal(recordFrom(stdout), RECORD);
});

test('a stream with no block anywhere yields something extractRecord rejects', () => {
  // Which is what makes probeRuntime retry and then report a probe error, as it
  // does today for a turn that answered without the block.
  const stdout = jsonl(agentMessage('I could not run those commands.'));
  const stream = parseProbeStream(stdout);
  const text = selectProbeTranscript(stream.strings, stream.plain, '');

  assert.ok(text.includes('I could not run those commands.'));
  assert.equal(extractRecord(text), null);
});

test('plain output with a block still works, which is the rollback path', () => {
  // Dropping `--json` has to leave a working probe: nothing parses as JSON, so
  // the transcript is the raw stdout.
  const stdout = `here you go\n${BLOCK}\n`;

  assert.equal(recordFrom(stdout), RECORD);
});
