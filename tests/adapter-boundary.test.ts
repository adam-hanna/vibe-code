import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeTurn } from '@src/claude.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import { codexTurn } from '@src/codex.js';
import type { CodexTurnOptions } from '@src/codex.js';
import type { ActivityObservation, ProgressOptions, RepeatingTimer, TimerApi } from '@src/progress.js';
import type { RunFn, RunResult } from '@src/proc.js';

/**
 * The adapter/heartbeat boundary, driven through the real adapters.
 *
 * Nothing is spawned: `exec` is injected, and the bin overrides only exist so
 * `resolveBin` succeeds on a machine where neither CLI is installed. Spawning
 * `claude` or `codex` needs a logged-in account and costs money per case.
 */
process.env['VIBE_CLAUDE_BIN'] = process.execPath;
process.env['VIBE_CODEX_BIN'] = process.execPath;

/** A timer that never fires: these cases are about the boundary, not cadence. */
const idleTimers: TimerApi = {
  repeat: (): RepeatingTimer => ({ unref: () => {}, cancel: () => {} }),
};

function progressRecorder(): { options: ProgressOptions; sources: string[] } {
  const sources: string[] = [];
  return {
    sources,
    options: {
      label: 'fixture',
      intervalMs: 30_000,
      onActivity: (observation: ActivityObservation) => sources.push(observation.source),
      timers: idleTimers,
    },
  };
}

/**
 * A child that emitted `lines`, optionally did something on the way out, and
 * exited with `code`.
 *
 * The line hook is driven here because `run` is its only production caller.
 * Without it there would be no line for `flush` to persist, and every assertion
 * about flushing would pass vacuously.
 */
function fakeExec(code: number | null, lines: readonly string[], after?: () => void): RunFn {
  return (_bin, _args, options): Promise<RunResult> => {
    for (const line of lines) options?.onLine?.(line);
    after?.();
    return Promise.resolve({ code, stdout: lines.map((line) => `${line}\n`).join(''), stderr: '' });
  };
}

const ASSISTANT = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.ts' } }] },
});
const SUCCESS = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'done',
  session_id: 'fixture-session',
  total_cost_usd: 0.02,
  num_turns: 1,
});

function claudeOptions(progress: ProgressOptions): ClaudeTurnOptions {
  return {
    prompt: 'hello',
    sessionId: 'fixture-session',
    resume: false,
    permissionMode: 'plan',
    model: 'fixture-model',
    effort: 'low',
    cwd: process.cwd(),
    timeoutMs: 1_000,
    progress,
  };
}

test('claude: output that fails validation is not flushed as a completed turn', async () => {
  const { options, sources } = progressRecorder();

  await assert.rejects(
    () => claudeTurn(claudeOptions(options), fakeExec(0, [ASSISTANT])),
    /no result event/,
  );

  assert.ok(sources.includes('start'));
  assert.ok(sources.includes('stdout'));
  assert.ok(!sources.includes('final'), 'a rejected turn must not record completion');
});

test('claude: an accepted turn flushes', async () => {
  const { options, sources } = progressRecorder();

  const result = await claudeTurn(claudeOptions(options), fakeExec(0, [ASSISTANT, SUCCESS]));

  assert.equal(result.text, 'done');
  assert.ok(sources.includes('final'));
});

test('claude: a non-zero exit with a complete successful result is accepted', async () => {
  // The payload is the verdict: the result envelope carries the cost and usage
  // the run depends on, so a bad exit after it is teardown, not a failed turn.
  const { options, sources } = progressRecorder();

  const result = await claudeTurn(claudeOptions(options), fakeExec(1, [ASSISTANT, SUCCESS]));

  assert.equal(result.text, 'done');
  assert.ok(sources.includes('final'));
});

test('claude: a non-zero exit with unusable output still fails and does not flush', async () => {
  const { options, sources } = progressRecorder();

  await assert.rejects(
    () => claudeTurn(claudeOptions(options), fakeExec(1, [ASSISTANT])),
    /no result event/,
  );

  assert.ok(!sources.includes('final'));
});

const CODEX_ITEM = JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } });
const TURN_FAILED = JSON.stringify({
  type: 'turn.failed',
  error: { message: 'the model refused the request' },
});

function codexDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'vibe-codex-boundary-'));
}

