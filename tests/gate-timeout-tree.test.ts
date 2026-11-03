import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runUserCommand } from '@src/verify.js';

/**
 * A gate that times out is stopped whole, and its result arrives only after
 * (#486). `node slow.mjs && echo done` makes the shell a parent of the runner;
 * killing the shell alone left the runner alive and still writing the tree
 * after the timeout had been reported - while a replay put its tests back, or
 * the next pass began.
 */

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('a timed-out gate takes its children with it before the timeout is reported', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-gate-tree-'));
  writeFileSync(
    path.join(dir, 'slow.mjs'),
    "import { writeFileSync } from 'node:fs';\n" +
      "writeFileSync('pid.txt', String(process.pid));\n" +
      "setTimeout(() => writeFileSync('late.txt', 'written after the timeout'), 1500);\n",
    'utf8',
  );
  const started = Date.now();
  const result = await runUserCommand('node slow.mjs && echo done', dir, process.env, 600);
  assert.equal(result.code, null, 'a timeout has no exit code');
  assert.match(result.output, /timed out after 600ms/);

  // The runner printed its pid before the timeout; by the time the result
  // arrived it is gone - or, at most, a zombie about to be reaped.
  const pid = Number(readFileSync(path.join(dir, 'pid.txt'), 'utf8'));
  const deadline = Date.now() + 2_000;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.equal(alive(pid), false, `the runner ${pid} outlived the timeout`);

  // And it never got to write: wait past when it would have.
  await new Promise((r) => setTimeout(r, Math.max(0, started + 2_000 - Date.now())));
  assert.equal(existsSync(path.join(dir, 'late.txt')), false, 'the runner wrote after the timeout');
});

test('a gate that finishes in time reports its own exit code, as before', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-gate-tree-'));
  const result = await runUserCommand('node -e "process.exit(3)"', dir, process.env, 30_000);
  assert.equal(result.code, 3);
});

/** Spawn and wait for a pid file a worker writes, the way the cases below start one. */
function workerScripts(dir: string, spawnOptions: string, exitRunner: boolean): void {
  writeFileSync(
    path.join(dir, 'worker.mjs'),
    "import { writeFileSync } from 'node:fs';\n" +
      "writeFileSync('worker.pid', String(process.pid));\n" +
      "setTimeout(() => writeFileSync('late.txt', 'written after the timeout'), 4000);\n" +
      'setInterval(() => {}, 1000);\n',
    'utf8',
  );
  writeFileSync(
    path.join(dir, 'runner.mjs'),
    "import { spawn } from 'node:child_process';\n" +
      "import { existsSync } from 'node:fs';\n" +
      `spawn(process.execPath, ['worker.mjs'], ${spawnOptions});\n` +
      `const wait = setInterval(() => { if (existsSync('worker.pid')) { clearInterval(wait); ${exitRunner ? 'process.exit(1);' : ''} } }, 20);\n` +
      'setInterval(() => {}, 1000);\n',
    'utf8',
  );
}

function killPidFile(file: string): void {
  if (!existsSync(file)) return;
  const pid = Number(readFileSync(file, 'utf8'));
  if (Number.isSafeInteger(pid) && pid > 1) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Gone, which is what the case wants.
    }
  }
}

async function gone(pid: number): Promise<boolean> {
  const deadline = Date.now() + 2_000;
  while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return !alive(pid);
}

test('a worker started with an environment allowlist, whose runner exited, is stopped before the timeout is reported', { skip: process.platform === 'win32' }, async (t) => {
  // Neither parentage nor the inherited token reaches this one: its parent is
  // gone and its environment has no token. Its process group still holds it.
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-gate-tree-'));
  t.after(() => killPidFile(path.join(dir, 'worker.pid')));
  workerScripts(dir, "{ stdio: ['ignore', 'inherit', 'inherit'], env: { PATH: process.env.PATH } }", true);
  const result = await runUserCommand('node runner.mjs && echo finished', dir, process.env, 3_000);
  assert.equal(result.code, null);
  assert.equal(result.escaped, undefined, 'every process was stopped, so the timeout is not reported as escaped');
  const pid = Number(readFileSync(path.join(dir, 'worker.pid'), 'utf8'));
  assert.equal(await gone(pid), true, `the worker ${pid} outlived the timeout`);
});

