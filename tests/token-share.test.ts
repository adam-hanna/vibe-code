import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeShare, execute } from '@src/cli.js';
import { checkTokenShare } from '@src/consistency.js';
import type { TokenShareFields } from '@src/consistency.js';
import { DEFAULTS } from '@src/config.js';
import { commitFork, planFork } from '@src/fork.js';
import { EXIT } from '@src/orchestrator.js';
import { createRun, loadRun, saveState, writeCheckpoint } from '@src/run.js';
import { StoredStateError } from '@src/stored.js';
import type { Config, RunState } from '@src/types.js';

/**
 * Rule D: a stored Codex share larger than the run's own total (#87).
 *
 * `summary()` renders the Claude share as `tokensUsed` minus `codexTokens`, so
 * such a state printed a NEGATIVE token total - a number that cannot exist,
 * presented as the run's accounting. Two defences are pinned here, and they are
 * deliberately independent:
 *
 * - **the rule** (`checkTokenShare`), applied by `loadRun` and `planFork`, which
 *   clamps the share down to the total and records what it did;
 * - **the display** (`claudeShare`), which returns null rather than a negative
 *   for any state that reaches it - including one built in memory that went
 *   through neither reader. Cases 7-9 are the ones that survive someone
 *   deleting the rule.
 *
 * The routes a state gets here by are a hand-edited `state.json` and a
 * hand-edited `checkpoint-<n>.json`; no writer produces one, and a malformed
 * `tokensUsed` refuses the load rather than being repaired to zero (case 5).
 * That last point is why the case is here at all: #87 proposed the repair route
 * as the likely cause, and it does not exist.
 *
 * Nothing cleans up its temp directory, for the reason `stored-state.test.ts`
 * gives: `rmSync` over a directory a child has just touched is a Windows flake
 * source in a suite that has to pass three times running.
 */

// ---- fixtures ---------------------------------------------------------------

/** A run on disk, and the handles to hand-edit it. */
function fresh(task = 'token share'): { targetDir: string; id: string; file: string } {
  const targetDir = mkdtempSync(path.join(tmpdir(), 'vibe-share-'));
  const state = createRun(targetDir, task, true);
  return { targetDir, id: state.id, file: path.join(state.dir, 'state.json') };
}

/** Rewrite a stored state through a mutation, as a hand edit would leave it. */
function edited(
  mutate: (raw: Record<string, unknown>) => void,
  task?: string,
): { targetDir: string; id: string; file: string } {
  const run = fresh(task);
  const raw: unknown = JSON.parse(readFileSync(run.file, 'utf8'));
  assert.ok(raw !== null && typeof raw === 'object' && !Array.isArray(raw));
  const rec = raw as Record<string, unknown>;
  mutate(rec);
  writeFileSync(run.file, JSON.stringify(rec, null, 2), 'utf8');
  return run;
}

/** The `state_repaired` events a load recorded, whole. */
function repairs(state: RunState): Record<string, unknown>[] {
  return state.events.filter((e) => e.type === 'state_repaired') as unknown as Record<
    string,
    unknown
  >[];
}

/** Console output, so a warning is an observation rather than an assumption. */
function capture<T>(work: () => T): { result: T; lines: string[] } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  try {
    return { result: work(), lines };
  } finally {
    console.log = original;
  }
}

async function captureAsync<T>(work: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  try {
    return { result: await work(), lines };
  } finally {
    console.log = original;
  }
}

/** sha256 of every file under a directory, so "byte-identical" is observed. */
function fingerprint(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string, prefix: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      const rel = path.posix.join(prefix, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else out.set(rel, createHash('sha256').update(readFileSync(full)).digest('hex'));
    }
  };
  walk(dir, '');
  return out;
}

function config(over: Partial<Config> = {}): Config {
  return {
    ...DEFAULTS,
    codex: { ...DEFAULTS.codex, readRateLimits: false },
    progress: { ...DEFAULTS.progress, enabled: false },
    ...over,
  };
}

/** A state that never passed a loader, for the display-side cases. */
function inMemory(tokensUsed: number, codexTokens: number | undefined, costUsd: number): RunState {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-share-mem-'));
  const state = createRun(dir, 'in memory', true);
  state.tokensUsed = tokensUsed;
  state.costUsd = costUsd;
  if (codexTokens === undefined) delete state.codexTokens;
  else state.codexTokens = codexTokens;
  return state;
}