function codexOptions(dir: string, progress: ProgressOptions): CodexTurnOptions {
  return {
    prompt: 'review this',
    schema: { type: 'object' },
    schemaName: 'review-0',
    artifactDir: dir,
    model: 'fixture-model',
    effort: 'low',
    sandbox: 'read-only',
    cwd: process.cwd(),
    timeoutMs: 1_000,
    progress,
  };
}

const outPath = (dir: string): string => path.join(dir, 'review-0.out.json');

test('codex: a turn that wrote no structured output is not flushed', async () => {
  const dir = codexDir();
  const { options, sources } = progressRecorder();

  await assert.rejects(
    () => codexTurn(codexOptions(dir, options), fakeExec(0, [CODEX_ITEM])),
    /wrote no structured output/,
  );

  assert.ok(sources.includes('start'));
  assert.ok(!sources.includes('final'));
});

test('codex: a turn whose output file parses flushes', async () => {
  const dir = codexDir();
  const { options, sources } = progressRecorder();

  const result = await codexTurn(
    codexOptions(dir, options),
    fakeExec(0, [CODEX_ITEM], () => {
      writeFileSync(outPath(dir), '{"findings":[]}', 'utf8');
    }),
  );

  assert.deepEqual(result.structured, { findings: [] });
  assert.ok(sources.includes('final'));
});

test('codex: a non-zero exit whose output file parses is accepted', async () => {
  const dir = codexDir();
  const { options, sources } = progressRecorder();

  const result = await codexTurn(
    codexOptions(dir, options),
    fakeExec(1, [CODEX_ITEM], () => {
      writeFileSync(outPath(dir), '{"findings":[]}', 'utf8');
    }),
  );

  assert.deepEqual(result.structured, { findings: [] });
  assert.ok(sources.includes('final'));
});

test('codex: a non-zero exit with no output file fails and does not flush', async () => {
  const dir = codexDir();
  const { options, sources } = progressRecorder();

  await assert.rejects(
    () => codexTurn(codexOptions(dir, options), fakeExec(1, [CODEX_ITEM])),
    /wrote no structured output/,
  );

  assert.ok(!sources.includes('final'));
});

test('codex: a previous attempt output file is not accepted as this turn result', async () => {
  // Schema names are per-round and withRateLimitRetry reuses them, so an
  // abandoned attempt's file sat exactly where this turn's would be.
  const dir = codexDir();
  writeFileSync(outPath(dir), '{"findings":["from the previous attempt"]}', 'utf8');
  const { options, sources } = progressRecorder();

  await assert.rejects(
    () => codexTurn(codexOptions(dir, options), fakeExec(0, [CODEX_ITEM])),
    /wrote no structured output/,
  );

  assert.equal(existsSync(outPath(dir)), false, 'the stale file is moved before the child runs');
  // Kept, because nothing else persists a rejected turn's raw output: the
  // attempt that went wrong would otherwise be the one with no evidence left.
  assert.equal(
    readFileSync(path.join(dir, 'review-0.superseded.json'), 'utf8'),
    '{"findings":["from the previous attempt"]}',
  );
  assert.ok(!sources.includes('final'));
});

test('codex: an explicit turn.failed is not accepted even with an output file', async () => {
  // Codex's own verdict on the turn. A file beside it is a partial write or an
  // earlier phase of the same turn, and handing it to the loop would present a
  // result the agent said was not one. Exit status cannot catch this: a failed
  // turn can still exit 0.
  const dir = codexDir();
  const { options, sources } = progressRecorder();

  await assert.rejects(
    () =>
      codexTurn(
        codexOptions(dir, options),
        fakeExec(0, [CODEX_ITEM, TURN_FAILED], () => {
          writeFileSync(outPath(dir), '{"findings":[]}', 'utf8');
        }),
      ),
    /reported the turn failed/,
  );

  assert.ok(!sources.includes('final'));
});

test('codex: the schema file is still written for the child to read', async () => {
  const dir = codexDir();
  const { options } = progressRecorder();

  await assert.rejects(() => codexTurn(codexOptions(dir, options), fakeExec(0, [])));

  const schema = JSON.parse(readFileSync(path.join(dir, 'review-0.schema.json'), 'utf8')) as unknown;
  assert.deepEqual(schema, { type: 'object' });
});
