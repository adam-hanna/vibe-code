import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { orchestrate } from '@src/orchestrator.js';
import * as log from '@src/log.js';
import { forkedSlotFields } from '@src/slots.js';
import { agents, config, freshRun, p1, planFixture, report, work } from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { Config, RunState } from '@src/types.js';

/**
 * The default table, pinned whole across #490.
 *
 * #490 gives a Claude reviewer a conversation of its own. The default table
 * seats the reviewer on Codex, so nothing about a default run may move: every
 * label dispatched, every prompt sent, the conversation fields `state.json`
 * holds (with their values) and the artifacts the rounds write.
 *
 * The expected record is `tests/fixtures/claude-reviewer-session/default-table.json`.
 * Nothing rewrites it but `VIBE_RECORD_PIN=1`, which is how it was made, on
 * 1ce6344 - before the change it guards. To see it pass on the old code, copy
 * this file and that directory into a checkout of 1ce6344 and run it there.
 *
 * Normalized, and nothing else: the run's directory, target directory and id,
 * a git object name, and a UUID (the `main` session id is minted at random).
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '..', '..', 'tests', 'fixtures', 'claude-reviewer-session');

/** Every conversation field a run's state can carry, the new slot's included. */
const SLOT_FIELD = /session|context|thread|fork|handoff/i;

interface Pinned {
  calls: string[];
  prompts: [string, string][];
  slotFields: Record<string, unknown>;
  artifacts: Record<string, string>;
}

function normal(state: RunState, text: string): string {
  return text
    .split(state.dir)
    .join('<dir>')
    .split(state.targetDir)
    .join('<target>')
    .split(state.id)
    .join('<id>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>')
    .replace(/\b[0-9a-f]{40}\b/g, '<sha>')
    .replace(/\b[0-9a-f]{7}\b/g, '<short-sha>');
}

async function drive(state: RunState, cfg: Config, files: readonly string[]): Promise<Pinned> {
  const calls: string[] = [];
  const prompts: [string, string][] = [];
  const handlers: Handlers = {
    claude: (label, options) => {
      prompts.push([label, normal(state, options.prompt)]);
      if (label === 'plan' || label.startsWith('revise-')) return planFixture();
      return work(state, `${label}.txt`);
    },
    codex: (label, options) => {
      prompts.push([label, normal(state, options.prompt)]);
      return label === 'review-0' ? report([p1('pinned-blocker')]) : report([]);
    },
  };
  log.setSink(() => undefined);
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(state, cfg, false, agents(handlers, calls));
  } finally {
    log.setSink(null);
    console.log = originalLog;
    console.error = originalError;
  }
  const saved = JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as Record<string, unknown>;
  const slotFields: Record<string, unknown> = {};
  for (const key of Object.keys(saved).sort()) {
    if (SLOT_FIELD.test(key)) slotFields[key] = JSON.parse(normal(state, JSON.stringify(saved[key]) ?? 'null')) as unknown;
  }
  const artifacts: Record<string, string> = {};
  for (const name of files) {
    const at = path.join(state.dir, name);
    artifacts[name] = existsSync(at) ? normal(state, readFileSync(at, 'utf8')) : '<absent>';
  }
  return { calls, prompts, slotFields, artifacts };
}

function pinned(name: string, got: Pinned): void {
  const file = path.join(fixtures, `${name}.json`);
  if (process.env['VIBE_RECORD_PIN'] === '1') {
    mkdirSync(fixtures, { recursive: true });
    writeFileSync(file, `${JSON.stringify(got, null, 2)}\n`, 'utf8');
    return;
  }
  const want = JSON.parse(readFileSync(file, 'utf8')) as Pinned;
  assert.deepEqual(got.calls, want.calls, 'the labels dispatched moved');
  assert.deepEqual(got.prompts, want.prompts, 'a prompt moved');
  assert.deepEqual(got.slotFields, want.slotFields, 'a conversation field in state.json moved');
  assert.deepEqual(got.artifacts, want.artifacts, 'an artifact moved');
}

test('a two-round run on the default table is pinned whole', async () => {
  const state = freshRun({ prefix: 'vibe-pin-reviewer-', task: 'pin the default table', planOnly: false, git: true, commit: true });
  const cfg = config({ p1Tolerance: 0 });
  const got = await drive(state, cfg, ['PLAN.md', 'code-review-0.json', 'code-review-1.json']);
  assert.ok(got.calls.includes('review-1'), got.calls.join(', '));
  assert.equal(state.status, 'done');
  pinned('default-table', got);

  // No field of the Claude reviewer's conversation on a run that has none.
  const saved = readFileSync(path.join(state.dir, 'state.json'), 'utf8');
  assert.doesNotMatch(saved, /reviewClaude/);
  assert.deepEqual(
    forkedSlotFields(state, cfg).conversations.map((c) => c.slot),
    ['main', 'judge', 'review', 'write'],
  );
});
