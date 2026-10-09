import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codexTurnNoMcp } from './helpers/codex-mcp.js';
import type { CodexTurnOptions } from '@src/codex.js';
import type { RunFn } from '@src/proc.js';
import {
  createHeartbeat,
  emptySnapshot,
  KNOWN_CODEX_ITEMS,
  noteCodexItems,
  parseCodexLine,
  resetUnrecognisedCodexItems,
} from '@src/progress.js';
import type { RepeatingTimer, TimerApi } from '@src/progress.js';
import { setSink } from '@src/log.js';
import type { Narration } from '@src/log.js';

/**
 * An unrecognised Codex item type warns once per run and never fails a turn
 * (#298). Codex adds item kinds as it grows; refusing one would break runs that
 * would have worked.
 *
 * Collected by `parseCodexLine` and said from `onLine` as the line arrives, so
 * a turn stopped, timed out or thrown a moment later has still said it. A turn
 * with progress off has no heartbeat, and gets `watchCodexItems` as its line
 * handler for the same reason.
 */

process.env['VIBE_CODEX_BIN'] = process.execPath;

const item = (type: string): string => JSON.stringify({ type: 'item.completed', item: { id: 'i', type } });

const idleTimers: TimerApi = {
  repeat: (): RepeatingTimer => ({ unref: () => {}, cancel: () => {} }),
};

function capture<T>(fn: () => T): { result: T; warned: Narration[] } {
  const seen: Narration[] = [];
  setSink((n) => seen.push(n));
  try {
    return { result: fn(), warned: seen.filter((n) => n.id === 'codex_item_unrecognised') };
  } finally {
    setSink(null);
  }
}

async function captureAsync(fn: () => Promise<unknown>): Promise<Narration[]> {
  const seen: Narration[] = [];
  setSink((n) => seen.push(n));
  try {
    await fn().catch(() => undefined);
  } finally {
    setSink(null);
  }
  return seen.filter((n) => n.id === 'codex_item_unrecognised');
}

test('parseCodexLine collects an unrecognised completed item type, and no known one', () => {
  const snapshot = emptySnapshot();
  for (const line of [
    item('command_execution'),
    item('mystery_item'),
    item('agent_message'),
    JSON.stringify({ type: 'item.started', item: { type: 'started_only' } }),
  ]) {
    parseCodexLine(snapshot, line);
  }
  assert.deepEqual(snapshot.unrecognised, ['mystery_item']);
});

test('every kind the code already names is known', () => {
  for (const kind of ['agent_message', 'reasoning', 'command_execution', 'web_search', 'file_change']) {
    assert.ok(KNOWN_CODEX_ITEMS.has(kind), kind);
  }
});

test('through the heartbeat, the warning fires once per run per type, naming both versions', () => {
  resetUnrecognisedCodexItems('0.160.0');
  const { warned } = capture(() => {
    for (const label of ['review-0', 'review-1']) {
      const beat = createHeartbeat({ label, intervalMs: 30_000, timers: idleTimers, parse: parseCodexLine, unit: 'event', provider: 'codex' });
      beat.onLine(item('mystery_item'));
      beat.onLine(item('mystery_item'));
      beat.stop();
    }
  });
  assert.equal(warned.length, 1);
  assert.equal(warned[0]?.level, 'warn');
  assert.match(warned[0]?.message ?? '', /"mystery_item"/);
  assert.match(warned[0]?.message ?? '', /codex 0\.160\.0 installed, tested with 0\.157\.1/);
  assert.deepEqual(warned[0]?.data, { type: 'mystery_item', installed: '0.160.0', tested: '0.157.1' });

  // A new run warns again.
  resetUnrecognisedCodexItems(null);
  const again = capture(() => noteCodexItems(['mystery_item']));
  assert.equal(again.warned.length, 1);
  assert.match(again.warned[0]?.message ?? '', /version unknown/);
  resetUnrecognisedCodexItems(null);
});

test('a known item type never warns', () => {
  resetUnrecognisedCodexItems('0.157.1');
  const { warned } = capture(() => {
    const beat = createHeartbeat({ label: 'x', intervalMs: 30_000, timers: idleTimers, parse: parseCodexLine, unit: 'event', provider: 'codex' });
    beat.onLine(item('reasoning'));
    beat.onLine(item('file_change'));
    beat.stop();
  });
  assert.equal(warned.length, 0);
  resetUnrecognisedCodexItems(null);
});

function options(dir: string, progress: boolean): CodexTurnOptions {
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
    ...(progress ? { progress: { label: 'review-0', intervalMs: 30_000, timers: idleTimers } } : {}),
  };
}

const LINES = [
  JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
  item('mystery_item'),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } }),
];

for (const progress of [true, false]) {
  const how = progress ? 'with progress on' : 'with progress off';

  test(`a turn ${how} warns, and the turn is not failed`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'vibe-codex-unknown-'));
    const exec: RunFn = (_bin, _args, runOptions) => {
      for (const line of LINES) runOptions?.onLine?.(line);
      writeFileSync(path.join(dir, 'review-0.out.json'), '{"findings":[]}', 'utf8');
      return Promise.resolve({ code: 0, signal: null, stdout: LINES.join('\n'), stderr: '' });
    };
    resetUnrecognisedCodexItems('0.157.1');
    let structured: unknown = null;
    const warned = await captureAsync(async () => {
      structured = (await codexTurnNoMcp(options(dir, progress), exec)).structured;
    });
    resetUnrecognisedCodexItems(null);
    assert.deepEqual(structured, { findings: [] });
    assert.equal(warned.length, 1);
  });

  test(`a turn ${how} that is killed after the item still warned about it`, async () => {
    // The reviewer's case: the item streamed, then the child was stopped, timed
    // out or threw, so nothing after `exec` ran. The warning was already said.
    const dir = mkdtempSync(path.join(tmpdir(), 'vibe-codex-unknown-'));
    const exec: RunFn = (_bin, _args, runOptions) => {
      for (const line of LINES.slice(0, 2)) runOptions?.onLine?.(line);
      return Promise.reject(new Error('codex timed out after 1000ms'));
    };
    resetUnrecognisedCodexItems('0.157.1');
    const warned = await captureAsync(() => codexTurnNoMcp(options(dir, progress), exec));
    resetUnrecognisedCodexItems(null);
    assert.equal(warned.length, 1);
    assert.match(warned[0]?.message ?? '', /"mystery_item"/);
  });
}
