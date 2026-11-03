import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { emptyRun, reduce } from './model';
import type { Run } from './model';
import { Summary } from './Summary';
import type { Frame } from '../host';

/**
 * The DONE card's **Carried findings**, counted from both gates (#481).
 *
 * A gate that passes with P1s inside `loop.p1Tolerance` carries them: the plan
 * gate into implementation, the review gate into the final fix round, which is
 * the set `OUTSTANDING.md` lists. The card counted the plan's census alone, so a
 * run that carried one review P1 and nothing from the plan read as having
 * carried nothing. Of the 25 archived runs on this machine that carried a
 * finding, 14 carried one out of review and 4 carried *only* that.
 *
 * The runs here are shaped on `20261021-211408`, which carried
 * `fix-round-recording-not-resumable` out of its critique and
 * `dispositions-lost-after-consumption` out of its second review.
 */

function say(id: string, data: Record<string, unknown>): Frame {
  return { type: 'narration', level: 'info', message: 'x', id, data };
}

function fold(frames: readonly Frame[], t0 = 1_000_000): Run {
  return frames.reduce((run, frame, i) => reduce(run, frame, t0 + i), emptyRun());
}

const census = (phase: 'plan' | 'review', over: Record<string, unknown> = {}): Frame =>
  say('findings_reported', {
    phase,
    counts: { P0: 0, P1: 1, P2: 1, P3: 0 },
    tolerance: 1,
    pass: true,
    reason: null,
    tolerated: [],
    findings: [],
    ...over,
  });

const PLAN_CARRIED = census('plan', { tolerated: ['fix-round-recording-not-resumable'] });
const REVIEW_BLOCKED = census('review', {
  counts: { P0: 0, P1: 2, P2: 1, P3: 0 },
  pass: false,
  reason: '2 P1 finding(s), above the tolerance of 1',
});
const REVIEW_CARRIED = census('review', { tolerated: ['dispositions-lost-after-consumption'] });

const card = (run: Run): string => renderToStaticMarkup(createElement(Summary, { run }));

/** The text of the Carried findings tile, from its label to the next tile. */
function carriedTile(html: string): string {
  const start = html.indexOf('Carried findings');
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('Commits', start);
  return html.slice(start, end).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

describe('the card counts what each gate carried', () => {
  test('a P1 carried out of review is on the card', () => {
    const tile = carriedTile(card(fold([census('plan'), REVIEW_BLOCKED, REVIEW_CARRIED])));
    expect(tile).toContain('dispositions-lost-after-consumption');
    expect(tile).not.toContain('None');
    expect(tile).not.toContain('nothing carried forward');
    expect(tile).toMatch(/Carried findings 1 /);
  });

  test('the plan’s and the review’s carried P1s are both counted', () => {
    const tile = carriedTile(card(fold([PLAN_CARRIED, REVIEW_BLOCKED, REVIEW_CARRIED])));
    expect(tile).toMatch(/Carried findings 2 /);
    expect(tile).toContain('fix-round-recording-not-resumable');
    expect(tile).toContain('dispositions-lost-after-consumption');
  });

  test('an id two censuses both carried is one finding, not two', () => {
    // A resumed run can pass the same gate again over the same report, and a
    // reviewer can re-raise a plan P1 under the plan's id. Either way it is one
    // finding carried, and counting it twice would be a number nobody took.
    const tile = carriedTile(
      card(
        fold([
          PLAN_CARRIED,
          census('review', { tolerated: ['fix-round-recording-not-resumable'] }),
          census('review', { tolerated: ['fix-round-recording-not-resumable'] }),
        ]),
      ),
    );
    expect(tile).toMatch(/Carried findings 1 /);
  });

  test('a run whose gates carried nothing says so', () => {
    const tile = carriedTile(card(fold([census('plan'), census('review')])));
    expect(tile).toContain('None');
    expect(tile).toContain('nothing carried forward');
  });
});

describe('a run whose record does not say what was carried', () => {
  test('an opened run’s censuses state no gate decision, so the card claims no count', () => {
    // A replayed census carries the counts and nothing else (`replayRun` reads
    // the round's report, and the gate's decision was never in it). `tolerated`
    // then folds to `[]`, and reading that as "nothing carried" drew
    // `20261021-211408`, which carried two, as `None`.
    const replayed = (phase: 'plan' | 'review'): Frame =>
      say('findings_reported', { phase, counts: { P0: 0, P1: 1, P2: 1, P3: 0 } });
    const tile = carriedTile(card(fold([replayed('plan'), replayed('review'), replayed('review')])));
    expect(tile).not.toContain('None');
    expect(tile).not.toContain('nothing carried forward');
    expect(tile).not.toMatch(/Carried findings 0 /);
    expect(tile).toContain('—');
  });

  test('a run with no census at all claims no count either', () => {
    const tile = carriedTile(card(emptyRun()));
    expect(tile).not.toContain('None');
    expect(tile).toContain('—');
  });
});
