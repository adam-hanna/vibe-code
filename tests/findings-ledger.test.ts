import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commitFork, planFork } from '@src/fork.js';
import { readLedger } from '@src/findings-ledger.js';
import { critiquePrompt, reviewPrompt } from '@src/prompts.js';
import { listCheckpoints, loadRun } from '@src/run.js';
import { REVIEW_LEDGER_SCHEMA } from '@src/schemas.js';
import type { Finding, ReproducerOutcome, RunState } from '@src/types.js';
import { committing, freshRun, p1, planFixture, report, reviewingRun, work } from './helpers/loop-harness.js';
import { driveReview, ledgerOf, threeRoundConfig, threeRounds } from './helpers/ledger-loop.js';
import type { Turn } from './helpers/ledger-loop.js';
import { FILE_LINK_SKIP, tryLink } from './helpers/links.js';

/**
 * The findings ledger, with `loop.findingsLedger` on (#498).
 *
 * From round 2 on, every review prompt - the reviewer's, every part of a split
 * round, every finder's - lists what each earlier round's `code-review-<k>.json`
 * recorded, by identity only, numbered as the prompts numbered the rounds.
 * The off side is `findings-ledger-off.test.ts`; `prior_id` itself is
 * `prior-id.test.ts`.
 */

const HEADING = '## Findings from earlier rounds';

const byLabel = (turns: readonly Turn[], label: string): Turn => {
  const found = turns.find((t) => t.label === label);
  assert.ok(found !== undefined, `no ${label} in ${turns.map((t) => t.label).join(', ')}`);
  return found;
};

// ---- through the loop --------------------------------------------------------

test('round 1 has no ledger, every review turn gets the prior_id schema, and a null prior_id is recorded as null', async () => {
  const state = reviewingRun({ prefix: 'vibe-ledger-round1-' });
  const { turns } = await driveReview(state, threeRoundConfig(true));
  for (const label of ['review-0', 'review-0-f1']) {
    const t = byLabel(turns, label);
    assert.ok(!t.prompt.includes(HEADING), `${label} has a ledger in round 1`);
    assert.equal(t.schema, REVIEW_LEDGER_SCHEMA, label);
  }
  for (const t of turns.filter((x) => x.label.startsWith('review-'))) {
    assert.equal(t.schema, REVIEW_LEDGER_SCHEMA, t.label);
  }
  const recorded = JSON.parse(readFileSync(path.join(state.dir, 'code-review-0.json'), 'utf8')) as {
    findings: Finding[];
  };
  const [only] = recorded.findings;
  assert.ok(only !== undefined);
  assert.equal(only.prior_id, null, 'a finding that declared none is recorded as null');
  assert.deepEqual(
    only.foundBy?.map((s) => s.priorId),
    [null, null],
    "and so is each seat's",
  );
});

test("rounds 2 and 3 list the earlier rounds' findings in the reviewer's and the finder's prompt, oldest first", async () => {
  const state = reviewingRun({ prefix: 'vibe-ledger-later-' });
  const { turns } = await driveReview(state, threeRoundConfig(true));
  const line1 = '- Round 1 - `first-defect` - P1 - Finding first-defect - implemented.ts:1 - reproducer: no reproducer';
  const line2 = '- Round 2 - `second-defect` - P1 - Finding second-defect - implemented.ts:1 - reproducer: no reproducer';
  for (const label of ['review-1', 'review-1-f1']) {
    const section = ledgerOf(byLabel(turns, label).prompt);
    assert.ok(section !== null, `${label} has no ledger`);
    assert.ok(section.includes(line1), `${label}: code-review-0.json is listed as round 1\n${section}`);
    assert.ok(!section.includes('Round 2'), label);
  }
  for (const label of ['review-2', 'review-2-f1']) {
    const section = ledgerOf(byLabel(turns, label).prompt) ?? '';
    const first = section.indexOf(line1);
    const second = section.indexOf(line2);
    assert.ok(first >= 0 && second > first, `${label}: both rounds, oldest first\n${section}`);
  }
  // The ledger sits after the report and before the diff.
  const prompt = byLabel(turns, 'review-1').prompt;
  assert.ok(prompt.indexOf(HEADING) < prompt.indexOf('## Files changed'));
});

