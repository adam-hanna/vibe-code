import { describe, expect, test } from 'vitest';
import { FENCE, UNNAMED, readEmitted, visible } from './emit';
import { execute } from './tools';
import { trailingResults } from './transcript';
import type { Message } from './pilot';

/**
 * The tool channel for a backend with no tool API (#211).
 *
 * This is the file where a bug would otherwise be invisible: the parse runs
 * against text a model wrote, and everything it produces is drawn as a card
 * somebody presses. `readEmitted` and `visible` are pure and this drives them
 * directly — a block in, a call out.
 *
 * The claim worth the most is the one about **failing closed in the direction
 * that costs nothing**. A block that cannot be read must never become a call
 * that looks fine; it becomes one that says it cannot be run, which the pane
 * already draws and the model is already told.
 */

const block = (body: string): string => ['```' + FENCE, body, '```'].join('\n');

describe('reading a call out of prose', () => {
  test('a well-formed block becomes the call a vendor would have streamed', () => {
    const text = [
      'I think this is ready. Here is what I would run:',
      '',
      block('{ "tool": "start_run", "input": { "task": "do it", "directory": "/r", "plan_only": true } }'),
      '',
      'Press it if you agree.',
    ].join('\n');

    const calls = readEmitted(text, 4);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('start_run');
    // The arguments are JSON text, exactly as a vendor streams them, so
    // `readCall` and `execute` below take the same path on both backends.
    expect(JSON.parse(calls[0]?.arguments ?? 'null')).toEqual({
      task: 'do it',
      directory: '/r',
      plan_only: true,
    });
  });

  test('the ids are unique within a turn and cannot collide with a vendor id', () => {
    // A reducer keyed on ids handed two calls sharing one would answer the
    // first and leave the second unanswered for ever, which is unsendable.
    const text = [block('{ "tool": "read_run" }'), block('{ "tool": "read_output" }')].join('\n\n');
    const ids = readEmitted(text, 7).map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^emit:7:/);
  });

  test('a tool with no arguments is not a broken call', () => {
    // `read_run` takes none, so the model writes no `input`. An empty argument
    // string is what `readCall` already treats as "a tool that takes no input".
    expect(readEmitted(block('{ "tool": "read_run" }'), 1)[0]?.arguments).toBe('');
  });

  test('a block that is not JSON is kept as a call that cannot be run', () => {
    // Kept rather than dropped. A model emits truncated JSON when a turn runs
    // out of room, and the only way it corrects itself is being told.
    const calls = readEmitted(block('{ "tool": "start_run", "input": {'), 1);
    expect(calls).toHaveLength(1);
    expect(JSON.parse.bind(JSON, calls[0]?.arguments ?? '')).toThrow();
  });

  test('a block that names no tool is refused by name, listing the ones that exist', () => {
    const calls = readEmitted(block('{ "input": { "task": "x" } }'), 1);
    expect(calls[0]?.name).toBe(UNNAMED);
    const settlement = execute(
      { name: calls[0]?.name ?? '', input: {}, unreadable: null },
      { run: {} as never },
    );
    expect(settlement.kind).toBe('refused');
    expect(settlement.kind === 'refused' && settlement.content).toContain('start_run');
  });

  test('an ordinary fenced code block is not a call', () => {
    // The whole reason the info string is specific. A pilot that explains a
    // snippet of JSON must not have that snippet run.
    const text = ['```json', '{ "tool": "start_run" }', '```'].join('\n');
    expect(readEmitted(text, 1)).toHaveLength(0);
  });

  test('an unterminated block is not a call', () => {
    // Half a call is not a call: a turn that ran out of room mid-block would
    // otherwise propose an argv that was still being written.
    expect(readEmitted('```' + FENCE + '\n{ "tool": "start_run"', 1)).toHaveLength(0);
  });
});

describe('what a person reads', () => {
  test('the block is taken out of the prose and the prose is kept', () => {
    const text = ['Here is the run.', '', block('{ "tool": "read_run" }'), '', 'Have a look.'].join(
      '\n',
    );
    // The blank lines the model left around the block are collapsed, so the
    // reply does not read as one with a hole in it.
    expect(visible(text)).toBe('Here is the run.\n\nHave a look.');
    expect(visible(text)).not.toContain('read_run');
  });

  test('a half-written block is hidden while it streams rather than spilling JSON', () => {
    const partial = 'One moment.\n\n```' + FENCE + '\n{ "tool": "start_ru';
    expect(visible(partial)).toBe('One moment.');
  });

  test('a reply that is only a call renders as nothing rather than as an empty card', () => {
    expect(visible(block('{ "tool": "read_run" }'))).toBe('');
  });
});

describe('answering a call on a backend with no tool role', () => {
  const tool = (id: string, name: string, content: string): Message => ({
    role: 'tool',
    id,
    name,
    content,
  });

  test('only the trailing results go back, because the rest were already sent', () => {
    const messages: readonly Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'first' },
      tool('a', 'read_run', 'OLD'),
      { role: 'assistant', content: 'second' },
      tool('b', 'read_output', 'NEW'),
    ];
    const sent = trailingResults(messages);
    expect(sent).toContain('NEW');
    // Re-sending it would have the model answer results it has already acted on.
    expect(sent).not.toContain('OLD');
    expect(sent).toContain('read_output');
  });

  test('a conversation that does not end in results has nothing to send', () => {
    // Which is the case where no turn should be taken at all — the empty prompt
    // that used to be sent instead asked the model to answer nothing.
    expect(trailingResults([{ role: 'user', content: 'hi' }])).toBeNull();
    expect(trailingResults([])).toBeNull();
  });
});
