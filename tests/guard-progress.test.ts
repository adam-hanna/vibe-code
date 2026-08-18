import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  budgetCeilings,
  Escalation,
  EXIT,
  guardProgress,
  persistenceWarning,
} from '@src/orchestrator.js';
import { p1Signature, recordRound } from '@src/run.js';
import { DEFAULTS } from '@src/config.js';
import type { Config, Finding, RoundRecord, Severity } from '@src/types.js';

function findings(ids: readonly string[], severity: Severity = 'P1'): Finding[] {
  return ids.map((id) => ({ id, severity, title: id, detail: '', suggested_fix: '' }));
}

/** Runs one guarded round and returns whatever the guard logged. */
function guardedRound(
  cfg: Config,
  history: RoundRecord[],
  ids: readonly string[],
  args: { cap: number; round: number },
): { lines: string[]; thrown: unknown } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  let thrown: unknown = null;
  try {
    guardProgress(cfg, history, findings(ids), findings(ids), {
      cap: args.cap,
      round: args.round,
      capName: 'maxReviewRounds',
      deadlockMsg: 'the reviewer and the fixer disagree',
    });
  } catch (err) {
    thrown = err;
  } finally {
    console.log = original;
  }
  return { lines, thrown };
}

const STUCK = 'regex-group-prefix-not-literalized';

/** The same nine rounds as tests/convergence.test.ts, replayed through the guard. */
const PICOMATCH: readonly (readonly string[])[] = [
  ['a-1', 'a-2'],
  ['a-2', 'b-1', 'b-2', 'b-3'],
  [STUCK, 'b-1', 'b-2'],
  [STUCK, 'c-1', 'c-2', 'c-3'],
  [STUCK, 'c-1'],
  [STUCK, 'd-1', 'd-2'],
  [STUCK, 'd-1'],
  [STUCK, 'e-1', 'e-2'],
  ['f-1'],
];

const CAP = 12;

test('the picomatch run is reported on but never escalated', () => {
  const cfg = DEFAULTS;
  const history: RoundRecord[] = [];
  const logged: string[][] = [];

  PICOMATCH.forEach((ids, idx) => {
    const { lines, thrown } = guardedRound(cfg, history, ids, { cap: CAP, round: idx + 1 });
    assert.equal(thrown, null, `round ${idx + 1} escalated a run that converged`);
    logged.push(lines);
  });

  // Streaks are 0,0,1,2,3,4,5,6,0 and minRounds is 4, so only rounds 6-8 speak.
  const noticed = logged.map((lines) => lines.filter((l) => l.includes(STUCK)).length);
  assert.deepEqual(noticed, [0, 0, 0, 0, 0, 1, 1, 1, 0]);

  const [six, seven, eight] = [logged[5]?.[0] ?? '', logged[6]?.[0] ?? '', logged[7]?.[0] ?? ''];
  assert.match(six, /4 rounds running/);
  assert.match(seven, /5 rounds running/);
  assert.match(eight, /6 rounds running/);
  for (const line of [six, seven, eight]) {
    // The cap the guard was handed, not the config default of 5.
    assert.match(line, /maxReviewRounds \(12\)/);
    assert.match(line, /at the latest/);
    assert.match(line, /another brake/);
    assert.match(line, /resume/);
  }
});

test('a lone unchanging blocker still stops, via the oscillation guard', () => {
  // The verification loop's synthetic P0 is exactly this shape: one id that is
  // the whole set, so its fingerprint repeats and the set rule ends the run at
  // three rounds - before the persistence notice's fourth round is reached.
  const history: RoundRecord[] = [];
  const said: string[] = [];
  let thrown: unknown = null;

  for (let round = 1; round <= 3 && thrown === null; round += 1) {
    const result = guardedRound(DEFAULTS, history, ['verification-failing'], { cap: CAP, round });
    said.push(...result.lines);
    thrown = result.thrown;
  }

  assert.ok(thrown instanceof Escalation);
  assert.equal(thrown.code, EXIT.NO_CONVERGENCE);
  assert.match(thrown.message, /same P1 set/);
  assert.deepEqual(
    said.filter((l) => l.includes('verification-failing') && l.includes('rounds running')),
    [],
    'the notice never reaches its threshold on this path',
  );
});

