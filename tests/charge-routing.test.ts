import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { applyCharge, attachSpend, chargeFailure, takeInFlight } from '@src/charge.js';
import { createRun } from '@src/run.js';
import type { Config, RunState } from '@src/types.js';

/**
 * Which agent a charge is filed under, and what happens to the evidence.
 *
 * Two questions that used to have one answer. The share was routed on
 * `costUsd === null`, a proxy that held only while every null-cost charge was
 * Codex's - and it stops holding the moment a Claude turn is charged with no
 * cost figure, which is what a turn recovered from a killed process is, and what
 * a turn charged from the stream after a failure is (#77).
 *
 * The other half is disposal. An in-flight entry lives from its turn's first
 * observation until the next accounting decision touches it, and every decision
 * disposes of it in the write that records the decision - which is what makes a
 * surviving entry mean "the process died before its accounting ran" rather than
 * "something, once".
 */

function freshState(): RunState {
  return createRun(mkdtempSync(path.join(tmpdir(), 'vibe-routing-')), 'charge routing', true);
}

function config(over: Partial<Config> = {}): Config {
  return { ...DEFAULTS, ...over };
}

function persisted(state: RunState): Partial<RunState> {
  return JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as Partial<RunState>;
}

/** A charge in the shape every call site builds. */
function charge(over: Partial<Parameters<typeof applyCharge>[2]> = {}): Parameters<
  typeof applyCharge
>[2] {
  return {
    costUsd: null,
    tokens: 1_000,
    provider: 'claude',
    label: 'implement',
    event: { type: 'claude_turn', data: { label: 'implement' } },
    describe: () => 'charged',
    warnings: [],
    ...over,
  };
}

/** The last event of a type, for reading what a charge recorded. */
function lastEvent(state: RunState, type: string): Record<string, unknown> | undefined {
  return [...state.events].reverse().find((e) => e.type === type);
}

// ---- which share ------------------------------------------------------------

test('a Claude charge with no cost figure lands in the Claude share', () => {
  const state = freshState();

  applyCharge(state, config(), charge({ costUsd: null, tokens: 12_000, provider: 'claude' }));

  assert.equal(state.tokensUsed, 12_000);
  // Absent, not zero: `summary()` renders `tokensUsed - codexTokens` as Claude's
  // share, so filing this under Codex would misreport both agents at once.
  assert.equal(state.codexTokens, undefined);
  assert.equal(state.tokensUsed - (state.codexTokens ?? 0), 12_000);
  assert.equal(state.costUsd, 0);
});

test('a Codex charge still lands in the Codex share', () => {
  const state = freshState();

  applyCharge(state, config(), charge({ costUsd: null, tokens: 500, provider: 'codex', label: 'review-0' }));

  assert.equal(state.tokensUsed, 500);
  assert.equal(state.codexTokens, 500);
  assert.equal(state.costUsd, 0);
});

test('a Claude charge with a cost figure moves both totals, as it always did', () => {
  const state = freshState();

  applyCharge(state, config(), charge({ costUsd: 0.02, tokens: 1_000 }));

  assert.equal(state.tokensUsed, 1_000);
  assert.equal(state.codexTokens, undefined);
  assert.equal(state.costUsd, 0.02);
});

test('a mixed run still renders each share correctly', () => {
  const state = freshState();

  applyCharge(state, config(), charge({ costUsd: 0.05, tokens: 3_000, provider: 'claude' }));
  applyCharge(state, config(), charge({ costUsd: null, tokens: 500, provider: 'codex', label: 'review-0' }));
  // The recovered turn: Claude's tokens, no cost.
  applyCharge(state, config(), charge({ costUsd: null, tokens: 2_000, provider: 'claude', label: 'plan' }));

  assert.equal(state.tokensUsed, 5_500);
  assert.equal(state.codexTokens, 500);
  assert.equal(state.tokensUsed - (state.codexTokens ?? 0), 5_000, 'the Claude share');
});

// ---- disposal ---------------------------------------------------------------

test('a charge clears its own in-flight entry and leaves a concurrent one', () => {
  const state = freshState();
  state.inFlight = [
    { label: 'compact', provider: 'claude', tokens: 900 },
    { label: 'review-0', provider: 'codex' },
  ];

  applyCharge(state, config(), charge({ label: 'compact', tokens: 900, costUsd: 0.01 }));

  // The overlapping pair `withConcurrentCompaction` produces: each turn's own
  // accounting disposes of its own record and nobody else's.
  assert.deepEqual(state.inFlight, [{ label: 'review-0', provider: 'codex' }]);
  assert.deepEqual(persisted(state).inFlight, [{ label: 'review-0', provider: 'codex' }]);
});

test('the clear and the event that explains it land in one write', () => {
  const state = freshState();
  state.inFlight = [{ label: 'implement', provider: 'claude', tokens: 1_000 }];

  applyCharge(state, config(), charge({ tokens: 1_000 }));

  // Read from disk, not memory: the guarantee is that no kill can observe a
  // state where the charge is recorded and its evidence is still owing, or the
  // reverse - the next run would charge it a second time.
  const file = persisted(state);
  assert.equal(file.inFlight, undefined);
  assert.ok(file.events?.some((e) => e.type === 'claude_turn'));
});