test('every part of a split round, and every finder part, carries the ledger', async () => {
  const state = reviewingRun({ prefix: 'vibe-ledger-chunked-', change: false });
  const line = `${'x'.repeat(79)}\n`;
  for (const name of ['one.txt', 'two.txt', 'three.txt']) {
    work(state, name, line.repeat(Math.ceil(200_000 / line.length)));
  }
  // Uncited P1s here: the chunked tree has no `implemented.ts` to cite.
  const review = (label: string): object => {
    if (label.startsWith('review-0')) return report([p1('first-defect')]);
    return report([]);
  };
  const { turns } = await driveReview(state, threeRoundConfig(true), review);
  const round2 = turns.filter((t) => t.label.startsWith('review-1'));
  const parts = round2.filter((t) => /^review-1-part\d+$/.test(t.label));
  const finderParts = round2.filter((t) => /^review-1-f1-part\d+$/.test(t.label));
  assert.ok(parts.length > 1, `the diff was not split: ${round2.map((t) => t.label).join(', ')}`);
  assert.equal(finderParts.length, parts.length);
  for (const t of round2) {
    assert.ok((ledgerOf(t.prompt) ?? '').includes('`first-defect`'), t.label);
  }
});

test('a resumed round 3 renders the same ledger an uninterrupted round 3 does', async () => {
  const straight = reviewingRun({ prefix: 'vibe-ledger-straight-' });
  const once = await driveReview(straight, threeRoundConfig(true));
  const expected = ledgerOf(byLabel(once.turns, 'review-2').prompt);
  assert.ok(expected !== null);

  const stopped = reviewingRun({ prefix: 'vibe-ledger-stopped-' });
  const dying = (label: string): object => {
    if (label === 'review-2') throw new Error('the reviewer died mid-turn');
    return threeRounds(label);
  };
  await assert.rejects(() => driveReview(stopped, threeRoundConfig(true), dying), /died mid-turn/);
  const reloaded = loadRun(stopped.targetDir, stopped.id);
  const again = await driveReview(reloaded, threeRoundConfig(true));
  assert.equal(ledgerOf(byLabel(again.turns, 'review-2').prompt), expected);
});

test("a fork from a review-round checkpoint says its earlier rounds are in the parent run; one at implemented has no ledger", async () => {
  const parent = freshRun({ prefix: 'vibe-ledger-fork-', planOnly: false, git: true, commit: true });
  const cfg = threeRoundConfig(true, committing());
  // Uncited: this tree has no `implemented.ts`.
  const review = (label: string): object => {
    if (label.startsWith('review-0')) return report([p1('first-defect')]);
    if (label.startsWith('review-1')) return report([p1('second-defect')]);
    return report([]);
  };
  await driveReview(parent, cfg, review, false);
  assert.equal(parent.status, 'done');

  const reviewPoints = listCheckpoints(parent.dir).filter((c) => c.meta?.boundary === 'review-round');
  const last = reviewPoints[reviewPoints.length - 1];
  assert.ok(last !== undefined, 'the parent recorded a review round');
  const plan = await planFork(parent.targetDir, parent.id, last.n, { git: { useBranch: false } });
  const { state: child } = await commitFork(parent.targetDir, plan);
  assert.ok(child.reviewRound >= 1, 'the fork starts after a review round');
  assert.equal(existsSync(path.join(child.dir, 'code-review-0.json')), false, 'commitFork copies no review');

  const driven = await driveReview(loadRun(child.targetDir, child.id), cfg, () => report([]));
  const first = driven.turns.find((t) => t.label === `review-${child.reviewRound}`);
  assert.ok(first !== undefined, driven.calls.join(', '));
  const section = ledgerOf(first.prompt) ?? '';
  for (let round = 1; round <= child.reviewRound; round += 1) {
    assert.ok(
      section.includes(
        `- Round ${round}: its findings are in the parent run \`${parent.id}\` and were not copied into this fork.`,
      ),
      section,
    );
  }
  assert.ok(!section.includes('could not be read'), section);

  const implemented = listCheckpoints(parent.dir).find((c) => c.meta?.boundary === 'implemented');
  assert.ok(implemented !== undefined);
  const fresh = await commitFork(
    parent.targetDir,
    await planFork(parent.targetDir, parent.id, implemented.n, { git: { useBranch: false } }),
  );
  const fromImplemented = await driveReview(loadRun(fresh.state.targetDir, fresh.state.id), cfg, () => report([]));
  const round1 = byLabel(fromImplemented.turns, 'review-0');
  assert.ok(!round1.prompt.includes(HEADING), 'round 1 of a fork at implemented has no ledger');
});

