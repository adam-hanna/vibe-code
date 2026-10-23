import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OutputCutOffError } from '@src/codex.js';
import { collapseEscapedBlankRuns } from '@src/cutoff.js';
import type { CodexTurnOptions } from '@src/codex.js';
import type { RunFn, RunResult } from '@src/proc.js';
import { codexTurnNoMcp as codexTurn } from './helpers/codex-mcp.js';

/**
 * A Codex answer cut off at its output limit is told apart from every other
 * failure, and says what happened in a size a person can read (#416).
 *
 * Driven through the real adapter with `exec` injected, as
 * `adapter-boundary.test.ts` is. The streams are the shape of the #389 failure:
 * an `agent_message` of JSON followed by blank space, an `error` and a
 * `turn.failed` naming `max_output_tokens`, no `turn.completed`, no out file.
 */
process.env['VIBE_CODEX_BIN'] = process.execPath;

function stream(lines: readonly string[]): RunFn {
  return (_bin, _args, options): Promise<RunResult> => {
    for (const line of lines) options?.onLine?.(line);
    return Promise.resolve({
      code: 1,
      signal: null,
      stdout: lines.map((line) => `${line}\n`).join(''),
      stderr: '',
    });
  };
}

function options(dir: string): CodexTurnOptions {
  return {
    prompt: 'critique this',
    schema: { type: 'object' },
    schemaName: 'critique-1',
    artifactDir: dir,
    model: 'fixture-model',
    effort: 'low',
    sandbox: 'read-only',
    cwd: process.cwd(),
    timeoutMs: 1_000,
  };
}

const FINDING =
  '{"id":"one","severity":"P1","title":"t","detail":"d","suggested_fix":"f","defer":false,' +
  '"evidence":[{"kind":"external","path":null,"line":null,"excerpt":null,"ref":"x"}]';
const JSON_PART = `{"verdict":"REVISE","summary":"three findings","findings":[${FINDING},"reproducer":null},`;
const BLANK = ' '.repeat(50_000);

const CUT_OFF = 'Incomplete response returned, reason: max_output_tokens';
const message = (text: string): string =>
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });

test('a stream cut off at max_output_tokens gives OutputCutOffError with the text and its counts', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-cut-off-'));
  const text = JSON_PART + BLANK;
  const err: unknown = await codexTurn(
    options(dir),
    stream([
      message(text),
      JSON.stringify({ type: 'error', message: CUT_OFF }),
      JSON.stringify({ type: 'turn.failed', error: { message: CUT_OFF } }),
    ]),
  ).then(
    () => assert.fail('a cut-off turn must not succeed'),
    (e: unknown) => e,
  );

  assert.ok(err instanceof OutputCutOffError, `expected OutputCutOffError, got ${String(err)}`);
  assert.equal(err.text, text);
  assert.equal(err.chars, text.length);
  assert.equal(err.blankChars, 50_000);
  assert.equal(err.reported, false, 'the stream carried no turn.completed usage');
  assert.equal(err.findings.length, 1);
  assert.match(err.message, /cut off at its output limit after [\d,]+ characters of JSON, then 50,000 characters/);
  assert.ok(err.message.length < 4_000, `the message must be short, was ${err.message.length}`);
  assert.ok(!/ {1000}/.test(err.message), 'no blank run reaches the message');

  const kept = path.join(dir, 'critique-1.cutoff.json');
  assert.ok(existsSync(kept));
  const record = JSON.parse(readFileSync(kept, 'utf8')) as Record<string, unknown>;
  assert.equal(record['reason'], 'max_output_tokens');
  assert.equal(record['chars'], text.length);
  assert.equal(record['blankChars'], 50_000);
  assert.equal((record['findings'] as unknown[]).length, 1);
  assert.equal(record['text'], `${JSON_PART}<… 50,000 blank characters …>`);
});

