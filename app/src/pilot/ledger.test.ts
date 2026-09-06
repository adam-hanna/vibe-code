import { describe, expect, test } from 'vitest';
// Sources as strings, through Vite's `?raw` — the same device `keys.test.ts`
// uses, and deliberately not `node:fs`: adding node types to the app's tsconfig
// would let any component in a webview import a filesystem.
import charge from '../../../src/charge.ts?raw';
import types from '../../../src/types.ts?raw';
import orchestrator from '../../../src/orchestrator.ts?raw';
import ledgerSource from './ledger.ts?raw';
import pane from './PilotPane.tsx?raw';
import {
  costOf,
  describeDay,
  emptyLedger,
  formatUsd,
  limitVerdict,
  localDay,
  NO_LIMITS,
  PRICES,
  priceFor,
  record,
  today,
} from './ledger';
import type { PilotLimits } from './ledger';
import type { Usage } from './pilot';

/**
 * The pilot's accounting, and the wall between it and the run's (#145).
 *
 * The valuable half of this file is the wall. A pilot conversation counting
 * toward `budget.maxTokens` would stop the thing being built because of a
 * discussion about what to build, and it would be reported as `EXIT.BUDGET`,
 * which already means something else. Nothing here would fail loudly if that
 * happened — the run would simply end early one day, for a reason nobody could
 * reconstruct — so it is checked as a boundary rather than as a behaviour.
 */

