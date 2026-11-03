import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import replay from '../../../src/replay.ts?raw';
import { emptyRun, reduce } from './model';
import type { Run } from './model';
import { Summary } from './Summary';
import type { Frame } from '../host';

/**
 * An opened run's Summary counts what its gates carried (#505).
 *
 * Since #503 the card reads `pass` and `tolerated` off every census, and an
 * opened run's censuses had neither: a census is narration with no event, so
 * `replayRun` rebuilt it from the round's artifact, and the card drew `—` over a
 * run whose `plan_approved` and `review_approved` say what it carried. The core
 * now attaches those ids to the census of the round each approval passed
 * (`tests/replay-carried.test.ts` pins which round, and the shape). These fold
 * that replay's frames - `level: 'detail'`, no `tolerance`, no `findings` - the
 * way the window folds an opened run, shaped on `20261021-211408`.
 */

function say(id: string, data: Record<string, unknown>): Frame {
  return { type: 'narration', level: 'detail', message: 'x', id, data };
}

function fold(frames: readonly Frame[], t0 = 1_000_000): Run {
  return frames.reduce((run, frame, i) => reduce(run, frame, t0 + i), emptyRun());
}

const counts = (P1: number) => ({ P0: 0, P1, P2: 1, P3: 0 });

/** A replayed census, with the gate decision only where an approval was tied to it. */
const replayed = (phase: 'plan' | 'review', P1: number, tolerated?: readonly string[]): Frame =>
  say('findings_reported', {
    phase,
    counts: counts(P1),
    ...(tolerated === undefined ? {} : { pass: true, reason: null, tolerated }),
  });

const card = (run: Run): string => renderToStaticMarkup(createElement(Summary, { run }));

function carriedTile(html: string): string {
  const start = html.indexOf('Carried findings');
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('Commits', start);
  return html.slice(start, end).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

test('the replay writes the gate decision in the fields the reducer reads', () => {
  // Two packages, one shape: the source of the core's census, read as text the
  // way `replay-census.test.ts` reads its counts.
  expect(replay).toContain('{ pass: true, reason: null, tolerated }');
});

describe('an opened run', () => {
  test('that carried a plan P1 and a review P1 counts 2', () => {
    const run = fold([
      replayed('plan', 2),
      replayed('plan', 1, ['fix-round-recording-not-resumable']),
      replayed('review', 2),
      replayed('review', 1, ['dispositions-lost-after-consumption']),
    ]);
    // Nothing on the way to `censuses` drops the fields.
    expect(run.censuses.map((c) => c.pass)).toEqual([null, true, null, true]);
    const tile = carriedTile(card(run));
    expect(tile).toMatch(/Carried findings 2 /);
    expect(tile).toContain('fix-round-recording-not-resumable');
    expect(tile).toContain('dispositions-lost-after-consumption');
  });

  test('with no approval event still shows —', () => {
    const tile = carriedTile(card(fold([replayed('plan', 2), replayed('plan', 1)])));
    expect(tile).toContain('—');
    expect(tile).not.toContain('None');
    expect(tile).not.toMatch(/Carried findings 0 /);
  });

  test('whose plan gate passed carrying nothing, beside a clean review, says None', () => {
    // The clean review records no ids, so its census states no decision; the
    // plan's `carried: []` is an answer, and it is the one the card has.
    const tile = carriedTile(card(fold([replayed('plan', 0, []), replayed('review', 0)])));
    expect(tile).toContain('None');
  });
});
