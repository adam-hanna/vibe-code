import { describe, expect, test } from 'vitest';
import { MEMORY_KEYS } from './memory';
import protocolSrc from '../../src/protocol.ts?raw';
import serveSrc from '../../src/serve.ts?raw';
import keysRs from '../src-tauri/src/keys.rs?raw';
import remoteRs from '../src-tauri/src/remote/mod.rs?raw';
import controlRs from '../remote/src/control.rs?raw';

/**
 * What stops a new setting, tab or write reaching one screen and not the other
 * (#371). Asked as *"What happens if we add a new setting or a new tab. I'm
 * worried we might forget to sync changes to them to the phone."*
 *
 * A tab needs nothing: the phone runs this same `src`, so it has every tab the
 * desktop has. What can be forgotten is **who hears a change**, and there are
 * three places a change lives, each with a closed list a new entry must join:
 *
 * - **the window's memory** - `MEMORY_KEYS`, shared or per device, and every
 *   reader of a shared key follows it;
 * - **the host** - every inbound frame below either changes nothing or names
 *   the frame every client hears it on, and something here reads that frame;
 * - **the desktop's Rust** - `COMMAND_REACH` in `control.rs`, checked by the
 *   remote crate's tests against the allowed commands.
 *
 * The project's and the global settings files need nothing new: a config save is
 * announced as `changed`, and the Settings screen and the cockpit re-read it, so
 * a new key in `vibe.config.json` is on both screens the day it is added.
 */
