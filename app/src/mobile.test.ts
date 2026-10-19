import { afterEach, describe, expect, test } from 'vitest';
import { MOBILE_SWAPS } from '../mobile-swaps';
import * as host from './host';
import { invoke as mobileInvoke } from './transport.mobile';
import { crumbs, foldersOf, isRepository, visibleFolders } from './cockpit/pick.mobile';
import phoneLib from '../mobile/src-tauri/src/lib.rs?raw';
import phoneIdentity from '../mobile/src-tauri/src/identity.rs?raw';
import phoneCapability from '../mobile/src-tauri/capabilities/default.json?raw';
import scanCapability from '../mobile/src-tauri/capabilities/scan.json?raw';
import phoneCargo from '../mobile/src-tauri/Cargo.toml?raw';
import phoneLink from '../mobile/src-tauri/src/link.rs?raw';
import iosPlist from '../mobile/src-tauri/Info.ios.plist?raw';
import appPackage from '../package.json?raw';
import phoneApp from './phone/PhoneApp.tsx?raw';
import pairScreen from './phone/Pair.tsx?raw';
import { confirmOnDevice as desktopConfirm } from './transport';
import { confirmOnDevice as phoneConfirm } from './transport.mobile';

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

  test('leaves out dot-folders until asked, and says how many it left out', () => {
    expect(visibleFolders(['.git', 'src', '.vibe', 'app'], false)).toEqual({ shown: ['src', 'app'], left: 2 });
    expect(visibleFolders(['.git', 'src'], true)).toEqual({ shown: ['.git', 'src'], left: 0 });
  });

  test('calls a folder a repository only when its listing holds a .git, which a worktree has as a file', () => {
    expect(isRepository([{ name: '.git', kind: 'dir' }])).toBe(true);
    expect(isRepository([{ name: '.git', kind: 'file' }])).toBe(true);
    expect(isRepository([{ name: '.git', kind: 'link' }, { name: 'src', kind: 'dir' }])).toBe(false);
  });

  test('turns a path into the places above it, each one absolute', () => {
    expect(crumbs('/home/you/code')).toEqual([
      { name: '/', path: '/' },
      { name: 'home', path: '/home' },
      { name: 'you', path: '/home/you' },
      { name: 'code', path: '/home/you/code' },
    ]);
    expect(crumbs('C:\\Users\\you')).toEqual([
      { name: 'C:', path: 'C:\\' },
      { name: 'Users', path: 'C:\\Users' },
      { name: 'you', path: 'C:\\Users\\you' },
    ]);
  });
});

/**
 * The phone's commands (#346): the three from #345 plus the fifteen about its
 * desktops and the device. Case 2 edit - the contract moved: pairing, the
 * desktops list, connect, unpair and rename all need the phone's own commands.
 */
const COMMANDS = [
  'phone_confirm',
  'phone_desktops',
  'phone_identity',
  'phone_network_change',
  'phone_notify',
  'phone_open',
  'phone_open_release_page',
  'phone_pair',
  'phone_pair_cancel',
  'phone_probe',
  'phone_release',
  'phone_rename',
  'phone_session',
  'phone_settings',
  'phone_settings_set',
  'phone_unlock',
  'phone_unpair',
  'remote_call',
];

