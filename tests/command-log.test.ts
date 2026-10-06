import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commandLogDir, pastCommands, prune, writeMeta } from '@src/commandlog.js';
import { clearCommands, keepCommandLogs, readCommand, startCommand, stopAllCommands } from '@src/commands.js';
import { decode } from '@src/protocol.js';
import { createSession } from '@src/serve.js';
import type { CommandMeta } from '@src/commandlog.js';
import type { Outbound } from '@src/protocol.js';

/**
 * A command's output, kept on disk (#223). The host held it only in memory, so
 * a relaunch emptied the Commands tab and a dev server that fell over in the
 * night took the only record of why with it.
 */

const fresh = (): string => path.join(mkdtempSync(path.join(tmpdir(), 'vibe-cmdlog-')), 'commands');

function meta(n: number, over: Partial<CommandMeta> = {}): CommandMeta {
  return {
    id: `cmd-${String(n)}`,
    program: 'node',
    args: ['-v'],
    resolved: 'node',
    dir: '/repo',
    startedAt: 1000 + n,
    endedAt: 2000 + n,
    code: 0,
    signal: null,
    stopped: false,
    ...over,
  };
}

async function ended(id: string, within = 20_000): Promise<void> {
  const deadline = Date.now() + within;
  for (;;) {
    if (readCommand(id)?.endedAt !== null) return;
    if (Date.now() > deadline) throw new Error(`${id} did not end within ${String(within)}ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('the directory is under the app data the shell names, and absent without it', () => {
  assert.equal(commandLogDir({ VIBE_APP_DATA: '/data' }), path.join('/data', 'commands'));
  assert.equal(commandLogDir({}), null);
  assert.equal(commandLogDir({ VIBE_APP_DATA: '' }), null);
});

test('a command writes its output and its ending, and the next process reads both back', async (t) => {
  t.after(() => clearCommands());
  const dir = fresh();
  assert.deepEqual(keepCommandLogs(dir), []);
  const started = startCommand({
    program: process.execPath,
    args: ['-e', 'process.stdout.write("hello\\n"); process.stderr.write("oops\\n"); process.exit(3)'],
    dir: tmpdir(),
  });
  assert.ok('id' in started);
  await ended(started.id);

  const log = readFileSync(path.join(dir, `${started.id}.log`), 'utf8');
  assert.match(log, /hello/);
  assert.match(log, /oops/);

  // A new process: nothing in memory, everything on disk.
  clearCommands();
  const [past] = keepCommandLogs(dir);
  assert.equal(past?.id, started.id);
  assert.equal(past?.code, 3);
  assert.equal(past?.lost, false);
  assert.equal(past?.output, log);
  assert.equal(past?.truncated, false);
  assert.equal(past?.bytes, log.length);
});

test('numbering continues past the ids on disk, so an id names one command across launches', (t) => {
  t.after(() => clearCommands());
  const dir = fresh();
  writeMeta(dir, meta(7));
  keepCommandLogs(dir);
  const started = startCommand({ program: process.execPath, args: ['-v'], dir: tmpdir() });
  assert.ok('id' in started);
  assert.equal(started.id, 'cmd-8');
  stopAllCommands();
});

test('a command still running when the host vanished is lost, not live', () => {
  const dir = fresh();
  writeMeta(dir, meta(1, { endedAt: null, code: null }));
  const [past] = pastCommands(dir, 1024);
  assert.equal(past?.lost, true);
  assert.equal(past?.endedAt, null);
});

test('a command stopped on the way out is recorded as stopped, because no close handler will run', async (t) => {
  t.after(() => clearCommands());
  const dir = fresh();
  keepCommandLogs(dir);
  const started = startCommand({ program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], dir: tmpdir() });
  assert.ok('id' in started);
  assert.equal(stopAllCommands(() => 5555), 1);
  const [past] = pastCommands(dir, 1024);
  assert.equal(past?.stopped, true);
  assert.equal(past?.endedAt, 5555);
  assert.equal(past?.lost, false);
  await ended(started.id);
});

test('the window is given the end of a long log, and told it is the end', () => {
  const dir = fresh();
  writeMeta(dir, meta(1));
  // A multi-byte character straddling the cut must not arrive as a broken one.
  writeFileSync(path.join(dir, 'cmd-1.log'), `${'a'.repeat(100)}é${'b'.repeat(9)}`, 'utf8');
  const [past] = pastCommands(dir, 10);
  assert.equal(past?.output, 'b'.repeat(9));
  assert.equal(past?.truncated, true);
  // What was dropped plus what is held: the cursor a reader resumes from.
  assert.equal(past?.bytes, 102 + 9);
});

test('only the newest are kept, and an unreadable record hides nothing', () => {
  const dir = fresh();
  for (let n = 1; n <= 5; n += 1) {
    writeMeta(dir, meta(n));
    writeFileSync(path.join(dir, `cmd-${String(n)}.log`), String(n));
  }
  writeFileSync(path.join(dir, 'cmd-9.json'), '{half');
  assert.equal(prune(dir, 3), 2);
  assert.equal(existsSync(path.join(dir, 'cmd-1.log')), false);
  assert.deepEqual(
    pastCommands(dir, 1024).map((c) => c.id),
    ['cmd-3', 'cmd-4', 'cmd-5'],
  );
});

test('the host answers with what it loaded at start-up', async () => {
  assert.deepEqual(decode('{"type":"commands_past","id":4}'), { ok: true, message: { type: 'commands_past', id: 4 } });
  const sent: Outbound[] = [];
  const past = [{ ...meta(2), output: 'x', truncated: false, bytes: 1, lost: false }];
  const session = createSession((m) => sent.push(m), { pastCommands: past });
  session.write('{"type":"commands_past","id":4}\n');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent.find((m) => m.type === 'commands_past'), { type: 'commands_past', id: 4, commands: past });
});
