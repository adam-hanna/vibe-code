import { afterEach, describe, expect, test } from 'vitest';
import { MOBILE_SWAPS } from '../mobile-swaps';
import * as host from './host';
import { invoke as mobileInvoke } from './transport.mobile';
import { foldersOf } from './cockpit/pick.mobile';
import phoneLib from '../mobile/src-tauri/src/lib.rs?raw';
import phoneIdentity from '../mobile/src-tauri/src/identity.rs?raw';
import phoneCapability from '../mobile/src-tauri/capabilities/default.json?raw';

/**
 * The phone build (#345): one cockpit, and the few modules swapped under it.
 *
 * The app has no jsdom and mocks no module, so Tauri is met where its `invoke`
 * actually goes - `window.__TAURI_INTERNALS__.invoke` - with a stub that records
 * what was asked and answers as Rust would.
 */

type Asked = { command: string; args: unknown };

function shell(answer: (command: string, args: unknown) => unknown): Asked[] {
  const asked: Asked[] = [];
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: unknown) => {
        asked.push({ command, args });
        return Promise.resolve(answer(command, args));
      },
      transformCallback: () => 0,
    },
  };
  return asked;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

// Every module under src, by its path from `app/`, for the swap list to be checked against.
const sources = Object.keys(import.meta.glob(['./**/*.ts', './**/*.tsx'])).map((p) => `src/${p.slice(2)}`);

describe('the swap list is the whole of what the phone build replaces', () => {
  test('every phone module is named in the list, and every entry has both files', () => {
    const phone = sources.filter((p) => /\.mobile\.tsx?$/.test(p));
    expect([...phone].sort()).toEqual(Object.values(MOBILE_SWAPS).sort());
    for (const [desktop, mobile] of Object.entries(MOBILE_SWAPS)) {
      expect(sources, desktop).toContain(desktop);
      expect(sources, mobile).toContain(mobile);
    }
  });

  test('each phone module exports everything the module it replaces does', async () => {
    const all = import.meta.glob(['./**/*.ts', './**/*.tsx']);
    for (const [desktop, mobile] of Object.entries(MOBILE_SWAPS)) {
      const load = (p: string) => {
        const loader = all[`./${p.slice(4)}`];
        if (loader === undefined) throw new Error(`${p} is not a source`);
        return loader() as Promise<Record<string, unknown>>;
      };
      const [d, m] = await Promise.all([load(desktop), load(mobile)]);
      for (const name of Object.keys(d)) expect(Object.keys(m), `${mobile} lacks ${name}`).toContain(name);
    }
  });
});

describe("the phone's transport", () => {
  test('a desktop command goes to the phone Rust as a remote_call naming it, with its arguments', async () => {
    const asked = shell(() => 'answered');
    const got = await mobileInvoke('host_send', { handle: 'service', line: '{"type":"memory","id":1}' });
    expect(got).toBe('answered');
    expect(asked).toEqual([
      {
        command: 'remote_call',
        args: { command: 'host_send', args: { handle: 'service', line: '{"type":"memory","id":1}' } },
      },
    ]);
  });

  test('a command with no arguments still sends an object, as Rust expects', async () => {
    const asked = shell(() => null);
    await mobileInvoke('host_status');
    expect(asked[0]?.args).toEqual({ command: 'host_status', args: {} });
  });

  test("the desktop's refusal reaches the caller unchanged", async () => {
    (globalThis as { window?: unknown }).window = {
      __TAURI_INTERNALS__: {
        invoke: () => Promise.reject('this phone is not connected to a desktop'),
        transformCallback: () => 0,
      },
    };
    await expect(mobileInvoke('host_status')).rejects.toBe('this phone is not connected to a desktop');
  });
});

describe('an update a phone asked for opens the page on the phone', () => {
  test('openOnPhone opens the release page here and reads as opened', async () => {
    const asked = shell((command) => (command === 'update_install' ? 'openOnPhone' : null));
    await expect(host.openReleasePage()).resolves.toBe('opened');
    expect(asked.map((a) => a.command)).toEqual(['update_install', 'phone_open_release_page']);
    // No URL travels: the phone opens its own constant.
    expect(asked[1]?.args).toEqual({});
  });

  test("the desktop's own outcomes pass through untouched", async () => {
    const asked = shell(() => 'confirm');
    await expect(host.updateInstall(false)).resolves.toBe('confirm');
    expect(asked.map((a) => a.command)).toEqual(['update_install']);
  });
});

describe("the phone's folder chooser", () => {
  test('lists folders only, in the order the host gave, and follows no link', () => {
    expect(
      foldersOf([
        { name: 'src', kind: 'dir' },
        { name: 'README.md', kind: 'file' },
        { name: 'elsewhere', kind: 'link' },
        { name: 'app', kind: 'dir' },
      ]),
    ).toEqual(['src', 'app']);
  });
});

describe("the phone's own boundary", () => {
  test('three commands, and none of them can hand back the key', () => {
    const commands = [...phoneLib.matchAll(/#\[tauri::command\]\s*(?:async )?fn (\w+)\(([\s\S]*?)\{/g)];
    expect(commands.map((m) => m[1]).sort()).toEqual(['phone_identity', 'phone_open_release_page', 'remote_call']);
    for (const [, name, signature] of commands) expect(signature, name).not.toMatch(/SecretKey|to_bytes/);
    expect(phoneLib).toMatch(/generate_handler!\[remote_call, phone_identity, phone_open_release_page\]/);
  });

  test('the window is granted no plugin permission', () => {
    expect(JSON.parse(phoneCapability).permissions).toEqual(['core:default']);
  });

  test('nothing deletes the key, and the key is never logged', () => {
    expect(phoneIdentity).not.toContain('delete_credential');
    expect(phoneLib).not.toMatch(/to_bytes|secret/i);
  });
});