test('a cut-off whose stream carried no message is still a cut-off, with nothing salvaged', async () => {
  // Classified on Codex's reason alone: a missing message leaves nothing to
  // salvage, not a different kind of failure.
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-cut-off-'));
  const err: unknown = await codexTurn(
    options(dir),
    stream([JSON.stringify({ type: 'turn.failed', error: { message: CUT_OFF } })]),
  ).then(
    () => assert.fail('a cut-off turn must not succeed'),
    (e: unknown) => e,
  );
  assert.ok(err instanceof OutputCutOffError);
  assert.equal(err.text, '');
  // Absent, not zero: no message arrived, so nothing was counted (#416).
  assert.equal(err.chars, null);
  assert.equal(err.blankChars, null);
  assert.deepEqual(err.findings, []);
  assert.match(err.message, /cut off at its output limit before its final message arrived/);
  assert.match(err.message, /It wrote no message\./);
  assert.doesNotMatch(err.message, /\b0 characters/);
  const record = JSON.parse(readFileSync(path.join(dir, 'critique-1.cutoff.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(record['chars'], null);
  assert.equal(record['blankChars'], null);
  assert.equal(record['text'], null);
});

test('an earlier message followed by more work is not counted as the cut-off answer', async () => {
  // The final message never completed: the last completed message is a note
  // from before a command ran, and quoting its length as "characters of JSON"
  // would describe the wrong message. Nothing is counted or salvaged from it.
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-cut-off-'));
  const earlier = JSON_PART + '"reproducer":null}]}';
  const err: unknown = await codexTurn(
    options(dir),
    stream([
      JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: earlier } }),
      JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'ls' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'ls' } }),
      JSON.stringify({ type: 'error', message: CUT_OFF }),
      JSON.stringify({ type: 'turn.failed', error: { message: CUT_OFF } }),
    ]),
  ).then(
    () => assert.fail('a cut-off turn must not succeed'),
    (e: unknown) => e,
  );
  assert.ok(err instanceof OutputCutOffError);
  assert.equal(err.chars, null);
  assert.equal(err.blankChars, null);
  assert.equal(err.text, '');
  assert.deepEqual(err.findings, [], 'nothing is salvaged from a message that was not the answer');
  assert.match(err.message, /before its final message arrived/);
  assert.match(err.message, /followed by more work, so it was not the answer/);
  assert.doesNotMatch(err.message, /characters of JSON/);
  assert.ok(!err.message.includes('three findings'), 'the earlier message is not quoted as the ending');
});

test('a message followed only by the start of another message is not the answer either', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-cut-off-'));
  const err: unknown = await codexTurn(
    options(dir),
    stream([
      JSON.stringify({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Looking.' } }),
      JSON.stringify({ type: 'item.started', item: { id: 'item_1', type: 'agent_message', text: '' } }),
      JSON.stringify({ type: 'turn.failed', error: { message: CUT_OFF } }),
    ]),
  ).then(
    () => assert.fail('a cut-off turn must not succeed'),
    (e: unknown) => e,
  );
  assert.ok(err instanceof OutputCutOffError);
  assert.equal(err.chars, null);
});

test('the final message is still the answer when updates of that same message precede its completion', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-cut-off-'));
  const text = JSON_PART + BLANK;
  const err: unknown = await codexTurn(
    options(dir),
    stream([
      JSON.stringify({ type: 'item.started', item: { id: 'item_3', type: 'agent_message', text: '' } }),
      JSON.stringify({ type: 'item.updated', item: { id: 'item_3', type: 'agent_message', text: '{' } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text } }),
      JSON.stringify({ type: 'turn.failed', error: { message: CUT_OFF } }),
    ]),
  ).then(
    () => assert.fail('a cut-off turn must not succeed'),
    (e: unknown) => e,
  );
  assert.ok(err instanceof OutputCutOffError);
  assert.equal(err.chars, text.length);
  assert.equal(err.blankChars, 50_000);
});

test('a second cut-off of the same label keeps its own record beside the first', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-cut-off-'));
  const cutOffWith = (text: string): Promise<unknown> =>
    codexTurn(
      options(dir),
      stream([message(text), JSON.stringify({ type: 'turn.failed', error: { message: CUT_OFF } })]),
    ).then(
      () => assert.fail('a cut-off turn must not succeed'),
      (e: unknown) => e,
    );
  const first = await cutOffWith(`{"verdict":"REVISE","summary":"first"${BLANK}`);
  const second = await cutOffWith(`{"verdict":"REVISE","summary":"second"${BLANK}`);

  assert.ok(first instanceof OutputCutOffError && second instanceof OutputCutOffError);
  assert.equal(first.keptAt, path.join(dir, 'critique-1.cutoff.json'));
  assert.equal(second.keptAt, path.join(dir, 'critique-1.cutoff-2.json'));
  const read = (name: string): string =>
    String((JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as Record<string, unknown>)['text']);
  assert.match(read('critique-1.cutoff.json'), /"first"/, 'the first record is not overwritten');
  assert.match(read('critique-1.cutoff-2.json'), /"second"/);
});

