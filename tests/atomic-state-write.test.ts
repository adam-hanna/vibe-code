import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifact, createRun, saveState } from '@src/run.js';
import { main } from '@src/cli.js';
import { EXIT } from '@src/orchestrator.js';
import type { RunState } from '@src/types.js';
import {
  ALLOC_CONTEXT_PREFIX,
  ALLOC_MODEL,
  ARTIFACT_BODY_A,
  ARTIFACT_BODY_B,
} from './helpers/kill-markers.js';

/**
 * What a process killed mid-write leaves behind.
 *
 * `state.json` is rewritten every five seconds for the whole run and reaches
 * ~96KB, so the old truncate-then-write had a window on every single write in
 * which a kill left a half-file - and a run that could then only be resumed by
 * hand (#77). The fix is write-temp-then-rename, and the only honest test of it
 * is the failure itself: a real child process, killed at points spread across a
 * real write, with the file read back each time.
 *
 * Asserting `renameSync` was called would prove nothing about what the operating
 * system does between two syscalls, which is the entire question.
 */

const HELPER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'helpers',
  'kill-during-save.js',
);

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'vibe-atomic-'));
}

interface Started {
  child: ChildProcessWithoutNullStreams;
  dir: string;
}

/** Spawn the helper and wait for the run directory it prints. */
function start(targetDir: string, mode: 'save' | 'alloc' | 'artifact'): Promise<Started> {
  return new Promise((resolve, reject) => {
    // All three piped so the child types as `ChildProcessWithoutNullStreams`;
    // stdin is simply never written to.
    const child = spawn(process.execPath, [HELPER, targetDir, mode], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const line = out.split('\n')[0] ?? '';
      if (line.startsWith('ready ')) resolve({ child, dir: line.slice('ready '.length).trim() });
    });
    child.on('exit', (code) => {
      reject(new Error(`helper exited ${String(code)} before saying ready: ${stderr}`));
    });
  });
}

function killed(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve) => {
    child.on('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('a state.json write killed at any point leaves a whole file', async () => {
  // Spread across the write loop rather than aimed at one moment: the kill has
  // to be able to land anywhere, and only some of these land inside a write.
  //
  // These points and this payload were chosen by measurement, not by feel. The
  // same parent against a truncate-then-write child tore 2 times in 40 at this
  // size and 0 times in 40 at a lifelike ~96KB, so a smaller fixture would have
  // passed against the bug. See the note in `kill-during-save.ts`.
  const delays = Array.from({ length: 24 }, (_, i) => i * 0.6);

  for (const delay of delays) {
    const targetDir = scratch();
    const { child, dir } = await start(targetDir, 'save');
    await sleep(delay);
    await killed(child);

    const file = path.join(dir, 'state.json');
    assert.ok(existsSync(file), `state.json is gone after a kill at ${delay}ms`);
    const text = readFileSync(file, 'utf8');
    let parsed: RunState;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(text) as RunState;
    }, `state.json did not parse after a kill at ${delay}ms (${text.length} bytes)`);

    // Whole, not merely parseable: the marker has to be one of the two the
    // helper writes, never a splice of both.
    parsed = JSON.parse(text) as RunState;
    assert.ok(
      parsed.task === 'A' || parsed.task === 'B',
      `recovered a state that was neither write, at ${delay}ms: ${String(parsed.task)}`,
    );
  }
});

/**
 * The same promise for artifacts, and a different failure to catch.
 *
 * state.json's was tearing. An artifact's is emptiness: `writeFileSync` opens
 * `O_TRUNC`, so the file is zeroed at open and a kill in that window leaves no
 * bytes at all. It is also far more common than tearing - 5 kills in 40 at a
 * lifelike 17KB, measured against `develop` at `99eca2e` - and the file it hurts
 * most is `OUTSTANDING.md`, which `recoverOutstanding` skips on `existsSync` and
 * `settlePendingOutstanding` skips for want of its marker, so an empty one is
 * never repaired by either (#88).
 *
 * Hence equality against a whole body rather than a marker check: a markdown
 * artifact has no parse step, so "exists and mentions A or B" passes against a
 * zero-byte file, which is the whole defect.
 */
test('an artifact write killed at any point leaves a whole file', async () => {
  // Spread across the write loop, not aimed: same reasoning as the state.json
  // sweep. A fresh directory and a fresh child per delay because SIGKILL ends
  // the child - one cannot serve two kill points.
  //
  // Sixty rather than the state.json sweep's twenty-four, and the count was
  // measured rather than chosen. Against develop's truncating `artifact()` on
  // this machine a kill damaged the file 5 times in 120 - 4.2% each, well under
  // the 12.5% the issue recorded elsewhere - which would have left twenty-four
  // kills failing to notice the defect about a third of the time. At sixty the
  // chance of a silent pass is ~8%, for ~8s. The modulo repeats the phase sweep
  // twice: the window is a fraction of one write, so what raises detection is
  // the number of kills, not how far out in time they are aimed.
  const delays = Array.from({ length: 60 }, (_, i) => (i % 30) * 1.7 + 2);

  for (const delay of delays) {
    const targetDir = scratch();
    const { child, dir } = await start(targetDir, 'artifact');
    await sleep(delay);
    await killed(child);

    const file = path.join(dir, 'PLAN.md');
    // The first write completes before the child says `ready`, so an absent
    // file is a real failure rather than a kill that arrived early.
    assert.ok(existsSync(file), `PLAN.md is gone after a kill at ${delay}ms`);
    const text = readFileSync(file, 'utf8');
    assert.ok(
      text === ARTIFACT_BODY_A || text === ARTIFACT_BODY_B,
      `recovered an artifact that was neither write, at ${delay}ms (${text.length} bytes)`,
    );
  }
});

