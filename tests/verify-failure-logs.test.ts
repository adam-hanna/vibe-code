import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { orchestrate } from '@src/orchestrator.js';
import { EXCERPT_HEAD, EXCERPT_TAIL, excerpt } from '@src/verify.js';
import { agents, config, report, reviewingRun, work } from './helpers/loop-harness.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import type { Config, RunState, VerifyGate } from '@src/types.js';

/**
 * A failing gate can be read (#248).
 *
 * In the #169 run the `core` gate failed 3 of 3 and the fixer was handed the
 * last 8,000 characters of the first failing attempt - which held `# fail 2` and
 * none of the failures. What is pinned here is the three things that replaced
 * that: every attempt of a gate that did not pass cleanly keeps its whole output
 * as a file named on the event; the fixer gets the head and the tail with the cut
 * stated and that file named; and none of the output reaches `state.events`.
 *
 * The gate commands are real, written into the repository as the loop harness's
 * are, and run by `src/verify.ts` exactly as a project's own would be.
 */

const RUN = { prefix: 'vibe-verify-logs-', task: 'verification logs' } as const;

/**
 * A gate that prints a body of our choosing and fails on the named runs.
 *
 * `exitCode` rather than `process.exit`: exiting while a 50 KB write to a pipe
 * is still draining can cut it short, and this file's whole claim is about
 * every byte arriving.
 */
function printingGate(
  state: RunState,
  name: string,
  options: { failRuns: readonly number[]; body: (run: number) => string },
): string {
  const script = `vibe-print-${name}.mjs`;
  const counter = `vibe-print-${name}-runs.txt`;
  const bodies: Record<number, string> = {};
  for (let run = 1; run <= 6; run += 1) bodies[run] = options.body(run);
  writeFileSync(path.join(state.targetDir, `vibe-print-${name}.json`), JSON.stringify(bodies), 'utf8');
  writeFileSync(
    path.join(state.targetDir, script),
    "import { appendFileSync, readFileSync } from 'node:fs';\n" +
      `appendFileSync(${JSON.stringify(counter)}, 'ran\\n');\n` +
      `const runs = readFileSync(${JSON.stringify(counter)}, 'utf8').split('\\n').filter(Boolean).length;\n` +
      `const bodies = JSON.parse(readFileSync(${JSON.stringify(`vibe-print-${name}.json`)}, 'utf8'));\n` +
      'process.stdout.write(bodies[runs] ?? "");\n' +
      `process.exitCode = ${JSON.stringify([...options.failRuns])}.includes(runs) ? 1 : 0;\n`,
    'utf8',
  );
  return `node ${script}`;
}

function gated(gates: readonly VerifyGate[]): Partial<Config> {
  return {
    verify: { ...DEFAULTS.verify, enabled: true, command: null, runs: 1, timeoutMs: 30_000, gates: [...gates] },
  };
}

/** Run the loop to completion, keeping every verify-fix prompt by label. */
async function drive(state: RunState, over: Partial<Config>): Promise<Map<string, string>> {
  const prompts = new Map<string, string>();
  await orchestrate(
    state,
    config({ maxVerifyRounds: 4 }, over),
    true,
    agents(
      {
        claude: (label: string, options: ClaudeTurnOptions) => {
          if (label.startsWith('verify-fix-')) prompts.set(label, options.prompt);
          return work(state, `${label}.txt`);
        },
        codex: () => report([]),
      },
      [],
    ),
  );
  return prompts;
}

const logsIn = (state: RunState): string[] =>
  readdirSync(state.dir)
    .filter((n) => /^verify-.*\.log$/.test(n))
    .sort();

// ---- the excerpt -------------------------------------------------------------

test('output within the budget passes through byte-identical, with no marker', () => {
  const exact = 'x'.repeat(EXCERPT_HEAD + EXCERPT_TAIL);
  assert.equal(excerpt(exact, '/abs/full.log'), exact);
  assert.equal(excerpt('short\n', null), 'short\n');
});

