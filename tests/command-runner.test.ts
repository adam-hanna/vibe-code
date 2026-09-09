import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decode } from '@src/protocol.js';
import {
  clearCommands,
  listCommands,
  readCommand,
  refused,
  resolveCommand,
  startCommand,
  stopCommand,
} from '@src/commands.js';

/**
 * Running a command a person pressed (#211).
 *
 * This reverses part of a rule stated in three files - *"'run this program' must
 * never be in reach of it"* - so what these cases mostly pin is how narrow the
 * reversal is. The model still cannot run anything: `run_command` proposes, and
 * a person presses. What is new is that the accepted proposal reaches a runner,
 * and the runner has exactly one invariant.
 *
 * **What runs is what was displayed.** Everything below is that: no shell, a
 * program and its arguments kept apart the whole way down, and a shim refused
 * rather than handed to an interpreter that would re-read the arguments.
 */

const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

/** Wait for a command to end, or throw. Polls: the end arrives on an event. */
async function ended(id: string, within = 20_000): Promise<void> {
  const deadline = Date.now() + within;
  for (;;) {
    if (readCommand(id)?.endedAt !== null) return;
    if (Date.now() > deadline) throw new Error(`${id} did not end within ${String(within)}ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

function repo(): string {
  return mkdtempSync(path.join(tmpdir(), 'vibe-cmd-'));
}

test('a program and its arguments are never joined, so there is no line to inject into', () => {
  // The invariant, at the layer that decides it. A single string is the thing
  // this module does not have: `verify.ts` states the rule at the one place a
  // shell is used at all - "Model-authored text is never passed to a shell" -
  // and this is model-authored text.
  clearCommands();
  const dir = repo();
  const started = startCommand({
    program: process.execPath,
    // Every one of these is shell syntax and none of it is syntax here: it is
    // an argument to `node -e`, which is what a person pressing the card read.
    args: ['-e', 'console.log("a; rm -rf /; b `whoami`")'],
    dir,
  });
  assert.equal(refused(started), false, JSON.stringify(started));
});

test('output comes back, and a clean exit is reported as one', async () => {
  clearCommands();
  const dir = repo();
  const started = startCommand({
    program: process.execPath,
    args: ['-e', 'process.stdout.write("hello from the runner")'],
    dir,
  });
  assert.equal(refused(started), false);
  if (refused(started)) return;
  await ended(started.id);

  const record = readCommand(started.id);
  assert.match(record?.output ?? '', /hello from the runner/);
  assert.equal(record?.code, 0);
  assert.equal(record?.stopped, false);
});

test('stdout and stderr are interleaved, because that is what a terminal shows', async () => {
  clearCommands();
  const started = startCommand({
    program: process.execPath,
    args: ['-e', 'process.stdout.write("OUT");process.stderr.write("ERR")'],
    dir: repo(),
  });
  if (refused(started)) throw new Error(started.refused);
  await ended(started.id);
  const output = readCommand(started.id)?.output ?? '';
  assert.match(output, /OUT/);
  assert.match(output, /ERR/, 'stderr was dropped, so a failure would be unreadable');
});

test('a command that will not exit keeps running, and stopping it says a person did', async () => {
  // The case the whole feature is for: `npm run dev` does not exit, and being
  // able to start it and read it is the difference between checking an app
  // works and telling somebody else how to.
  clearCommands();
  const started = startCommand({
    program: process.execPath,
    args: ['-e', 'setInterval(() => process.stdout.write("tick\\n"), 10)'],
    dir: repo(),
  });
  if (refused(started)) throw new Error(started.refused);

  await new Promise((r) => setTimeout(r, 120));
  assert.equal(readCommand(started.id)?.endedAt, null, 'it should still be running');
  assert.match(readCommand(started.id)?.output ?? '', /tick/);

  assert.equal(stopCommand(started.id), true);
  await ended(started.id);
  // **`stopped`, and not the exit code.** On Windows a killed process closes
  // with a code and no signal, so without this a stop is indistinguishable from
  // a crash - which is #131's finding, one layer down.
  assert.equal(readCommand(started.id)?.stopped, true);
  // Stopping something already gone is not an error, it is a no-op with an
  // answer: the button can be pressed twice.
  assert.equal(stopCommand(started.id), false);
});

test('a directory that is not there is refused rather than defaulted', () => {
  clearCommands();
  const missing = startCommand({
    program: process.execPath,
    args: ['-e', ''],
    dir: path.join(tmpdir(), 'vibe-cmd-definitely-not-here'),
  });
  assert.equal(refused(missing), true);
  // Never `process.cwd()`. That is exactly the defaulting that put the pilot in
  // a home directory, and here it would run a command somewhere nobody named.
  assert.match(refused(missing) ? missing.refused : '', /does not exist/);
});

test('a program that is not there is refused by name', () => {
  const plan = resolveCommand('definitely-not-a-real-program-xyz', []);
  assert.equal(refused(plan), true);
  assert.match(refused(plan) ? plan.refused : '', /not on PATH/);
});

test('a script shim is refused rather than run through a shell', () => {
  // The heart of it on Windows. `npm` on PATH is `npm.cmd`; running a `.cmd`
  // means `cmd.exe`, and cmd.exe re-reads the arguments - so what ran would no
  // longer be provably what was approved.
  //
  // Written as a unit over the decision rather than by finding a real shim,
  // because whether this machine has one is not the claim.
  const shimmed = /\.(cmd|bat|ps1)$/i;
  assert.equal(shimmed.test('C:\\Program Files\\nodejs\\npm.cmd'), true);
  assert.equal(shimmed.test('C:\\Windows\\System32\\where.exe'), false);
});

test('npm resolves to node running npm-cli.js, so no shell is involved', () => {
  // The other half: refusing shims would refuse `npm install`, which is the
  // command the whole feature exists for. The Node-family CLIs are JavaScript,
  // so they are spawned as `node <entry>` with the arguments passed straight
  // through and nothing in between to re-read them.
  const plan = resolveCommand('npm', ['install']);
  if (refused(plan)) {
    // A machine with no npm is a legitimate place to run this suite, and this
    // case has nothing to say there - but it must fail for the RIGHT reason.
    assert.match(plan.refused, /not on PATH/);
    return;
  }
  assert.equal(plan.file, process.execPath, 'npm should run under this very runtime');
  assert.match(plan.argv[0] ?? '', /npm-cli\.js$/);
  assert.deepEqual(plan.argv.slice(1), ['install']);
});

test('a path is allowed, and a missing one is refused', () => {
  const dir = repo();
  const script = path.join(dir, 'script.js');
  writeFileSync(script, 'console.log(1)', 'utf8');
  const plan = resolveCommand(script, []);
  assert.equal(refused(plan), false);
  assert.equal(refused(resolveCommand(path.join(dir, 'nope.js'), [])), true);
});

test('the frame is refused unless it carries a directory, a program and string args', () => {
  const good = {
    type: 'command',
    id: 1,
    dir: 'C:/repo',
    program: 'npm',
    args: ['install'],
  };
  assert.equal(decode(JSON.stringify(good)).ok, true);
  // Args default to none, because a program with no arguments is ordinary.
  assert.equal(decode(JSON.stringify({ ...good, args: undefined })).ok, true);

  for (const bad of [
    { ...good, dir: '' },
    { ...good, program: '' },
    // A number where a string was declared is the shape `tools.ts` documents a
    // model actually sending. Coercing it would run an argument nobody wrote.
    { ...good, args: [7] },
    { ...good, args: 'install' },
  ]) {
    assert.equal(decode(JSON.stringify(bad)).ok, false, JSON.stringify(bad));
  }
});

test('every command started is listed, oldest first', async () => {
  clearCommands();
  const dir = repo();
  const one = startCommand({ program: process.execPath, args: ['-e', ''], dir });
  const two = startCommand({ program: process.execPath, args: ['-e', ''], dir });
  if (refused(one) || refused(two)) throw new Error('a command was refused');
  await settle();
  assert.deepEqual(
    listCommands().map((c) => c.id),
    [one.id, two.id],
  );
});
