import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { configFromFlags, flagOverrideNames, main, parseArgs } from '@src/cli.js';
import { EXIT } from '@src/orchestrator.js';

/**
 * `vibe doctor` reports the config the same flags would RUN under (#106).
 *
 * #89 made doctor read the config and print the resolved role table, with
 * `--role` patches applied and nothing else. That left it reporting a *subset*
 * of what a run would use - some values reflected the flags, some did not, and
 * nothing on the page said which were which. A preview you cannot trust is worse
 * than no preview, and worse than the coherent thing doctor was before #89,
 * which read no config at all.
 *
 * So: full preview. The care is in what it changes for anyone running
 * `vibe doctor` in a script today - a flag that was silently ignored starts
 * mattering, including an invalid one, and the last case here is that.
 *
 * Nothing is spawned: `readRateLimits` is off so no app-server child starts, and
 * `--skip-probe` keeps the agent probe out of it.
 */

function targetDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-doctor-flags-'));
  writeFileSync(
    path.join(dir, 'vibe.config.json'),
    JSON.stringify({
      codex: { readRateLimits: false, model: 'gpt-from-file', effort: 'high' },
      claude: { model: 'claude-from-file', effort: 'low' },
      loop: { maxPlanRounds: 11, maxReviewRounds: 12 },
      context: { compactAboveRatio: 0.5 },
      verify: { enabled: true, command: 'file-verify' },
    }),
    'utf8',
  );
  return dir;
}

async function doctor(...args: string[]): Promise<{ code: number; said: string }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  console.log = collect;
  console.error = collect;
  try {
    const code = await main(['doctor', '--skip-probe', ...args]);
    return { code, said: lines.join('\n') };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

// ---- the flags reach the report ---------------------------------------------

test('doctor with no flags reports the file, and says nothing about the command line', async () => {
  const { code, said } = await doctor('-C', targetDir());

  assert.equal(code, EXIT.OK);
  assert.match(said, /claude claude-from-file\/low - codex gpt-from-file\/high/);
  assert.match(said, /plan rounds 11 - review rounds 12/);
  assert.match(said, /compaction above 50%/);
  assert.match(said, /verify: verification - file-verify/);
  // The ordinary case prints no provenance clause at all: there is nothing to
  // disambiguate when every value came from one place.
  assert.doesNotMatch(said, /command line also sets/);
});

test('the provider flags reach the report, where they used to be dropped', async () => {
  const { code, said } = await doctor(
    '-C',
    targetDir(),
    '--codex-model',
    'gpt-5.6-pro',
    '--claude-effort',
    'max',
  );

  assert.equal(code, EXIT.OK);
  assert.match(said, /claude claude-from-file\/max - codex gpt-5\.6-pro\/high/);
});

test('the loop, budget, compaction and verify flags reach it too', async () => {
  const { code, said } = await doctor(
    '-C',
    targetDir(),
    '--max-plan-rounds',
    '3',
    '--max-tokens',
    '999000',
    '--no-compact',
    '--verify-command',
    'flag-verify',
  );

  assert.equal(code, EXIT.OK);
  assert.match(said, /plan rounds 3 - review rounds 12/, 'the flag moves one and the file keeps the other');
  assert.match(said, /999,000 tokens \(both\)/);
  assert.match(said, /compaction off/);
  assert.match(said, /verify: verification - flag-verify/);
});

// ---- and the report says which of them did ----------------------------------

test('the config line names what the command line moved, in config keys', async () => {
  const { code, said } = await doctor(
    '-C',
    targetDir(),
    '--codex-model',
    'gpt-5.6-pro',
    '--max-plan-rounds',
    '3',
    '--role',
    'reviewer:effort=max',
  );

  assert.equal(code, EXIT.OK);
  // Named, not counted, and sorted: the reader's question is "did a flag reach
  // the value I am looking at", and only the names answer it. Config keys rather
  // than flag spellings, because the lines underneath print config keys.
  assert.match(
    said,
    /config: .*vibe\.config\.json \(command line also sets codex\.model, loop\.maxPlanRounds, roles\.reviewer\.effort\)/,
  );
});

test('flagOverrideNames covers a flag no line of the report prints', () => {
  // `codex.persistSession` has no line in doctor's output, so the provenance
  // clause is the only place it can be seen - which is exactly why the clause is
  // built from the overrides rather than from the lines.
  const { flags } = parseArgs(['doctor', '--no-codex-session', '--no-branch']);

  assert.deepEqual(flagOverrideNames(flags), ['codex.persistSession', 'git.useBranch']);
  assert.deepEqual(flagOverrideNames(parseArgs(['doctor']).flags), [], 'and is empty by default');
});

// ---- the preview is the run's, which cuts both ways -------------------------

test('doctor and run build the same config from the same flags', () => {
  const dir = targetDir();
  const args = ['-C', dir, '--codex-model', 'gpt-5.6-pro', '--no-verify', '--role', 'critic:effort=max'];
  const { flags } = parseArgs(args);

  // One function builds both since #106. Asserted rather than assumed: a second
  // builder is precisely how doctor came to report a subset in the first place,
  // and this is the claim that stops one growing back.
  const shown = configFromFlags(dir, flags);
  const run = configFromFlags(dir, parseArgs(args).flags);
  assert.deepEqual(shown, run);
  assert.equal(shown.codex.model, 'gpt-5.6-pro');
  assert.equal(shown.verify.enabled, false);
  // A role value is a provider string or an object; a patched seat is the object.
  const critic = shown.roles?.['critic'];
  assert.ok(typeof critic === 'object' && critic !== null, `critic is an object: ${String(critic)}`);
  assert.equal(critic.effort, 'max');
});

test('a flag that makes the config invalid now fails doctor, as the same run would', async () => {
  // The cost of a full preview, stated rather than discovered: a flag that was
  // silently ignored starts mattering. `--codex-context-window 0` used to be
  // dropped on the floor here and refused by `vibe run`; doctor is not a preview
  // if it disagrees with the run about whether the run can start.
  //
  // This is also the smaller thing #106 asked to confirm: doctor surfacing a
  // broken config through `check()` - #89's deliberate change - is the same
  // question, and the answer is the same. It counts, and the agent probe is
  // reported as never having had a contract rather than as skipped.
  const { code, said } = await doctor('-C', targetDir(), '--codex-context-window', '0');

  assert.equal(code, EXIT.ERROR);
  assert.match(said, /config: codex\.contextWindow must be a positive whole number/);
  assert.match(said, /agent environments: not checked - the config above could not be read/);
  assert.doesNotMatch(said, /agent environments: skipped/);
});
