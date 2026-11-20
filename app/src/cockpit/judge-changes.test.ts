import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { disagreedFiles, needsLook, readReport, reviewReportName } from './artifacts';
import type { JudgedFile } from './artifacts';
import { JudgeChanges, JudgeFlags, disagreementLine } from './JudgeChanges';
import { foldReplay } from './model';
import { rounds } from './rounds';
import { RoundCard } from '../pilot/RoundCard';
import { LIVE } from './fixtures/review-round-20261023-111151';

/**
 * A review round's changes to the run's own judge, in the window and on the
 * phone (#460). The phone draws the same cockpit, so these are its cases too.
 *
 * The records below are the shape the core writes into `code-review-<n>.json`
 * (`TestChanges` in `src/types.ts`): a combined `verdict` of
 * `{ justified, reason }` or `'unjudged'`, and with finders seated a
 * `verdicts` list of `{ seat, provider, model, verdict }`.
 */

const files = (testChanges: unknown): readonly JudgedFile[] =>
  readReport(JSON.stringify({ findings: [], testChanges }))?.testChanges ?? [];

const seat = (s: string, verdict: unknown, provider = 'codex', model = 'default') => ({ seat: s, provider, model, verdict });

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const draw = (f: readonly JudgedFile[]): string => renderToStaticMarkup(createElement(JudgeChanges, { files: f }));

const SOLO = {
  round: 2,
  patterns: ['**/*.test.ts', 'vibe.config.json'],
  files: [
    { path: 'tests/a.test.ts', oldPath: null, status: 'modified', added: 3, removed: 9, verdict: { justified: false, reason: 'drops the timeout case' } },
    { path: 'vibe.config.json', oldPath: null, status: 'modified', added: 1, removed: 1, verdict: 'unjudged' },
    { path: 'tests/b.test.ts', oldPath: null, status: 'added', added: 40, removed: 0, verdict: { justified: true, reason: 'covers the new flag' } },
  ],
};

describe('reading the stored record', () => {
  test('every file, its combined verdict and the reason stored with it', () => {
    expect(files(SOLO).map((f) => [f.path, f.verdict, f.reason])).toEqual([
      ['tests/a.test.ts', 'not justified', 'drops the timeout case'],
      ['vibe.config.json', 'unjudged', null],
      ['tests/b.test.ts', 'justified', 'covers the new flag'],
    ]);
  });

  test('the combined verdict is the stored one, never worked out from the seats', () => {
    // The core keeps the stored verdict when a seat's entry was dropped, so a
    // record whose surviving seats all said justified can still be stored as
    // not justified - and the window must say what the core said.
    const [f] = files({
      round: 1,
      patterns: [],
      files: [
        {
          path: 'tests/a.test.ts',
          verdict: { justified: false, reason: 'a seat said it weakens the case' },
          verdicts: [seat('roles.reviewer', { justified: true, reason: 'fine' })],
        },
      ],
    });
    expect(f?.verdict).toBe('not justified');
    expect(f !== undefined && needsLook(f)).toBe(true);
  });

  test('a verdict this build cannot read is looked at, not passed as justified', () => {
    const [f] = files({ files: [{ path: 'tests/a.test.ts', verdict: { justified: 'yes' } }] });
    expect(f?.verdict).toBeNull();
    expect(f !== undefined && needsLook(f)).toBe(true);
  });

  test('the report is the review round’s own file', () => {
    expect(reviewReportName(0)).toBe('code-review-0.json');
    expect(reviewReportName(3)).toBe('code-review-3.json');
  });
});

