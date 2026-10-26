import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RUNS_DIR } from '@src/run.js';
import { renderScorecard, scoreArchive, UNMEASURABLE } from '@src/scorecard.js';

/**
 * Critique findings by what the planner did with them, in `vibe stats` (#453).
 *
 * The rules are the fixer section's (#393): every figure beside the others and
 * its `of`, no percentage, "rebutted by the planner", and a revision that
 * recorded nothing counted as one that could not say - never as zero.
 */

const at = (): string => new Date().toISOString();

function charge(label: string): Record<string, unknown> {
  return { at: at(), type: 'claude_turn', label, tokens: 100 };
}

function entry(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    severity: 'P1',
    raisedBy: 'critic',
    disposition: 'fixed',
    reason: 'r',
    seats: [{ seat: 'roles.critic', provider: 'codex', model: 'gpt-x' }],
    reproducer: null,
    vote: null,
    ...over,
  };
}

function recorded(round: number, entries: Record<string, unknown>[]): Record<string, unknown> {
  return {
    at: at(),
    type: 'plan_dispositions',
    round,
    label: `revise-${String(round)}`,
    answers: round - 1,
    dispositions: entries,
    dropped: [],
    duplicates: [],
  };
}

function unreadable(round: number): Record<string, unknown> {
  return { at: at(), type: 'plan_dispositions_unreadable', round, label: `revise-${String(round)}`, answers: round - 1, reason: 'x' };
}

function compared(round: number, rebutted: string[], disputed: string[]): Record<string, unknown> {
  return {
    at: at(),
    type: 'critique_rebuttal_disputed',
    round,
    rebutted,
    disputed,
    notRaisedAgain: rebutted.filter((id) => !disputed.includes(id)),
  };
}

function archive(runs: Record<string, unknown[]>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-plan-outcomes-'));
  for (const [id, events] of Object.entries(runs)) {
    const runDir = path.join(dir, RUNS_DIR, id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, 'state.json'), JSON.stringify({ status: 'done', events }));
  }
  return dir;
}

