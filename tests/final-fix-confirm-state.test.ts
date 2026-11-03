import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateStoredState } from '@src/stored.js';
import type { FinalFixConfirmations, FixReproductions } from '@src/types.js';

/**
 * `finalFixConfirmations` and `fixReproductions` across a stop and a resume
 * (#489), in `testChanges`' style: absence is preserved, a well-formed record
 * round-trips with no repairs, a damaged entry is dropped and named, and a
 * damaged container drops the key. A dropped verdict is bought again on resume
 * (`final-fix-confirm.test.ts`), so a repair can cost a turn but never invent a
 * verdict.
 */

function widest(): Record<string, unknown> {
  const file = fileURLToPath(new URL('../../tests/fixtures/state/done-widest.json', import.meta.url));
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

const read = (raw: Record<string, unknown>): ReturnType<typeof validateStoredState> =>
  validateStoredState(raw, String(raw['id']), 'C:/nowhere');

const SHA = '0123456789abcdef0123456789abcdef01234567';

const confirmations: FinalFixConfirmations = {
  round: 2,
  since: SHA,
  claims: [
    {
      id: 'guarded-one',
      severity: 'P2',
      title: 'A claim',
      detail: 'Detail.',
      suggested_fix: 'Fix it.',
      downgraded: { from: 'P1', reason: 'it cited no evidence' },
    },
  ],
  findings: [
    {
      id: 'carried-one',
      verdict: 'fixed',
      counted: 'cannot-tell',
      source: 'seat',
      seat: { provider: 'codex', model: 'default', sharesImplementerVendor: false },
      reason: 'the guard is there',
      evidence: [{ kind: 'code', path: 'src/a.ts', line: 3 }],
      countedReason: 'its evidence resolved to nothing: src/a.ts does not exist',
    },
    {
      id: 'proven-one',
      verdict: 'fixed',
      counted: 'fixed',
      source: 'reproducer',
      reason: 'its test passes now',
      evidence: [],
    },
  ],
};

const reproductions: FixReproductions = {
  round: 1,
  outcomes: [
    {
      id: 'fixed-one',
      outcome: {
        verdict: 'unproven',
        at: 'fix',
        gate: 'test',
        command: 'npm test',
        exitCode: 1,
        baseline: 'not-observed',
        reason: 'no baseline',
        archived: 'reproducers/fixed-one/witness.txt',
      },
    },
  ],
};

test('a state written before the fields existed loads with no repairs and neither record', () => {
  const { state, repairs } = read(widest());
  assert.deepEqual(repairs, []);
  assert.equal(state.finalFixConfirmations, undefined);
  assert.equal(state.fixReproductions, undefined);
});

test('well-formed records survive the round trip intact, with no repairs', () => {
  const { state, repairs } = read({ ...widest(), finalFixConfirmations: confirmations, fixReproductions: reproductions });
  assert.deepEqual(repairs, []);
  assert.deepEqual(state.finalFixConfirmations, confirmations);
  assert.deepEqual(state.fixReproductions, reproductions);
  assert.equal(JSON.stringify(state.finalFixConfirmations), JSON.stringify(confirmations));

  const noAnchor = read({ ...widest(), finalFixConfirmations: { ...confirmations, since: null } });
  assert.deepEqual(noAnchor.repairs, []);
  assert.equal(noAnchor.state.finalFixConfirmations?.since, null);
});

test('a malformed verdict is dropped by its path, and the rest are kept', () => {
  const [first, second] = confirmations.findings;
  for (const bad of [
    'nonsense',
    { ...first, verdict: 'real' },
    { ...first, counted: undefined },
    { ...first, source: 'vote' },
    { ...first, id: '' },
    { ...first, reason: 3 },
    { ...first, evidence: 'src/a.ts' },
    { ...first, evidence: [{ kind: 'guess' }] },
    { ...first, seat: { provider: 'gemini', model: 'm', sharesImplementerVendor: false } },
    { ...first, seat: { provider: 'codex', model: '', sharesImplementerVendor: false } },
    { ...first, seat: { provider: 'codex', model: 'm' } },
    { ...first, countedReason: null },
  ]) {
    const { state, repairs } = read({
      ...widest(),
      finalFixConfirmations: { ...confirmations, findings: [second, bad] },
    });
    assert.deepEqual(state.finalFixConfirmations?.findings, [second], JSON.stringify(bad));
    assert.deepEqual(
      repairs.map((r) => [r.field, r.droppedPaths]),
      [['finalFixConfirmations', ['finalFixConfirmations.findings[1]']]],
      JSON.stringify(bad),
    );
  }
});

test('a malformed claim is dropped by its path and said', () => {
  const { state, repairs } = read({
    ...widest(),
    finalFixConfirmations: { ...confirmations, claims: [{ id: 'half' }, ...confirmations.claims] },
  });
  assert.deepEqual(state.finalFixConfirmations?.claims, confirmations.claims);
  assert.deepEqual(
    repairs.map((r) => [r.field, r.droppedPaths]),
    [['finalFixConfirmations', ['finalFixConfirmations.claims[0]']]],
  );
});

test('a damaged container drops its key, once, and says so', () => {
  for (const broken of [
    { ...confirmations, round: 0 },
    { ...confirmations, since: 'HEAD' },
    { ...confirmations, claims: null },
    { ...confirmations, findings: {} },
    'nonsense',
    null,
  ]) {
    const { state, repairs } = read({ ...widest(), finalFixConfirmations: broken });
    assert.equal(state.finalFixConfirmations, undefined, JSON.stringify(broken));
    assert.deepEqual(
      repairs.map((r) => [r.field, r.droppedPaths]),
      [['finalFixConfirmations', ['finalFixConfirmations']]],
      JSON.stringify(broken),
    );
  }
});

test('the reproducers after a fix round: a bad entry is dropped by its path, a bad container drops the key', () => {
  const [good] = reproductions.outcomes;
  for (const bad of ['nonsense', { id: '', outcome: good?.outcome }, { id: 'x', outcome: { ...good?.outcome, at: 'later' } }]) {
    const { state, repairs } = read({ ...widest(), fixReproductions: { ...reproductions, outcomes: [good, bad] } });
    assert.deepEqual(state.fixReproductions, reproductions, JSON.stringify(bad));
    assert.deepEqual(
      repairs.map((r) => [r.field, r.droppedPaths]),
      [['fixReproductions', ['fixReproductions.outcomes[1]']]],
      JSON.stringify(bad),
    );
  }
  for (const broken of [{ ...reproductions, round: 0 }, { round: 1 }, 'nonsense']) {
    const { state, repairs } = read({ ...widest(), fixReproductions: broken });
    assert.equal(state.fixReproductions, undefined, JSON.stringify(broken));
    assert.deepEqual(repairs.map((r) => [r.field, r.droppedPaths]), [['fixReproductions', ['fixReproductions']]]);
  }
});
