import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { p1Signature, planStall, recordRound } from '@src/run.js';
import { blockers } from '@src/validate.js';
import type { Finding, FindingAuthor, RoundRecord, Severity } from '@src/types.js';

// The plan-stall detector (#394), replayed over three archived plan loops. The
// fixtures are copied from `.vibe/runs/<run>/plan-critique-<n>.json` in the main
// checkout, keeping only `id`, `severity`, `defer` and `raisedBy` per finding;
// a test never reads `.vibe/`.

interface FixtureFinding {
  id: string;
  severity: Severity;
  defer?: boolean;
  raisedBy?: FindingAuthor;
}

interface Fixture {
  run: string;
  critiques: { file: string; findings: FixtureFinding[] }[];
}

function fixture(name: string): Fixture {
  const file = fileURLToPath(new URL(`../../tests/fixtures/plan-stall/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(file, 'utf8')) as Fixture;
}

function finding(f: FixtureFinding): Finding {
  return {
    id: f.id,
    severity: f.severity,
    title: f.id,
    detail: '',
    suggested_fix: '',
    ...(f.defer === undefined ? {} : { defer: f.defer }),
    ...(f.raisedBy === undefined ? {} : { raisedBy: f.raisedBy }),
  };
}

/** One record per critique file, built the way `guardProgress` builds `p1Rounds`. */
function historyOf(fx: Fixture): RoundRecord[] {
  const history: RoundRecord[] = [];
  for (const critique of fx.critiques) {
    const all = critique.findings.map(finding);
    const b = blockers(all);
    recordRound(
      history,
      p1Signature(all),
      b.length,
      b.map((f) => f.id),
      b.map((f) => ({ id: f.id, title: f.title })),
    );
  }
  return history;
}

/** A hand-built history: one record per round, from its blocking ids. */
function rounds(...specs: readonly (readonly string[])[]): RoundRecord[] {
  const history: RoundRecord[] = [];
  for (const ids of specs) recordRound(history, null, ids.length, ids);
  return history;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * Judge every position in order, as the caller will once per critique, and
 * assume the step-back never helps: each stall only moves `lastStall`.
 */
function replay(history: readonly RoundRecord[], stallAfter: number, human = NONE): number[] {
  const stalls: number[] = [];
  let lastStall: number | null = null;
  for (let r = 0; r < history.length; r += 1) {
    if (planStall(history.slice(0, r + 1), { stallAfter, lastStall, human }) !== null) {
      stalls.push(r);
      lastStall = r;
    }
  }
  return stalls;
}

const B246 = historyOf(fixture('246-b'));
const P346 = historyOf(fixture('346'));
const A246 = historyOf(fixture('246-a'));

test('the fixtures hold one record per archived critique', () => {
  assert.equal(B246.length, 19);
  assert.equal(P346.length, 15);
  assert.equal(A246.length, 5);
});

test('#246-b stalls first at position 4, and again at 7 when the step-back changes nothing', () => {
  assert.deepEqual(replay(B246, 3), [4, 7, 10, 12, 14, 16]);
});

test('#346 stalls first at position 4, and again at 6', () => {
  assert.deepEqual(replay(P346, 3), [4, 6, 8, 12]);
});

test('stallAfter 2, 3 and 4 give the same first two stalls, and the converging run never stalls', () => {
  for (const stallAfter of [2, 3, 4]) {
    assert.deepEqual(replay(B246, stallAfter).slice(0, 2), [4, 7], `246-b at ${stallAfter}`);
    assert.deepEqual(replay(P346, stallAfter).slice(0, 2), [4, 6], `346 at ${stallAfter}`);
    assert.deepEqual(replay(A246, stallAfter), [], `246-a at ${stallAfter}`);
  }
});

test('a stall reports the window it judged, counted from the ids', () => {
  // #246-b's critiques 2-4 were 2/1, 1/1, 3/3 (blocking/new).
  assert.deepEqual(planStall(B246.slice(0, 5), { stallAfter: 3, lastStall: null, human: NONE }), {
    counts: [2, 1, 3],
    fresh: [1, 1, 3],
  });
});

test('stallAfter that is not a positive whole number turns detection off', () => {
  for (const stallAfter of [0, -1, 2.5, Number.NaN]) {
    assert.deepEqual(replay(B246, stallAfter), [], `stallAfter ${stallAfter}`);
  }
});

test('no stall at a position below stallAfter', () => {
  const upTo4 = B246.slice(0, 5);
  assert.notEqual(planStall(upTo4, { stallAfter: 4, lastStall: null, human: NONE }), null);
  assert.equal(planStall(upTo4, { stallAfter: 5, lastStall: null, human: NONE }), null);
  // And stallAfter 1 still needs two earlier rounds to compare against.
  assert.equal(planStall(rounds(['a'], ['b']), { stallAfter: 1, lastStall: null, human: NONE }), null);
});

test('a step-back gets one full round before it can be judged', () => {
  // #246-b at position 5 would stall on its own, but not one round after a stall.
  const upTo5 = B246.slice(0, 6);
  assert.notEqual(planStall(upTo5, { stallAfter: 3, lastStall: null, human: NONE }), null);
  assert.equal(planStall(upTo5, { stallAfter: 3, lastStall: 4, human: NONE }), null);

  // Every round all new: each position stalls alone, but the replay skips lastStall + 1.
  const allNew = rounds(['a'], ['b'], ['c'], ['d'], ['e']);
  assert.notEqual(planStall(allNew.slice(0, 4), { stallAfter: 2, lastStall: null, human: NONE }), null);
  assert.deepEqual(replay(allNew, 2), [2, 4]);
});

test('a human-raised id counts neither as blocking nor as new', () => {
  // As blocking: the only latest blocker is a person's, so the count is zero.
  const onlyHuman = rounds(['a'], ['b'], ['h']);
  assert.deepEqual(planStall(onlyHuman, { stallAfter: 2, lastStall: null, human: NONE }), {
    counts: [1, 1, 1],
    fresh: [1, 1, 1],
  });
  assert.equal(planStall(onlyHuman, { stallAfter: 2, lastStall: null, human: new Set(['h']) }), null);

  // As new: without the set the latest rounds are 3 of 3 new; with it the count
  // still passes (1 >= 1) but nothing left is new.
  const newOnlyByHuman = rounds(['a'], ['h1'], ['a', 'h2']);
  assert.deepEqual(planStall(newOnlyByHuman, { stallAfter: 2, lastStall: null, human: NONE }), {
    counts: [1, 1, 2],
    fresh: [1, 1, 1],
  });
  assert.equal(
    planStall(newOnlyByHuman, { stallAfter: 2, lastStall: null, human: new Set(['h1', 'h2']) }),
    null,
  );

  // And a stall that survives the exclusion reports the counts without them.
  const mixed = rounds(['a'], ['b'], ['c', 'h1', 'h2']);
  assert.deepEqual(planStall(mixed, { stallAfter: 2, lastStall: null, human: NONE })?.counts, [1, 1, 3]);
  assert.deepEqual(planStall(mixed, { stallAfter: 2, lastStall: null, human: new Set(['h1', 'h2']) }), {
    counts: [1, 1, 1],
    fresh: [1, 1, 1],
  });
});

test('an id repeated within one record counts once', () => {
  assert.deepEqual(planStall(rounds(['a'], ['b'], ['c', 'c', 'c']), { stallAfter: 2, lastStall: null, human: NONE }), {
    counts: [1, 1, 1],
    fresh: [1, 1, 1],
  });
});

test('counts come from ids, never from record.count', () => {
  const inflated: RoundRecord[] = [
    { signature: null, count: 9, ids: ['a'] },
    { signature: null, count: 9, ids: ['b'] },
    { signature: null, count: 9, ids: ['c'] },
  ];
  assert.deepEqual(planStall(inflated, { stallAfter: 2, lastStall: null, human: NONE })?.counts, [1, 1, 1]);

  // A count that would stall over ids that are empty does not.
  const empty: RoundRecord[] = [
    { signature: null, count: 1, ids: ['a'] },
    { signature: null, count: 1, ids: ['b'] },
    { signature: null, count: 5, ids: [] },
  ];
  assert.equal(planStall(empty, { stallAfter: 2, lastStall: null, human: NONE }), null);
});

test('a record written before ids existed fails closed, wherever it sits', () => {
  const stalls = rounds(['a'], ['b'], ['c'], ['d']);
  assert.notEqual(planStall(stalls, { stallAfter: 2, lastStall: null, human: NONE }), null);
  for (let k = 0; k < stalls.length; k += 1) {
    const legacy = stalls.map((rec, i) => (i === k ? { signature: null, count: 3 } : rec));
    assert.equal(planStall(legacy, { stallAfter: 2, lastStall: null, human: NONE }), null, `legacy at ${k}`);
  }
});
