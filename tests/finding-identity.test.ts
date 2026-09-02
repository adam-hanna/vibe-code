import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessConvergence,
  p1Signature,
  persistenceNotice,
  persistentStreak,
  recordRound,
  recycledLabelNotice,
  sameClaim,
} from '@src/run.js';
import { similarity } from '@src/similarity.js';
import { DEFAULTS } from '@src/config.js';
import type { Finding, RoundClaim, RoundRecord, Severity } from '@src/types.js';

/**
 * What makes two findings the same finding (#116).
 *
 * Three guards - the repeat arm of `assessConvergence`, `windowTurnedOver` and
 * `persistentStreak` - read a finding's **id** as its **claim**. Across 25
 * archived runs an id came back in more than one round 21 times, and all 21
 * carried a different claim: the critic reuses a label for the next defect in
 * the same area while the planner closes the last one. Not one genuine repeat
 * exists in the archive.
 *
 * The fixtures below are those sequences verbatim, titles included, read from
 * `.vibe/runs/*` on 2026-09-02. They are the population this change has to
 * separate, so they are the population it is tested against - the same reason
 * `convergence.test.ts` carries the picomatch round sequence rather than a
 * synthetic one.
 */

const ARGS = {
  repeatThreshold: DEFAULTS.loop.oscillationThreshold,
  window: DEFAULTS.loop.convergenceWindow,
};

/** Rounds 2-5 of the stalled #63 run, one label, four separate defects. */
const FACT_UNKNOWNS: readonly string[] = [
  'Partial or empty answerer output can clear blocking unknowns',
  'Fact unknown completion still fails open on human and repaired state',
  'Pending fact unknowns can still be bypassed',
  'Partial pending markers still let planning skip unknowns',
];

/** Rounds 3-6 of the #78 run, same shape. */
const FORK_CODEX: readonly string[] = [
  'A valid checkpoint can lack the required inherited Codex total',
  'An absent inherited Codex total remains ambiguous and is later treated as zero',
  'Unknown Codex-share provenance is still lost on a descendant fork',
  "The Codex evidence rule does not match this repository's event shape and cannot prove zero",
];

function claim(id: string, title: string): RoundClaim {
  return { id, title };
}

function findings(claims: readonly RoundClaim[], severity: Severity = 'P1'): Finding[] {
  return claims.map((c) => ({ ...c, severity, detail: '', suggested_fix: '' }));
}

/** A history recorded the way `guardProgress` records one since #116. */
function historyOf(...rounds: readonly (readonly RoundClaim[])[]): RoundRecord[] {
  const history: RoundRecord[] = [];
  for (const claims of rounds) {
    recordRound(
      history,
      p1Signature(findings(claims)),
      claims.length,
      claims.map((c) => c.id),
      claims,
    );
  }
  return history;
}

/** The same history as a build before #116 wrote it: ids and a hash, no claims. */
function legacyHistoryOf(...rounds: readonly (readonly RoundClaim[])[]): RoundRecord[] {
  const history: RoundRecord[] = [];
  for (const claims of rounds) {
    recordRound(
      history,
      p1Signature(findings(claims)),
      claims.length,
      claims.map((c) => c.id),
    );
  }
  return history;
}

/** One id per round, carrying the claim that round actually made. */
const recycled = (id: string, titles: readonly string[]): readonly RoundClaim[][] =>
  titles.map((t) => [claim(id, t)]);

// ---- the rule itself --------------------------------------------------------

test('the recycled labels from the archive are not the same finding', () => {
  for (const titles of [FACT_UNKNOWNS, FORK_CODEX]) {
    for (let i = 1; i < titles.length; i += 1) {
      const a = claim('an-id', titles[i - 1] ?? '');
      const b = claim('an-id', titles[i] ?? '');
      assert.equal(sameClaim(a, b), false, `${titles[i - 1] ?? ''} / ${titles[i] ?? ''}`);
      // And not marginally: the whole recycled population sits far below the
      // threshold. The census behind that is in `src/similarity.ts`.
      assert.ok(similarity(a.title, b.title) < 0.4);
    }
  }
});

test('a genuine repeat is the same finding, reworded or not', () => {
  const original = 'A valid checkpoint can lack the required inherited Codex total';
  assert.equal(sameClaim(claim('x', original), claim('x', original)), true);
  // Normalization is the same one question identity uses: punctuation and case
  // are not a new claim.
  assert.equal(sameClaim(claim('x', original), claim('x', `${original.toUpperCase()}!`)), true);
  // Reworded above the threshold, and the score says why.
  const reworded = 'A valid checkpoint can lack a required inherited Codex total';
  assert.ok(similarity(original, reworded) >= 0.6);
  assert.equal(sameClaim(claim('x', original), claim('x', reworded)), true);
});

test('a different id is a different finding whatever it says', () => {
  const title = 'Pending fact unknowns can still be bypassed';
  assert.equal(sameClaim(claim('a', title), claim('b', title)), false);
});

test('a finding with no title degrades to id-only, which is what the loop always did', () => {
  // Fail closed, in the direction of the guard that already exists: with nothing
  // to compare, the honest answer is the one that keeps the brake firing.
  assert.equal(sameClaim(claim('x', ''), claim('x', 'anything at all')), true);
  assert.equal(sameClaim(claim('x', '   '), claim('x', '')), true);
});

// ---- the repeat arm ---------------------------------------------------------

test('four rounds of one recycled label do not stop the run', () => {
  // What the loop used to see: one id, four rounds, an unchanging signature. The
  // planner closed a defect every round and the run was told the opposite.
  const history = historyOf(...recycled('unanswered-fact-unknowns-proceed', FACT_UNKNOWNS));

  assert.equal(assessConvergence(history, { ...ARGS, cap: 12, round: 4 }), null);
});

