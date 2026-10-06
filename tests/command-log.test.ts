import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commandLogDir, pastCommands, prune, writeMeta } from '@src/commandlog.js';
import { adoptedSnapshot, clearCommands, keepCommandLogs, readCommand, sameProcess, startCommand, stopCommand, stopTiedCommands } from '@src/commands.js';
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
    pid: null,
    adopted: false,
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
});

test('a command still running when the host vanished is lost, not live', () => {
  const dir = fresh();
  writeMeta(dir, meta(1, { endedAt: null, code: null }));
  const [past] = pastCommands(dir, 1024);
  assert.equal(past?.lost, true);
  assert.equal(past?.endedAt, null);
});

const posix = process.platform !== 'win32';

async function until(what: string, ok: () => boolean, within = 20_000): Promise<void> {
  const deadline = Date.now() + within;
  while (!ok()) {
    if (Date.now() > deadline) throw new Error(`${what} within ${String(within)}ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

// Case 2 of AGENTS.md's two: this pinned that the host's way out STOPS every
// command, which was the contract until a relaunch killing the pilot's dev
// servers was reported. Where a command can be picked back up it is now left
// running; where it cannot (Windows, which pipes) the old claim still holds and
// is kept.
test('on the way out a detached command is left running and says so, a piped one is recorded as stopped', async (t) => {
  t.after(() => clearCommands());
  const dir = fresh();
  keepCommandLogs(dir);
  const started = startCommand({ program: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], dir: tmpdir() });
  assert.ok('id' in started);
  const [past] = pastCommands(dir, 1024);
  assert.equal(typeof past?.pid, 'number');
  if (posix) {
    assert.equal(stopTiedCommands(() => 5555), 0);
    const [after] = pastCommands(dir, 1024);
    assert.equal(after?.endedAt, null, 'the record still says it is running, which is true');
    assert.equal(gone(after?.pid ?? 0), false);
    assert.equal(sameProcess(after?.pid ?? 0, after?.startedAt ?? 0), true);
  } else {
    assert.equal(stopTiedCommands(() => 5555), 1);
    const [after] = pastCommands(dir, 1024);
    assert.equal(after?.stopped, true);
    assert.equal(after?.endedAt, 5555);
    assert.equal(after?.lost, false);
    await ended(started.id);
  }
});

/** A process an "earlier launch" left behind: detached, writing into its log. */
function leftBehind(dir: string, n: number, script: string): { pid: number; startedAt: number } {
  writeMeta(dir, meta(n, { endedAt: null, code: null }));
  const out = openSync(path.join(dir, `cmd-${String(n)}.log`), 'a');
  const startedAt = Date.now();
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', out, out] });
  closeSync(out);
  child.unref();
  const pid = child.pid ?? 0;
  writeMeta(dir, meta(n, { endedAt: null, code: null, startedAt, pid }));
  return { pid, startedAt };
}

test('a command an earlier launch left running is picked back up, followed, and can be stopped', { skip: !posix }, async (t) => {
  t.after(() => clearCommands());
  const dir = fresh();
  const { pid } = leftBehind(dir, 4, 'console.log("up on 5174"); setInterval(() => console.log("tick"), 50)');
  await until('the left-behind process wrote', () => readFileSync(path.join(dir, 'cmd-4.log'), 'utf8').includes('up on'));

  const chunks: string[] = [];
  const endings: (number | null)[] = [];
  const [past] = keepCommandLogs(dir, { onOutput: (_id, c) => chunks.push(c), onEnd: (r) => endings.push(r.code) });
  assert.equal(past?.lost, false, 'alive and the same process: not lost');
  assert.equal(past?.adopted, true);
  assert.equal(past?.endedAt, null);
  assert.match(past?.output ?? '', /up on 5174/);

  // Output written after the pick-up arrives as output, and the window asking
  // later is given it rather than the start-up copy.
  await until('output was followed', () => chunks.join('').includes('tick'));
  assert.ok((adoptedSnapshot('cmd-4')?.bytes ?? 0) > (past?.bytes ?? 0));

  assert.equal(stopCommand('cmd-4'), true);
  await until('the ending was noticed', () => endings.length === 1);
  assert.equal(gone(pid), true);
  const record = readCommand('cmd-4');
  assert.equal(record?.stopped, true);
  // Not our child, so no exit code was seen - and none is invented.
  assert.equal(record?.code, null);
  const [written] = pastCommands(dir, 1024);
  assert.equal(written?.adopted, true);
  assert.notEqual(written?.endedAt, null);
});

test('a live pid that started at another time is a stranger, and is never picked up', { skip: !posix }, (t) => {
  t.after(() => clearCommands());
  const dir = fresh();
  // This test's own process: alive, and certainly not started an hour ago.
  writeMeta(dir, meta(1, { endedAt: null, code: null, pid: process.pid, startedAt: Date.now() - 3_600_000 }));
  const [past] = keepCommandLogs(dir);
  assert.equal(past?.lost, true);
  assert.equal(past?.adopted, false);
  assert.equal(readCommand('cmd-1'), null);
});

test('a detached command is stopped by its group, so what it started goes with it', { skip: !posix }, async (t) => {
  t.after(() => clearCommands());
  const dir = fresh();
  keepCommandLogs(dir);
  const started = startCommand({
    program: process.execPath,
    args: [
      '-e',
      'const{spawn}=require("child_process");' +
        'const c=spawn(process.execPath,["-e","setInterval(()=>{},50)"],{stdio:"ignore"});' +
        'console.log("grandchild "+c.pid);setInterval(()=>{},50)',
    ],
    dir: tmpdir(),
  });
  assert.ok('id' in started);
  await until('it named its child', () => /grandchild \d+/.test(readCommand(started.id)?.output ?? ''));
  const grandchild = Number(/grandchild (\d+)/.exec(readCommand(started.id)?.output ?? '')?.[1]);
  assert.equal(stopCommand(started.id), true);
  await ended(started.id);
  await until('the grandchild died with it', () => gone(grandchild));
  assert.equal(readCommand(started.id)?.stopped, true);
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