test('a turn.failed for a bad model name stays a plain Error', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-cut-off-'));
  const err: unknown = await codexTurn(
    options(dir),
    stream([
      JSON.stringify({ type: 'turn.failed', error: { message: "The model 'gpt-nope' does not exist" } }),
    ]),
  ).then(
    () => assert.fail('a failed turn must not succeed'),
    (e: unknown) => e,
  );
  assert.ok(err instanceof Error);
  assert.ok(!(err instanceof OutputCutOffError));
  assert.match(err.message, /codex wrote no structured output/);
  assert.equal(existsSync(path.join(dir, 'critique-1.cutoff.json')), false);
});

test("a plain failure's stdout tail is collapsed rather than a tail of blank space", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-cut-off-'));
  const err: unknown = await codexTurn(
    options(dir),
    stream([message(`{"verdict":${' '.repeat(20_000)}`), JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } })]),
  ).then(
    () => assert.fail('a failed turn must not succeed'),
    (e: unknown) => e,
  );
  assert.ok(err instanceof Error && !(err instanceof OutputCutOffError));
  assert.match(err.message, /<… 20,000 blank characters …>/);
});

test('escaped blank runs in the JSONL stream are collapsed, counted as the characters they encode (#429)', () => {
  // In the stream a message's newlines are the two characters `\n`, so the #389
  // stall of newlines and `\r ` pairs never makes a literal run.
  const stalled = JSON.stringify({ text: `{"verdict":${'\n\r '.repeat(500)}` });
  assert.equal(collapseEscapedBlankRuns(stalled), '{"text":"{\\"verdict\\":<… 1,500 blank characters …>"}');
  // Below the threshold, and real indentation, are left alone.
  const indented = JSON.stringify({ excerpt: `if (a) {\n${' '.repeat(25)}return b;` });
  assert.equal(collapseEscapedBlankRuns(indented), indented);
  const short = JSON.stringify({ text: '\n'.repeat(999) });
  assert.equal(collapseEscapedBlankRuns(short), short);
  // An escaped backslash followed by `n` is a backslash and a letter, not a newline.
  const backslashes = JSON.stringify({ text: '\\n'.repeat(2_000) });
  assert.equal(collapseEscapedBlankRuns(backslashes), backslashes);
  // Literal runs are still collapsed, as `collapseBlankRuns` does.
  assert.equal(collapseEscapedBlankRuns(`a${' '.repeat(1_000)}b`), 'a<… 1,000 blank characters …>b');
});

test("a plain failure's stdout tail collapses a stall of escaped newlines (#429)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-cut-off-'));
  const err: unknown = await codexTurn(
    options(dir),
    stream([
      message(`{"verdict":${'\n\r '.repeat(40_000)}`),
      JSON.stringify({ type: 'turn.failed', error: { message: 'boom' } }),
    ]),
  ).then(
    () => assert.fail('a failed turn must not succeed'),
    (e: unknown) => e,
  );
  assert.ok(err instanceof Error && !(err instanceof OutputCutOffError));
  assert.match(err.message, /<… 120,000 blank characters …>/);
  assert.ok(err.message.includes('"turn.failed"'), 'the tail reaches the line after the stall');
});

test('a parsed answer keeps every blank character an excerpt quotes, escaped or not (#429)', async () => {
  // The collapse is for error text only. An accepted turn's output, and the raw
  // text beside it, are what the model wrote, including a whitespace run far
  // longer than the collapse threshold.
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-cut-off-'));
  const excerpt = `if (a) {\n${' '.repeat(25)}return b;\n}${'\n'.repeat(1_500)}${' '.repeat(1_500)}// end`;
  const answer = {
    verdict: 'REVISE',
    summary: 's',
    findings: [{ evidence: [{ kind: 'code', ref: null, path: 'src/x.ts', line: 1, excerpt }] }],
  };
  const written = JSON.stringify(answer);
  const lines = [message(written), JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } })];
  const result = await codexTurn(options(dir), (_bin, _args, opts): Promise<RunResult> => {
    for (const line of lines) opts?.onLine?.(line);
    writeFileSync(path.join(dir, 'critique-1.out.json'), written, 'utf8');
    return Promise.resolve({ code: 0, signal: null, stdout: lines.map((l) => `${l}\n`).join(''), stderr: '' });
  });
  assert.equal(result.raw, written);
  assert.deepEqual(result.structured, answer);
});
