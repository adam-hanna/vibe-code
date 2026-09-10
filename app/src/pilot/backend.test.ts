import { expect, test } from 'vitest';
import keysSource from './keys.ts?raw';
import serve from '../../../src/serve.ts?raw';
import protocol from '../../../src/protocol.ts?raw';
import { BACKEND_NAME, BACKEND_NOTE, BACKENDS, modelsFor, needsKey } from './backend';
import { costOf } from './ledger';
import { MODELS } from './pilot';
import { PROVIDERS } from './keys';
import type { Usage } from './pilot';

/**
 * The third backend, and the wall between it and the keychain (#193).
 *
 * A backend is **not** a provider. `Provider` is the keychain's vocabulary —
 * `key_set` and `key_status` are Rust commands that refuse anything but the two,
 * and `keys.test.ts` pins the registered list. Widening it would have meant a
 * third key slot for a backend that has no key, so this is the wider axis and
 * `needsKey` is the one place they meet.
 */

test('the subscription backend is the one that works with nothing configured', () => {
  // First in the list, and it is the pane's default. The whole of the issue is
  // that an API key is optional rather than a precondition for the pane doing
  // anything at all.
  expect(BACKENDS[0]).toBe('subscription');
  expect(needsKey('subscription')).toBe(false);
  for (const provider of PROVIDERS) expect(needsKey(provider)).toBe(true);
});

test('every backend has a name, and a note only where there is a cost to state', () => {
  // The note used to describe the *mechanism* — no key needed, a fenced block
  // rather than a tool call — and this pinned that wording. It is no longer the
  // contract: the owner removed it, on the grounds that a person choosing a
  // backend cannot act on any of it and `Claude (subscription)` beside it says
  // the whole of what they need. The mechanism is still documented, in the file
  // that implements it.
  //
  // What still holds and is still pinned: every backend is nameable, and the two
  // that spend money say so — which is the fact the selector cannot carry.
  for (const backend of BACKENDS) {
    expect(BACKEND_NAME[backend], `${backend} has no name`).toBeTruthy();
  }
  expect(BACKEND_NOTE.subscription, 'a subscription bills nothing, so it says nothing').toBe('');
  for (const provider of PROVIDERS) {
    expect(BACKEND_NOTE[provider]).toMatch(/billed to your key/i);
    expect(BACKEND_NOTE[provider]).toMatch(/propose/i);
  }
});

test('the subscription models are their own list, not a row in the vendor map', () => {
  // `pilot.MODELS` mirrors what Rust sends to a vendor, and this backend never
  // reaches Rust. One list serving two wires is how a model reaches the one that
  // cannot run it.
  expect(modelsFor('anthropic', MODELS)).toEqual(MODELS.anthropic);
  expect(modelsFor('subscription', MODELS).length).toBeGreaterThan(0);
  for (const model of modelsFor('subscription', MODELS)) {
    expect(model, 'the CLI runs Claude, whatever the vendor map says').toMatch(/^claude-/);
  }
});

test('the keychain never learns the third backend exists', () => {
  // From the side that would have to change if it did. `keys.ts` is the wire to
  // three Rust commands whose `Provider` is refused by serde if it is not one of
  // two, so a `subscription` reaching any of them is a request that cannot
  // succeed and would fail at the boundary rather than here.
  const code = keysSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  expect(code).not.toContain('subscription');
});

test('a subscription turn is counted in tokens and never in money', () => {
  // The rule the whole ledger is built on: **never invent a number.** A
  // subscription bills nothing at all, so there is no quantity for a figure to
  // be an estimate of — the same sentence that makes Codex cost unreportable.
  const usage: Usage = { input: 100, output: 20, cache_read: 5, cache_write: null };
  const free = costOf('subscription', 'claude-opus-5', usage);

  expect(free.tokens).toBe(125);
  expect(free.usd).toBeNull();
  expect(free.price).toBeNull();
  expect(free.why).toMatch(/bills nothing/);
});

test('a subscription turn and an unpriced model do not share a sentence', () => {
  // Two different nulls. One is missing information — a model this build has no
  // published price for — and the other is a statement that there is no price to
  // have. Collapsing them would make the second look like an omission somebody
  // should fix.
  const usage: Usage = { input: 100, output: 20, cache_read: 5, cache_write: null };
  const free = costOf('subscription', 'claude-opus-5', usage);
  const unpriced = costOf('anthropic', 'a-model-nobody-has-priced', usage);

  expect(unpriced.usd).toBeNull();
  expect(unpriced.why).not.toBe(free.why);
  expect(unpriced.why).toMatch(/no published price/);
});

/**
 * The other end of the wire, read from the core's own source.
 *
 * The failure is quiet in the way #159's phase map was: an unknown `type` is
 * refused with an `error` frame that lands in the log pane, so the pane would
 * appear to send a message that never got answered, with nothing going red.
 */
test('the host still accepts a pilot turn and answers with the two frames', () => {
  const body = /export function decode\([\s\S]*?\n\}/.exec(protocol)?.[0];
  if (body === undefined) throw new Error('decode not found in src/protocol.ts');
  expect(body).toContain("case 'pilot':");

  expect(protocol).toContain("type: 'pilot_delta'");
  expect(protocol).toContain("type: 'pilot_reply'");
  // And it runs beside a run rather than through the one-at-a-time gate: the
  // handler returns before `running` is ever consulted.
  expect(serve).toContain("if (msg.type === 'pilot')");
});

test('a pilot reply carries no money field, on either side of the wire', () => {
  // `PilotChatResult` has no `costUsd` and there is nowhere here to invent one.
  // Checked as a boundary rather than as a behaviour, because nothing would fail
  // loudly if a figure appeared — it would simply be wrong, and believed.
  const reply = /type: 'pilot_reply';[\s\S]*?\}/.exec(protocol)?.[0] ?? '';
  expect(reply).not.toMatch(/cost|usd|price/i);
});
