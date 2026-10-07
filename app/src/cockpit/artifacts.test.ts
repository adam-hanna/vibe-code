import { describe, expect, test } from 'vitest';
import orchestrator from '../../../src/orchestrator.ts?raw';
import {
  classify,
  ofKind,
  planText,
  readAnswers,
  readReport,
} from './artifacts';
import type { ArtifactEntry } from '../host';

/**
 * Reading what a run wrote (#223).
 *
 * Two different claims live here and they fail for different reasons.
 *
 * The first is **classification**: given the listing the host returned, which
 * pane does each file belong behind, and which round is it. That is pure and is
 * tested directly.
 *
 * The second is the one that would otherwise rot silently. These patterns are a
 * **duplicate of the loop's own naming**, which lives in `src/orchestrator.ts`,
 * and the two are not shared because the app and the core are two packages -
 * `app/src/cockpit/raise.ts` already duplicates `src/raise.ts`'s markers for the
 * same reason. What makes that safe is the same thing that makes it safe there:
 * the core is read as source, so a rename fails in the commit that makes it
 * rather than in a pane somebody opens a week later. A drift here does not throw
 * and does not log - it shows an empty tab, which is the failure mode nobody
 * reports because it looks like a run that has not got there yet.
 */

const file = (name: string, bytes = 10): ArtifactEntry => ({ name, kind: 'file', bytes });

describe('which pane a file belongs behind', () => {
  test('the four shapes are placed, with the round out of the name', () => {
    expect(classify(file('plan-0.json'))).toMatchObject({ kind: 'plan', round: 0 });
    expect(classify(file('plan-critique-2.json'))).toMatchObject({ kind: 'critique', round: 2 });
    expect(classify(file('code-review-11.json'))).toMatchObject({ kind: 'review', round: 11 });
    expect(classify(file('answers-1.json'))).toMatchObject({ kind: 'answers', round: 1 });
  });

  test('a critique is not a plan, which is what the pattern order is for', () => {
    // `plan-critique-0.json` starts with `plan-`. A looser plan pattern tested
    // first would claim every critique in the directory, and the critique pane
    // would be empty while the plans pane showed the critiques as plan versions.
    expect(classify(file('plan-critique-0.json')).kind).toBe('critique');
    expect(classify(file('plan-critique-0.json')).kind).not.toBe('plan');
  });

  test('PLAN.md is a plan with no round, because it is not one of them', () => {
    // Written once, after the plan is approved. A round number here would file
    // the approved plan under whichever round happened to produce it.
    expect(classify(file('PLAN.md'))).toMatchObject({ kind: 'plan', round: null });
  });

  test('anything else is listed rather than hidden', () => {
    // The loop is free to write an artifact this build has never heard of, and
    // the honest drawing of one is its own name - the rule `boundary()` and
    // `ending()` already follow.
    expect(classify(file('transcript.log')).kind).toBe('other');
    expect(classify(file('state.json')).kind).toBe('other');
  });

  test('a directory or a link is never offered as readable', () => {
    // `gate-artifacts-<n>/` is a directory #111 writes; a link is one vibe never
    // creates, so its presence is the finding. Offering either behind a pane
    // would be a row whose only outcome is a refusal one click later.
    expect(classify({ name: 'plan-0.json', kind: 'directory', bytes: null }).kind).toBe('other');
    expect(classify({ name: 'plan-0.json', kind: 'link', bytes: null }).kind).toBe('other');
    expect(classify({ name: 'plan-0.json', kind: 'unknown', bytes: null }).kind).toBe('other');
  });

  test('a group is oldest round first, and the approved plan is last', () => {
    const entries = [file('PLAN.md'), file('plan-2.json'), file('plan-0.json'), file('plan-1.json')];
    expect(ofKind(entries, 'plan').map((p) => p.name)).toEqual([
      'plan-0.json',
      'plan-1.json',
      'plan-2.json',
      'PLAN.md',
    ]);
  });
});

describe('the names are the loop’s, and the loop is read to prove it', () => {
  // Each of these is the exact interpolation `src/orchestrator.ts` writes. A
  // rename there fails here, which is the whole point: the alternative is a tab
  // that silently shows nothing.
  const writes = (template: string): boolean => orchestrator.includes(template);

  test('the four artifact names still exist in the core', () => {
    expect(writes('`plan-${state.planRound}.json`')).toBe(true);
    expect(writes('`plan-critique-${state.planRound}.json`')).toBe(true);
    expect(writes('`code-review-${state.reviewRound}.json`')).toBe(true);
    expect(writes('`answers-${state.questionRound}.json`')).toBe(true);
    expect(writes("'PLAN.md'")).toBe(true);
  });

  test('and this module places what those templates produce', () => {
    // The templates above with a round substituted in. If a pattern here stopped
    // matching what the core writes, this is where it shows.
    expect(classify(file('plan-3.json')).kind).toBe('plan');
    expect(classify(file('plan-critique-3.json')).kind).toBe('critique');
    expect(classify(file('code-review-3.json')).kind).toBe('review');
    expect(classify(file('answers-3.json')).kind).toBe('answers');
  });
});

