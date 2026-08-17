import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '@src/proc.js';

/**
 * `process.execPath` only - never a real agent.
 *
 * Spawning `claude` or `codex` needs a logged-in account, costs money and takes
 * minutes; node is the only child this hook needs in order to be exercised.
 */
const node = process.execPath;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test('every complete line arrives, and the buffered stdout is unchanged', async () => {
  const script = "process.stdout.write('one\\ntwo\\nthree\\n')";
  const lines: string[] = [];

  const hooked = await run(node, ['-e', script], { onLine: (line) => lines.push(line) });
  const plain = await run(node, ['-e', script]);

  assert.deepEqual(lines, ['one', 'two', 'three']);
  assert.equal(hooked.stdout, plain.stdout);
  assert.equal(hooked.code, 0);
});

test('a line split across two chunks is delivered once, reassembled', async () => {
  const script = `process.stdout.write('{"half":'); setTimeout(() => process.stdout.write('"whole"}\\n'), 100)`;
  const lines: string[] = [];

  const { stdout } = await run(node, ['-e', script], { onLine: (line) => lines.push(line) });

  assert.deepEqual(lines, ['{"half":"whole"}']);
  assert.equal(stdout, '{"half":"whole"}\n');
});

test('CRLF output does not leave a carriage return on the line', async () => {
  const lines: string[] = [];

  await run(node, ['-e', "process.stdout.write('one\\r\\ntwo\\r\\n')"], {
    onLine: (line) => lines.push(line),
  });

  assert.deepEqual(lines, ['one', 'two']);
});

test('a final line with no trailing newline is flushed exactly once on close', async () => {
  const lines: string[] = [];

  await run(node, ['-e', "process.stdout.write('single')"], { onLine: (line) => lines.push(line) });

  assert.deepEqual(lines, ['single']);
});

test('a hook that throws costs the progress line, not the turn', async () => {
  const script = "process.stdout.write('one\\ntwo\\n'); process.exitCode = 3";
  let calls = 0;

  const { code, stdout } = await run(node, ['-e', script], {
    onLine: () => {
      calls += 1;
      throw new Error('the sink exploded');
    },
  });

  assert.equal(calls, 2);
  assert.equal(stdout, 'one\ntwo\n');
  assert.equal(code, 3);
});

test('no line is delivered after a timeout has rejected the promise', async () => {
  // Margins are deliberate: the first write lands ~100ms in on the verified
  // hosts, the timeout at 1500ms, the second write at 3000ms. A tighter test
  // could fail before it ever reached the path it exists to check.
  const script = "process.stdout.write('a\\n'); setTimeout(() => process.stdout.write('b\\n'), 3000)";
  const lines: string[] = [];

  await assert.rejects(
    () => run(node, ['-e', script], { timeoutMs: 1500, onLine: (line) => lines.push(line) }),
    /timed out/,
  );

  const atRejection = [...lines];
  await sleep(2500);

  assert.deepEqual(lines, atRejection);
  assert.ok(!lines.includes('b'), 'a line arrived after the promise settled');
});

test('a run with no hook behaves exactly as it did before', async () => {
  const { code, stdout, stderr } = await run(node, ['-e', "console.log('quiet'); console.error('noise')"]);

  assert.equal(code, 0);
  assert.equal(stdout, 'quiet\n');
  assert.match(stderr, /noise/);
});