// ---- 1. the rule itself -----------------------------------------------------

test('checkTokenShare clamps a Codex share larger than the run total, and nothing else', () => {
  // A plain literal, not a run on disk: `TokenShareFields` exists so the rule
  // can be asked about a pair directly.
  const at = (tokensUsed: number, codexTokens?: number): TokenShareFields => ({
    id: 'r',
    dir: 'd',
    tokensUsed,
    codexTokens,
  });

  const clamped = checkTokenShare(at(1_000, 5_000_000));
  assert.ok(clamped !== null);
  assert.equal(clamped.rule, 'D');
  assert.equal(clamped.storedCodexTokens, 5_000_000);
  assert.equal(clamped.tokensUsed, 1_000);
  assert.equal(clamped.codexTokens, 1_000, 'clamped to the authority, which is never raised');
  assert.match(clamped.why, /5,000,000/);
  assert.match(clamped.why, /1,000/);

  // `>` and never `>=`: a run whose work was all Codex is a real run.
  assert.equal(checkTokenShare(at(10_214, 10_214)), null, 'equal is legal');
  assert.equal(checkTokenShare(at(12_000, 500)), null);
  assert.equal(checkTokenShare(at(12_000)), null, 'absent is not zero, and is not a fault');
  assert.equal(checkTokenShare(at(0, 0)), null);
  assert.equal(checkTokenShare(at(0)), null);
});

// ---- 2-5. the load path -----------------------------------------------------

test('loadRun clamps the Codex share to the run total, and records what it did', () => {
  const run = edited((raw) => {
    raw['tokensUsed'] = 1_000;
    raw['codexTokens'] = 5_000_000;
  });

  const { result: loaded, lines } = capture(() => loadRun(run.targetDir, run.id));

  assert.equal(loaded.codexTokens, 1_000);
  assert.equal(loaded.tokensUsed, 1_000, 'the authority is never touched');

  const events = repairs(loaded);
  assert.equal(events.length, 1, 'exactly one repair, naming both fields');
  const event = events[0] ?? {};
  assert.equal(event['field'], 'codexTokens');
  assert.equal(event['rule'], 'D');
  assert.equal(event['against'], 'tokensUsed');
  assert.equal(event['storedCodexTokens'], 5_000_000, 'the only surviving copy of the figure');
  assert.equal(event['tokensUsed'], 1_000);
  assert.equal(event['found'], '5000000');
  assert.equal(event['replacedWith'], '1000');

  // Persisted, not merely returned: `recordEvent` saves.
  const reloaded: unknown = JSON.parse(readFileSync(run.file, 'utf8'));
  assert.equal((reloaded as { codexTokens?: number }).codexTokens, 1_000);

  const warning = lines.find((l) => l.includes('Codex tokens'));
  assert.ok(warning !== undefined, 'the alteration is reported, not silent');
  assert.match(warning, /5,000,000/);
  assert.match(warning, /1,000/);
});

test('the clamp fires once - a second load of the same run records nothing', () => {
  const run = edited((raw) => {
    raw['tokensUsed'] = 1_000;
    raw['codexTokens'] = 5_000_000;
  });

  capture(() => loadRun(run.targetDir, run.id));
  const { result: again, lines } = capture(() => loadRun(run.targetDir, run.id));

  // Unlike rule B, this rewrites the field its own predicate reads, so the next
  // load sees a consistent state and has nothing to say about it.
  assert.equal(repairs(again).length, 1, 'the one from the first load, and no more');
  assert.equal(again.codexTokens, 1_000);
  assert.equal(lines.filter((l) => l.includes('Codex tokens')).length, 0);
});