const sources = import.meta.glob(['./**/*.ts', './**/*.tsx', '!./**/*.test.ts', '!./**/*.test.tsx'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Every `const NAME = 'vibe.<key>'` in the app, by file. */
function keyConstants(): { file: string; name: string; key: string }[] {
  const found: { file: string; name: string; key: string }[] = [];
  for (const [file, text] of Object.entries(sources)) {
    for (const m of text.matchAll(/const (\w+) = '(vibe\.[A-Za-z.]+)'/g)) found.push({ file, name: m[1]!, key: m[2]! });
  }
  return found;
}

/**
 * A component that reads a shared key once, when the read is at the moment it is
 * used - in a handler, never in state - and so cannot be stale. Each names why.
 */
const READ_AT_USE: Readonly<Record<string, readonly string[]>> = {
  // `relocate` and the start's rename read the lists when pressed, and write.
  './cockpit/Cockpit.tsx': ['PROJECTS_KEY', 'PINNED_KEY', 'NAMES_KEY', 'PROJECT_NAMES_KEY'],
  // The folder browser is opened from a press, and reads the projects then.
  './cockpit/pick.mobile.tsx': ['PROJECTS_KEY'],
};

describe("the window's memory: every key says whose it is", () => {
  const constants = keyConstants();

  test('every vibe. key the app names is in MEMORY_KEYS, and every listed key is used', () => {
    // The chat store's prefix is not a key: conversations have a store of their own.
    const named = new Set(constants.map((c) => c.key).filter((k) => k !== 'vibe.chat.' && k !== 'vibe.config.json'));
    expect([...named].filter((k) => !(k in MEMORY_KEYS))).toEqual([]);
    expect(Object.keys(MEMORY_KEYS).filter((k) => !named.has(k))).toEqual([]);
  });

  test("a device key is read only through deviceKey, so a phone never moves the desktop's", () => {
    const cockpit = sources['./cockpit/Cockpit.tsx']!;
    for (const { name, key } of constants) {
      if (MEMORY_KEYS[key] !== 'device') continue;
      expect(cockpit, `${key} (${name})`).toMatch(new RegExp(`deviceKey\\(${name}, device\\)`));
    }
  });

  test('a component reading a shared key follows it, or reads it only when pressed', () => {
    const shared = new Set(constants.filter((c) => MEMORY_KEYS[c.key] === 'shared').map((c) => c.name));
    const unfollowed: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      if (!file.endsWith('.tsx')) continue;
      for (const name of shared) {
        const reads = new RegExp(`(getItem|readMemory)\\(${name}\\)`).test(text);
        if (!reads) continue;
        const follows =
          new RegExp(`useFollowedMemory(<[^>]*>)?\\(${name}\\b`).test(text) ||
          new RegExp(`useMemoryRevision\\([^)]*\\b${name}\\b`).test(text);
        if (!follows && !(READ_AT_USE[file] ?? []).includes(name)) unfollowed.push(`${file}: ${name}`);
      }
    }
    expect(unfollowed).toEqual([]);
  });
});

/**
 * Every frame a client may send the host, and the frame every other client
 * hears its change on - or `read` when it changes nothing. A new inbound frame
 * fails here until somebody decides.
 */
const INBOUND_REACH: Readonly<Record<string, string>> = {
  archive: 'read',
  stats: 'read',
  diff: 'read',
  artifacts: 'read',
  artifact: 'read',
  replay: 'read',
  prompts: 'read',
  fs: 'read',
  chats: 'read',
  memory: 'read',
  commands_past: 'read',
  models: 'read',
  pilot_turns: 'read',
  // A read, or a patch announced as `changed`.
  config: 'changed',
  chat_save: 'changed',
  memory_save: 'changed',
  delete_run: 'run_deleted',
  answer_questions: 'questions_answered',
  command: 'command_started',
  command_stop: 'command_ended',
  pilot: 'pilot_started',
  pilot_stop: 'pilot_stopped',
  // A run's own: its narration is relayed to every client.
  invoke: 'narration',
  answer: 'narration',
  pause: 'controls',
  unpause: 'controls',
  cancel: 'controls',
  // The run host leaves, and every client hears the exit.
  shutdown: 'host://exit',
};

describe('the host: every write says who hears it', () => {
  const inbound = protocolSrc.slice(protocolSrc.indexOf('export type Inbound ='));
  const inboundTypes = new Set([...inbound.slice(0, inbound.indexOf('\nexport ', 1)).matchAll(/type: '(\w+)'/g)].map((m) => m[1]!));
  const outbound = protocolSrc.slice(protocolSrc.indexOf('export type Outbound ='), protocolSrc.indexOf('export type Inbound ='));

  test('every inbound frame is classified, and nothing classified is gone', () => {
    expect([...inboundTypes].filter((t) => !(t in INBOUND_REACH))).toEqual([]);
    expect(Object.keys(INBOUND_REACH).filter((t) => !inboundTypes.has(t))).toEqual([]);
  });

  test('the frame a write is heard on exists, is sent, and is read by every client', () => {
    const app = Object.entries(sources)
      .map(([, text]) => text)
      .join('\n');
    for (const heard of new Set(Object.values(INBOUND_REACH))) {
      if (heard === 'read' || heard === 'host://exit') continue;
      expect(outbound, heard).toContain(`type: '${heard}'`);
      expect(serveSrc, heard).toContain(`type: '${heard}'`);
      expect(app, heard).toMatch(new RegExp(`\\.type [!=]== '${heard}'|case '${heard}':`));
    }
  });
});

describe("the desktop's Rust: what a command changed is announced", () => {
  test('the commands heard on desktop://changed announce it, on every road', () => {
    for (const name of ['key_set', 'key_clear', 'remote_set', 'remote_revoke']) {
      expect(controlRs).toContain(`("${name}", Reach::Event("desktop://changed"))`);
    }
    expect(keysRs.match(/desktop_changed\(app, crate::remote::Changed::Keys\)/g)).toHaveLength(2);
    // The window's remote_set, a phone's that keeps the endpoint, one that stops it, and a revoke.
    expect(remoteRs.match(/desktop_changed\(&?app, Changed::Remote\)/g)).toHaveLength(4);
    expect(sources['./pilot/keys.ts']).toMatch(/event\.payload === 'keys'/);
    expect(sources['./remote/remote.ts']).toMatch(/event\.payload === 'remote'/);
  });
});
