import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '@src/cli.js';
import { detectCliVersions, resetCliProbes } from '@src/cliversions.js';
import { setSink } from '@src/log.js';
import type { Narration } from '@src/log.js';
import type { RunFn } from '@src/proc.js';
import { createRun, saveState } from '@src/run.js';
import type { RunState } from '@src/types.js';

/**
 * `run_started` says who asked for the run, when somebody said (#365).
 *
 * #354 records an invoke's origin as `run_origin` and #344 draws a phone's
 * gate answers, but the frame a window builds a run's identity from carried no
 * origin - so *Started from <phone>* had nothing to be drawn from. It now
 * carries `origin` exactly when the invoke had a readable one and omits the key
 * otherwise, `gate_released`'s rule: no field, never a placeholder.
 *
 * Both resume paths are driven through `main` on a finished run, the
 * arrangement `run-origin.test.ts` and `cli-versions-state.test.ts` use: the
 * resume says `run_started` and then has nothing to do, so no turn runs. The
 * fresh start is pinned by source in `app/src/cockpit/contract.test.ts`, since
 * reaching it here would need real agents.
 */

async function primeVersions(): Promise<void> {
  // Detection is read once per process; a fake here means nothing real spawns.
  resetCliProbes();
  const fake: RunFn = (bin) =>
    Promise.resolve({ code: 0, signal: null, stdout: bin === 'c' ? '2.1.294 (Claude Code)' : 'codex-cli 0.157.1', stderr: '' });
  await detectCliVersions(fake, { claude: () => 'c', codex: () => 'x' });
}

function finished(prefix: string): { targetDir: string; state: RunState } {
  const targetDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const state = createRun(targetDir, 'started from', false);
  state.status = 'done';
  state.phase = 'complete';
  saveState(state);
  return { targetDir, state };
}

/** Resume through `main`, and hand back the `run_started` it said. */
async function resumed(targetDir: string, state: RunState, origin: string | null): Promise<Narration> {
  const seen: Narration[] = [];
  setSink((n) => void seen.push(n));
  const realLog = console.log;
  const realError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    const argv = ['resume', state.id, '-C', targetDir, '--no-progress'];
    await (origin === null ? main(argv) : main(argv, undefined, origin));
  } finally {
    console.log = realLog;
    console.error = realError;
    setSink(null);
  }
  const started = seen.filter((n) => n.id === 'run_started');
  assert.equal(started.length, 1, 'one run_started per invoke');
  return started[0] as Narration;
}

test('a resume a phone asked for says its origin on run_started', async () => {
  await primeVersions();
  try {
    const { targetDir, state } = finished('vibe-started-phone-');
    const started = await resumed(targetDir, state, "phone:Adam's iPhone");
    assert.equal(started.data?.['origin'], "phone:Adam's iPhone");
    // The identity fields are untouched beside it.
    assert.equal(started.data?.['runId'], state.id);
    assert.equal(started.data?.['resumed'], true);
  } finally {
    resetCliProbes();
  }
});

test('a resume with no origin carries no origin key at all, not a null', async () => {
  // The window's own invokes, the CLI's and an unreadable label all arrive
  // here as null (`readOrigin`), and none of them may draw anything new.
  await primeVersions();
  try {
    const { targetDir, state } = finished('vibe-started-none-');
    const started = await resumed(targetDir, state, null);
    assert.ok(started.data !== undefined && started.data !== null);
    assert.equal(Object.hasOwn(started.data, 'origin'), false);
  } finally {
    resetCliProbes();
  }
});

test('the resume that retires a findings stall carries it too', async () => {
  // The second resume site: a `NEEDS-INPUT.md` with no answer blocks is a
  // round-cap stall, renamed and resumed on its own `run_started`.
  await primeVersions();
  try {
    for (const origin of ['phone:Pixel', null] as const) {
      const { targetDir, state } = finished('vibe-started-stall-');
      writeFileSync(path.join(state.dir, 'NEEDS-INPUT.md'), '# Needs input\n\nThe round cap was reached.\n');
      const started = await resumed(targetDir, state, origin);
      assert.ok(started.data !== undefined && started.data !== null);
      if (origin === null) assert.equal(Object.hasOwn(started.data, 'origin'), false);
      else assert.equal(started.data['origin'], origin);
      // It really was the stall path: the file was retired.
      assert.throws(() => readFileSync(path.join(state.dir, 'NEEDS-INPUT.md')));
    }
  } finally {
    resetCliProbes();
  }
});

test('the origin is still recorded once, as run_origin, and not a second time', async () => {
  // The decision #365 took: `run_started` is narration and records nothing,
  // so the durable fact stays `run_origin`'s one row per invoke (#354).
  await primeVersions();
  try {
    const { targetDir, state } = finished('vibe-started-record-');
    await resumed(targetDir, state, 'phone:Pixel');
    const events = (JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as {
      events: { type: string; origin?: string }[];
    }).events;
    assert.deepEqual(
      events.filter((e) => e.origin !== undefined).map((e) => [e.type, e.origin]),
      [['run_origin', 'phone:Pixel']],
    );
  } finally {
    resetCliProbes();
  }
});
