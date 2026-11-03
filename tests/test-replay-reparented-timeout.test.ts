import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runUserCommand } from '@src/verify.js';

test('a timeout stops a worker whose runner exited before the deadline', { skip: process.platform !== 'linux' }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-replay-reparented-timeout-'));
  const pidFile = path.join(dir, 'worker.pid');
  t.after(() => {
    if (!existsSync(pidFile)) return;
    const pid = Number(readFileSync(pidFile, 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 1) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  });
  writeFileSync(path.join(dir, 'worker.mjs'),
    "import { writeFileSync } from 'node:fs';\n" +
    "writeFileSync('worker.pid', String(process.pid));\n" +
    "process.send('ready');\n" +
    'setInterval(() => {}, 1000);\n');
  writeFileSync(path.join(dir, 'runner.mjs'),
    "import { fork } from 'node:child_process';\n" +
    "const worker = fork('./worker.mjs', [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });\n" +
    "worker.once('message', () => process.exit(1));\n");
  const result = await runUserCommand('node runner.mjs && echo finished', dir, process.env, 3000);
  assert.notEqual(result.code, 0);
  assert.ok(existsSync(pidFile), 'the worker never reached its readiness notification');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.ok(Number.isSafeInteger(pid) && pid > 1);
  let running = false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const kind = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0];
    running = kind !== 'Z' && kind !== 'X';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  assert.equal(running, false, 'replay can restore and continue while the timed-out worker remains alive');
});