test('clearing the last entry removes the field rather than leaving an empty list', () => {
  const state = freshState();
  state.inFlight = [{ label: 'plan', provider: 'claude', tokens: 10 }];

  assert.equal(takeInFlight(state, 'plan', 'claude'), 10);
  assert.equal('inFlight' in state, false);
});

test('a charge whose entry observed more than was charged records the difference', () => {
  const state = freshState();
  state.inFlight = [{ label: 'implement', provider: 'claude', tokens: 5_000 }];

  applyCharge(state, config(), charge({ tokens: 1_000, costUsd: 0.01 }));

  // The provider's figure is what a completed turn is charged - re-charging the
  // difference would invent spend - but the disagreement is a fact about this
  // run and is recorded rather than dropped.
  assert.equal(state.tokensUsed, 1_000);
  assert.equal(lastEvent(state, 'claude_turn')?.['observedTokens'], 5_000);
});

test('a charge that matches what was observed records no difference', () => {
  const state = freshState();
  state.inFlight = [{ label: 'implement', provider: 'claude', tokens: 1_000 }];

  applyCharge(state, config(), charge({ tokens: 1_000 }));

  assert.equal(lastEvent(state, 'claude_turn')?.['observedTokens'], undefined);
});

// ---- reconciliation on failure ---------------------------------------------

test('a failure reporting a cost with zero tokens is charged the stream figure', () => {
  const state = freshState();
  state.inFlight = [{ label: 'implement', provider: 'claude', tokens: 4_000 }];
  // Exactly the envelope `src/claude.ts` builds when the failure carries a cost
  // but no usage block: a real cost beside a structurally impossible token count.
  const err = attachSpend(new Error('claude turn failed'), { costUsd: 0.02, tokens: 0 });

  const ceiling = chargeFailure(state, config(), err, { label: 'implement', provider: 'claude' });

  assert.equal(ceiling, null);
  assert.equal(state.tokensUsed, 4_000, 'the tokens the stream saw');
  assert.equal(state.costUsd, 0.02, 'and the cost the provider reported');
  assert.equal(lastEvent(state, 'turn_failed')?.['tokensFrom'], 'stream');
  assert.equal(state.inFlight, undefined);
});

test('a failure whose provider figure is larger is charged that, not the stream', () => {
  const state = freshState();
  state.inFlight = [{ label: 'implement', provider: 'claude', tokens: 4_000 }];
  const err = attachSpend(new Error('boom'), { costUsd: 0.02, tokens: 9_000 });

  chargeFailure(state, config(), err, { label: 'implement', provider: 'claude' });

  // Never a sum: the two measure the same turn, so 13,000 would be a figure no
  // one observed.
  assert.equal(state.tokensUsed, 9_000);
  assert.equal(lastEvent(state, 'turn_failed')?.['tokensFrom'], 'provider');
});

test('a failure with only a stream observation is charged it once', () => {
  const state = freshState();
  state.inFlight = [{ label: 'implement', provider: 'claude', tokens: 7_000 }];

  chargeFailure(state, config(), new Error('killed'), { label: 'implement', provider: 'claude' });

  assert.equal(state.tokensUsed, 7_000);
  assert.equal(state.codexTokens, undefined, 'a Claude turn, even with no cost figure');
  assert.equal(lastEvent(state, 'turn_failed')?.['tokensFrom'], 'stream');
  assert.equal(state.inFlight, undefined);

  // And it is not charged again by anything that comes later: the evidence is
  // gone in the same write that recorded the charge.
  assert.equal(persisted(state).inFlight, undefined);
});

test('a failure with nothing reported and nothing observed charges and records nothing', () => {
  const state = freshState();
  const before = state.events.length;

  const ceiling = chargeFailure(state, config(), new Error('died silently'), {
    label: 'implement',
    provider: 'claude',
  });

  assert.equal(ceiling, null);
  assert.equal(state.tokensUsed, 0);
  assert.equal(state.events.length, before, 'nothing happened that a reader could act on');
});

test('a failure disposes of a record it did not charge, so it cannot read as a kill later', () => {
  const state = freshState();
  // What a turn that opened and then died before saying anything leaves: the
  // `'start'` observation wrote an entry with nothing in it.
  state.inFlight = [{ label: 'implement', provider: 'claude', tokens: 0 }];

  chargeFailure(state, config(), new Error('no result event'), {
    label: 'implement',
    provider: 'claude',
  });

  // An entry surviving an in-process failure would be announced by the next
  // resume as an interrupted turn, which would simply be untrue.
  assert.equal(state.inFlight, undefined);
  assert.equal(persisted(state).inFlight, undefined, 'and the disposal reached disk');
});

test('a Codex failure disposes of its record and charges the Codex share', () => {
  const state = freshState();
  state.inFlight = [{ label: 'review-0', provider: 'codex' }];
  const err = attachSpend(new Error('codex blew up'), { costUsd: null, tokens: 500 });

  chargeFailure(state, config(), err, { label: 'review-0', provider: 'codex' });

  assert.equal(state.tokensUsed, 500);
  assert.equal(state.codexTokens, 500);
  assert.equal(state.inFlight, undefined);
});