test('past the budget, the head and the tail survive and the cut is stated', () => {
  const text = `${'h'.repeat(EXCERPT_HEAD)}${'Z'.repeat(500)}${'t'.repeat(EXCERPT_TAIL)}`;
  const named = excerpt(text, '/abs/full.log');
  assert.equal(named.startsWith('h'.repeat(EXCERPT_HEAD) + '\n'), true);
  assert.equal(named.endsWith('\n' + 't'.repeat(EXCERPT_TAIL)), true);
  assert.match(named, /\[vibe\] … 500 characters omitted; the full output is \/abs\/full\.log …/);
  assert.equal(named.includes('Z'), false);

  const unnamed = excerpt(text, null);
  assert.match(unnamed, /\[vibe\] … 500 characters omitted …/);
  assert.equal(unnamed.includes('full output'), false);
});

// ---- what the fixer is shown ------------------------------------------------

test('a big failing output puts its head, the cut and the full log in the fixer prompt', async () => {
  const state = reviewingRun({ ...RUN, commit: true });
  const head = 'TAP version 13\nnot ok 1 - SENTINEL_HEAD broke\n  ---\n  error: expected 1 got 2\n';
  const filler = (n: number): string => `ok ${n} - filler line that pads the output out\n`;
  const middle = Array.from({ length: 600 }, (_u, i) => filler(i)).join('') + 'SENTINEL_MIDDLE\n';
  const rest = Array.from({ length: 600 }, (_u, i) => filler(i + 600)).join('');
  const full = `${head}${middle}${rest}# fail 1\n`;
  assert.ok(full.length > 50_000);

  const command = printingGate(state, 'core', { failRuns: [1], body: (run) => (run === 1 ? full : 'ok\n') });
  const prompts = await drive(state, gated([{ name: 'core', command }]));

  const prompt = prompts.get('verify-fix-1') ?? '';
  const log = path.resolve(state.dir, 'verify-0-0-core-1.log');
  // The whole output, byte for byte, in the attempt's own file.
  assert.equal(readFileSync(log, 'utf8'), full);

  assert.match(prompt, /not ok 1 - SENTINEL_HEAD broke/);
  const omitted = full.length - (EXCERPT_HEAD + EXCERPT_TAIL);
  assert.ok(prompt.includes(`[vibe] … ${omitted} characters omitted; the full output is ${log} …`));
  assert.ok(prompt.includes(`- run 1: ${log}`));
  assert.match(prompt, /Search the full log/);
  assert.equal(prompt.includes('SENTINEL_MIDDLE'), false);

  // `verify-failure-0.txt` holds the same excerpt the prompt carried.
  const failure = readFileSync(path.join(state.dir, 'verify-failure-0.txt'), 'utf8');
  assert.equal(failure, excerpt(full, log));
  assert.ok(prompt.includes(`\`\`\`\n${failure}\n\`\`\``));

  // Nothing of the output is on the run's record.
  assert.equal(JSON.stringify(state.events).includes('SENTINEL_MIDDLE'), false);
  assert.equal(JSON.stringify(state.events).includes('SENTINEL_HEAD'), false);
  assert.equal(readFileSync(path.join(state.dir, 'state.json'), 'utf8').includes('SENTINEL_MIDDLE'), false);
});

test('a small failing output reaches the prompt unchanged, with no marker', async () => {
  const state = reviewingRun({ ...RUN, commit: true });
  const small = 'not ok 1 - small failure\n# tests 1\n# fail 1\n';
  const command = printingGate(state, 'core', { failRuns: [1], body: (run) => (run === 1 ? small : 'ok\n') });
  const prompts = await drive(state, gated([{ name: 'core', command }]));

  const prompt = prompts.get('verify-fix-1') ?? '';
  assert.ok(prompt.includes(`\`\`\`\n${small}\n\`\`\``));
  assert.equal(prompt.includes('characters omitted'), false);
  assert.equal(readFileSync(path.join(state.dir, 'verify-failure-0.txt'), 'utf8'), small);
});

// ---- which logs are written, and under which names ---------------------------

