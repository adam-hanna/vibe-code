import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OutputCutOffError } from '@src/codex.js';
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
  assert.equal(err.chars, 0);
  assert.equal(err.blankChars, 0);
  assert.deepEqual(err.findings, []);
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