describe("the phone's own boundary", () => {
  test('eighteen commands, all registered, and none of them can hand back the key', () => {
    const commands = [...phoneLib.matchAll(/#\[tauri::command\]\s*(?:async )?fn (\w+)\(([\s\S]*?)\{/g)];
    expect(commands.map((m) => m[1]).sort()).toEqual(COMMANDS);
    for (const [, name, signature] of commands) expect(signature, name).not.toMatch(/SecretKey|to_bytes/);
    const handler = /generate_handler!\[([\s\S]*?)\]/.exec(phoneLib)?.[1] ?? '';
    expect(handler.split(',').map((c) => c.trim()).filter(Boolean).sort()).toEqual(COMMANDS);
  });

  test('every command that reads or reaches a desktop takes the lock guard, and only those', () => {
    const commands = [...phoneLib.matchAll(/#\[tauri::command\]\s*(?:async )?fn (\w+)\([\s\S]*?\{([\s\S]*?)\n\}/g)];
    const guarded = commands.filter(([, , body]) => /^\s*phone\.unlocked\(\)\?;/.test(body ?? '')).map((m) => m[1]);
    expect(guarded.sort()).toEqual([
      'phone_desktops',
      'phone_open',
      'phone_pair',
      'phone_probe',
      'phone_release',
      'phone_rename',
      'phone_session',
      'phone_settings_set',
      'phone_unpair',
    ]);
    // `remote_call` is guarded inside `Phone::remote_call`.
    expect(phoneLib).toMatch(/async fn remote_call\(&self[\s\S]*?\{\s*self\.unlocked\(\)\?;/);
  });

  test('the window is granted no plugin permission but the camera, on phones only', () => {
    expect(JSON.parse(phoneCapability).permissions).toEqual(['core:default']);
    const scan = JSON.parse(scanCapability) as { windows: string[]; platforms: string[]; permissions: string[] };
    expect(scan.windows).toEqual(['main']);
    expect(scan.platforms.sort()).toEqual(['android', 'iOS']);
    expect(scan.permissions).toEqual([
      'barcode-scanner:allow-scan',
      'barcode-scanner:allow-cancel',
      'barcode-scanner:allow-check-permissions',
      'barcode-scanner:allow-request-permissions',
    ]);
  });

  test('the plugins are driven from Rust: notification everywhere, biometric and the scanner on phones', () => {
    expect(phoneLib).toContain('.plugin(tauri_plugin_notification::init())');
    expect(phoneLib).toMatch(/#\[cfg\(mobile\)\]\s*let builder = builder\.plugin\(tauri_plugin_biometric::init\(\)\)\.plugin\(tauri_plugin_barcode_scanner::init\(\)\);/);
  });

  test("the Hello carries the app's version, not the crate's", () => {
    expect(phoneLib).toContain('app.package_info().version.to_string()');
    expect(phoneLib + phoneLink).not.toContain('CARGO_PKG_VERSION');
  });

  test('the phone dials with its own iroh, as the desktop reaches the internet, with mDNS', () => {
    expect(phoneCargo).toMatch(/^iroh = \{ version = "1\.3", default-features = false, features = \["tls-ring", "fast-apple-datapath"\] \}/m);
    expect(phoneLink).toContain('vibe_remote::reach::internet(None, true)');
    for (const key of ['NSCameraUsageDescription', 'NSFaceIDUsageDescription', 'NSLocalNetworkUsageDescription', 'NSBonjourServices', '_irohv1._udp']) {
      expect(iosPlist).toContain(key);
    }
  });

  test('the scanner package is a dependency and Pair.tsx is its only importer', () => {
    expect(JSON.parse(appPackage).dependencies).toHaveProperty('@tauri-apps/plugin-barcode-scanner');
    const raw = import.meta.glob(['./**/*.ts', './**/*.tsx', '!./**/*.test.ts'], { query: '?raw', import: 'default', eager: true });
    const importers = Object.entries(raw)
      .filter(([, text]) => String(text).includes("from '@tauri-apps/plugin-barcode-scanner'"))
      .map(([path]) => path);
    expect(importers).toEqual(['./phone/Pair.tsx']);
  });
});

describe('the phone app', () => {
  test('reads its settings and gates on the lock before it opens any desktop', () => {
    const settings = phoneApp.indexOf("local<PhoneSettings>('phone_settings')");
    const gate = phoneApp.indexOf('bootStep(read)');
    const open = phoneApp.indexOf("'phone_open'");
    expect(settings).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(settings);
    expect(open).toBeGreaterThan(-1);
    // `phone_open` is only reached through `start`, which only an unlocked boot runs.
    expect(phoneApp).toMatch(/if \(bootStep\(read\) === 'locked'\) lock\(true\);\s*else \{\s*lock\(false\);\s*await start\(\);/);
    // The session and the release wait for the unlock: the Rust refuses both while locked.
    expect(phoneApp).toContain('session: () => gate.current.when(api.session)');
    expect(phoneApp).toContain('release: (generation) => gate.current.when(() => api.release(generation))');
  });

  test('sends the network signals', () => {
    expect(phoneApp).toContain('networkSignals(');
  });

  test('pairing listens for the code before it asks, draws the digits, and warns a phone with no lock', () => {
    const listens = pairScreen.indexOf("listen<{ attempt: number; code: string }>('phone://pair-code'");
    const asks = pairScreen.indexOf("local<Outcome>('phone_pair'");
    expect(listens).toBeGreaterThan(-1);
    expect(asks).toBeGreaterThan(listens);
    expect(pairScreen).toContain('Check that the desktop shows the same number, then press Allow there.');
    expect(pairScreen).toContain('lockWarning(settings.deviceLock)');
  });

  test('leaving the pairing screen ends the attempt: nothing after a late scan listens, dispatches or pairs', () => {
    // A scan that resolves after Back (or after the lock unmounted the screen)
    // must not go on to pair a desktop nobody is looking at.
    const scans = pairScreen.indexOf('await scan(');
    const listens = pairScreen.indexOf("listen<{ attempt: number; code: string }>('phone://pair-code'");
    const asks = pairScreen.indexOf("local<Outcome>('phone_pair'");
    const between = (from: number, to: number) => pairScreen.slice(from, to);
    expect(between(scans, listens)).toContain('if (!live.current) return;');
    expect(between(listens, asks)).toContain('if (!live.current) return;');
    // Back from the scan cancels the camera, and unmounting cancels both.
    expect(pairScreen).toMatch(/live\.current = false;\s*if \(state\.step === 'scanning'\) void cancelScan\(\)/);
    expect(pairScreen).toMatch(/return \(\) => \{\s*live\.current = false;\s*void cancelScan\(\)[^;]*;\s*if \(dialling\.current !== null\) void local\('phone_pair_cancel', \{ attempt: dialling\.current \}\)/);
  });
});

describe('confirming on the device', () => {
  test('the desktop build resolves at once and asks nothing', async () => {
    const asked = shell(() => false);
    await expect(desktopConfirm('Delete a run')).resolves.toBe(true);
    expect(asked).toEqual([]);
  });

  test("the phone asks the phone's Rust, with the reason", async () => {
    const asked = shell(() => true);
    await expect(phoneConfirm('Delete a run')).resolves.toBe(true);
    expect(asked).toEqual([{ command: 'phone_confirm', args: { reason: 'Delete a run' } }]);
  });
});

describe("the phone's key", () => {

  test('nothing deletes the key, and the key is never logged', () => {
    expect(phoneIdentity).not.toContain('delete_credential');
    expect(phoneLib).not.toMatch(/to_bytes|secret/i);
  });
});