/**
 * A source file with its comments removed.
 *
 * Needed because the assertions below are about what the **code** reaches, and
 * this area's comments necessarily name the very things the code must not touch
 * — the ledger's own docblock explains at length why `applyCharge` and
 * `maxCostUsd` are not on this side of the wall. Asserting over raw text made
 * the documentation fail the test it documents, which is the wrong way round:
 * the prose is the evidence and the code is the claim.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const usage = (over: Partial<Usage> = {}): Usage => ({
  input: null,
  output: null,
  cache_read: null,
  cache_write: null,
  ...over,
});

// ---- the wall --------------------------------------------------------------

describe('the pilot spends nothing the run is counting', () => {
  test('the ledger reaches nothing that charges a run', () => {
    // The one assertion this whole issue exists for. `applyCharge` is the seam
    // every token in the product is charged through, and the pilot's tokens are
    // not the product's tokens.
    const source = code(ledgerSource);
    expect(source).not.toContain('applyCharge');
    expect(source).not.toContain('enforceCeilings');
    expect(source).not.toContain('maxTokens');
    expect(source).not.toContain('maxCostUsd');
    expect(source).not.toContain('tokensUsed');
    // No import from the core at all, of any kind. The ledger's only imports
    // are its two sibling modules, so there is no path from here to the run's
    // arithmetic even by accident.
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['./keys', './pilot']);
  });

  test('the run never learns the pilot exists', () => {
    // From the other side of the wall, which is the side that would have to
    // change for the leak to happen. A `pilot` field on `RunState`, or a pilot
    // branch in the charge, is the shape of the mistake — and `state.json` for a
    // run is byte-identical whether the pilot pane was open or closed.
    expect(code(types)).not.toMatch(/\bpilot/i);
    expect(code(charge)).not.toMatch(/\bpilot/i);
    expect(code(orchestrator)).not.toMatch(/\bpilot/i);
  });

  test('the ledger owns no ceiling the run has a name for', () => {
    // `maxTokens` and `maxCostUsd` are the run's and mean something else.
    // Reusing either spelling here is how one number absorbs the other, three
    // refactors from now, in a diff that looks like tidying.
    expect(ledgerSource).toContain('dailyTokens');
    expect(ledgerSource).toContain('dailyUsd');
  });

  test('the two cost figures are never rendered in one place', () => {
    // The UI half of the same rule. The word *cost* now means two things on one
    // screen — a proxy for work volume beside a run, money beside the pilot —
    // and nothing may add them or column them together. The pane may DISCUSS
    // the run's figure in a comment, and must not read it.
    expect(code(pane)).not.toMatch(/tokensUsed|costUsd/);
  });
});

// ---- what a turn cost ------------------------------------------------------

describe('a dollar figure is produced only where one can be', () => {
  test('a fully reported Anthropic turn is priced from its published rates', () => {
    const cost = costOf(
      'anthropic',
      'claude-sonnet-5-20260114',
      usage({ input: 1000, output: 500, cache_read: 2000, cache_write: 400 }),
    );
    // Sonnet 5 at $2 / $10 / $0.20 / $2.50 per million, as published:
    // 1000*2 + 500*10 + 2000*0.2 + 400*2.5.
    expect(cost.usd).toBeCloseTo((2000 + 5000 + 400 + 1000) / 1_000_000, 12);
    expect(cost.tokens).toBe(3900);
    expect(cost.why).toBeNull();
    // The date travels with the figure, which is the whole mitigation for
    // shipping prices in source: a stale table is visible rather than wrong.
    expect(cost.price?.takenOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('a dated model id is priced by its alias, and a cheaper sibling is not', () => {
    // Longest prefix wins. Without that rule the table's ORDER decides what a
    // turn cost, which nobody notices until the cheap model is being charged at
    // five times its rate.
    expect(priceFor('openai', 'gpt-5-mini-2026-01-01')?.model).toBe('gpt-5-mini');
    expect(priceFor('openai', 'gpt-5-2026-01-01')?.model).toBe('gpt-5');
    expect(priceFor('anthropic', 'claude-opus-5-20260114')?.model).toBe('claude-opus-5');
  });

  test('a model this build has no price for reports no figure, and says so', () => {
    const cost = costOf('anthropic', 'claude-something-6', usage({ input: 10, output: 10, cache_read: 0, cache_write: 0 }));
    expect(cost.usd).toBeNull();
    // Tokens are still reported: the count is measured whatever the price table
    // knows, and the two absences are independent.
    expect(cost.tokens).toBe(20);
    expect(cost.why).toContain('no published price');
    expect(cost.why).toContain('claude-something-6');
  });

  test('a turn still streaming is not priced from the half that arrived', () => {
    // A figure that rises as the turn goes and is wrong the whole way is worse
    // than no figure, because it looks like the answer.
    const cost = costOf('anthropic', 'claude-sonnet-5', usage({ input: 1000, cache_read: 0 }));
    expect(cost.usd).toBeNull();
    expect(cost.why).toContain('not reported every count');
    expect(cost.tokens).toBe(1000);
  });

  test('OpenAI having no cache-write charge is not a missing count', () => {
    // The one absence that is not missing information, and the reason
    // `Price.cacheWrite` is nullable rather than zero: `null` means the charge
    // does not exist, and a vendor that has no such charge reports no such
    // count. The two agree, so the turn is priceable.
    const cost = costOf('openai', 'gpt-5', usage({ input: 1000, output: 100, cache_read: 0 }));
    expect(cost.usd).toBeCloseTo((1250 + 1000) / 1_000_000, 12);
    expect(cost.why).toBeNull();
  });

  test('a model that IS charged for cache writes and reported none is not priced', () => {
    // The other direction of the same test. Anthropic charges for cache writes,
    // so a turn that reported no cache-write count is missing a priced field,
    // and treating that absence as zero would understate every such turn.
    const cost = costOf('anthropic', 'claude-opus-5', usage({ input: 10, output: 10, cache_read: 0 }));
    expect(cost.usd).toBeNull();
    expect(cost.why).toContain('cache writes');
  });

  test('a turn before the vendor named its model reports no figure', () => {
    const cost = costOf('anthropic', null, usage({ input: 10, output: 10 }));
    expect(cost.usd).toBeNull();
    expect(cost.why).toContain('which model answered');
  });

  test('a turn the vendor said nothing about has no token count either', () => {
    // Null, not zero. "The vendor reported nothing" and "the turn used nothing"
    // are different facts and only one of them is a number.
    expect(costOf('anthropic', 'claude-opus-5', usage()).tokens).toBeNull();
  });

  test('every price in the table says where it came from and when', () => {
    // A price is a fact with a date. An entry without one is a number in source
    // that nobody can check and nobody will remember to.
    //
    // This is not a formality. The first draft of this table was written from
    // memory and stamped with today's date and a plausible URL, and when the
    // pages were actually read EVERY Anthropic figure was wrong - Opus 5 at
    // $15/$75 against a published $5/$25, a threefold overstatement on every
    // turn. The fields are what made that checkable; nothing else would have
    // caught it, because a wrong price and a right one look identical in a diff.
    for (const price of PRICES) {
      expect(price.source).toMatch(/^https:\/\//);
      expect(price.takenOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

// ---- the day ---------------------------------------------------------------

describe('the ledger accumulates per local day', () => {
  const at = (iso: string): Date => new Date(iso);

  test('turns on the same day add up, and a new day starts fresh', () => {
    const priced = costOf('openai', 'gpt-5', usage({ input: 1000, output: 100, cache_read: 0 }));
    let ledger = emptyLedger();
    ledger = record(ledger, priced, at('2026-09-06T10:00:00'));
    ledger = record(ledger, priced, at('2026-09-06T18:00:00'));
    ledger = record(ledger, priced, at('2026-09-07T09:00:00'));

    expect(ledger.days.length).toBe(2);
    // Newest first, so the day being spent into is the one at the top.
    expect(ledger.days[0]?.day).toBe('2026-09-07');
    expect(ledger.days[1]?.turns).toBe(2);
    expect(ledger.days[1]?.tokens).toBe(2200);
  });

  test('an unpriced turn is counted as a turn and named as unpriced', () => {
    // Two numbers rather than one, for the reason the scorecard carries its
    // denominators: `$1.20` over ten turns means something different when three
    // of them could not be priced.
    let ledger = emptyLedger();
    ledger = record(
      ledger,
      costOf('openai', 'gpt-5', usage({ input: 1000, output: 100, cache_read: 0 })),
      at('2026-09-06T10:00:00'),
    );
    ledger = record(
      ledger,
      costOf('anthropic', 'claude-unknown-9', usage({ input: 50, output: 50, cache_read: 0, cache_write: 0 })),
      at('2026-09-06T11:00:00'),
    );

    const day = today(ledger, at('2026-09-06T12:00:00'));
    expect(day?.turns).toBe(2);
    expect(day?.unpriced).toBe(1);
    // The unpriced turn's TOKENS still count - they were measured - and only
    // its dollars are missing.
    expect(day?.tokens).toBe(1200);
  });

  test('the day is the local one, and the sentence never says the run', () => {
    const noon = at('2026-09-06T12:00:00');
    expect(localDay(noon)).toBe('2026-09-06');

    const ledger = record(
      emptyLedger(),
      costOf('openai', 'gpt-5', usage({ input: 1000, output: 100, cache_read: 0 })),
      noon,
    );
    const line = describeDay(today(ledger, noon));
    expect(line).toContain('Pilot today');
    expect(line).toContain('estimated');
    // It must be unreadable as the run's figure. The run's is a proxy for work
    // volume and is not money; this one is money and is not the run's.
    expect(line).not.toMatch(/run|budget/i);
  });

  test('a day with nothing in it says so rather than showing zero dollars', () => {
    expect(describeDay(null)).toBe('Pilot: nothing spent today.');
    expect(describeDay(today(emptyLedger(), at('2026-09-06T12:00:00')))).toBe(
      'Pilot: nothing spent today.',
    );
  });

  test('a day where nothing could be priced reports tokens and no dollars', () => {
    const ledger = record(
      emptyLedger(),
      costOf('anthropic', 'claude-unknown-9', usage({ input: 50, output: 50, cache_read: 0, cache_write: 0 })),
      at('2026-09-06T12:00:00'),
    );
    const line = describeDay(today(ledger, at('2026-09-06T12:00:00')));
    expect(line).toContain('100 tokens');
    expect(line).not.toContain('$');
    expect(line).toContain('1 of 1 turn could not be priced');
  });
});

// ---- the ceiling -----------------------------------------------------------

describe('the pilot has its own ceiling, and it is off until asked for', () => {
  const at = new Date('2026-09-06T12:00:00');
  const spent = (tokens: number, usd: number): ReturnType<typeof emptyLedger> => ({
    days: [{ day: localDay(at), tokens, usd, unpriced: 0, turns: 1 }],
  });

  test('no ceiling is the default, and it never refuses', () => {
    expect(NO_LIMITS).toEqual({ dailyTokens: null, dailyUsd: null });
    expect(limitVerdict(spent(9_999_999, 9_999), NO_LIMITS, at).allowed).toBe(true);
  });

  test('an empty ledger is allowed whatever the ceiling', () => {
    const limits: PilotLimits = { dailyTokens: 1, dailyUsd: 0.01 };
    expect(limitVerdict(emptyLedger(), limits, at).allowed).toBe(true);
  });

  test('a token ceiling refuses at it, and says whose ceiling it is', () => {
    const verdict = limitVerdict(spent(1000, 0), { dailyTokens: 1000, dailyUsd: null }, at);
    expect(verdict.allowed).toBe(false);
    // The refusal has to be unmistakably the pilot's. A user who reads "over
    // budget" and thinks the run stopped has been told the wrong thing.
    expect(verdict.why).toContain("pilot's own limit");
    expect(verdict.why).toContain('nothing to do with the run');
  });

  test('a dollar ceiling refused over an incomplete figure says it is incomplete', () => {
    const ledger = { days: [{ day: localDay(at), tokens: 10, usd: 5, unpriced: 3, turns: 8 }] };
    const verdict = limitVerdict(ledger, { dailyTokens: null, dailyUsd: 5 }, at);
    expect(verdict.allowed).toBe(false);
    // The reader needs "at least this much", not "exactly this much" - three of
    // today's turns are missing from the number the ceiling was checked against.
    expect(verdict.why).toContain('could not be priced');
    expect(verdict.why).toContain('the real figure is higher');
  });

  test("yesterday's spend does not hold today's turn", () => {
    const ledger = { days: [{ day: '2026-09-05', tokens: 10_000, usd: 50, unpriced: 0, turns: 4 }] };
    expect(limitVerdict(ledger, { dailyTokens: 10, dailyUsd: 1 }, at).allowed).toBe(true);
  });
});

test('a figure too small to have a cent still shows what it was', () => {
  // `$0.00` beside a real turn reads as free. Four places is where a single
  // cheap turn stops rounding to nothing.
  expect(formatUsd(0.0004)).toBe('$0.0004');
  expect(formatUsd(1.234)).toBe('$1.23');
});