describe('what is inside a report', () => {
  const report = JSON.stringify({
    verdict: 'REQUEST_CHANGES',
    summary: 'Two things are wrong and one of them blocks.',
    findings: [
      {
        id: 'f-1',
        severity: 'P1',
        title: 'the lock is taken twice',
        detail: 'acquireLock runs before the first state write and again after it.',
        suggested_fix: 'Take it once, at the top of main.',
        raisedBy: 'reviewer',
        evidence: [{ kind: 'code', path: 'src/lock.ts', line: 42, excerpt: 'acquireLock(dir)' }],
        downgraded: { from: 'P0', reason: 'cites nothing that resolves' },
        defer: true,
      },
      // No id: this build cannot place it, and dropping the other one with it
      // would lose a person's view of a round over one bad row.
      { severity: 'P2', title: 'nameless' },
    ],
  });

  test('the prose the wire has never carried comes through', () => {
    const got = readReport(report);
    expect(got?.verdict).toBe('REQUEST_CHANGES');
    expect(got?.summary).toMatch(/one of them blocks/);
    const f = got?.findings[0];
    expect(f?.detail).toMatch(/before the first state write/);
    expect(f?.suggestedFix).toMatch(/Take it once/);
    expect(f?.raisedBy).toBe('reviewer');
    expect(f?.deferred).toBe(true);
    expect(f?.downgraded).toEqual({ from: 'P0', reason: 'cites nothing that resolves' });
  });

  test('every place a finding says to look, with its excerpt', () => {
    const c = readReport(report)?.findings[0]?.citations[0];
    expect(c).toMatchObject({ kind: 'code', path: 'src/lock.ts', line: 42 });
    expect(c?.excerpt).toBe('acquireLock(dir)');
  });

  test('a row with no id is dropped and the rest survive', () => {
    expect(readReport(report)?.findings).toHaveLength(1);
  });

  test('a field the report did not carry stays absent, never empty', () => {
    // An empty string under a heading reads as a rendering bug; null is what
    // lets the pane say *the report carried no detail*.
    const bare = readReport(JSON.stringify({ findings: [{ id: 'a', severity: 'P3' }] }));
    expect(bare?.findings[0]?.detail).toBeNull();
    expect(bare?.findings[0]?.suggestedFix).toBeNull();
    expect(bare?.findings[0]?.citations).toEqual([]);
    expect(bare?.verdict).toBeNull();
    expect(bare?.summary).toBeNull();
  });

  test('a file that is not a report is null rather than an empty report', () => {
    // Null is what makes the pane show the bytes instead. An empty report would
    // say the round found nothing, which is a different claim.
    expect(readReport('not json at all')).toBeNull();
    expect(readReport('[]')).toBeNull();
  });

  test('a report with no findings array is still a report', () => {
    // The verdict and the summary are worth showing on their own, and a report
    // that approved has nothing in the list by construction.
    expect(readReport(JSON.stringify({ verdict: 'APPROVE' }))?.findings).toEqual([]);
  });
});

describe('what is inside an answers file', () => {
  const rows = [
    {
      question: 'Lazy or eager?',
      answer: 'Lazy, and measure it.',
      confidence: 'high',
      rationale: 'The brief says start small.',
      defer_to_human: false,
    },
    { question: 'Which database?', defer_to_human: true, rationale: 'Product intent.' },
  ];

  test('the bare array the orchestrator writes', () => {
    const got = readAnswers(JSON.stringify(rows));
    expect(got).toHaveLength(2);
    expect(got?.[0]).toMatchObject({ answer: 'Lazy, and measure it.', confidence: 'high' });
  });

  test('and the {answers} envelope the model returns', () => {
    // An archive holds files written by releases either side of every change to
    // this. Accepting both costs one line and is the difference between a
    // readable round and an empty pane.
    expect(readAnswers(JSON.stringify({ answers: rows }))).toHaveLength(2);
  });

  test('a decline is an outcome, not a missing answer', () => {
    // `escalateOnDefer` acts on exactly this, so drawing it as "no answer yet"
    // would hide the reason a run stopped on the screen built to explain it.
    const got = readAnswers(JSON.stringify(rows));
    expect(got?.[1]?.declined).toBe(true);
    expect(got?.[1]?.answer).toBeNull();
    expect(got?.[1]?.rationale).toBe('Product intent.');
  });

  test('a row with no question is dropped: it answers nothing', () => {
    expect(readAnswers(JSON.stringify([{ answer: 'yes' }]))).toEqual([]);
  });

  test('a file that is not answers is null', () => {
    expect(readAnswers('{"nope":1}')).toBeNull();
    expect(readAnswers('broken')).toBeNull();
  });
});

describe('what a plan section shows', () => {
  test('a plan-<n>.json shows its markdown', () => {
    expect(planText('plan-0.json', JSON.stringify({ plan_md: '# a plan' }))).toBe('# a plan');
  });

  test('PLAN.md is already markdown and is shown as it is', () => {
    expect(planText('PLAN.md', '# approved')).toBe('# approved');
  });

  test('a plan-<n>.json this build cannot parse falls back to its bytes', () => {
    // Unparseable JSON is still the thing the run wrote, and showing it is how
    // somebody finds out what went wrong with it. An empty pane is not.
    expect(planText('plan-0.json', '{oops')).toBe('{oops');
    expect(planText('plan-0.json', JSON.stringify({ no_plan: true }))).toMatch(/no_plan/);
  });
});