describe('disagreement, as the terminal counts it', () => {
  test('justified against not justified is a disagreement; unjudged beside justified is an omission', () => {
    const got = files({
      round: 1,
      patterns: [],
      files: [
        {
          path: 'split.test.ts',
          verdict: { justified: false, reason: 'no' },
          verdicts: [seat('roles.reviewer', { justified: true, reason: 'ok' }), seat('review.finders[0]', { justified: false, reason: 'no' })],
        },
        {
          path: 'omitted.test.ts',
          verdict: 'unjudged',
          verdicts: [seat('roles.reviewer', { justified: true, reason: 'ok' }), seat('review.finders[0]', 'unjudged')],
        },
        {
          path: 'agreed.test.ts',
          verdict: { justified: true, reason: 'ok' },
          verdicts: [seat('roles.reviewer', { justified: true, reason: 'ok' }), seat('review.finders[0]', { justified: true, reason: 'ok' })],
        },
      ],
    });
    expect(disagreedFiles(got).map((f) => f.path)).toEqual(['split.test.ts']);
    expect(disagreementLine(got)).toBe('The seats disagreed on 1 of 3 files.');
  });

  test('a round with no finders says no disagreement count at all', () => {
    expect(disagreementLine(files(SOLO))).toBeNull();
  });
});

describe('the section', () => {
  test('a round with no judge changes draws nothing, not an empty section', () => {
    expect(draw([])).toBe('');
    expect(draw(files(undefined))).toBe('');
    expect(draw(files({ round: 1, patterns: [], files: [] }))).toBe('');
    expect(renderToStaticMarkup(createElement(JudgeFlags, { round: 0, files: [] }))).toBe('');
  });

  test('every file is drawn with its verdict and reason, and the ones to look at in the alarm tone', () => {
    const html = draw(files(SOLO));
    const words = text(html);
    expect(words).toContain('tests/a.test.ts not justified drops the timeout case');
    expect(words).toContain('vibe.config.json unjudged');
    expect(words).toContain('tests/b.test.ts justified covers the new flag');
    // Two alarm badges: the not-justified file and the unjudged one.
    expect(html.match(/bg-alarm/g)?.length).toBe(2);
  });

  test('with finders seated, who said what, named `<seat> <provider>/<model>`', () => {
    const words = text(
      draw(
        files({
          round: 1,
          patterns: [],
          files: [
            {
              path: 'tests/a.test.ts',
              verdict: { justified: false, reason: 'weakened' },
              verdicts: [
                seat('roles.reviewer', { justified: true, reason: 'fine' }, 'claude', 'opus'),
                seat('review.finders[0]', { justified: false, reason: 'weakened' }),
              ],
            },
          ],
        }),
      ),
    );
    expect(words).toContain('The seats disagreed on 1 of 1 file.');
    expect(words).toContain('roles.reviewer claude/opus justified fine');
    expect(words).toContain('review.finders[0] codex/default not justified weakened');
  });

  test('the rail names only what was not justified, counted from one', () => {
    const words = text(renderToStaticMarkup(createElement(JudgeFlags, { round: 1, files: files(SOLO) })));
    expect(words).toContain('Round 2 test change not justified tests/a.test.ts');
    expect(words).toContain('Round 2 test change unjudged vibe.config.json');
    expect(words).not.toContain('tests/b.test.ts');
    const fine = files({ files: [{ path: 'tests/b.test.ts', verdict: { justified: true, reason: 'ok' } }] });
    expect(renderToStaticMarkup(createElement(JudgeFlags, { round: 1, files: fine }))).toBe('');
  });

  test('it adds no control: a verdict never blocks', () => {
    const html = draw(files(SOLO)) + renderToStaticMarkup(createElement(JudgeFlags, { round: 1, files: files(SOLO) }));
    expect(html).not.toMatch(/<button|<a |role="button"|<input/);
  });
});

describe('on the review round’s card', () => {
  test('a card whose report has not been read draws no section', () => {
    const card = rounds(foldReplay(LIVE)).find((c) => c.cycle === 'review');
    if (card === undefined) throw new Error('the review round left no card');
    const html = renderToStaticMarkup(
      createElement(RoundCard, { card, judge: { dir: '/repo', runId: 'r', revision: 0 } }),
    );
    expect(html).not.toContain('changes to the tests');
  });
});
