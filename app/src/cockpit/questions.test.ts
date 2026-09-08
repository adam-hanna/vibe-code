import { describe, expect, test } from 'vitest';
import { emptyRun, reduce } from './model';
import type { Run } from './model';
import type { Frame } from '../host';

/**
 * The question loop and the rate-limit wait (`1f`, `7e`, #223).
 *
 * Both were two counts and a sentence before this. What they have in common is
 * the failure they would otherwise share: a screen that cannot tell an outcome
 * from an absence.
 *
 * - A **declined** answer is not a missing one. It is the adversary refusing to
 *   guess at product intent, and on a blocking question it is what ends the run.
 * - A rate-limit wait is **waiting**, not halted. It asks nobody anything, and
 *   it resumes by itself.
 */

function say(id: string | null, data: Record<string, unknown> | null): Frame {
  return { type: 'narration', level: 'info', message: 'x', id, data };
}

function fold(frames: readonly Frame[], t0 = 1_000_000): Run {
  return frames.reduce((run, frame, i) => reduce(run, frame, t0 + i), emptyRun());
}

const opened = (...qs: readonly Record<string, unknown>[]): Frame =>
  say('questions_opened', {
    total: qs.length,
    blocking: qs.filter((q) => q['blocking'] === true).length,
    questions: qs,
  });

describe('the questions arrive with their answers', () => {
  test('an answer is matched onto its question by the text, as the loop matches it', () => {
    const run = fold([
      opened({ question: 'Which database?', kind: 'product', blocking: true }),
      say('questions_answered', {
        answered: 1,
        total: 1,
        answers: [
          {
            question: 'Which database?',
            answer: 'sqlite',
            confidence: 'high',
            rationale: 'already a dependency',
          },
        ],
        declined: [],
      }),
    ]);
    const q = run.questions?.open[0];
    expect(q?.answer).toBe('sqlite');
    // The field `1f` draws its policy on - escalate on low - so a pane that
    // could not see it could not explain its own behaviour.
    expect(q?.confidence).toBe('high');
    expect(q?.declined).toBe(false);
  });

  test('a decline is an outcome, not a blank', () => {
    // On a blocking question this is the thing that ends the run and writes
    // NEEDS-INPUT.md. Drawn as "no answer yet" it would hide the reason a run
    // stopped, on the screen built to explain it.
    const run = fold([
      opened({ question: 'Should we drop v1 support?', kind: 'product', blocking: true }),
      say('questions_answered', {
        answered: 0,
        total: 1,
        answers: [],
        declined: [
          {
            question: 'Should we drop v1 support?',
            confidence: 'low',
            rationale: 'this is product intent, not a technical call',
            deferToHuman: true,
          },
        ],
      }),
    ]);
    const q = run.questions?.open[0];
    expect(q?.declined).toBe(true);
    expect(q?.answer).toBeNull();
    expect(q?.rationale).toMatch(/product intent/);
  });

  test('a question nobody answered keeps its null', () => {
    const run = fold([
      opened(
        { question: 'A', kind: 'product', blocking: true },
        { question: 'B', kind: 'technical', blocking: false },
      ),
      say('questions_answered', {
        answered: 1,
        total: 2,
        answers: [{ question: 'A', answer: 'yes', confidence: 'high' }],
        declined: [],
      }),
    ]);
    expect(run.questions?.open[0]?.answer).toBe('yes');
    // Unanswered and answered are the two states this pane exists to tell apart.
    expect(run.questions?.open[1]?.answer).toBeNull();
    expect(run.questions?.open[1]?.declined).toBe(false);
  });

  test('blocking fails closed on a field this build cannot read', () => {
    // An advisory question shown as blocking is somebody looking at it sooner
    // than they had to. The other way round is a run ending unexplained.
    const run = fold([opened({ question: 'A', kind: 'product' })]);
    expect(run.questions?.open[0]?.blocking).toBe(true);
  });

  test('answers with no round open are dropped rather than inventing one', () => {
    const run = fold([say('questions_answered', { answered: 1, answers: [{ question: 'A' }] })]);
    expect(run.questions).toBeNull();
  });
});

describe('a rate limit is a wait, and it is remembered', () => {
  test('it carries which account ran out, so the other one is left alone', () => {
    const run = fold([
      say('rate_limited', {
        label: 'implement',
        provider: 'claude',
        waitMs: 300_000,
        resetsAt: '2026-09-07T12:00:00.000Z',
      }),
    ]);
    expect(run.rateLimit?.provider).toBe('claude');
    expect(run.rateLimit?.waitMs).toBe(300_000);
    expect(run.rateLimit?.resumedAt).toBeNull();
  });

  test('resuming closes it and keeps it, because the time still went somewhere', () => {
    // A run that waited forty minutes did so, and a screen that forgets cannot
    // answer the first question anybody asks about a long run.
    const run = fold([
      say('rate_limited', { label: 'implement', provider: 'claude', waitMs: 300_000 }),
      say('rate_limit_resumed', { label: 'implement' }),
    ]);
    expect(run.rateLimit?.resumedAt).not.toBeNull();
  });

  test('a resume with no wait behind it creates nothing', () => {
    // A card claiming a wait it never measured is worse than no card: it would
    // have to invent when the wait began.
    const run = fold([say('rate_limit_resumed', { label: 'implement' })]);
    expect(run.rateLimit).toBeNull();
  });

  test('a wait that reported no reset time says nothing about one', () => {
    const run = fold([say('rate_limited', { label: 'implement' })]);
    expect(run.rateLimit?.resetsAt).toBeNull();
    expect(run.rateLimit?.waitMs).toBeNull();
    expect(run.rateLimit?.provider).toBeNull();
  });
});