test('a completed write leaves no temp file behind', () => {
  const targetDir = scratch();
  const state = createRun(targetDir, 'temp files', true);
  saveState(state);
  saveState(state);
  // Artifacts go through the same atomic write since #88, so they have the same
  // obligation to leave nothing behind.
  artifact(state, 'PLAN.md', ARTIFACT_BODY_A);
  artifact(state, 'PLAN.md', ARTIFACT_BODY_B);

  const stray = readdirSync(state.dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(stray, []);
});

/**
 * The other window the same kill exposed, one layer up.
 *
 * `vibe run` used to create the run, then save the config, then save the extra
 * context - three writes, each of them whole. A kill in either gap left a
 * perfectly loadable state.json with no config and no context, and the resume
 * after it silently ran on current defaults and dropped the context file the
 * user had passed. Atomicity cannot help with that: the fix is that allocation
 * and initialisation are separate, and the first state written is complete.
 */
test('a run killed after allocation and before initialisation leaves no state at all', async () => {
  const targetDir = scratch();
  // Killed without ever being told to proceed, so the child provably never
  // reached `createRun`. This is the deterministic half: allocation writes a
  // directory and nothing else, so there is no half-configured run to resume.
  const { child, dir } = await start(targetDir, 'alloc');
  await killed(child);

  assert.ok(existsSync(dir), 'the run directory should have been allocated');
  assert.equal(
    existsSync(path.join(dir, 'state.json')),
    false,
    'allocation alone must persist no state',
  );
});

test('a run killed during its first state write keeps all of its config and context, or none of it', async () => {
  // Spread across the first write, which is the window the old three-write
  // start-up left open: a kill between them produced a loadable state.json with
  // no config and no context, and the resume after it ran on the defaults and
  // dropped the user's brief.
  const delays = Array.from({ length: 16 }, (_, i) => i * 1.5);

  for (const delay of delays) {
    const targetDir = scratch();
    const { child, dir } = await start(targetDir, 'alloc');
    child.stdin.write('go\n');
    await sleep(delay);
    await killed(child);

    const file = path.join(dir, 'state.json');
    if (!existsSync(file)) continue; // Killed before the write reached the disk.

    const text = readFileSync(file, 'utf8');
    let parsed: Partial<RunState> = {};
    assert.doesNotThrow(() => {
      parsed = JSON.parse(text) as Partial<RunState>;
    }, `state.json did not parse after a kill at ${delay}ms (${text.length} bytes)`);
    parsed = JSON.parse(text) as Partial<RunState>;

    // Both, or the state would not have existed: they go in the same write.
    assert.equal(
      parsed.config?.claude.model,
      ALLOC_MODEL,
      `a state written by a kill at ${delay}ms lost its config`,
    );
    assert.ok(
      (parsed.extraContext ?? '').startsWith(ALLOC_CONTEXT_PREFIX),
      `a state written by a kill at ${delay}ms lost its context`,
    );
  }
});

/**
 * The other half of the same promise, one step earlier: a run that is refused
 * before anything is created leaves nothing to clean up. Driven through `main`
 * rather than `cmdRun` because the ordering being asserted - read the context
 * file, then allocate - is a property of the command, not of a helper.
 */
test('a missing --context file is refused before any run directory exists', async () => {
  const targetDir = scratch();
  const missing = path.join(targetDir, 'no-such-brief.md');

  const code = await main(['run', 'a task', '-C', targetDir, '--context', missing]);

  assert.equal(code, EXIT.ERROR);
  assert.equal(
    existsSync(path.join(targetDir, '.vibe', 'runs')),
    false,
    'nothing may be created before the context file is known to exist',
  );
});

test("a run's first state carries its config and its context", () => {
  const targetDir = scratch();
  const state = createRun(targetDir, 'first write', true, {
    config: { claude: { model: 'opus' } } as unknown as RunState['config'],
    extraContext: 'the brief',
  });

  // Read from disk, not from the object: the claim is about what a killed
  // process would have left, which is whatever the first save put there.
  const onDisk = JSON.parse(
    readFileSync(path.join(state.dir, 'state.json'), 'utf8'),
  ) as Partial<RunState>;
  assert.equal(onDisk.extraContext, 'the brief');
  assert.equal(onDisk.config?.claude.model, 'opus');
});