test('a gate failing every attempt writes one log per attempt; a passing gate writes none', async () => {
  const state = reviewingRun({ ...RUN, commit: true });
  const core = printingGate(state, 'core', { failRuns: [1, 2, 3], body: (run) => `core run ${run}\n` });
  const lint = printingGate(state, 'lint', { failRuns: [], body: () => 'clean\n' });
  await drive(state, gated([
    { name: 'lint', command: lint, runs: 3 },
    { name: 'core', command: core, runs: 3 },
  ]));

  assert.deepEqual(logsIn(state), ['verify-0-0-core-1.log', 'verify-0-0-core-2.log', 'verify-0-0-core-3.log']);
  assert.equal(readFileSync(path.join(state.dir, 'verify-0-0-core-2.log'), 'utf8'), 'core run 2\n');

  const failed = state.events.find((e) => e.type === 'verify_failed');
  const attempts = failed?.['attempts'] as Record<string, unknown>[];
  assert.equal(attempts.length, 3);
  for (const [i, a] of attempts.entries()) {
    assert.deepEqual(Object.keys(a).sort(), ['exitCode', 'log', 'ok', 'run']);
    assert.equal(a['log'], `verify-0-0-core-${i + 1}.log`);
    assert.equal(existsSync(path.join(state.dir, String(a['log']))), true);
  }
  // The output is in the files and nowhere on the record.
  assert.equal(JSON.stringify(state.events).includes('core run 2'), false);
  // A gate that passed every attempt names no log either.
  const passed = state.events.find((e) => e.type === 'verify_passed');
  for (const a of passed?.['attempts'] as Record<string, unknown>[]) assert.equal('log' in a, false);
});

test('a flaky gate keeps the attempt that passed beside the one that failed', async () => {
  const state = reviewingRun({ ...RUN, commit: true });
  const core = printingGate(state, 'core', { failRuns: [1], body: (run) => `core run ${run}\n` });
  const prompts = await drive(state, gated([{ name: 'core', command: core, runs: 2 }]));

  assert.deepEqual(logsIn(state), ['verify-0-0-core-1.log', 'verify-0-0-core-2.log']);
  assert.equal(readFileSync(path.join(state.dir, 'verify-0-0-core-2.log'), 'utf8'), 'core run 2\n');
  // Only the FAILED attempt is named to the fixer as where the failures are.
  const prompt = prompts.get('verify-fix-1') ?? '';
  assert.ok(prompt.includes(`- run 1: ${path.resolve(state.dir, 'verify-0-0-core-1.log')}`));
  assert.equal(prompt.includes('- run 2:'), false);
});

test('two gates failing in turn, and one gate failing twice, never share a log', async () => {
  // `runGate` stops at the first failing gate, so two gates fail in SUCCESSIVE
  // passes under one review round - which is exactly where a name keyed only by
  // the round and the attempt would collide.
  const state = reviewingRun({ ...RUN, commit: true });
  const typecheck = printingGate(state, 'typecheck', { failRuns: [1], body: (run) => `typecheck run ${run}\n` });
  const suite = printingGate(state, 'test', { failRuns: [1], body: (run) => `test run ${run}\n` });
  await drive(state, gated([
    { name: 'typecheck', command: typecheck },
    { name: 'test', command: suite },
  ]));
  assert.deepEqual(logsIn(state), ['verify-0-0-typecheck-1.log', 'verify-0-1-test-1.log']);

  // The same gate failing again after a verify-fix: the first pass's log is
  // still there and still says what the first pass printed.
  const again = reviewingRun({ ...RUN, commit: true });
  const core = printingGate(again, 'core', { failRuns: [1, 2], body: (run) => `core run ${run}\n` });
  const prompts = await drive(again, gated([{ name: 'core', command: core }]));
  assert.deepEqual(logsIn(again), ['verify-0-0-core-1.log', 'verify-0-1-core-1.log']);
  assert.equal(readFileSync(path.join(again.dir, 'verify-0-0-core-1.log'), 'utf8'), 'core run 1\n');
  assert.equal(readFileSync(path.join(again.dir, 'verify-0-1-core-1.log'), 'utf8'), 'core run 2\n');
  // And each fix round is pointed at its own pass's log.
  assert.ok((prompts.get('verify-fix-2') ?? '').includes(path.resolve(again.dir, 'verify-0-1-core-1.log')));
});
