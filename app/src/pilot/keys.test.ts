import { describe, expect, test } from 'vitest';
// Sources as strings, through Vite's `?raw`. Deliberately not `node:fs`: adding
// node types to the app's tsconfig would let any component in a webview import a
// filesystem, and no test is worth that.
import corePackage from '../../../package.json?raw';
import coreLock from '../../../package-lock.json?raw';
import rust from '../../src-tauri/src/keys.rs?raw';
import lib from '../../src-tauri/src/lib.rs?raw';
import pilotMod from '../../src-tauri/src/pilot/mod.rs?raw';
import anthropicMod from '../../src-tauri/src/pilot/anthropic.rs?raw';
import openaiMod from '../../src-tauri/src/pilot/openai.rs?raw';
import eventMod from '../../src-tauri/src/pilot/event.rs?raw';
import pilotWire from './pilot.ts?raw';
import tools from './tools.ts?raw';
import { PROVIDER_NAME, PROVIDERS, usable } from './keys';
import type { KeyStatus } from './keys';

/**
 * The credential boundary, checked as a boundary (#143).
 *
 * The valuable assertions here are the two that fail **when somebody adds a
 * command**, not when somebody breaks one. A `key_get` would be an obvious and
 * reasonable-looking thing to add — the pilot pane wants to show the user
 * something, a settings screen wants to prefill a field — and every one of those
 * reasons is wrong. This is what says so at the moment it happens.
 */

const status = (over: Partial<KeyStatus> = {}): KeyStatus => ({
  provider: 'anthropic',
  present: false,
  unreadable: null,
  ...over,
});

