import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main } from '@src/cli.js';
import { EXIT } from '@src/orchestrator.js';

/**
 * `vibe doctor` states the resolved role table (#89).
 *
 * Doctor is the command whose whole job is "tell me what this run will do", and
 * the one setting it could not answer that for was the role table - deferred by
 * #46 as new user-facing output. It now prints every seat with the model, effort
 * and timeout that seat resolved to, with `--role` flags applied.
 *
 * The fixture below makes every figure distinguishable on purpose: the reviewer
 * names its own model, effort and timeout, the critic names none, and the
 * planner and the implementer differ from each other only by which of Claude's
 * two timeout keys their access selects. A line printed from a hardcoded value,
 * or from the provider key alone, cannot pass all five.
 *
 * Nothing is spawned: `readRateLimits` is off so no app-server child starts, and
 * `--skip-probe` keeps the agent probe out of it.
 */

/** A repo whose per-role and per-provider values are all different from each other. */
function targetDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-doctor-roles-'));
  writeFileSync(
    path.join(dir, 'vibe.config.json'),
    JSON.stringify({
      // Off, or doctor starts a codex app-server child to read the window.
      codex: {
        readRateLimits: false,
        model: 'gpt-fixture',
        effort: 'high',
        timeoutMs: 111_000,
        implementTimeoutMs: 222_000,
      },
      claude: {
        model: 'claude-fixture',
        effort: 'low',
        planTimeoutMs: 333_000,
        implementTimeoutMs: 444_000,
      },
      roles: {
        reviewer: { provider: 'codex', model: 'reviewer-fixture', effort: 'max', timeoutMs: 555_000 },
      },
    }),
    'utf8',
  );
  return dir;
}

async function captureLog<T>(work: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  console.log = collect;
  console.error = collect;
  try {
    return { result: await work(), lines };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

/** The line for one seat, from doctor's `roles:` block. */
function roleLine(lines: readonly string[], role: string): string {
  const found = lines.filter((line) => new RegExp(`^\\s+${role}\\s`).test(line));
  assert.equal(found.length, 1, `exactly one line for ${role}, got ${found.length}`);
  return found[0] as string;
}

test('doctor prints every seat, resolved, with the --role flag applied', async () => {
  const { result: code, lines } = await captureLog(() =>
    main(['doctor', '-C', targetDir(), '--skip-probe', '--role', 'reviewer:model=gpt-5.6-pro']),
  );

  assert.equal(code, EXIT.OK);

  // The flag wins over the model the file named for the same seat, and the rest
  // of that role object survives - which is the patch semantics, seen from the
  // command line.
  assert.match(roleLine(lines, 'reviewer'), /codex\s+gpt-5\.6-pro \/ max \/ 555000ms/);
  // Named nothing, so every figure is its provider's - including the read
  // timeout rather than the writing one.
  assert.match(roleLine(lines, 'critic'), /codex\s+gpt-fixture \/ high \/ 111000ms/);
  assert.match(roleLine(lines, 'answerer'), /codex\s+gpt-fixture \/ high \/ 111000ms/);
  // The two Claude seats differ only in which timeout key their access picks,
  // which is the pair `turnTimeoutMs` chooses between.
  assert.match(roleLine(lines, 'planner'), /claude\s+claude-fixture \/ low \/ 333000ms/);
  assert.match(roleLine(lines, 'implementer'), /claude\s+claude-fixture \/ low \/ 444000ms/);

  // Unchanged from before this: a probe the user skipped is reported as skipped.
  assert.match(lines.join('\n'), /agent environments: skipped \(--skip-probe\)/);
});

test('doctor with no --role prints the same table, from the file alone', async () => {
  const { result: code, lines } = await captureLog(() =>
    main(['doctor', '-C', targetDir(), '--skip-probe']),
  );

  assert.equal(code, EXIT.OK);
  assert.match(roleLine(lines, 'reviewer'), /codex\s+reviewer-fixture \/ max \/ 555000ms/);
});

test('a bad --role value fails doctor in the config vocabulary, once', async () => {
  const { result: code, lines } = await captureLog(() =>
    main(['doctor', '-C', targetDir(), '--skip-probe', '--role', 'reviewer:effort=maximum']),
  );

  assert.equal(code, EXIT.ERROR);
  const said = lines.join('\n');
  // The message `roles.reviewer.effort` gets in a config file, not a second one
  // invented for the flag.
  assert.match(said, /config: roles\.reviewer\.effort is "maximum"; must be one of/);
  assert.equal(
    said.split('roles.reviewer.effort is').length - 1,
    1,
    'said once - doctor used to load the config again and repeat it',
  );
  // "skipped" would claim a choice the user made. Doctor never had a contract to
  // probe against, and this line has to say so even under --skip-probe.
  assert.match(said, /agent environments: not checked - the config above could not be read/);
  assert.doesNotMatch(said, /agent environments: skipped/);
});
