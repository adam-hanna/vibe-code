import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RUNS_DIR } from '@src/run.js';
import { renderScorecard, scoreArchive, SCORECARD_VERSION } from '@src/scorecard.js';

/**
 * Review findings by what the fixer did with them, in `vibe stats` (#393).
 *
 * The rules under test are the scorecard's own, applied to a new section: each
 * figure travels with the others and its denominator, a round that recorded
 * nothing is counted as one that could not say, and "same id raised again",
 * "not reviewed again" and "not recorded" are three different answers.
 */

const at = (): string => new Date().toISOString();

function charge(label: string): Record<string, unknown> {
  return { at: at(), type: 'claude_turn', label, tokens: 100 };
}

function entry(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    severity: 'P1',
    raisedBy: 'reviewer',
    disposition: 'fixed',
    reason: 'r',
    seats: [{ seat: 'roles.reviewer', provider: 'codex', model: 'gpt-x' }],
    reproducer: null,
    ...over,
  };
}

function recorded(round: number, entries: Record<string, unknown>[], final = false): Record<string, unknown> {
  const label = `${final ? 'final-fix' : 'fix'}-${String(round)}`;
  return { at: at(), type: 'fix_dispositions', round, label, answers: round - 1, dispositions: entries, dropped: [], duplicates: [] };
}

function unreadable(round: number): Record<string, unknown> {
  return { at: at(), type: 'fix_dispositions_unreadable', round, label: `fix-${String(round)}`, answers: round - 1, reason: 'x' };
}

interface Run {
  state: Record<string, unknown>;
  files?: Record<string, string>;
}

function archive(runs: Record<string, Run>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-outcomes-'));
  for (const [id, run] of Object.entries(runs)) {
    const runDir = path.join(dir, RUNS_DIR, id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ status: 'done', events: [], ...run.state }));
    for (const [name, body] of Object.entries(run.files ?? {})) writeFileSync(path.join(runDir, name), body);
  }
  return dir;
}

function review(ids: readonly string[]): string {
  return JSON.stringify({ verdict: 'REVISE', summary: '', findings: ids.map((id) => ({ id, severity: 'P1' })) });
}

test('per-seat rows carry their denominators, and a finding with two seats counts once in the totals', () => {
  const twoSeats = [
    { seat: 'roles.reviewer', provider: 'codex', model: 'gpt-x' },
    { seat: 'review.finders[0]', provider: 'claude', model: 'default' },
  ];
  const dir = archive({
    a: {
      state: {
        events: [
          charge('fix-1'),
          recorded(1, [
            entry('both', { seats: twoSeats, disposition: 'rebutted', severity: 'P1' }),
            entry('codex-only', { disposition: 'fixed', severity: 'P2' }),
          ]),
        ],
      },
      files: { 'code-review-1.json': review([]) },
    },
  });
  const card = scoreArchive(dir);
  const o = card.findings.outcomes;
  assert.equal(card.version, SCORECARD_VERSION);
  assert.equal(SCORECARD_VERSION, 1);

  assert.deepEqual(o.total, { of: 2, fixed: 1, rebutted: 1, deferred: 0, notAddressed: 0 });
  assert.deepEqual(o.bySeverity, {
    P1: { of: 1, fixed: 0, rebutted: 1, deferred: 0, notAddressed: 0 },
    P2: { of: 1, fixed: 1, rebutted: 0, deferred: 0, notAddressed: 0 },
  });
  assert.deepEqual(o.bySeat, {
    'codex/gpt-x': { of: 2, fixed: 1, rebutted: 1, deferred: 0, notAddressed: 0 },
    'claude/default': { of: 1, fixed: 0, rebutted: 1, deferred: 0, notAddressed: 0 },
  });
  // The seat rows add up to more than the total, and that is the expected shape.
  const seatSum = Object.values(o.bySeat).reduce((n, r) => n + r.of, 0);
  assert.equal(seatSum, 3);
  assert.equal(o.total.of, 2);

  const text = renderScorecard(card).join('\n');
  assert.match(text, /codex\/gpt-x:\s+1 fixed, 1 rebutted by the fixer, 0 deferred, 0 not addressed, of 2/);
  assert.match(text, /claude\/default:\s+0 fixed, 1 rebutted by the fixer, 0 deferred, 0 not addressed, of 1/);
  assert.match(text, /all seats:\s+1 fixed, 1 rebutted by the fixer, 0 deferred, 0 not addressed, of 2/);
  assert.match(text, /dispositions recorded for 1 of 1 fix round\(s\)/);
});

test('unreadable rounds and rounds that recorded nothing are counted, not left out', () => {
  const dir = archive({
    a: { state: { events: [charge('fix-1'), recorded(1, [entry('x')]), charge('fix-2'), unreadable(2)] } },
    // A round charged before #393 existed: no event either way.
    old: { state: { events: [charge('fix-1'), charge('verify-fix-1'), charge('review-0')] } },
  });
  const card = scoreArchive(dir);
  assert.deepEqual(card.findings.outcomes.rounds, { matched: 1, measured: 2, unmeasured: 1 });
  assert.equal(card.findings.outcomes.unreadable, 1);
  assert.match(
    renderScorecard(card).join('\n'),
    /dispositions recorded for 1 of 3 fix round\(s\); not recorded for 2 \(1 unreadable, 1 recorded nothing\)/,
  );
});

