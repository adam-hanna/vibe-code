import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexTurnNoMcp } from './helpers/codex-mcp.js';
import type { RunFn } from '@src/proc.js';
import { noteCodexItems, parseEvents, resetUnrecognisedCodexItems } from '@src/codex.js';
import { KNOWN_CODEX_ITEMS } from '@src/progress.js';
import { setSink } from '@src/log.js';
import type { Narration } from '@src/log.js';

/**
 * An unrecognised Codex item type warns once per run and never fails a turn
 * (#298). Codex adds item kinds as it grows; refusing one would break runs that
 * would have worked.
 *
 * Collected by `parseEvents` rather than by the heartbeat's parser, because
 * `parseEvents` reads every turn's stdout whether progress is on or not - a
 * `--no-progress` run has no heartbeat, and would otherwise never warn.
 */

process.env['VIBE_CODEX_BIN'] = process.execPath;

const item = (type: string): string => JSON.stringify({ type: 'item.completed', item: { id: 'i', type } });

function capture(fn: () => void): Narration[] {
  const seen: Narration[] = [];
  setSink((n) => seen.push(n));
  try {
    fn();
  } finally {
    setSink(null);
  }
  return seen.filter((n) => n.id === 'codex_item_unrecognised');
}

test('parseEvents collects each unrecognised item type once, and no known one', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 't' }),
    item('command_execution'),
    item('mystery_item'),
    item('agent_message'),
    item('mystery_item'),
    item('another_new_kind'),
    JSON.stringify({ type: 'item.started', item: { type: 'started_only' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } }),
  ].join('\n');
  const events = parseEvents(stdout);
  assert.deepEqual(events.unrecognised, ['mystery_item', 'another_new_kind']);
  assert.equal(events.threadId, 't');
  assert.equal(events.failed, false);
});

test('every kind the code already names is known', () => {
  for (const kind of ['agent_message', 'reasoning', 'command_execution', 'web_search', 'file_change']) {
    assert.ok(KNOWN_CODEX_ITEMS.has(kind), kind);
  }
});

test('the warning fires once per run per type, naming the installed and tested versions', () => {
  resetUnrecognisedCodexItems('0.160.0');
  const first = capture(() => {
    noteCodexItems(parseEvents(item('mystery_item')).unrecognised);
    noteCodexItems(parseEvents([item('mystery_item'), item('mystery_item')].join('\n')).unrecognised);
  });
  assert.equal(first.length, 1);
  assert.equal(first[0]?.level, 'warn');
  assert.match(first[0]?.message ?? '', /"mystery_item"/);
  assert.match(first[0]?.message ?? '', /codex 0\.160\.0 installed, tested with 0\.157\.1/);
  assert.deepEqual(first[0]?.data, { type: 'mystery_item', installed: '0.160.0', tested: '0.157.1' });

  // A new run warns again.
  resetUnrecognisedCodexItems(null);
  const second = capture(() => noteCodexItems(['mystery_item']));
  assert.equal(second.length, 1);
  assert.match(second[0]?.message ?? '', /version unknown/);
  resetUnrecognisedCodexItems(null);
});

test('a known item type never warns', () => {
  resetUnrecognisedCodexItems('0.157.1');
  const seen = capture(() => noteCodexItems(parseEvents([item('reasoning'), item('file_change')].join('\n')).unrecognised));
  assert.equal(seen.length, 0);
  resetUnrecognisedCodexItems(null);
});

test('a turn with progress off still warns, and the turn is not failed', async () => {
  // The reviewer's case: `--no-progress` means no heartbeat and no `onLine`, so
  // a warning collected only by the heartbeat's parser would never be said.
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-codex-unknown-'));
  const lines = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    item('mystery_item'),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } }),
  ];
  const exec: RunFn = () => {
    writeFileSync(path.join(dir, 'review-0.out.json'), '{"findings":[]}', 'utf8');
    return Promise.resolve({ code: 0, signal: null, stdout: lines.join('\n'), stderr: '' });
  };
  resetUnrecognisedCodexItems('0.157.1');
  const seen: Narration[] = [];
  setSink((n) => seen.push(n));
  try {
    const result = await codexTurnNoMcp(
      {
        prompt: 'review this',
        schema: { type: 'object' },
        schemaName: 'review-0',
        artifactDir: dir,
        model: 'fixture-model',
        effort: 'low',
        sandbox: 'read-only',
        cwd: process.cwd(),
        timeoutMs: 1_000,
      },
      exec,
    );
    assert.deepEqual(result.structured, { findings: [] });
    assert.equal(result.sessionId, 'thread-1');
  } finally {
    setSink(null);
    resetUnrecognisedCodexItems(null);
  }
  assert.equal(seen.filter((n) => n.id === 'codex_item_unrecognised').length, 1);
});
