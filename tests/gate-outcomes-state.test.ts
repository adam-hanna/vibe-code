import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateStoredState } from '@src/stored.js';

/**
 * What `gateOutcomes` does to a state file that has never heard of it.
 *
 * The rule is #44's: absence is preserved, never repaired. Absent means no gate
 * has run - a plan-only run, or one that stopped before the gate - while `[]`
 * would mean gates ran and there were none, which nothing produces and which the
 * exit rule would read as "verified". So a 1.1.0 state must load untouched.
 *
 * The fixture is a real post-run `state.json`, not a constructed one: a claim
 * about what older state looks like should be settled by an older state file.
 */

function widest(): Record<string, unknown> {
  const file = fileURLToPath(
    new URL('../../tests/fixtures/state/done-widest.json', import.meta.url),
  );
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/**
 * The fixture's own id is passed back in: `validateStoredState` refuses a state
 * whose id does not name the directory it was loaded from, and that refusal is
 * not what any of these cases are about.
 */
const read = (raw: Record<string, unknown>): ReturnType<typeof validateStoredState> =>
  validateStoredState(raw, String(raw['id']), 'C:/nowhere');

test('a 1.1.0 state loads with no repairs and no gateOutcomes invented', () => {
  const { state, repairs } = read(widest());

  assert.deepEqual(repairs, []);
  assert.equal('gateOutcomes' in state, false);
  assert.equal(state.gateOutcomes, undefined);
});

test('a well-formed record survives the round trip intact', () => {
  const raw = widest();
  raw['gateOutcomes'] = [
    { name: 'typecheck', status: 'passed', command: 'npm run typecheck', runs: 1, required: true },
    { name: 'qa', status: 'unavailable', command: null, runs: 0, required: false },
  ];

  const { state, repairs } = read(raw);

  assert.deepEqual(repairs, []);
  assert.equal(state.gateOutcomes?.length, 2);
  assert.equal(state.gateOutcomes?.[1]?.required, false);
});

test('a malformed list is repaired to empty, which is no evidence rather than no problems', () => {
  const { state, repairs } = read({ ...widest(), gateOutcomes: 'nonsense' });
  assert.deepEqual(state.gateOutcomes, []);
  assert.deepEqual(repairs.map((r) => r.field), ['gateOutcomes']);
});

test('one unreadable entry discards the whole gate record', () => {
  // Unlike every other repaired list in this file, which is history: this one is
  // evidence the exit code is computed from. A three-gate record whose two
  // failures were dropped as malformed reads exactly like a one-gate run that
  // passed, and would exit 0 saying so.
  const partial = read({
    ...widest(),
    gateOutcomes: [
      { name: 'test', status: 'passed', command: 'npm test', runs: 3, required: true },
      // No `required`: the exit code is computed from it, so guessing `false`
      // would turn an unverified run into a clean one.
      { name: 'qa', status: 'unavailable', command: null, runs: 0 },
      { name: 'lint', status: 'sideways', command: 'npm run lint', runs: 1, required: true },
    ],
  });

  assert.deepEqual(partial.state.gateOutcomes, []);
  assert.deepEqual(partial.repairs.map((r) => r.field), ['gateOutcomes']);
  // Said out loud, per the repair log's contract, rather than silently.
  assert.match(partial.repairs[0]?.replacedWith ?? '', /partial gate record/);
});

test('a stored environment without verifyGates keeps its facts and invents no list', () => {
  const raw = widest();
  const environment = raw['environment'];
  assert.ok(environment !== undefined, 'the fixture no longer carries an environment section');

  const { state, repairs } = read(raw);

  assert.deepEqual(repairs, []);
  // The pair `readEnvironment` refuses a record without is still there, which is
  // why it was kept beside the gate list rather than replaced by it.
  assert.equal(typeof state.environment?.verifyRuns, 'number');
  assert.equal(state.environment?.verifyGates, undefined);
});

test('a malformed verifyGates entry is dropped without taking the environment with it', () => {
  const raw = widest();
  const environment = { ...(raw['environment'] as Record<string, unknown>) };
  environment['verifyGates'] = [
    { name: 'test', command: 'npm test', runs: 3 },
    { name: 'qa', command: null },
  ];
  raw['environment'] = environment;

  const { state, repairs } = read(raw);

  assert.deepEqual(state.environment?.verifyGates?.map((g) => g.name), ['test']);
  assert.deepEqual(repairs.map((r) => r.field), ['environment']);
  assert.equal(typeof state.environment?.verifyRuns, 'number');
});

// ---- the artifacts a failing gate preserved (#62) ---------------------------

/** One gate outcome carrying a well-formed artifact record. */
function withArtifacts(artifacts: unknown): Record<string, unknown> {
  return {
    ...widest(),
    gateOutcomes: [
      { name: 'qa', status: 'failed', command: 'npx playwright test', runs: 1, required: true, artifacts },
      { name: 'test', status: 'passed', command: 'npm test', runs: 3, required: true },
    ],
  };
}

const GOOD_ARTIFACTS = {
  dir: 'artifacts/qa/round-1',
  bytes: 2048,
  entries: [
    { path: 'playwright-report', status: 'copied', files: 12, bytes: 2048, skippedLinks: ['trace/link'] },
    { path: 'test-results/summary.json', status: 'missing', reason: '"test-results/summary.json" was not produced' },
  ],
};

test('an artifact record survives the round trip whole', () => {
  const { state, repairs } = read(withArtifacts(GOOD_ARTIFACTS));

  assert.deepEqual(repairs, []);
  const artifacts = state.gateOutcomes?.[0]?.artifacts;
  assert.equal(artifacts?.dir, 'artifacts/qa/round-1');
  assert.equal(artifacts?.bytes, 2048);
  assert.deepEqual(artifacts?.entries.map((e) => e.status), ['copied', 'missing']);
  assert.deepEqual(artifacts?.entries[0]?.skippedLinks, ['trace/link']);
  // Absent stays absent on the gate that preserved nothing: "nothing was asked
  // for" is not an empty record.
  assert.equal(state.gateOutcomes?.[1]?.artifacts, undefined);
});

test('a malformed artifact record costs that field alone, and is logged', () => {
  // The one field on a gate outcome that does NOT cost the whole list. The
  // all-or-nothing rule above exists because the exit code is computed from
  // `status` and `required`; nothing computes anything from this, so discarding
  // a run's gate record over a damaged pointer to a report would be the same
  // mistake pointing the other way.
  const { state, repairs } = read(withArtifacts('nonsense'));

  assert.equal(state.gateOutcomes?.length, 2);
  assert.equal(state.gateOutcomes?.[0]?.status, 'failed');
  assert.equal(state.gateOutcomes?.[0]?.artifacts, undefined);
  // Logged, so `loadRun`'s `state_repaired` event makes the loss visible even
  // though the field is not.
  assert.deepEqual(repairs.map((r) => r.field), ['gateOutcomes[0].artifacts']);
});

test('one damaged entry inside the record is dropped, keeping the rest', () => {
  const { state, repairs } = read(
    withArtifacts({
      ...GOOD_ARTIFACTS,
      entries: [GOOD_ARTIFACTS.entries[0], { path: 'x', status: 'invented' }],
    }),
  );

  assert.deepEqual(state.gateOutcomes?.[0]?.artifacts?.entries.map((e) => e.path), [
    'playwright-report',
  ]);
  assert.deepEqual(repairs.map((r) => r.field), ['gateOutcomes[0].artifacts.entries']);
});

test('a malformed optional member is dropped without costing its entry', () => {
  const { state, repairs } = read(
    withArtifacts({
      ...GOOD_ARTIFACTS,
      entries: [{ path: 'playwright-report', status: 'copied', files: 'lots', bytes: 2048 }],
    }),
  );

  const first = state.gateOutcomes?.[0]?.artifacts?.entries[0];
  assert.equal(first?.status, 'copied');
  assert.equal(first?.files, undefined);
  // Never guessed at a number: "lots" is not a count, and inventing one here is
  // exactly what this repo refuses everywhere else.
  assert.equal(first?.bytes, 2048);
  assert.deepEqual(repairs.map((r) => r.field), ['gateOutcomes[0].artifacts.entries[0].files']);
});