test('the final cap round says nothing about continuing, because it does not', () => {
  // The notice claims the run is continuing. On the round the cap ends the run
  // that is false, so it must not be emitted - even though the streak (5) is
  // well past the threshold. Counts fall, so the trend guard stays out of it.
  const cfg = DEFAULTS;
  const cap = cfg.loop.maxReviewRounds;
  const rounds = [
    [STUCK, 'a-1', 'a-2', 'a-3'],
    [STUCK, 'b-1', 'b-2'],
    [STUCK, 'c-1', 'c-2', 'c-3'],
    [STUCK, 'd-1', 'd-2'],
    [STUCK, 'e-1'],
  ];
  const history: RoundRecord[] = [];
  const logged: string[][] = [];
  let thrown: unknown = null;

  rounds.forEach((ids, idx) => {
    if (thrown !== null) return;
    const result = guardedRound(cfg, history, ids, { cap, round: idx + 1 });
    logged.push(result.lines);
    thrown = result.thrown;
  });

  assert.ok(thrown instanceof Escalation);
  assert.match(thrown.message, /Hit maxReviewRounds \(5\)/);
  // Round 4 crosses the threshold and legitimately speaks; round 5 does not.
  assert.equal(logged[3]?.filter((l) => l.includes(STUCK)).length, 1);
  assert.deepEqual(logged[4]?.filter((l) => l.includes(STUCK)), []);
});

test('a late stalled trend says nothing about continuing either', () => {
  // Same contradiction by the other route: at a raised cap the trend guard can
  // stop a round on which the persistence streak has long since qualified.
  const history: RoundRecord[] = [];
  const logged: string[][] = [];
  let thrown: unknown = null;

  for (let round = 1; round <= 8 && thrown === null; round += 1) {
    const result = guardedRound(DEFAULTS, history, [STUCK, `m-${round}`], { cap: CAP, round });
    logged.push(result.lines);
    thrown = result.thrown;
  }

  assert.ok(thrown instanceof Escalation);
  assert.match(thrown.message, /has not fallen in 3 rounds/);
  assert.deepEqual(logged[logged.length - 1]?.filter((l) => l.includes(STUCK)), []);
  // It did report on the earlier rounds, where continuing was true.
  assert.ok(logged.slice(0, -1).some((lines) => lines.some((l) => l.includes(STUCK))));
});

test('the round cap still escalates with blockers outstanding', () => {
  const history: RoundRecord[] = [];

  const { thrown } = guardedRound(DEFAULTS, history, ['l-1'], { cap: 1, round: 1 });

  assert.ok(thrown instanceof Escalation);
  assert.equal(thrown.code, EXIT.NO_CONVERGENCE);
  assert.match(thrown.message, /Hit maxReviewRounds \(1\)/);
});

test('a disabled token ceiling is not offered as something to raise', () => {
  const off: Config = { ...DEFAULTS, budget: { ...DEFAULTS.budget, maxTokens: 0 } };

  assert.deepEqual(budgetCeilings(DEFAULTS), [
    'budget.maxCostUsd ($25, Claude only)',
    'budget.maxTokens (25.0M)',
  ]);
  assert.deepEqual(budgetCeilings(off), ['budget.maxCostUsd ($25, Claude only)']);

  const history: RoundRecord[] = [];
  for (const ids of PICOMATCH.slice(0, 8)) {
    recordRound(history, p1Signature(findings(ids)), ids.length, ids);
  }

  const line = persistenceWarning(off, history, { cap: CAP, capName: 'maxReviewRounds' });
  assert.match(line ?? '', /budget\.maxCostUsd/);
  assert.doesNotMatch(line ?? '', /maxTokens/);
  assert.match(line ?? '', /maxReviewRounds \(12\) at the latest/);
});
