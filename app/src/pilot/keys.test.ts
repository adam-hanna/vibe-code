import { describe, expect, test } from 'vitest';
// Sources as strings, through Vite's `?raw`. Deliberately not `node:fs`: adding
// node types to the app's tsconfig would let any component in a webview import a
// filesystem, and no test is worth that.
import corePackage from '../../../package.json?raw';
import rust from '../../src-tauri/src/keys.rs?raw';
import lib from '../../src-tauri/src/lib.rs?raw';
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

  test('the handler list is exactly those three plus the host commands', () => {
    // The second half of the same guard: a command is only reachable once it is
    // registered, so the registration is worth pinning too.
    const registered = lib
      .slice(lib.indexOf('generate_handler!['), lib.indexOf(']', lib.indexOf('generate_handler![')))
      .match(/\b\w+\b/g)
      ?.filter((w) => w.startsWith('host_') || w.startsWith('key_'));
    expect(registered?.sort()).toEqual([
      'host_send',
      'host_start',
      'host_status',
      'key_clear',
      'key_set',
      'key_status',
    ]);
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
});
