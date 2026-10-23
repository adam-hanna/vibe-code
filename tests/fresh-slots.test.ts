import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatSlot } from '@src/roles.js';
import { ensureSlotId, forkedSlotFields, SLOTS, slotHasMemory, slotResumeId } from '@src/slots.js';
import { config, freshRun } from './helpers/loop-harness.js';

/**
 * The one-shot read-only slots an additional review seat will use (#388
 * decision 2), added in Part A and unused by the loop.
 *
 * A Claude seat must never be on `main` - the implementer's own session - and
 * no seat may resume `review` or `judge`. These pin the vocabulary: which slot a
 * seat gets, that it never carries a conversation however `codex.persistSession`
 * is set, that a Claude seat gets a new id each turn without the run's state
 * moving, and that a fork's census is what it was.
 */

const ON = config();
const OFF = config({}, { codex: { ...config().codex, persistSession: false } });

test('a seat is never on main, judge or review, and sits with its own provider', () => {
  for (const provider of ['claude', 'codex'] as const) {
    const slot = seatSlot(provider);
    assert.ok(!['main', 'judge', 'review', 'write'].includes(slot), `${provider} seat on ${slot}`);
    assert.equal(SLOTS[slot].provider, provider);
  }
});

test('neither fresh slot carries a conversation, whatever persistSession says', () => {
  const state = freshRun({ prefix: 'vibe-fresh-slots-' });
  for (const slot of ['fresh-claude', 'fresh-codex'] as const) {
    for (const cfg of [ON, OFF]) {
      assert.equal(SLOTS[slot].persists(cfg), false, slot);
      assert.equal(slotHasMemory(state, cfg, slot), false, slot);
      assert.equal(slotResumeId(state, cfg, slot), null, slot);
    }
    assert.equal(SLOTS[slot].reset, null, `${slot} has nothing to rotate`);
    assert.equal(SLOTS[slot].occupancy, null, `${slot} has no thread to measure`);
  }
});

test('a Claude seat gets a new id every turn, and the run state does not move', () => {
  const state = freshRun({ prefix: 'vibe-fresh-slots-' });
  const before = structuredClone(state);
  const a = ensureSlotId(state, 'fresh-claude');
  const b = ensureSlotId(state, 'fresh-claude');
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.notEqual(a, b);
  assert.notEqual(a, state.sessionId, 'never the implementer session');
  assert.deepEqual(state, before);
  // A Codex seat is provider-minted, as `write` is: there is no id to spawn under.
  assert.throws(() => ensureSlotId(state, 'fresh-codex'), /provider-minted/);
});

test('a fork census lists the four conversations it always has', () => {
  const parent = freshRun({ prefix: 'vibe-fresh-slots-' });
  for (const cfg of [ON, OFF]) {
    const { conversations } = forkedSlotFields(parent, cfg);
    assert.deepEqual(
      conversations.map((c) => c.slot),
      ['main', 'judge', 'review', 'write'],
    );
  }
});
