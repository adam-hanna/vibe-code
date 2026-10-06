import { PROVIDER_NAME, PROVIDERS } from './keys';
import type { Provider } from './keys';

/**
 * Where a pilot turn actually runs (#193).
 *
 * Two of the four are vendors reached over HTTP from Rust with a key from the
 * keychain. The other two are **the CLIs the user already pays for**: `claude -p`
 * through `src/pilotchat.ts`, and `codex exec` through `src/pilotcodex.ts` (#223),
 * both spawned by the host on the subscription. So an API key is optional rather
 * than a precondition for the pane doing anything at all, for either vendor.
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
 * Both CLIs have their own tools - files and a shell, bounded by the settings
 * for all projects (#223, `src/pilotchat.ts`, `src/pilotcodex.ts`). The vendors'
 * APIs have no filesystem at all, so they read through vibe's `list_dir` and
 * `read_file`, answered by the host inside the allowed directories.
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
export type Backend = Provider | 'subscription' | 'codex';

/**
 * Subscription first: it is the one that works with nothing configured.
 *
 * `subscription` is the Claude CLI and keeps that spelling because it is stored
 * on every saved reply; `codex` is the OpenAI subscription, through `codex exec`
 * (#223).
 */
export const BACKENDS: readonly Backend[] = ['subscription', 'codex', ...PROVIDERS];

export const BACKEND_NAME: Readonly<Record<Backend, string>> = {
  subscription: 'Claude (subscription)',
  codex: 'Codex (subscription)',
  ...PROVIDER_NAME,
};

/**
 * How the pilot reaches one vendor, as Settings chose it (#223). The shape of
 * `PilotAccess`'s two route fields, restated here so this module needs nothing
 * from the window.
 */
export interface Routes {
  anthropic: 'subscription' | 'api';
  openai: 'subscription' | 'api';
}

/**
 * The backend a conversation with this vendor runs on (#223).
 *
 * *"two options for both anthropic and openAI: (1) subscription, (2) api key"* —
 * so the conversation picks the vendor and Settings picks the road, and this is
 * the one place the two become a backend.
 */
export function backendFor(vendor: Provider, routes: Routes): Backend {
  if (vendor === 'anthropic') return routes.anthropic === 'api' ? 'anthropic' : 'subscription';
  return routes.openai === 'api' ? 'openai' : 'codex';
}

/** Which CLI the host spawns for a backend that needs no key. */
export function agentOf(backend: Exclude<Backend, Provider>): 'claude' | 'codex' {
  return backend === 'codex' ? 'codex' : 'claude';
}

/**
 * Whether this backend needs a key, narrowing to the keychain's vocabulary.
 *
 * A type guard rather than a boolean, so a caller that has checked cannot then
 * pass `'subscription'` to `key_status` - the compiler stops it, which is
 * stronger than a comment saying not to.
 */
export function needsKey(backend: Backend): backend is Provider {
  return backend === 'anthropic' || backend === 'openai';
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

/**
 * What `codex exec` may be asked to run on (#223).
 *
 * The two Codex names this build already ships — `DEFAULTS.codex.model` and the
 * one `--help` prints beside `--role` — which is `KNOWN_MODELS.codex` in
 * `src/roles.ts`. Restated rather than imported because the app and the core are
 * two packages; `backend.test.ts` reads that file and fails when they disagree.
 */
export const CODEX_SUBSCRIPTION_MODELS: readonly string[] = ['gpt-5.6-luna', 'gpt-5.6-pro'];

/** What this backend can be asked to run on. */
export function modelsFor(backend: Backend, api: Readonly<Record<Provider, readonly string[]>>): readonly string[] {
  if (needsKey(backend)) return api[backend];
  return backend === 'codex' ? CODEX_SUBSCRIPTION_MODELS : SUBSCRIPTION_MODELS;
}

/**
 * What this backend costs, said out loud in the pane. Empty when there is
 * nothing to say.
 *
 * **The subscription row is deliberately empty**, and what was there is worth
 * recording as a lesson rather than as a loss. It described the *mechanism* -
 * no key needed, a fenced block rather than a tool call, the CLI takes no
 * schemas - which is true, is the reason `emit.ts` exists, and is of no use
 * whatever to somebody deciding what to type. `Claude (subscription)` in the
 * selector beside it is the whole of what a reader needs; the mechanism belongs
 * in `emit.ts`'s header, where it is.
 *
 * The two API rows stay, because *billed to your key* is a fact about money that
 * the selector does not carry and a person would want before sending.
 */
export const BACKEND_NOTE: Readonly<Record<Backend, string>> = {
  subscription: '',
  codex: '',
  anthropic: 'over the API, billed to your key. It can propose a run, and reads files through vibe.',
  openai: 'over the API, billed to your key. It can propose a run, and reads files through vibe.',
};
