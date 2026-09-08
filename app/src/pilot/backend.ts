import { PROVIDER_NAME, PROVIDERS } from './keys';
import type { Provider } from './keys';

/**
 * Where a pilot turn actually runs (#193).
 *
 * Two of the three are vendors reached over HTTP from Rust with a key from the
 * keychain. The third is **the CLI the user already pays for**: `claude -p`,
 * spawned by the host through `src/pilotchat.ts`, on the subscription. So an API
 * key is optional rather than a precondition for the pane doing anything at all.
 *
 * **A backend is not a provider, and widening `Provider` would have been the
 * wrong move.** `Provider` is the *keychain's* vocabulary - `key_set` and
 * `key_status` are Rust commands that refuse anything but those two, and
 * `keys.test.ts` pins the list. A third member would mean a third key slot for a
 * backend that has no key. This is the wider axis, and `needsKey` is the one
 * place the two meet.
 *
 * ## The two are asymmetric, and both directions are on purpose
 *
 * The API-backed pilot has **no filesystem at all** and the subscription one can
 * read the repository - `--tools Read Glob Grep` under `--restricted`, which is
 * what makes it useful for *"what is this doing"*.
 *
 * In the other direction the two reach the **same** tools by different roads,
 * which is #211 and is a change from how this shipped. `claude -p` still takes
 * no schemas from us, so a subscription turn is told `declare()` in its system
 * prompt and answers in a fenced block that `emit.ts` reads back into the same
 * `Call` a vendor would have streamed. One table, two channels, and `execute`
 * below them both - so a tool cannot exist on one backend and not the other.
 *
 * What stays asymmetric is the wire, not the capability: a vendor call is
 * validated by the vendor against a schema, and an emitted one is validated here
 * on arrival. Both are propose-only, which is what makes the weaker channel
 * acceptable - a block read wrong produces a card with a visibly wrong argv that
 * nobody presses, never an action.
 */
export type Backend = Provider | 'subscription';

/** Subscription first: it is the one that works with nothing configured. */
export const BACKENDS: readonly Backend[] = ['subscription', ...PROVIDERS];

export const BACKEND_NAME: Readonly<Record<Backend, string>> = {
  subscription: 'Claude (subscription)',
  ...PROVIDER_NAME,
};

/**
 * Whether this backend needs a key, narrowing to the keychain's vocabulary.
 *
 * A type guard rather than a boolean, so a caller that has checked cannot then
 * pass `'subscription'` to `key_status` - the compiler stops it, which is
 * stronger than a comment saying not to.
 */
export function needsKey(backend: Backend): backend is Provider {
  return backend !== 'subscription';
}

/**
 * What `claude -p` may be asked to run on.
 *
 * Its own list rather than a row in `pilot.MODELS`, because that map mirrors
 * what **Rust** sends to a vendor and this backend never reaches Rust at all.
 * One list serving two wires is how a model reaches the one that cannot run it.
 */
export const SUBSCRIPTION_MODELS: readonly string[] = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
];

/** What this backend can be asked to run on. */
export function modelsFor(backend: Backend, api: Readonly<Record<Provider, readonly string[]>>): readonly string[] {
  return needsKey(backend) ? api[backend] : SUBSCRIPTION_MODELS;
}

/** What this backend can and cannot do, said out loud in the pane. */
export const BACKEND_NOTE: Readonly<Record<Backend, string>> = {
  subscription:
    'runs on the subscription — no key needed. It can read the repository, and it proposes a ' +
    'run in a fenced block rather than a tool call: the CLI takes no schemas, so the table is ' +
    'in its prompt. You still press the button.',
  anthropic: 'over the API, billed to your key. It can propose a run and cannot read files.',
  openai: 'over the API, billed to your key. It can propose a run and cannot read files.',
};