describe('the webview can store a key and can never read one', () => {
  test('there is no command that returns a key', () => {
    // Read out of the Rust source rather than asserted about this module,
    // because the hole this guards would be opened over there. `read` exists and
    // is `pub(crate)` on purpose; a `#[tauri::command]` on it is the mistake.
    const commands = [...rust.matchAll(/#\[tauri::command\]\s*pub fn (\w+)/g)].map((m) => m[1]);
    expect(commands.sort()).toEqual(['key_clear', 'key_set', 'key_status']);
    expect(rust).toContain('pub(crate) fn read');
    expect(rust).not.toContain('pub fn read');
  });

  test('the handler list is exactly those three plus the host and pilot commands', () => {
    // The second half of the same guard: a command is only reachable once it is
    // registered, so the registration is worth pinning too. Every name the
    // window can reach is on this list and nowhere else.
    const registered = lib
      .slice(lib.indexOf('generate_handler!['), lib.indexOf(']', lib.indexOf('generate_handler![')))
      .match(/\b\w+\b/g)
      ?.filter((w) => /^(host|key|pilot)_/.test(w));
    expect(registered?.sort()).toEqual([
      'host_send',
      'host_start',
      'host_status',
      'key_clear',
      'key_set',
      'key_status',
      'pilot_cancel',
      'pilot_send',
    ]);
  });

  test('the one thing that reads a key is the one thing that makes the request', () => {
    // `read` gained its caller when the adapters landed, and this pins WHO it
    // is. A second caller is not automatically wrong, but it is the moment to
    // ask whether the key has grown a second lifetime — which is exactly the
    // question nobody thinks to ask six months later.
    const callers = [...pilotMod.matchAll(/keys::read\(/g)];
    expect(callers.length).toBe(1);
    expect(pilotMod).toContain('fn drive(');
  });

  test('every tool is a host request this window already makes', () => {
    // #144's one sentence, checked as a boundary. The table may declare what it
    // likes; what it may not do is reach the loop another way. Every effect is
    // an `invoke` or an `answer` - the two inbound frames in `src/protocol.ts` -
    // so a third `kind` here is a third definition of what a legal run is, and
    // this is the commit it would fail on.
    const effect = tools.slice(
      tools.indexOf('export type Effect ='),
      tools.indexOf('export const ORIGIN'),
    );
    const kinds = [...effect.matchAll(/kind: '(\w+)'/g)].map((m) => m[1]);
    expect([...new Set(kinds)].sort()).toEqual(['answer', 'invoke']);
    // And no other way out. The pane hands an accepted effect UP to the cockpit,
    // which owns the one `host.send` in the window; a tool module that imported
    // the wire could send its own frame past the launch and gate controls.
    expect(tools).not.toMatch(/from '\.\.\/host'/);
  });

  test('the pilot cannot reach a credential, and does not have to be trusted not to', () => {
    // Decision 5 of the five #144 asks for, and the only real answer to "what
    // never goes to a provider": a key. Not a rule the table follows - a thing
    // it has no path to. `ToolContext` is the whole of what a read may see, and
    // it holds the run.
    expect(tools).not.toMatch(/from '\.\/keys'/);
    const context = tools.slice(
      tools.indexOf('export interface ToolContext {'),
      tools.indexOf('}', tools.indexOf('export interface ToolContext {')),
    );
    expect(context).toContain('run: Run');
    expect(context).not.toMatch(/key|secret|token/i);
  });

  test('the two capabilities #144 refuses are absent, not merely undocumented', () => {
    // Config (decision 3, answered no) and the run archive (decision 4, yes but
    // #114 first). An absence is only a decision if something fails when it
    // stops being one.
    const declared = [...tools.matchAll(/^ {2}name: '(\w+)',$/gm)].map((m) => m[1] ?? '');
    expect(declared.sort()).toEqual(['answer_gate', 'read_output', 'read_run', 'start_run']);
    expect(declared.filter((n) => /config|archive|runs/.test(n))).toEqual([]);
  });

  test('the event vocabulary is the same set on both sides of the wire', () => {
    // The cross-language guard `contract.test.ts` does for phases. Rust's
    // `#[serde(rename_all = "snake_case")]` is what makes these comparable, and
    // a variant added on one side and not the other is silent otherwise: the
    // window would drop an event as unrecognised and count it.
    // Sliced to the enum body first, so a `PilotEvent::Ended { .. }` in a match
    // arm or a test cannot be mistaken for a variant declaration.
    const start = eventMod.indexOf('pub enum PilotEvent {');
    const body = eventMod.slice(start, eventMod.indexOf('\n}', start));
    expect(start).toBeGreaterThan(-1);
    const rustKinds = [...body.matchAll(/^ {4}([A-Z]\w+) \{/gm)]
      .map((m) => m[1] ?? '')
      .map((name) => name.replace(/(?<!^)([A-Z])/g, '_$1').toLowerCase());
    const tsKinds = [...pilotWire.matchAll(/kind: '(\w+)'/g)].map((m) => m[1] ?? '');
    expect(rustKinds.length).toBeGreaterThan(0);
    expect([...new Set(tsKinds)].sort()).toEqual([...new Set(rustKinds)].sort());
  });

  test('no vendor URL is reachable from the webview', () => {
    // Both endpoints are `const` in Rust and neither is a parameter of a
    // command. A `pilot_send` that took a URL would be a page choosing where a
    // credential gets sent, which is the whole thing this boundary prevents.
    for (const source of [anthropicMod, openaiMod]) {
      expect(source).toMatch(/pub const URL: &str = "https:\/\//);
    }
    expect(pilotMod).not.toMatch(/url:\s*String/);
  });

  test('the status shape has no field a key could live in', () => {
    const keys = Object.keys(status()).sort();
    expect(keys).toEqual(['present', 'provider', 'unreadable']);
  });
});

describe('one provider is a supported state', () => {
  test('a single stored key is usable', () => {
    // The likeliest real first run: somebody with one subscription, trying this
    // before deciding whether to buy a second.
    expect(usable([status({ present: true }), status({ provider: 'openai' })])).toEqual([
      'anthropic',
    ]);
  });

  test('a keychain that could not be read is not counted as configured', () => {
    // Fails closed. `unreadable` never sets `present`, so an unreadable entry
    // cannot be mistaken for a working one - the pilot would fail at the request
    // instead, which is later and harder to explain.
    expect(usable([status({ unreadable: 'the keychain is locked' })])).toEqual([]);
  });

  test('both providers are named for prose', () => {
    for (const p of PROVIDERS) expect(PROVIDER_NAME[p]).toMatch(/^[A-Z]/);
  });
});

describe('the core is untouched', () => {
  test('nothing in src/ gained a network dependency', () => {
    // The sentence this whole issue is arranged around: *every external call the
    // core makes is a child process*. `app/` may open a socket; `src/` may not,
    // and the published package must gain nothing.
    const pkg = JSON.parse(corePackage) as {
      dependencies?: Record<string, string>;
      files: string[];
    };
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.files).toEqual(['dist/src', 'README.md', 'CHANGELOG.md', 'LICENSE']);
  });

  test('and its lockfile agrees, which is the half a manifest cannot prove', () => {
    // `dependencies: {}` is a statement of intent; the lockfile is what would
    // actually be installed. A transitive HTTP client arriving through a build
    // tool would leave the manifest looking exactly as it does above.
    const lock = JSON.parse(coreLock) as { packages: Record<string, { dev?: boolean }> };
    const shipped = Object.entries(lock.packages)
      .filter(([name, meta]) => name !== '' && meta.dev !== true)
      .map(([name]) => name);
    expect(shipped).toEqual([]);
  });
});
