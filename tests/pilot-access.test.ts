import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, readGlobalConfig, writeConfigPatch } from '@src/config.js';
import {
  DEFAULT_SAFE_COMMANDS,
  PILOT_ACCESS_DEFAULTS,
  pilotFs,
  pilotRoots,
  readPilotAccess,
  READ_KEEP_BYTES,
} from '@src/pilotaccess.js';
import { pilotChatArgs } from '@src/pilotchat.js';
import { createSession } from '@src/serve.js';
import type { Outbound } from '@src/protocol.js';
import type { PilotChatOptions, PilotChatResult } from '@src/pilotchat.js';

/**
 * What the pilot may do without asking, and where it may look (#223).
 *
 * Asked for as *"It's completely safe for it to run 'ls', 'cat', 'echo', 'git
 * add|commit'"*, with a YOLO switch and a list of directories beyond the
 * repository. These cases pin the core's half: the settings live only in the
 * file for all projects, the subscription pilot is given exactly the allowed
 * directories, and the host's reads answer inside them and nowhere else.
 */

function scratch(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'vibe-access-'));
}

function withGlobal<T>(at: string, body: () => T): T {
  const before = process.env['VIBE_GLOBAL_CONFIG'];
  process.env['VIBE_GLOBAL_CONFIG'] = at;
  try {
    return body();
  } finally {
    if (before === undefined) delete process.env['VIBE_GLOBAL_CONFIG'];
    else process.env['VIBE_GLOBAL_CONFIG'] = before;
  }
}

test('with nothing set the pilot gets git that reads, plus add and commit, and no YOLO', () => {
  const access = readPilotAccess({});
  assert.equal(access.yolo, false);
  assert.deepEqual(access.dirs, []);
  assert.deepEqual(access.safeCommands, DEFAULT_SAFE_COMMANDS);
  assert.ok(access.safeCommands.includes('git status'));
  assert.ok(access.safeCommands.includes('git commit'));
  // A prefix of plain `git branch` would also cover `git branch -D`.
  assert.ok(!access.safeCommands.includes('git branch'));
});

test('the settings are refused by name rather than half-loaded', () => {
  assert.throws(() => readPilotAccess({ pilot: { yollo: true } }), /pilot\.yollo is not a setting/);
  assert.throws(() => readPilotAccess({ pilot: { yolo: 'yes' } }), /pilot\.yolo must be true or false/);
  assert.throws(
    () => readPilotAccess({ pilot: { safeCommands: ['git status && rm -rf .'] } }),
    /holds shell syntax/,
  );
  assert.throws(() => readPilotAccess({ pilot: { dirs: ['relative/dir'] } }), /must be an absolute path/);
  // Null is the default, which is what "use the default list" writes.
  assert.deepEqual(readPilotAccess({ pilot: { safeCommands: null } }).safeCommands, DEFAULT_SAFE_COMMANDS);
});

test("a project's own file cannot widen its pilot, on either road", () => {
  const dir = scratch();
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ pilot: { yolo: true } }));
  assert.throws(() => loadConfig(dir), /only your settings for all projects can/);
  const other = scratch();
  assert.throws(
    () => writeConfigPatch(other, { pilot: { safeCommands: ['rm'] } }, 'project'),
    /only your settings for all projects can/,
  );
  assert.equal(existsSync(path.join(other, 'vibe.config.json')), false, 'nothing was written');
});

test('the global file takes them, and a bad one is refused unwritten', () => {
  const dir = scratch();
  const global = path.join(scratch(), 'vibe', 'config.json');
  withGlobal(global, () => {
    writeConfigPatch(dir, { pilot: { safeCommands: ['git status', 'ls'] } }, 'global');
    // A run's config is untouched by it: `pilot` is not part of `Config`.
    assert.equal('pilot' in loadConfig(dir), false);
    assert.throws(() => writeConfigPatch(dir, { pilot: { yolo: 1 } }, 'global'), /pilot\.yolo/);
  });
  withGlobal(global, () => {
    // The refused write left the earlier one in place.
    assert.deepEqual(readPilotAccess(readGlobalConfig()).safeCommands, ['git status', 'ls']);
  });
});

test('the subscription pilot is given the allowed directories, and in YOLO every disk', () => {
  const repo = scratch();
  const extra = scratch();
  const roots = pilotRoots(repo, { ...PILOT_ACCESS_DEFAULTS, yolo: false, safeCommands: [], dirs: [extra] }, 'linux');
  assert.deepEqual(roots, [path.resolve(repo), path.resolve(extra)]);
  const yolo = pilotRoots(repo, { ...PILOT_ACCESS_DEFAULTS, yolo: true, safeCommands: [], dirs: [] }, 'linux');
  assert.ok(yolo.includes('/'));

  const args = pilotChatArgs({
    prompt: 'p',
    system: 's',
    sessionId: 'id',
    resume: false,
    model: 'opus',
    cwd: repo,
    addDirs: roots,
    timeoutMs: 1000,
  });
  const at = args.indexOf('--add-dir');
  assert.ok(at > 0, 'the extra directory is passed');
  assert.equal(args[at + 1], path.resolve(extra));
  // The repository is the cwd already, so it is not passed twice.
  assert.ok(!args.slice(at + 1, args.indexOf('--model')).includes(repo));
  // `--restricted` stays, so settings files and MCP are still not inherited.
  assert.ok(args.includes('--restricted'));
});

