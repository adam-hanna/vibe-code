import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '@src/cli.js';
import { EXIT } from '@src/orchestrator.js';

// `doctor-roles.test.ts`' reason: only so `resolveBin` succeeds where neither
// CLI is installed. Nothing here spawns either.
process.env['VIBE_CLAUDE_BIN'] = process.execPath;
process.env['VIBE_CODEX_BIN'] = process.execPath;

/**
 * `vibe doctor` lists the review seats (#388), and says nothing extra under the
 * defaults - so doctor's output for every config that names no seat is what it
 * was. Finders are used since Part B and verifiers since Part C, each under a
 * header of its own that says what it costs; *not used yet* is gone.
 *
 * The fixture makes each figure distinguishable: one finder names everything,
 * one names nothing and so takes Claude's read timeout, and a verifier names
 * only an effort. Nothing is spawned (`readRateLimits` off, `--skip-probe`).
 */

function targetDir(review: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-doctor-review-'));
  writeFileSync(
    path.join(dir, 'vibe.config.json'),
    JSON.stringify({
      codex: { readRateLimits: false, model: 'gpt-fixture', effort: 'high', timeoutMs: 111_000 },
      claude: { model: 'claude-fixture', effort: 'low', planTimeoutMs: 333_000 },
      ...(review === undefined ? {} : { review }),
    }),
    'utf8',
  );
  return dir;
}

async function doctor(dir: string): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  console.log = collect;
  console.error = collect;
  try {
    return { code: await main(['doctor', '-C', dir, '--skip-probe']), lines };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function line(lines: readonly string[], label: string): string {
  const found = lines.filter((l) => new RegExp(`^\\s+${label}\\s`).test(l));
  assert.equal(found.length, 1, `exactly one line for ${label}, got ${found.length}`);
  return found[0] as string;
}

test('doctor lists finders and verifiers as used, each under its own header', async () => {
  const { code, lines } = await doctor(
    targetDir({
      finders: [
        { provider: 'codex', model: 'finder-fixture', effort: 'max', timeoutMs: 555_000, focus: 'security' },
        'claude',
      ],
      verifiers: [{ provider: 'codex', effort: 'medium' }, 'claude', 'codex'],
      unconfirmedP0: 'halt',
    }),
  );
  assert.equal(code, EXIT.OK);
  // Finders are used since #388 Part B and verifiers since Part C: each block
  // sits under its own header, the verifiers' after the finders', and nothing
  // says *not used yet* any more.
  const findersAt = lines.findIndex((l) => l.includes('review finders (each reviews every chunk'));
  const verifiersAt = lines.findIndex((l) =>
    /review verifiers \(each votes on every blocking finding not reproduced; one extra turn per such finding per verifier\)/.test(l),
  );
  assert.ok(findersAt >= 0, 'a review finders header');
  assert.ok(verifiersAt > findersAt, 'the verifiers header follows the finders');
  assert.equal(lines.some((l) => l.includes('not used yet')), false);
  const at = (label: string): number => lines.indexOf(line(lines, label));
  assert.ok(at('finder 1') > findersAt && at('finder 2') < verifiersAt, 'finders are under their own header');
  for (const label of ['verifier 1', 'verifier 3', 'quorum', 'unconfirmed P0']) {
    assert.ok(at(label) > verifiersAt, `${label} is under the verifiers header`);
  }
  assert.match(line(lines, 'finder 1'), /codex\s+finder-fixture \/ max \/ 555000ms {2}focus: "security"$/);
  assert.match(line(lines, 'finder 2'), /claude\s+claude-fixture \/ low \/ 333000ms$/);
  assert.match(line(lines, 'verifier 1'), /codex\s+gpt-fixture \/ medium \/ 111000ms$/);
  assert.match(line(lines, 'verifier 3'), /codex\s+gpt-fixture \/ high \/ 111000ms$/);
  assert.match(line(lines, 'quorum'), /2 of 3 \(a majority\)$/);
  assert.match(line(lines, 'unconfirmed P0'), /halt$/);
});

test('a quorum that was set is printed as set, and finders alone print no quorum', async () => {
  const set = await doctor(targetDir({ verifiers: ['codex', 'codex'], quorum: 2 }));
  assert.match(line(set.lines, 'quorum'), /\s2 of 2$/);
  const findersOnly = await doctor(targetDir({ finders: ['codex'] }));
  assert.equal(findersOnly.lines.filter((l) => /^\s+quorum\s/.test(l)).length, 0);
});

test('under the defaults doctor prints no review block', async () => {
  const { code, lines } = await doctor(targetDir(undefined));
  assert.equal(code, EXIT.OK);
  assert.equal(lines.some((l) => l.includes('review seats')), false);
  assert.equal(lines.some((l) => l.includes('review finders') || l.includes('review verifiers')), false);
});

test('doctor says how many seat turns may run at once, and what that costs (#403)', async () => {
  const one = await doctor(targetDir({ verifiers: ['codex', 'codex'] }));
  assert.match(line(one.lines, 'parallel'), /\s1 \(one after another\)$/);
  const lines = one.lines;
  assert.ok(lines.indexOf(line(lines, 'parallel')) > lines.indexOf(line(lines, 'unconfirmed P0')));

  const four = await doctor(targetDir({ finders: ['codex'], maxParallel: 4 }));
  assert.match(
    line(four.lines, 'parallel'),
    /\s4 at once \(Codex turns can overshoot budget\.maxTokens by up to 4 turns' spend\)$/,
  );
  // And under the defaults, still nothing.
  const none = await doctor(targetDir(undefined));
  assert.equal(none.lines.filter((l) => /^\s+parallel\s/.test(l)).length, 0);
});
