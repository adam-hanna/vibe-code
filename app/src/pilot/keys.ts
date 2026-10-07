import { invoke } from '@tauri-apps/api/core';

/**
 * The webview's half of credential handling (#143).
 *
 * **There is no `get`.** Three commands exist — store, forget, and ask whether
 * one is present — and the absence of a fourth is the design rather than an
 * omission. The key never crosses the IPC boundary, so a compromised page has
 * nothing to steal; and the CSP says the same thing from the other side, since
 * `connect-src 'self' ipc: http://ipc.localhost` means this page could not reach
 * a vendor even holding one.
 *
 * The request is made in Rust, with a key read through a `pub(crate)` function
 * nothing reachable from here can call.
 */

/** The two providers the pilot speaks to. Closed, and refused by serde if it is not one of these. */
export type Provider = 'anthropic' | 'openai';

export const PROVIDERS: readonly Provider[] = ['anthropic', 'openai'];

/** What a provider is called in prose. */
export const PROVIDER_NAME: Readonly<Record<Provider, string>> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
};

export interface KeyStatus {
  provider: Provider;
  /** Whether a key is stored. Never the key, and never part of one. */
  present: boolean;
  /**
   * Why presence could not be established, or null.
   *
   * A different fact from `present: false` and treated as one: a locked keychain
   * is not a user who has entered nothing, and telling them to enter a key they
   * already gave is how they end up overwriting a working one.
   */
  unreadable: string | null;
}

export function status(): Promise<KeyStatus[]> {
  return invoke<KeyStatus[]>('key_status');
}

export function set(provider: Provider, key: string): Promise<void> {
  return invoke('key_set', { provider, key });
}

export function clear(provider: Provider): Promise<void> {
  return invoke('key_clear', { provider });
}

/**
 * What the app can do with what it has.
 *
 * **One provider configured is a supported state, not a degraded one.** It is
 * probably the common case — somebody with one subscription trying this before
 * deciding whether to buy a second — and the app has to work, and say plainly
 * which one it has, rather than asking for the other.
 */
export function usable(statuses: readonly KeyStatus[]): readonly Provider[] {
  return statuses.filter((s) => s.present).map((s) => s.provider);
}