test('the same four rounds DO stop a build that recorded no claims', () => {
  // The legacy fallback, asserted rather than assumed: a resumed history from
  // before this change has only a hash of its ids, and it must behave exactly as
  // it did - including being wrong in exactly the same way.
  const history = legacyHistoryOf(...recycled('unanswered-fact-unknowns-proceed', FACT_UNKNOWNS));

  assert.match(
    String(assessConvergence(history, { ...ARGS, cap: 12, round: 4 })),
    /the same P1 set came back/,
  );
});

test('a genuine repeat still stops the run, which is what the arm is for', () => {
  const stuck = claim('regex-group-prefix-not-literalized', 'The group prefix is not literalized');
  const history = historyOf([stuck], [stuck], [stuck], [stuck]);

  assert.match(
    String(assessConvergence(history, { ...ARGS, cap: 12, round: 4 })),
    /the same P1 set came back/,
  );
});

test('a window that spans the upgrade falls back rather than comparing halves', () => {
  // A resume mid-run: earlier rounds have no claims, later ones do. Comparing a
  // claim against a bare id is not a comparison, so the whole window falls back.
  const stuck = claim('same-id', 'The same claim every round');
  const history = legacyHistoryOf([stuck], [stuck]);
  history.push(...historyOf([stuck], [stuck]));

  assert.match(
    String(assessConvergence(history, { ...ARGS, cap: 12, round: 4 })),
    /the same P1 set came back/,
  );
});

// ---- the persistence notice -------------------------------------------------

const NOTICE = { minRounds: DEFAULTS.loop.oscillationThreshold + 1, capLimit: 'maxPlanRounds (12)', ceilings: [] };

test('a recycled label is not reported as a finding that has been blocking for four rounds', () => {
  // The line the stalled #63 run printed - `"unanswered-fact-unknowns-proceed"
  // has been blocking for 4 rounds running` - over four separate defects with
  // four separate fixes. It was read as evidence the loop was stuck; it was
  // evidence of the loop working.
  const history = historyOf(...recycled('unanswered-fact-unknowns-proceed', FACT_UNKNOWNS));

  assert.equal(persistentStreak(history)?.rounds, 1);
  assert.equal(persistenceNotice(history, NOTICE), null);
});

test('a claim that really did persist is still reported, and still named', () => {
  const stuck = claim('regex-group-prefix-not-literalized', 'The group prefix is not literalized');
  const history = historyOf(
    [stuck, claim('c-1', 'One')],
    [stuck, claim('d-1', 'Two')],
    [stuck, claim('e-1', 'Three')],
    [stuck, claim('f-1', 'Four')],
  );

  assert.deepEqual(persistentStreak(history), {
    id: 'regex-group-prefix-not-literalized',
    rounds: 4,
  });
  assert.match(String(persistenceNotice(history, NOTICE)), /has been blocking for 4 rounds/);
});

// ---- the turnover excuse ----------------------------------------------------

/**
 * The excuse is bounded: `flatRun(history) === window`, so the flat run has to
 * have STARTED inside the window. Hence the leading round of two - a fourth flat
 * round would put the start outside it and the excuse would not apply, which is
 * the existing behaviour and not what these two cases are about.
 */
const LEAD = [claim('lead-a', 'One'), claim('lead-b', 'Two')];

test('a flat count under one recycled label counts as turned over', () => {
  // `windowTurnedOver` grants one window's grace to a flat count whose findings
  // genuinely rotated. A label reused across the window used to defeat it - the
  // trend arm firing on a run that was making progress every round.
  const id = 'unanswered-fact-unknowns-proceed';
  const history = historyOf(LEAD, ...recycled(id, FACT_UNKNOWNS.slice(0, 3)));

  assert.equal(assessConvergence(history, { ...ARGS, cap: 4, round: 4 }), null);
});

test('a flat count of one unchanging claim is still deadlock', () => {
  const stuck = claim('same-id', 'The same claim every round');
  const history = historyOf(LEAD, [stuck], [stuck], [stuck]);

  assert.match(
    String(assessConvergence(history, { ...ARGS, cap: 4, round: 4 })),
    /the same P1 set came back|has not fallen/,
  );
});

// ---- the record of the disagreement ----------------------------------------

test('a brake that did not fire says so, with both claims and the score', () => {
  // The mitigation for what the census could not measure: it has no positive
  // samples, so a genuine repeat reworded below the threshold would slip. That
  // costs a visible, checkable line rather than a silent omission - the same
  // answer REPHRASED.md gives for questions.
  const history = historyOf(...recycled('unanswered-fact-unknowns-proceed', FACT_UNKNOWNS));

  const said = recycledLabelNotice(history, DEFAULTS.loop.oscillationThreshold);
  assert.match(String(said), /unanswered-fact-unknowns-proceed/);
  assert.match(String(said), /Partial pending markers still let planning skip unknowns/);
  assert.match(String(said), /that is a defect worth reporting/);
});

test('nothing is said when the two rules agree', () => {
  const stuck = claim('same-id', 'The same claim every round');
  assert.equal(
    recycledLabelNotice(historyOf([stuck], [stuck], [stuck]), DEFAULTS.loop.oscillationThreshold),
    null,
  );
  // Nor when the ids themselves turned over: the old rule would not have fired
  // either, so there is no disagreement to report.
  assert.equal(
    recycledLabelNotice(
      historyOf([claim('a', 'One')], [claim('b', 'Two')], [claim('c', 'Three')]),
      DEFAULTS.loop.oscillationThreshold,
    ),
    null,
  );
});