// ---- what each line says -----------------------------------------------------

/** A run directory standing at review round `reviewRound`, for `readLedger` alone. */
function standingAt(reviewRound: number, prefix: string): RunState {
  const state = freshRun({ prefix });
  state.reviewRound = reviewRound;
  return state;
}

const outcome = (verdict: ReproducerOutcome['verdict'], at: ReproducerOutcome['at'] = 'review'): ReproducerOutcome => ({
  verdict,
  at,
  gate: 'core',
  command: 'npm test',
  baseline: 'gate-passed',
  reason: null,
  archived: null,
});

const SECRET_DETAIL = 'DETAIL-THE-LEDGER-MUST-NEVER-SHOW';
const SECRET_FIX = 'SUGGESTED-FIX-THE-LEDGER-MUST-NEVER-SHOW';
const SECRET_REASON = 'DISPOSITION-REASON-THE-LEDGER-MUST-NEVER-SHOW';

function seeded(id: string, over: Partial<Finding>): Finding {
  return { ...p1(id), detail: SECRET_DETAIL, suggested_fix: SECRET_FIX, ...over };
}

function renderedFor(state: RunState, round: number): string {
  return reviewPrompt('diff', ['x'], '# plan', [], round, false, null, undefined, undefined, undefined, undefined, undefined, undefined, undefined, readLedger(state).rounds);
}

test('each entry is exactly round, id, severity, title, first code citation and reproducer status, and nothing of the argument', () => {
  const state = standingAt(1, 'vibe-ledger-fields-');
  const findings: Finding[] = [
    seeded('reproduced-one', {
      title: 'A reproduced\n  defect',
      evidence: [
        { kind: 'external', ref: 'https://example.com' },
        { kind: 'code', path: 'src/a.ts', line: 12 },
        { kind: 'code', path: 'src/b.ts', line: 3 },
      ],
      reproducerOutcomes: [outcome('unproven'), outcome('reproduced'), outcome('did-not-reproduce', 'final-fix')],
    }),
    seeded('did-not', { severity: 'P2', evidence: [{ kind: 'code', path: 'src/c.ts' }], reproducerOutcomes: [outcome('did-not-reproduce')] }),
    seeded('unproven-one', { severity: 'P3', reproducerOutcomes: [outcome('unproven')] }),
    seeded('no-repro', { evidence: [{ kind: 'code', path: 'src/d.ts', line: 7 }], reproducerOutcomes: [outcome('reproduced', 'fix')] }),
  ];
  writeFileSync(path.join(state.dir, 'code-review-0.json'), JSON.stringify(report(findings)));
  writeFileSync(
    path.join(state.dir, 'fix-dispositions-0.json'),
    JSON.stringify({ dispositions: [{ id: 'reproduced-one', disposition: 'rebutted', reason: SECRET_REASON }] }),
  );
  const section = ledgerOf(renderedFor(state, 2)) ?? '';
  const lines = section.split('\n').filter((l) => l.startsWith('- '));
  assert.deepEqual(lines, [
    '- Round 1 - `reproduced-one` - P1 - A reproduced defect - src/a.ts:12 - reproducer: reproduced',
    '- Round 1 - `did-not` - P2 - Finding did-not - src/c.ts - reproducer: did-not-reproduce',
    '- Round 1 - `unproven-one` - P3 - Finding unproven-one - no code citation - reproducer: unproven',
    '- Round 1 - `no-repro` - P1 - Finding no-repro - src/d.ts:7 - reproducer: no reproducer',
  ]);
  const whole = renderedFor(state, 2);
  for (const secret of [SECRET_DETAIL, SECRET_FIX, SECRET_REASON, 'rebutted']) {
    assert.ok(!whole.includes(secret), `the prompt shows ${secret}`);
  }
  assert.deepEqual([...readLedger(state).ids].sort(), ['did-not', 'no-repro', 'reproduced-one', 'unproven-one']);
});