test('a read answers inside the allowed directories and refuses outside them', () => {
  const repo = scratch();
  const outside = scratch();
  writeFileSync(path.join(repo, 'a.txt'), 'hello');
  mkdirSync(path.join(repo, 'sub'));
  writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  const roots = pilotRoots(repo, { ...PILOT_ACCESS_DEFAULTS, yolo: false, safeCommands: [], dirs: [] });

  const listing = pilotFs('list', repo, '.', roots);
  assert.ok(!('refused' in listing));
  if (!('refused' in listing) && listing.op === 'list') {
    assert.deepEqual(
      listing.entries.map((e) => [e.name, e.kind]),
      [
        ['a.txt', 'file'],
        ['sub', 'dir'],
      ],
    );
  }
  const read = pilotFs('read', repo, 'a.txt', roots);
  assert.ok(!('refused' in read) && read.op === 'read' && read.text === 'hello');

  const away = pilotFs('read', repo, path.join(outside, 'secret.txt'), roots);
  assert.ok('refused' in away && /outside the directories the pilot may read/.test(away.refused));
  const climb = pilotFs('read', repo, path.relative(repo, path.join(outside, 'secret.txt')), roots);
  assert.ok('refused' in climb, '.. out of the repository is outside it');

  // Allowed once it is on the list.
  const wider = pilotRoots(repo, { ...PILOT_ACCESS_DEFAULTS, yolo: false, safeCommands: [], dirs: [outside] });
  const now = pilotFs('read', repo, path.join(outside, 'secret.txt'), wider);
  assert.ok(!('refused' in now));
});

test('a link inside the repository is judged by where it lands', () => {
  const repo = scratch();
  const outside = scratch();
  writeFileSync(path.join(outside, 'secret.txt'), 'nope');
  symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'link.txt'));
  const roots = pilotRoots(repo, { ...PILOT_ACCESS_DEFAULTS, yolo: false, safeCommands: [], dirs: [] });
  const answer = pilotFs('read', repo, 'link.txt', roots);
  assert.ok('refused' in answer);
});

test('a binary file is refused, and a long one is cut and says so', () => {
  const repo = scratch();
  writeFileSync(path.join(repo, 'bin'), Buffer.from([0x50, 0x00, 0x01]));
  writeFileSync(path.join(repo, 'big.txt'), 'x'.repeat(READ_KEEP_BYTES + 10));
  const roots = pilotRoots(repo, { ...PILOT_ACCESS_DEFAULTS, yolo: false, safeCommands: [], dirs: [] });
  assert.ok('refused' in pilotFs('read', repo, 'bin', roots));
  const big = pilotFs('read', repo, 'big.txt', roots);
  assert.ok(!('refused' in big) && big.op === 'read');
  if (!('refused' in big) && big.op === 'read') {
    assert.equal(big.truncated, true);
    assert.equal(big.bytes, READ_KEEP_BYTES + 10);
    assert.equal(big.text.length, READ_KEEP_BYTES);
  }
});

const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

test('the host answers an fs frame from its own settings, never the frame', async () => {
  const repo = scratch();
  const outside = scratch();
  writeFileSync(path.join(outside, 'x.txt'), 'x');
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => Promise.resolve(0),
    pilotAccess: () => ({ ...PILOT_ACCESS_DEFAULTS, yolo: false, safeCommands: [], dirs: [] }),
  });
  session.receive(JSON.stringify({ type: 'fs', id: 3, op: 'list', dir: repo, path: '.' }));
  session.receive(
    JSON.stringify({ type: 'fs', id: 4, op: 'read', dir: repo, path: path.join(outside, 'x.txt') }),
  );
  await settle();
  assert.ok(sent.some((f) => f.type === 'fs' && f.id === 3));
  assert.ok(sent.some((f) => f.type === 'error' && f.id === 4));
});

test('a pilot turn is spawned with the directories the settings allow', async () => {
  const repo = scratch();
  const extra = scratch();
  let seen: PilotChatOptions | null = null;
  const session = createSession(() => undefined, {
    invoke: () => Promise.resolve(0),
    pilotAccess: () => ({ ...PILOT_ACCESS_DEFAULTS, yolo: false, safeCommands: [], dirs: [extra] }),
    pilot: (options: PilotChatOptions): Promise<PilotChatResult> => {
      seen = options;
      return Promise.resolve({
        text: 'ok',
        sessionId: 's',
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 },
      });
    },
  });
  session.receive(
    JSON.stringify({
      type: 'pilot',
      id: 9,
      prompt: 'p',
      system: 's',
      model: 'opus',
      sessionId: 'abc',
      dir: repo,
      resume: false,
    }),
  );
  await settle();
  assert.ok(seen !== null);
  assert.deepEqual((seen as PilotChatOptions).addDirs, [path.resolve(repo), path.resolve(extra)]);
});
