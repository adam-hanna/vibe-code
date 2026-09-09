import { describe, expect, test } from 'vitest';
// Sources as strings, through Vite's `?raw`. Deliberately not `node:fs`: adding
// node types to the app's tsconfig would let any component in a webview import a
// filesystem, and no test is worth that.
import corePackage from '../../../package.json?raw';
import coreLock from '../../../package-lock.json?raw';
import rust from '../../src-tauri/src/keys.rs?raw';
import lib from '../../src-tauri/src/lib.rs?raw';
import defaultCapability from '../../src-tauri/capabilities/default.json?raw';
import pick from '../cockpit/pick.ts?raw';
import pilotMod from '../../src-tauri/src/pilot/mod.rs?raw';
import anthropicMod from '../../src-tauri/src/pilot/anthropic.rs?raw';
import openaiMod from '../../src-tauri/src/pilot/openai.rs?raw';
import eventMod from '../../src-tauri/src/pilot/event.rs?raw';
import pilotWire from './pilot.ts?raw';
import pilotPane from './PilotPane.tsx?raw';
import credentials from './Credentials.tsx?raw';
import cockpit from '../cockpit/Cockpit.tsx?raw';
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
    // registered, so the registration is worth pinning too.
    //
    // This list is no longer the whole of what the window can reach, and saying
    // so is the point: since #189 a plugin also registers commands, and it does
    // it somewhere this regex cannot see. The plugin list below is the other
    // half, and the two together are the surface.
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

  test('a plugin is a capability surface too, and there are two', () => {
    // #189 added the first plugin whose commands the window actually calls, and
    // a plugin command does not appear in `generate_handler!` - so the list
    // above stopped being the complete answer to "what can the page invoke" on
    // the commit that added it. This is the half that keeps the question
    // answerable: a third plugin fails here, which is the moment to ask what it
    // put within reach.
    const plugins = [...lib.matchAll(/\.plugin\(tauri_plugin_(\w+)::/g)].map((m) => m[1]);
    expect(plugins.sort()).toEqual(['dialog', 'single_instance']);
  });

  test('the dialog plugin is granted one permission by name, not its default set', () => {
    // `dialog:default` carries `save`, `message`, `ask` and `confirm` as well,
    // and none of those has a caller. Taking the whole set to get the one is how
    // a capability file stops describing the app - and the file is the only
    // place a reader can find out what the window may do.
    const capability = JSON.parse(defaultCapability) as { permissions: string[] };
    expect(capability.permissions.sort()).toEqual(['core:default', 'dialog:allow-open']);
  });

  test('the chooser returns a path and the window judges nothing about it', () => {
    // The rule #189 is written around: a chosen directory is exactly as trusted
    // as a typed one. `consistency.ts` and the preflight are the definition of a
    // usable repository, and a second definition in a webview is the
    // re-derivation the whole app is arranged against.
    expect(pick).not.toMatch(/\.git|isRepo|exists|readDir|readTextFile/);
    // And it opens a directory chooser rather than a file one. `directory: true`
    // is what makes the result a path to hand the host; without it this is a
    // file picker wearing the same label.
    expect(pick).toContain('directory: true');
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
    // likes; what it may not do is reach the loop another way.
    //
    // **This pinned two kinds and now pins three.** `invoke` and `answer` were
    // the two inbound frames that existed, and #211 added `command` along with
    // the frame it sends and the window's own control that sends it. So the
    // claim moved: the sentence was never "there are two", it was "each one is
    // a request the window also makes", and that is still true. A fourth is
    // still a decision somebody takes on purpose, which is what this fails for.
    const effect = tools.slice(
      tools.indexOf('export type Effect ='),
      tools.indexOf('export const ORIGIN'),
    );
    const kinds = [...effect.matchAll(/kind: '(\w+)'/g)].map((m) => m[1]);
    expect([...new Set(kinds)].sort()).toEqual(['answer', 'command', 'invoke']);
    // The structural half, and it is the one that did NOT move. The pane hands
    // an accepted effect UP to the cockpit, which owns the one `host.send` in
    // the window; a tool module that imported the wire could send its own frame
    // past the launch, gate and command controls. Nothing about #211 touches
    // this, which is what keeps the widening narrow.
    expect(tools).not.toMatch(/from '\.\.\/host'/);
  });

  test('a command is proposed and never run by the tool that asks for it', () => {
    // The rule the command runner is allowed to exist under (#211). `run_command`
    // is the most consequential thing in the table - it starts a process on the
    // machine - and it settles the same way `start_run` does: a proposal, with
    // the exact program and arguments drawn, that a person presses.
    //
    // Read from the source rather than by calling it, for the reason the effect
    // list above is: what matters is that no future edit gives this executor a
    // `ran` path, and a passing call today would not catch that.
    const runCommand = tools.slice(
      tools.indexOf("name: 'run_command'"),
      tools.indexOf('The table.'),
    );
    expect(runCommand).toContain("kind: 'proposes'");
    expect(runCommand).not.toMatch(/kind: 'ran'/);
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
    //
    // The table grew by two in #211 - `read_command` and `run_command` - and the
    // list moves with it, which is the point of spelling it out rather than
    // counting. **Neither refusal moved**: there is still no config tool and no
    // archive tool, and the second assertion is the one that says so.
    const declared = [...tools.matchAll(/^ {2}name: '(\w+)',$/gm)].map((m) => m[1] ?? '');
    expect(declared.sort()).toEqual([
      'answer_gate',
      'read_command',
      'read_output',
      'read_run',
      'run_command',
      'start_run',
    ]);
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

describe('the window reads the keychain in one place', () => {
  test('exactly one component asks, and it is the one that owns the window', () => {
    // #188: two panes each fetched their own copy of "which providers have a
    // key". The pilot pane is mounted for the whole session and hidden rather
    // than unmounted - a conversation is state nobody can get back - so its copy
    // was taken at launch and never retaken. Storing a key updated the Keys form
    // and nothing else, and the composer stayed disabled behind a snapshot from
    // before the key existed.
    //
    // Asserted over the source because the defect is structural and there is
    // nothing left in a component to test once it is fixed: the guarantee is
    // that only one call site exists, not that any particular render is right.
    const callers = [
      ['Cockpit.tsx', cockpit],
      ['PilotPane.tsx', pilotPane],
      ['Credentials.tsx', credentials],
    ] as const;

    const asking = callers.filter(([, source]) => /keys\s*\.\s*status\s*\(/.test(source));
    expect(asking.map(([name]) => name)).toEqual(['Cockpit.tsx']);
  });

  test('the two panes take it as a prop rather than holding it', () => {
    // The other half. A component could stop calling `keys.status()` and still
    // keep its own `useState` copy fed from somewhere else, which would be the
    // same bug wearing a different import.
    for (const source of [pilotPane, credentials]) {
      expect(source).not.toMatch(/useState<readonly KeyStatus\[\]/);
    }
    expect(cockpit).toMatch(/useState<readonly KeyStatus\[\] \| null>/);
  });
});
