/**
 * The two API keys the app handed this process, in memory and nowhere else
 * (#223). A leaf - no imports - because `proc.ts` redacts with it and
 * `auth.ts` reads the config, and a cycle between those is one whose evaluation
 * order decides whether a constant exists yet. See `auth.ts` for the design.
 */

export type KeyVendor = 'anthropic' | 'openai';

/** Every variable either CLI reads a key from, which `secrets()` also redacts. */
const ENV_KEYS: readonly string[] = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CODEX_API_KEY', 'OPENAI_API_KEY'];

const held: Record<KeyVendor, string | null> = { anthropic: null, openai: null };

/** The variable the app puts the frame's secret in when it spawns the host. */
export const KEYS_SECRET_VAR = 'VIBE_HOST_KEYS_SECRET';

/**
 * Take the keys the app read from its keychain, if the frame proves it came
 * from the app. Returns whether it was accepted, and never says why not - a
 * refusal that explained itself would be telling a forger what to fix.
 *
 * The secret is read once and removed from this process's environment, so no
 * child - and no agent turn printing its environment - ever inherits it.
 */
let secret: string | null | undefined;
export function acceptKeys(frame: Readonly<Record<string, unknown>>): boolean {
  if (secret === undefined) {
    const value = process.env[KEYS_SECRET_VAR];
    secret = value === undefined || value === '' ? null : value;
    delete process.env[KEYS_SECRET_VAR];
  }
  if (secret === null || frame['secret'] !== secret) return false;
  for (const vendor of ['anthropic', 'openai'] as const) {
    const key = frame[vendor];
    held[vendor] = typeof key === 'string' && key.trim() !== '' ? key.trim() : null;
  }
  return true;
}

/** For tests: forget the keys and the secret. */
export function resetKeys(): void {
  held.anthropic = null;
  held.openai = null;
  secret = undefined;
}

/** Every key this process could put in a child's environment, for redaction. */
export function secrets(): string[] {
  const all = [held.anthropic, held.openai, ...ENV_KEYS.map((name) => process.env[name])];
  // Eight characters, so a variable set to something like "1" cannot turn every
  // digit in a transcript into a redaction.
  return all.filter((key): key is string => typeof key === 'string' && key.length >= 8);
}

/** The key the app sent for one vendor, or null. */
export function heldKey(vendor: KeyVendor): string | null {
  return held[vendor];
}

/** Every occurrence of a held key in `text`, replaced. */
export function redact(text: string, keys: readonly string[] = secrets()): string {
  let out = text;
  for (const key of keys) out = out.split(key).join('[redacted key]');
  return out;
}
