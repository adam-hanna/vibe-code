import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CodexTurnOptions } from '@src/codex.js';
import { DEFAULTS, loadConfig } from '@src/config.js';
import { reviewPrompt, withFocus } from '@src/prompts.js';
import type { RunFn, RunResult } from '@src/proc.js';
import type { TimerApi } from '@src/progress.js';
import { FINDINGS_SCHEMA, REVIEW_SCHEMA } from '@src/schemas.js';
import type { FileChange } from '@src/types.js';
import { codexTurnNoMcp as codexTurn } from './helpers/codex-mcp.js';
import { reviewingRun } from './helpers/loop-harness.js';
import { driveReview, threeRoundConfig } from './helpers/ledger-loop.js';
import { CRITERIA, DIFF, FILES, OUT_OF_SCOPE, PLAN_MD } from './helpers/prompt-fixture-args.js';

/**
 * `loop.findingsLedger` off, which is the default, changes nothing (#498).
 *
 * Every digest here was taken from the build at `bd6beba`, before this work
 * touched `src/`: the review prompts with every trailing argument present, the
 * two findings schemas as objects, and `REVIEW_SCHEMA` as `codexTurn` writes it
 * to `codex/<label>.schema.json` (`JSON.stringify(schema, null, 2)`). A digest
 * rather than a fixture file because only equality is claimed; a mismatch says
 * the bytes moved, and the frozen goldens in `review-prompt-compat.test.ts`
 * say where.
 */

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const JUDGE: readonly FileChange[] = [
  { path: 'tests/widget.test.ts', oldPath: null, status: 'modified', added: 2, removed: 1 },
];
const REVIEW_MD = { text: '# Review\n\nBe strict.\n', commit: '0'.repeat(40) };

/** Every argument present, so the digest covers every trailing section too. */
function prompt(round: number, hasMemory: boolean): string {
  return reviewPrompt(
    DIFF,
    FILES,
    PLAN_MD,
    OUT_OF_SCOPE,
    round,
    hasMemory,
    null,
    undefined,
    CRITERIA,
    undefined,
    '## Report\n\nDid it.',
    ['core'],
    JUDGE,
    REVIEW_MD,
  );
}

test('with the ledger off, the review prompts of rounds 1 and 3 are the bytes they were', () => {
  assert.equal(sha(prompt(1, true)), '3be122cc10fb4c03d8e4e6c293624ab956e8db1c55267b4c94b162d38a7afb70');
  assert.equal(sha(prompt(1, false)), '3be122cc10fb4c03d8e4e6c293624ab956e8db1c55267b4c94b162d38a7afb70');
  assert.equal(sha(prompt(3, true)), 'da06d2701c8426a73c1f34444d977f7e457fd800c2ba7c8c700de6828a2682c8');
  assert.equal(sha(prompt(3, false)), '7cba1a3da74f6536f6f83b4de66fa9a3d379e9b88af6a7634e6d344dfefef29f');
  assert.equal(
    sha(withFocus(prompt(3, false), 'error handling')),
    '66aa03b0b07b96800f58abf931ba9e670f32e2474a37bcf85912955fa82b5a60',
    "a finder's prompt",
  );
});

test('with the ledger off, the findings schemas are the objects they were', () => {
  assert.equal(sha(JSON.stringify(REVIEW_SCHEMA)), 'b0f35403175df0b7bd81f4ad76d0fc64e4f0c2077f1ac3784f7ef5753405d523');
  assert.equal(sha(JSON.stringify(FINDINGS_SCHEMA)), '23a1d90a70597c5ba047bd06671243aa7f172b08bbbaaf03f9dc8478066f227d');
  assert.doesNotMatch(JSON.stringify(REVIEW_SCHEMA), /prior_id/);
});

test("the schema file a review turn writes is the file it wrote", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-ledger-off-schema-file-'));
  const timers: TimerApi = { repeat: () => ({ unref: () => {}, cancel: () => {} }) };
  const options: CodexTurnOptions = {
    prompt: 'review this',
    schema: REVIEW_SCHEMA,
    schemaName: 'review-0',
    artifactDir: dir,
    model: 'fixture-model',
    effort: 'low',
    sandbox: 'read-only',
    cwd: process.cwd(),
    timeoutMs: 1_000,
    progress: { label: 'fixture', intervalMs: 30_000, onActivity: () => {}, timers },
  };
  // A child that wrote no answer: the turn fails, after the schema is written.
  const exec: RunFn = (): Promise<RunResult> => Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '' });
  await assert.rejects(() => codexTurn(options, exec));
  const file = path.join(dir, 'review-0.schema.json');
  assert.ok(existsSync(file));
  assert.equal(sha(readFileSync(file, 'utf8')), '0e386627424e77ccd72b24e67908b129e4eb584cb709341368a376fde98e6949');
});

test('loop.findingsLedger is off by default, and must be a boolean', () => {
  assert.equal(DEFAULTS.loop.findingsLedger, false);
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-ledger-config-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ loop: {} }));
  assert.equal(loadConfig(dir).loop.findingsLedger, false);
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ loop: { findingsLedger: true } }));
  assert.equal(loadConfig(dir).loop.findingsLedger, true);
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ loop: { findingsLedger: 'yes' } }));
  assert.throws(() => loadConfig(dir), /loop\.findingsLedger must be true or false/);
});

// ---- through the loop --------------------------------------------------------

test('a three-round run with a finder and the ledger off sends, prompts and records what it always did', async () => {
  const state = reviewingRun({ prefix: 'vibe-ledger-off-loop-' });
  const { turns } = await driveReview(state, threeRoundConfig(false));
  const reviews = turns.filter((t) => t.label.startsWith('review-'));
  assert.deepEqual(
    reviews.map((t) => t.label),
    ['review-0', 'review-0-f1', 'review-1', 'review-1-f1', 'review-2', 'review-2-f1'],
  );
  for (const t of reviews) {
    assert.equal(t.schema, REVIEW_SCHEMA, `${t.label} was sent the reviewer's own schema object`);
    assert.ok(!t.prompt.includes('Findings from earlier rounds'), t.label);
    assert.ok(!t.prompt.includes('prior_id'), t.label);
  }
  for (const n of [0, 1, 2]) {
    const text = readFileSync(path.join(state.dir, `code-review-${n}.json`), 'utf8');
    assert.doesNotMatch(text, /prior_id|priorId/, `code-review-${n}.json`);
  }
  assert.match(readFileSync(path.join(state.dir, 'code-review-0.json'), 'utf8'), /foundBy/, 'finders ran');
  assert.doesNotMatch(readFileSync(path.join(state.dir, 'state.json'), 'utf8'), /prior_id|priorId/);
});