function section(dir: string): string {
  const lines = renderScorecard(scoreArchive(dir));
  const start = lines.findIndex((l) => l.startsWith('Critique findings, by what the planner did'));
  assert.ok(start >= 0, 'the section is rendered');
  const end = lines.findIndex((l, i) => i > start && l === '');
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

test('revisions that recorded nothing say "not recorded", never zero; revise-qN is not a findings revision', () => {
  const dir = archive({ a: [charge('plan'), charge('revise-q1'), charge('revise-1'), charge('revise-2')] });
  const card = scoreArchive(dir).findings.critiqueOutcomes;
  assert.deepEqual(card.rounds, { matched: 0, measured: 0, unmeasured: 2 });
  assert.deepEqual(card.total, { of: 0, fixed: 0, rebutted: 0, deferred: 0, notAddressed: 0 });
  const text = section(dir);
  assert.match(text, /dispositions not recorded for any of 2 plan revision\(s\) \(0 unreadable, 2 recorded nothing\)/);
  assert.equal(text.includes('0 fixed'), false, 'no row of zeros stands in for missing data');
});

test('no findings revision at all says so', () => {
  assert.match(section(archive({ a: [charge('plan'), charge('critique-0')] })), /no findings revision in any run/);
});

test('rows by seat, severity and vote, the rebuttal comparison, and nothing as a percentage', () => {
  const twoSeats = [
    { seat: 'roles.critic', provider: 'codex', model: 'gpt-x' },
    { seat: 'critique.finders[0]', provider: 'claude', model: 'default' },
  ];
  const dir = archive({
    a: [
      charge('revise-1'),
      recorded(1, [
        entry('both', { seats: twoSeats, disposition: 'rebutted', vote: 'confirmed' }),
        entry('codex-only', { severity: 'P2', disposition: 'fixed' }),
        entry('nobody', { seats: null, disposition: 'rebutted', vote: 'unconfirmed' }),
        entry('mine', { raisedBy: 'human', seats: null }),
        entry('refused', { raisedBy: 'vibe', seats: null }),
      ]),
      compared(1, ['both', 'nobody'], ['both']),
      charge('revise-2'),
      unreadable(2),
      charge('revise-3'),
      recorded(3, [entry('later', { disposition: 'rebutted' })]),
      // No comparison for round 3: the critique after it never recorded one.
    ],
  });
  const card = scoreArchive(dir).findings.critiqueOutcomes;
  assert.deepEqual(card.rounds, { matched: 2, measured: 3, unmeasured: 0 });
  assert.equal(card.unreadable, 1);
  assert.deepEqual(card.total, { of: 4, fixed: 1, rebutted: 3, deferred: 0, notAddressed: 0 });
  assert.deepEqual(card.bySeat['codex/gpt-x'], { of: 3, fixed: 1, rebutted: 2, deferred: 0, notAddressed: 0 });
  assert.deepEqual(card.bySeat['claude/default'], { of: 1, fixed: 0, rebutted: 1, deferred: 0, notAddressed: 0 });
  assert.equal(card.unattributed, 1);
  assert.deepEqual(card.rebuttals, { matched: 1, measured: 2, unmeasured: 1 });
  assert.deepEqual(card.excluded, { human: 1, vibe: 1 });
  assert.deepEqual(Object.keys(card.byVote).sort(), ['confirmed', 'not voted', 'unconfirmed']);

  const text = section(dir);
  assert.match(text, /\(critic findings only; a rebuttal is the planner's call, not a verdict\)/);
  assert.match(text, /dispositions recorded for 2 of 3 plan revision\(s\); not recorded for 1 \(1 unreadable, 0 recorded nothing\)/);
  assert.match(text, /all seats: +1 fixed, 3 rebutted by the planner, 0 deferred, 0 not addressed, of 4/);
  assert.match(text, /codex\/gpt-x: +1 fixed, 2 rebutted by the planner, 0 deferred, 0 not addressed, of 3/);
  assert.match(text, /credited to no seat: +1/);
  assert.match(text, /P2: +1 fixed, 0 rebutted by the planner, 0 deferred, 0 not addressed, of 1/);
  assert.match(
    text,
    /rebutted, raised again: +1 raised again under the same id, 1 not raised again, of 3 rebutted \(1 could not say: no later critique recorded the comparison\) - same id only: a finding raised again under a new id, including a memoryless finder's renamed `<id>-f<k>`, is not detected, so this undercounts/,
  );
  assert.match(text, /vote confirmed: +0 fixed, 1 rebutted by the planner, 0 deferred, 0 not addressed, of 1/);
  assert.match(text, /not voted: +1 fixed, 1 rebutted by the planner, 0 deferred, 0 not addressed, of 2/);
  assert.match(text, /not scored, raised by: +human 1, vibe 1/);
  assert.equal(text.includes('%'), false, 'no percentage anywhere in the section');
  assert.equal(text.includes('rebutted by the fixer'), false);
});

test('a revision redone after a stop is scored by its last record', () => {
  const dir = archive({
    a: [charge('revise-1'), recorded(1, [entry('x', { disposition: 'fixed' })]), charge('revise-1'), unreadable(1)],
  });
  const card = scoreArchive(dir).findings.critiqueOutcomes;
  assert.deepEqual(card.rounds, { matched: 0, measured: 1, unmeasured: 0 });
  assert.equal(card.total.of, 0);
});

test('finding precision names both rebuttal proxies, and neither as precision', () => {
  const why = UNMEASURABLE.find((u) => u.dimension === 'finding precision')?.why ?? '';
  assert.match(why, /the fixer's rebuttal rate for review findings and the planner's for critique findings/);
  assert.match(why, /rebutted by the fixer and rebutted by the planner/);
  assert.match(why, /neither is precision/);
});
