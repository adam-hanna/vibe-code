import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { foldReplay, gateSentence } from './model';
import type { Census, Run } from './model';
import { rounds } from './rounds';
import { RoundCard } from '../pilot/RoundCard';
import { GateHead } from './ReportPane';
import { LIVE, REPLAYED } from './fixtures/review-round-20261023-111151';

/**
 * A census draws the tolerance and the pass or block the loop reported, and
 * nothing where it reported neither (#437).
 *
 * The review round of run `20261023-111151` passed at tolerance 1 with two P2s,
 * and its card said `tolerance P1≤0` and *"The gate blocked this round."*. The
 * card was drawn from the replayed census, which carries the counts alone; the
 * fold read the missing tolerance as `0` and the missing `pass` as `false`.
 * Folded here from that round's own frames (`fixtures/`), live and replayed.
 */

const reviewCard = (run: Run) => {
  const card = rounds(run).find((c) => c.cycle === 'review');
  if (card === undefined) throw new Error('the review round left no card');
  return card;
};

const text = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('the live review round', () => {
  const run = foldReplay(LIVE);

  test('folds the tolerance and the pass the loop said', () => {
    const census = reviewCard(run).census;
    expect(census?.tolerance).toBe(1);
    expect(census?.pass).toBe(true);
    expect(census?.reason).toBeNull();
  });

  test('the round card says tolerance 1 and that the gate passed', () => {
    const html = text(renderToStaticMarkup(createElement(RoundCard, { card: reviewCard(run) })));
    expect(html).toContain('tolerance P1≤1');
    expect(html).toContain('The gate passed.');
    expect(html).not.toContain('P1≤0');
    expect(html).not.toContain('blocked');
  });

  test('the Review pane says the gate passed', () => {
    const census = reviewCard(run).census;
    const html = text(renderToStaticMarkup(createElement(GateHead, { census, verdict: 'REVISE' })));
    expect(html).toContain('The gate passed.');
    expect(html).not.toContain('blocked');
    // The gate's word stands; the judge's is only for a round with none.
    expect(html).not.toContain('judge’s own verdict');
  });
});

describe('the replayed review round - the card in the issue', () => {
  const run = foldReplay(REPLAYED);

  test('folds no tolerance and no pass, rather than 0 and a block', () => {
    const census = reviewCard(run).census;
    expect(census?.counts).toEqual({ P0: 0, P1: 0, P2: 2, P3: 0 });
    expect(census?.tolerance).toBeNull();
    expect(census?.pass).toBeNull();
  });

  test('the round card draws the counts and no tolerance badge and no gate sentence', () => {
    const html = text(renderToStaticMarkup(createElement(RoundCard, { card: reviewCard(run) })));
    expect(html).toContain('P2');
    expect(html).not.toContain('tolerance');
    expect(html).not.toContain('The gate');
  });

  test("the Review pane falls back to the judge's own verdict, labelled as such", () => {
    const census = reviewCard(run).census;
    const html = text(renderToStaticMarkup(createElement(GateHead, { census, verdict: 'REVISE' })));
    expect(html).not.toContain('The gate');
    expect(html).toContain('REVISE');
    expect(html).toContain('No gate decision was narrated to this window for this round.');
  });

  test('and says nothing of a gate when there is no verdict either', () => {
    const census = reviewCard(run).census;
    const html = text(renderToStaticMarkup(createElement(GateHead, { census, verdict: null })));
    expect(html).not.toContain('The gate');
    expect(html).not.toContain('verdict');
  });
});

describe('gateSentence', () => {
  const base: Census = {
    phase: 'review',
    counts: { P0: 0, P1: 2, P2: 0, P3: 0 },
    tolerance: 1,
    pass: false,
    reason: '2 P1 finding(s), above the tolerance of 1',
    tolerated: [],
    findings: [],
    at: 0,
    seq: 0,
  };

  test("a block is said in the loop's own words", () => {
    expect(gateSentence(base)).toBe('2 P1 finding(s), above the tolerance of 1');
  });

  test('a block the loop gave no reason for is still a block', () => {
    expect(gateSentence({ ...base, reason: null })).toBe('The gate blocked this round.');
  });

  test('a tolerance of zero is a real tolerance and is drawn', () => {
    const run = foldReplay([
      ...REPLAYED.slice(0, 3),
      {
        at: 1792782137570,
        narration: {
          level: 'info',
          message: 'x',
          id: 'findings_reported',
          data: { phase: 'review', counts: { P0: 0, P1: 1, P2: 0, P3: 0 }, tolerance: 0, pass: false, reason: '1 P1 finding(s), above the tolerance of 0' },
        },
      },
    ]);
    const html = text(renderToStaticMarkup(createElement(RoundCard, { card: reviewCard(run) })));
    expect(html).toContain('tolerance P1≤0');
    expect(html).toContain('1 P1 finding(s), above the tolerance of 0');
  });

  test('a decision nobody reported is not a block', () => {
    expect(gateSentence({ ...base, pass: null, reason: null })).toBeNull();
    // A reason with no pass beside it decides nothing either.
    expect(gateSentence({ ...base, pass: null })).toBeNull();
  });
});
