import { chmodSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type StubMode = 'ok' | 'exit' | 'noise';

/**
 * A stand-in for `codex app-server` that the spawn path can be tested against.
 *
 * The real binary needs a logged-in account, seconds of startup and the network.
 * This is node speaking the same JSONL protocol, reached through the same shim
 * shapes `codexBin()` resolves in the field - a `.cmd` on Windows, an executable
 * script elsewhere - so the shell rule and the argument vector are exercised
 * rather than assumed.
 */
export interface Stub {
  /** Pass to spawnCodexAppServer as the binary. */
  bin: string;
  /** The pid the stub reported at startup, once it has written one. */
  pid(): number | null;
  dir: string;
}

const SCRIPT = (mode: StubMode): string => `
const fs = require('node:fs');
fs.writeFileSync(process.env.STUB_PID_FILE, String(process.pid));
if (${JSON.stringify(mode)} === 'exit') process.exit(3);
if (${JSON.stringify(mode)} === 'noise') process.stdout.write('starting up, not json\\n');

let carry = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  carry += chunk;
  const lines = carry.split('\\n');
  carry = lines.pop() || '';
  for (const line of lines) {
    if (line.trim() === '') continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      // Answer in two writes, so the client's framing has to reassemble it.
      const reply = JSON.stringify({ id: msg.id, result: { userAgent: 'stub' } });
      process.stdout.write(reply.slice(0, 4));
      setTimeout(() => process.stdout.write(reply.slice(4) + '\\n'), 5);
    } else if (msg.method === 'account/rateLimits/read') {
      process.stdout.write(JSON.stringify({
        id: msg.id,
        result: { rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 15, windowDurationMins: 10080, resetsAt: 1787196925 },
          secondary: null,
          planType: 'plus',
        } },
      }) + '\\n');
    }
  }
});
setInterval(() => {}, 1000);
`;

const isWin = process.platform === 'win32';

/** Swept at exit rather than per test, so a failing assertion still cleans up. */
const created: string[] = [];
process.once('exit', () => {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A stub the OS still holds open is temp-directory litter, not a failure.
    }
  }
});

export function writeStub(mode: StubMode): Stub {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-stub-'));
  created.push(dir);
  const script = path.join(dir, 'stub.cjs');
  const pidFile = path.join(dir, 'pid');
  writeFileSync(script, SCRIPT(mode), 'utf8');

  // The env var is baked into the shim rather than passed through spawn options,
  // because spawnCodexAppServer deliberately does not take an env.
  const bin = path.join(dir, isWin ? 'stub.cmd' : 'stub.sh');
  const body = isWin
    ? `@echo off\r\nset STUB_PID_FILE=${pidFile}\r\n"${process.execPath}" "${script}"\r\n`
    : `#!/bin/sh\nSTUB_PID_FILE='${pidFile}' exec '${process.execPath}' '${script}'\n`;
  writeFileSync(bin, body, 'utf8');
  if (!isWin) chmodSync(bin, 0o755);

  return {
    bin,
    dir,
    pid(): number | null {
      if (!existsSync(pidFile)) return null;
      const raw = readFileSync(pidFile, 'utf8').trim();
      return raw === '' ? null : Number(raw);
    },
  };
}

/** Whether a process still exists, without signalling it. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}