test('a legal share loads untouched, whichever legal shape it is', () => {
  const legal: [number, number | undefined][] = [
    [10_214, 10_214],
    [12_000, 500],
    [12_000, undefined],
    [0, 0],
    [0, undefined],
  ];
  for (const [tokensUsed, codexTokens] of legal) {
    const run = edited((raw) => {
      raw['tokensUsed'] = tokensUsed;
      if (codexTokens === undefined) delete raw['codexTokens'];
      else raw['codexTokens'] = codexTokens;
    });
    const { result: loaded, lines } = capture(() => loadRun(run.targetDir, run.id));
    assert.equal(loaded.tokensUsed, tokensUsed);
    assert.equal(loaded.codexTokens, codexTokens, `${tokensUsed}/${String(codexTokens)}`);
    assert.deepEqual(repairs(loaded), [], `${tokensUsed}/${String(codexTokens)} needs no repair`);
    assert.equal(
      lines.filter((l) => l.includes('Codex tokens')).length,
      0,
      'and produces no warning',
    );
  }
});

test('a malformed tokensUsed still refuses, in the same words - rule D softens nothing', () => {
  // #87 proposed that this is repaired to 0 while a valid codexTokens survives
  // beside it. It is not: `tokensUsed` is read by `refusedNumber`, and the run
  // cannot proceed without it. The refusal must survive rule D.
  const run = edited((raw) => {
    raw['tokensUsed'] = 'lots';
    raw['codexTokens'] = 5_000_000;
  });
  const before = readFileSync(run.file, 'utf8');

  assert.throws(
    () => loadRun(run.targetDir, run.id),
    (err: unknown) => {
      assert.ok(err instanceof StoredStateError);
      assert.match(err.message, /tokensUsed/);
      assert.match(err.message, /a number of tokens is required/);
      return true;
    },
  );

  assert.equal(readFileSync(run.file, 'utf8'), before, 'and nothing was rewritten');
});

// ---- 6. the fork path -------------------------------------------------------

/** A finished-enough parent with one checkpoint, hand-edited into the fault. */
function parentWithCheckpoint(tokensUsed: number, codexTokens: number): {
  state: RunState;
  n: number;
  file: string;
} {
  const targetDir = mkdtempSync(path.join(tmpdir(), 'vibe-share-fork-'));
  const state = createRun(targetDir, 'forking a bad share', true);
  state.tokensUsed = tokensUsed;
  state.codexTokens = 1;
  saveState(state);
  const meta = writeCheckpoint(state, 'plan-approved', { sha: null, note: 'commits-disabled' });
  assert.ok(meta !== null);
  const file = path.join(state.dir, `checkpoint-${meta.n}.json`);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  raw['tokensUsed'] = tokensUsed;
  raw['codexTokens'] = codexTokens;
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
  return { state, n: meta.n, file };
}

test('a fork clamps the checkpoint it inherits, writes nothing to the parent, and says so', async () => {
  const parent = parentWithCheckpoint(1_000, 5_000_000);
  const before = fingerprint(parent.state.dir);

  const plan = await planFork(parent.state.targetDir, parent.state.id, parent.n, {
    git: { useBranch: false },
  });

  // The whole parent directory, not just the checkpoint: a `recordEvent` called
  // from `planFork` would rewrite the parent's state.json and leave the
  // checkpoint untouched, which a narrower check would miss.
  assert.deepEqual(fingerprint(parent.state.dir), before, 'planFork wrote nothing');

  assert.equal(plan.checkpointState.codexTokens, 1_000);
  assert.equal(plan.checkpointState.tokensUsed, 1_000);
  assert.ok(plan.tokenShare !== null);
  assert.equal(plan.tokenShare.rule, 'D');
  assert.equal(plan.tokenShare.storedCodexTokens, 5_000_000);
  const disclosure = plan.losses.find((l) => l.includes('5,000,000'));
  assert.ok(disclosure !== undefined, 'the clamp is disclosed, not quiet');
  assert.match(disclosure, /1,000/);

  const { state: child } = await commitFork(parent.state.targetDir, plan);
  assert.deepEqual(fingerprint(parent.state.dir), before, 'and neither did commitFork');

  const reloaded = loadRun(child.targetDir, child.id);
  assert.equal(reloaded.codexTokens, 1_000);
  assert.equal(reloaded.tokensUsed, 1_000);

  // The staged event carries the same payload the load path writes, key for
  // key. `stageEvent` takes arbitrary keys, so nothing but this keeps the two
  // paths in step.
  const events = repairs(reloaded);
  assert.equal(events.length, 1, 'staged once by the fork, and not repeated by the reload');
  const event = events[0] ?? {};
  assert.equal(event['field'], 'codexTokens');
  assert.equal(event['rule'], 'D');
  assert.equal(event['against'], 'tokensUsed');
  assert.equal(event['storedCodexTokens'], 5_000_000);
  assert.equal(event['tokensUsed'], 1_000);

  const origin = reloaded.forkedFrom;
  assert.ok(origin !== undefined);
  assert.equal(origin.inheritedTokens, 1_000);
  assert.equal(
    origin.inheritedCodexTokens,
    1_000,
    'provenance carries the normalised figure, never one larger than the total beside it',
  );
  assert.ok(
    origin.notInherited.some((l) => l.includes('5,000,000')),
    'and the raw figure survives in the record of what the fork did not carry',
  );
});