test('a process that left the group on purpose and kept the pipe is reported as escaped, not as stopped', { skip: process.platform === 'win32' }, async (t) => {
  // `detached` is `setsid`: out of the gate's group, and with the allowlist out
  // of the token's reach too. Nothing vibe can find, and it holds the pipe, so
  // the result says teardown was not confirmed.
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-gate-tree-'));
  t.after(() => killPidFile(path.join(dir, 'worker.pid')));
  workerScripts(dir, "{ detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: { PATH: process.env.PATH } }", true);
  const result = await runUserCommand('node runner.mjs && echo finished', dir, process.env, 1_500);
  assert.equal(result.code, null);
  assert.equal(result.escaped, true);
  assert.match(result.output, /timed out after 1500ms/);
  assert.match(result.output, /still holding its output/);
});

test('Ctrl-C reaches a gate in its own group, and vibe still dies of it', { skip: process.platform === 'win32' }, async (t) => {
  // The gate is out of the terminal's foreground group, so the interrupt is
  // forwarded; and the process running it ends by the signal, as it did.
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-gate-tree-'));
  t.after(() => killPidFile(path.join(dir, 'worker.pid')));
  writeFileSync(
    path.join(dir, 'worker.mjs'),
    "import { writeFileSync } from 'node:fs';\nwriteFileSync('worker.pid', String(process.pid));\nsetInterval(() => {}, 1000);\n",
    'utf8',
  );
  const verify = new URL('../src/verify.js', import.meta.url).href;
  writeFileSync(
    path.join(dir, 'host.mjs'),
    `const { runUserCommand } = await import(${JSON.stringify(verify)});\n` +
      "console.log('started');\n" +
      "await runUserCommand('node worker.mjs', process.cwd(), process.env, 60000);\n" +
      "console.log('finished');\n",
    'utf8',
  );
  const host = spawn(process.execPath, ['host.mjs'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => {
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
  });
  let out = '';
  host.stdout.on('data', (d: Buffer) => void (out += d.toString('utf8')));
  host.stderr.on('data', (d: Buffer) => void (out += d.toString('utf8')));
  const ended = new Promise<NodeJS.Signals | number | null>((resolve) =>
    host.on('exit', (code, sig) => resolve(sig ?? code)),
  );
  const pidFile = path.join(dir, 'worker.pid');
  const deadline = Date.now() + 15_000;
  while (!existsSync(pidFile) && host.exitCode === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(existsSync(pidFile), `the gate never started: ${host.exitCode === null ? 'nothing within 15s' : `the host ended first`}\n${out}`);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  host.kill('SIGINT');
  assert.equal(await ended, 'SIGINT', `the host ended some other way:\n${out}`);
  assert.doesNotMatch(out, /finished/);
  assert.equal(await gone(pid), true, `the gate ${pid} outlived the interrupt`);
});

test('an escaped gate lets go of its pipes, so the process that ran it can still exit', { skip: process.platform === 'win32' }, async (t) => {
  // The run stops with EXIT.ERROR on an escaped replay gate; that only reaches
  // a shell or the desktop host if vibe can then exit while the escaped
  // process still holds the write ends of the gate's pipes.
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-gate-tree-'));
  t.after(() => killPidFile(path.join(dir, 'worker.pid')));
  workerScripts(dir, "{ detached: true, stdio: ['ignore', 'inherit', 'inherit'], env: { PATH: process.env.PATH } }", true);
  const verify = new URL('../src/verify.js', import.meta.url).href;
  writeFileSync(
    path.join(dir, 'host.mjs'),
    `const { runUserCommand } = await import(${JSON.stringify(verify)});\n` +
      "const r = await runUserCommand('node runner.mjs && echo finished', process.cwd(), process.env, 1500);\n" +
      "console.log(r.escaped === true ? 'escaped' : 'not escaped');\n",
    'utf8',
  );
  const host = spawn(process.execPath, ['host.mjs'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => {
    if (host.exitCode === null && host.signalCode === null) host.kill('SIGKILL');
  });
  let out = '';
  host.stdout.on('data', (d: Buffer) => void (out += d.toString('utf8')));
  host.stderr.on('data', (d: Buffer) => void (out += d.toString('utf8')));
  const ended = await new Promise<number | string>((resolve) => {
    const timer = setTimeout(() => resolve('still running 20s later'), 20_000);
    host.on('exit', (code, sig) => {
      clearTimeout(timer);
      resolve(sig ?? code ?? 'unknown');
    });
  });
  assert.equal(ended, 0, `the host did not exit on its own:\n${out}`);
  assert.match(out, /^escaped$/m);
});
