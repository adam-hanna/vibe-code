import { readGlobalConfig } from '@src/config.js';
import { heldKey } from '@src/heldkeys.js';

/**
 * How vibe reaches each vendor, for everything it does there (#223).
 *
 * *"If we have api keys set, we should use them everywhere (pilot, runs,
 * etc). Same for subscriptions."* So the choice is one per vendor, and it is
 * no longer the pilot's: `auth.anthropic` decides how every `claude` child is
 * authenticated - each run turn, each preflight probe and the subscription
 * pilot - and `auth.openai` does the same for every `codex` child. The
 * API-backed pilot is the same choice reaching the vendor without a CLI.
 *
 * - **`subscription`** - the CLI's own login. The API-key variables are
 *   **removed** from the child's environment, because both CLIs prefer a key
 *   to a login when one is set (measured: `claude` says so in a warning, and
 *   `codex exec` answers a bogus `CODEX_API_KEY` with a 401) - so a key
 *   lying in somebody's shell would otherwise bill them under a setting that
 *   says nothing is billed.
 * - **`api`** - the key, put in the child's environment: `ANTHROPIC_API_KEY`
 *   for `claude`, `CODEX_API_KEY` for `codex exec`. It comes from the app's
 *   keychain when the app sent one, and otherwise from this process's own
 *   environment, which is how a terminal user supplies it. A route of `api`
 *   with neither is refused **before the spawn**, naming both ways to fix it,
 *   because the alternative is a child that quietly falls back to the login.
 *
 * **Machine-only, like `pilot` and `cli`.** Which account pays is a fact about
 * one person, and a committed `vibe.config.json` that could switch a clone to
 * somebody's key - or off it - is a repository choosing who is billed.
 *
 * ## The keys, and where they may go
 *
 * The keychain is read by the app's Rust, and the window can never read it. The
 * app hands both keys to this process **on stdin**, in a frame carrying a
 * secret the app put in this process's environment at spawn - so the window,
 * which can write frames, cannot forge one (`acceptKeys`). They live here, in
 * memory (`heldkeys.ts`), and go only into a child's environment. Never onto
 * the wire, never into `state.json`, never into a log: `secrets()` is what
 * `run()` redacts from everything a child prints, because a vendor's 401 quotes
 * the key it was sent.
 */

export type Vendor = 'anthropic' | 'openai';
export type Route = 'subscription' | 'api';
export type Routes = Readonly<Record<Vendor, Route>>;

/**
 * Subscription for both: it is the road that works with nothing entered, and a
 * default needing a key would be a product that does nothing until you buy one.
 */
export const ROUTE_DEFAULTS: Routes = { anthropic: 'subscription', openai: 'subscription' };

/** The variables each CLI reads a key from, and the one we set on `api`. */
const KEY_VARS: Readonly<Record<Vendor, { set: string; all: readonly string[] }>> = {
  anthropic: { set: 'ANTHROPIC_API_KEY', all: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] },
  openai: { set: 'CODEX_API_KEY', all: ['CODEX_API_KEY', 'OPENAI_API_KEY'] },
};

const VENDOR_OF_CLI = { claude: 'anthropic', codex: 'openai' } as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The global file's `auth` section, over the defaults, or a refusal by name. */
export function readRoutes(globalRaw: Readonly<Record<string, unknown>>): Routes {
  const section = globalRaw['auth'];
  if (section === undefined) return ROUTE_DEFAULTS;
  if (!isRecord(section)) throw new Error('auth must be an object');
  const out: Record<Vendor, Route> = { ...ROUTE_DEFAULTS };
  for (const [key, value] of Object.entries(section)) {
    if (key !== 'anthropic' && key !== 'openai') {
      throw new Error(`auth.${key} is not a setting; the two are anthropic and openai`);
    }
    if (value === null) continue;
    if (value !== 'subscription' && value !== 'api') {
      throw new Error(`auth.${key} must be "subscription" or "api"`);
    }
    out[key] = value;
  }
  return out;
}

/** Refuse a project file that names `auth` (see the module comment). */
export function refuseProjectAuth(raw: Readonly<Record<string, unknown>>, label: string): void {
  if (raw['auth'] === undefined) return;
  throw new Error(
    `${label} sets auth, and only your settings for all projects can: which account pays is ` +
      'a fact about one person, and this file is committed',
  );
}

/** Read on every call, for `configuredBin`'s reason: a change reaches the next turn. */
export function currentRoutes(): Routes {
  try {
    return readRoutes(readGlobalConfig());
  } catch {
    // An unreadable settings file is reported where settings are read; here the
    // safe direction is the login, which bills nothing.
    return ROUTE_DEFAULTS;
  }
}

/**
 * The environment one CLI child runs under, given the route its vendor takes.
 * Throws, before anything is spawned, for `api` with no key anywhere.
 */
export function agentEnv(cli: 'claude' | 'codex', routes: Routes = currentRoutes()): NodeJS.ProcessEnv {
  const vendor = VENDOR_OF_CLI[cli];
  const vars = KEY_VARS[vendor];
  const env: NodeJS.ProcessEnv = { ...process.env };
  // A terminal user's own key: the one we set, or OpenAI's usual name for it.
  const inherited = [vars.set, ...(vendor === 'openai' ? ['OPENAI_API_KEY'] : [])]
    .map((name) => process.env[name])
    .find((value): value is string => value !== undefined && value !== '');
  for (const name of vars.all) delete env[name];
  if (routes[vendor] === 'subscription') return env;
  const key = heldKey(vendor) ?? inherited ?? null;
  if (key === null) {
    const name = vendor === 'anthropic' ? 'Anthropic' : 'OpenAI';
    throw new Error(
      `auth.${vendor} is "api", and there is no ${name} key: store one in Settings, ` +
        `set ${vars.set}, or switch ${name} to subscription`,
    );
  }
  env[vars.set] = key;
  return env;
}