test('a fork of a legal checkpoint is untouched, and records no repair', async () => {
  const parent = parentWithCheckpoint(12_000, 500);

  const plan = await planFork(parent.state.targetDir, parent.state.id, parent.n, {
    git: { useBranch: false },
  });
  assert.equal(plan.tokenShare, null);
  assert.equal(plan.checkpointState.codexTokens, 500);

  const { state: child } = await commitFork(parent.state.targetDir, plan);
  const reloaded = loadRun(child.targetDir, child.id);
  assert.deepEqual(repairs(reloaded), []);
  assert.equal(reloaded.forkedFrom?.inheritedCodexTokens, 500);
});

// ---- 7-8. the display, which does not depend on the rule having run ---------

test('claudeShare returns null rather than a negative, for a state no loader saw', () => {
  assert.equal(claudeShare({ tokensUsed: 1_000, codexTokens: 5_000_000 }), null);
  assert.equal(claudeShare({ tokensUsed: 62_887, codexTokens: 52_673 }), 10_214);
  assert.equal(claudeShare({ tokensUsed: 10_214, codexTokens: 10_214 }), 0, 'an all-Codex run');
  assert.equal(claudeShare({ tokensUsed: 12_000 }), 12_000, 'absent is not a fault');
  assert.equal(claudeShare({ tokensUsed: 0, codexTokens: 0 }), 0);
});

test('the summary prints no negative Claude share, whatever state reaches it', async () => {
  // Through `execute`, which is what a user actually sees, and with a state
  // built in memory that went through neither `loadRun` nor `planFork` - the
  // case that still fails if rule D is deleted.
  const state = inMemory(1_000, 5_000_000, 0.52);

  const { lines } = await captureAsync(() =>
    execute(
      state,
      config(),
      false,
      true,
      () => Promise.resolve(EXIT.PREFLIGHT),
      () => Promise.resolve(),
    ),
  );

  assert.equal(
    lines.filter((l) => /Claude\s+-/.test(l)).length,
    0,
    'a negative token total is a number that cannot exist',
  );
  const share = lines.find((l) => l.includes('Claude'));
  assert.ok(share !== undefined);
  assert.match(share, /not available/);
  assert.match(share, /5,000,000/);
  assert.match(share, /1,000/);
  assert.match(share, /\$0\.52/, 'the cost figure is Claude\'s alone, and is unaffected');
});

// ---- 9. what did NOT change ------------------------------------------------

test('a legal share renders exactly the line it always did', async () => {
  // The golden line, byte for byte. Deliberately not a diff of two whole runs:
  // ids, timestamps, session uuids and elapsed minutes make two runs necessarily
  // different, so such a check would fail for a correct implementation while
  // establishing nothing. This pins the one thing that must not move.
  const state = inMemory(62_887, 52_673, 0.52);

  const { lines } = await captureAsync(() =>
    execute(
      state,
      config(),
      false,
      true,
      () => Promise.resolve(EXIT.PREFLIGHT),
      () => Promise.resolve(),
    ),
  );

  assert.ok(
    lines.includes('            Claude 10,214 tok (~$0.52 API-equivalent)'),
    `expected the untouched Claude line, got:\n${lines.join('\n')}`,
  );
  assert.ok(lines.some((l) => l.includes('Codex  52,673 tok (cost not reported)')));
});