test('a missing, an unparseable and a linked earlier round each say so in a line of their own, and the link is never opened', (t) => {
  const state = standingAt(5, 'vibe-ledger-unreadable-');
  // code-review-0.json: missing.
  writeFileSync(path.join(state.dir, 'code-review-1.json'), '{not json');
  writeFileSync(path.join(state.dir, 'code-review-3.json'), JSON.stringify({ verdict: 'APPROVE', summary: '', findings: [] }));
  writeFileSync(
    path.join(state.dir, 'code-review-4.json'),
    JSON.stringify(report([p1('kept'), { id: 'broken', severity: 'P9' } as unknown as Finding])),
  );
  const outside = mkdtempSync(path.join(tmpdir(), 'vibe-ledger-link-target-'));
  const target = path.join(outside, 'elsewhere.json');
  writeFileSync(target, JSON.stringify(report([p1('LINKED-TARGET-MUST-NEVER-BE-READ')])));
  const linked = tryLink(target, path.join(state.dir, 'code-review-2.json'), 'file');

  const section = ledgerOf(renderedFor(state, 6)) ?? '';
  const lines = section.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(lines.includes('- Round 1: code-review-0.json is missing or could not be read; its findings are not listed.'), section);
  assert.ok(lines.includes('- Round 2: code-review-1.json could not be parsed; its findings are not listed.'), section);
  assert.ok(lines.includes('- Round 4: no findings.'), section);
  assert.ok(lines.includes('- Round 5 - `kept` - P1 - Finding kept - no code citation - reproducer: no reproducer'), section);
  assert.ok(lines.includes('- Round 5: 1 finding entries in code-review-4.json could not be read.'), section);
  if (!linked) {
    t.skip(FILE_LINK_SKIP);
    return;
  }
  assert.ok(lines.includes('- Round 3: code-review-2.json is a link, so it was not opened; its findings are not listed.'), section);
  assert.ok(!section.includes('LINKED-TARGET-MUST-NEVER-BE-READ'));
  assert.equal(readLedger(state).ids.has('LINKED-TARGET-MUST-NEVER-BE-READ'), false);
  // One line per round that could not be listed, and three different sentences.
  assert.equal(lines.filter((l) => /^- Round [123]:/.test(l)).length, 3);
});

test('round 1 renders no section, and neither does an empty ledger', () => {
  const state = standingAt(0, 'vibe-ledger-empty-');
  assert.deepEqual(readLedger(state).rounds, []);
  assert.ok(!renderedFor(state, 1).includes(HEADING));
});

// ---- the continuity note -----------------------------------------------------

test('with the ledger, the memoryless note no longer says the findings are absent, and the carried one keeps its same-id rule', () => {
  const ledger = [{ round: 1, file: 'code-review-0.json', kind: 'findings' as const, entries: [], unreadable: 0 }];
  const fresh = reviewPrompt('diff', ['x'], '# plan', [], 2, false, null, undefined, undefined, undefined, undefined, undefined, undefined, undefined, ledger);
  assert.ok(!fresh.includes('are not reproduced here'));
  assert.ok(!fresh.includes('you do not have those findings'));
  assert.ok(fresh.includes('listed by id under **Findings from earlier rounds** below'));
  assert.ok(fresh.includes('sets `prior_id` to that id; a new finding sets `prior_id` to null'));
  assert.ok(fresh.includes('Raise every defect you can see, whether it is listed or not'));

  const carried = reviewPrompt('diff', ['x'], '# plan', [], 2, true, null, undefined, undefined, undefined, undefined, undefined, undefined, undefined, ledger);
  assert.ok(carried.includes('re-raise it with the **exact same `id` you used before**'));
  assert.ok(carried.includes('sets `prior_id` to that id; a new finding sets `prior_id` to null'));

  // Off, both notes are the ones they were, and the critique never moves.
  const off = reviewPrompt('diff', ['x'], '# plan', [], 2, false);
  assert.ok(off.includes('they are not reproduced here'));
  assert.ok(!off.includes('prior_id'));
  const critique = critiquePrompt(planFixture().plan_md, [], [], 2, false);
  assert.ok(critique.includes('they are not reproduced here'));
  assert.ok(!critique.includes('prior_id'));
});