test('runs that predate the event read as not recorded, with no percentage at all', () => {
  const dir = archive({
    a: { state: { events: [charge('fix-1'), charge('final-fix-2')] } },
    b: { state: { events: [charge('fix-1')] } },
  });
  const card = scoreArchive(dir);
  assert.deepEqual(card.findings.outcomes.rounds, { matched: 0, measured: 0, unmeasured: 3 });
  const text = renderScorecard(card).join('\n');
  const section = text.slice(text.indexOf('Review findings, by what the fixer did'), text.indexOf('\nQuestions'));
  assert.match(section, /dispositions not recorded for any of 3 fix round\(s\) \(0 unreadable, 3 recorded nothing\)/);
  assert.equal(section.includes('%'), false);
  assert.equal(section.includes('all seats'), false, 'no rows over an empty sample');
});

test('"precision" appears only in the UNMEASURABLE entry', () => {
  const dir = archive({ a: { state: { events: [charge('fix-1'), recorded(1, [entry('x', { disposition: 'rebutted' })])] } } });
  const lines = renderScorecard(scoreArchive(dir));
  const mentions = lines.filter((l) => /precision/i.test(l));
  assert.equal(mentions.length, 1);
  assert.match(mentions[0] ?? '', /finding precision:.*the fixer's rebuttal rate.*the fixer can be wrong too.*not a verdict/);
});

test('same id raised again, not reviewed again, and not recorded are three different answers', () => {
  const dir = archive({
    raised: {
      state: { events: [charge('fix-1'), recorded(1, [entry('again'), entry('gone')])] },
      files: { 'code-review-1.json': review(['again', 'new-one']) },
    },
    final: {
      state: {
        events: [charge('final-fix-1'), recorded(1, [entry('carried', { reproducer: 'reproduced' })], true)],
        outstanding: [
          {
            id: 'carried',
            reproducerOutcomes: [
              { verdict: 'reproduced', at: 'review' },
              { verdict: 'did-not-reproduce', at: 'final-fix' },
            ],
          },
        ],
      },
    },
    // The run stopped before the next review wrote its artifact.
    missing: { state: { events: [charge('fix-1'), recorded(1, [entry('unknown')])] } },
    // And one whose next artifact cannot be read.
    garbled: {
      state: { events: [charge('fix-1'), recorded(1, [entry('unknown-too')])] },
      files: { 'code-review-1.json': '{ not json' },
    },
  });
  const o = scoreArchive(dir).findings.outcomes;
  assert.deepEqual(o.raisedAgain, { matched: 1, measured: 2, unmeasured: 2 });
  assert.equal(o.notReviewedAgain, 1);
  assert.deepEqual(o.finalFixReproducer, { 'did-not-reproduce': 1 });
  assert.deepEqual(o.reproduced, { of: 1, fixed: 1, rebutted: 0, deferred: 0, notAddressed: 0 });

  const text = renderScorecard(scoreArchive(dir)).join('\n');
  assert.match(text, /same id raised again:\s+1 of 2 findings - 50%, 2 could not say \(next round\)/);
  assert.match(text, /not reviewed again:\s+1 \(final fix round\)/);
  assert.match(text, /carried P1, after final fix:\s+reproducer 1 did-not-reproduce/);
});

test('human and vibe findings are recorded but scored nowhere; unattributed reviewer findings count in totals only', () => {
  const dir = archive({
    a: {
      state: {
        events: [
          charge('fix-1'),
          recorded(1, [
            entry('mine', { raisedBy: 'human', seats: null }),
            entry('vibes', { raisedBy: 'vibe', seats: null }),
            entry('nobody', { seats: null }),
          ]),
        ],
      },
    },
  });
  const card = scoreArchive(dir);
  const o = card.findings.outcomes;
  assert.deepEqual(o.total, { of: 1, fixed: 1, rebutted: 0, deferred: 0, notAddressed: 0 });
  assert.deepEqual(o.excluded, { human: 1, vibe: 1 });
  assert.equal(o.unattributed, 1);
  assert.deepEqual(o.bySeat, {});
  assert.deepEqual(o.raisedAgain, { matched: 0, measured: 0, unmeasured: 1 }, 'humans are not observed either');
  const text = renderScorecard(card).join('\n');
  assert.match(text, /credited to no seat:\s+1/);
  assert.match(text, /not scored, raised by:\s+human 1, vibe 1/);
});

test('an entry with a severity outside P0-P3 is skipped whole, not tallied under a row nobody gave', () => {
  const dir = archive({
    a: { state: { events: [charge('fix-1'), recorded(1, [entry('ok'), entry('damaged', { severity: 'P9' })])] } },
  });
  const o = scoreArchive(dir).findings.outcomes;
  assert.equal(o.total.of, 1);
  assert.deepEqual(Object.keys(o.bySeverity), ['P1']);
  assert.equal(o.bySeat['codex/gpt-x']?.of, 1);
});

test('a round recorded twice is counted once, as its last record says', () => {
  const dir = archive({
    readableLast: { state: { events: [charge('fix-1'), unreadable(1), charge('fix-1'), recorded(1, [entry('x')])] } },
    unreadableLast: { state: { events: [charge('fix-1'), recorded(1, [entry('y')]), charge('fix-1'), unreadable(1)] } },
  });
  const o = scoreArchive(dir).findings.outcomes;
  assert.deepEqual(o.rounds, { matched: 1, measured: 2, unmeasured: 0 });
  assert.equal(o.unreadable, 1);
  assert.equal(o.total.of, 1, 'only the readable retry is scored');
});
