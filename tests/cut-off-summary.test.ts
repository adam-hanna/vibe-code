import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute } from '@src/cli.js';
import { DEFAULTS } from '@src/config.js';
import { EXIT } from '@src/orchestrator.js';
import { createRun, stageEvent } from '@src/run.js';
import type { Config, RunState } from '@src/types.js';

/**
 * The run summary says when a turn had to be retried after a cut-off, and says
 * nothing when none was (#416). Through `execute`, which prints what a user
 * actually sees, as `token-share.test.ts` reaches the same summary.
 */

function config(): Config {
  return {
    ...DEFAULTS,
    codex: { ...DEFAULTS.codex, readRateLimits: false },
    progress: { ...DEFAULTS.progress, enabled: false },
  };
}

function inMemory(): RunState {
  return createRun(mkdtempSync(path.join(tmpdir(), 'vibe-cutoff-summary-')), 'summary', true);
}

async function summaryLines(state: RunState): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  try {
    await execute(state, config(), false, true, () => Promise.resolve(EXIT.PREFLIGHT), () => Promise.resolve());
  } finally {
    console.log = original;
  }
  return lines;
}

test('one Retries line when a turn was retried after a cut-off', async () => {
  const state = inMemory();
  stageEvent(state, 'turn_retried', { label: 'critique-1', reason: 'max_output_tokens', attempt: 2 });
  stageEvent(state, 'turn_retried', { label: 'review-0', reason: 'max_output_tokens', attempt: 2 });
  const retries = (await summaryLines(state)).filter((l) => l.includes('Retries:'));
  assert.deepEqual(retries.length, 1);
  assert.match(retries[0] ?? '', /2 turn\(s\) retried after Codex's answer was cut off at its output limit/);
});

test('no Retries line when nothing was retried', async () => {
  const lines = await summaryLines(inMemory());
  assert.equal(lines.some((l) => l.includes('Retries:')), false);
});
