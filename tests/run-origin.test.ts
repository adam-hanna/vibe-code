import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { execute, main, recordRunOrigin } from '@src/cli.js';
import { detectCliVersions, resetCliProbes } from '@src/cliversions.js';
import { setSink } from '@src/log.js';
import type { Narration } from '@src/log.js';
import { decode } from '@src/protocol.js';
import type { Outbound } from '@src/protocol.js';
import { createRun, saveState } from '@src/run.js';
import { createSession } from '@src/serve.js';
import type { RunFn } from '@src/proc.js';
import type { RunState } from '@src/types.js';
import { initGit } from './helpers/loop-harness.js';

/**
 * Who started a run, when a client says (#354).
 *
 * A phone will be a second client of the service host, and the desktop's
 * bridge will stamp `origin: "phone:<name>"` on everything it sends. An invoke
 * that carries a readable origin leaves one `run_origin` row in the run's
 * events - the carve-out `gate_released` already takes from `recordAndSay`'s
 * durability rule - and one that does not leaves nothing at all, so a run from
 * the desktop window or the CLI writes a `state.json` byte-identical to before.
 */

const line = (v: unknown): string => JSON.stringify(v);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

const stateBytes = (state: RunState): string => readFileSync(path.join(state.dir, 'state.json'), 'utf8');
const origins = (state: RunState) => state.events.filter((e) => e.type === 'run_origin');

function fresh(prefix: string): { targetDir: string; state: RunState } {
  const targetDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  initGit(targetDir);
  return { targetDir, state: createRun(targetDir, 'origin', false) };
}

async function quiet<T>(body: () => Promise<T>): Promise<T> {
  const realLog = console.log;
  const realError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    return await body();
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

/** A preflight that passes and a loop that does nothing: only the origin step is left. */
const run = (state: RunState, resume: boolean, origin?: string | null) =>
  quiet(() =>
    origin === undefined
      ? execute(state, DEFAULTS, resume, true, () => Promise.resolve(null), () => Promise.resolve())
      : execute(state, DEFAULTS, resume, true, () => Promise.resolve(null), () => Promise.resolve(), undefined, origin),
  );

test('an invoke decodes a readable origin, and drops one it cannot read without refusing', () => {
  const got = decode(line({ type: 'invoke', id: 1, argv: ['run', 'x'], origin: ' phone:pixel ' }));
  assert.deepEqual(got, { ok: true, message: { type: 'invoke', id: 1, argv: ['run', 'x'], origin: 'phone:pixel' } });

  for (const origin of ['', '   ', 'x'.repeat(41), 7, null, { name: 'phone' }]) {
    const dropped = decode(line({ type: 'invoke', id: 2, argv: ['run', 'x'], origin }));
    assert.deepEqual(dropped, { ok: true, message: { type: 'invoke', id: 2, argv: ['run', 'x'] } }, JSON.stringify(origin));
  }
  // Exactly the limit is still a name.
  const forty = decode(line({ type: 'invoke', id: 3, argv: [], origin: 'x'.repeat(40) }));
  assert.equal(forty.ok && forty.message.type === 'invoke' ? forty.message.origin : null, 'x'.repeat(40));
});

test('a config read carries no origin; a write does', () => {
  assert.deepEqual(decode(line({ type: 'config', id: 1, dir: '/r', origin: 'phone:x' })), {
    ok: true,
    message: { type: 'config', id: 1, dir: '/r' },
  });
  assert.deepEqual(decode(line({ type: 'config', id: 2, dir: '/r', patch: {}, scope: 'global', origin: 'phone:x' })), {
    ok: true,
    message: { type: 'config', id: 2, dir: '/r', patch: {}, scope: 'global', origin: 'phone:x' },
  });
});

test('the host hands the origin to the run beside the argv, never inside it', async () => {
  const cases: [unknown, string | null][] = [
    ['phone:x', 'phone:x'],
    [undefined, null],
    ['', null],
    ['x'.repeat(41), null],
    [7, null],
  ];
  for (const [given, expected] of cases) {
    const sent: Outbound[] = [];
    const seen: { argv: readonly string[]; origin: string | null }[] = [];
    const session = createSession((m) => void sent.push(m), {
      invoke: (argv, _loop, origin) => {
        seen.push({ argv, origin });
        return Promise.resolve(0);
      },
    });
    session.receive(line({ type: 'invoke', id: 4, argv: ['run', 'x'], ...(given === undefined ? {} : { origin: given }) }));
    await tick();
    assert.deepEqual(seen, [{ argv: ['run', 'x'], origin: expected }], JSON.stringify(given));
    // It still ran: an unreadable label is never a reason to refuse.
    assert.deepEqual(sent, [{ type: 'result', id: 4, exit: 0 }], JSON.stringify(given));
  }
});

test('an invoke with an origin records one row naming it, durably, and says it once', async () => {
  const { state } = fresh('vibe-origin-row-');
  const said: Narration[] = [];
  setSink((n) => said.push(n));
  try {
    await run(state, false, 'phone:pixel');
  } finally {
    setSink(null);
  }
  assert.equal(origins(state).length, 1);
  assert.equal(origins(state)[0]?.['origin'], 'phone:pixel');
  const onDisk = (JSON.parse(stateBytes(state)) as { events: { type: string; origin?: string }[] }).events;
  assert.deepEqual(
    onDisk.filter((e) => e.type === 'run_origin').map((e) => e.origin),
    ['phone:pixel'],
  );
  assert.equal(said.filter((n) => n.id === 'run_origin').length, 1);
});

test('a resume and an --implement record their own row, once per invoke', async () => {
  // `execute` is the one place every road reaches - the fresh start, both
  // resume branches and `--implement`, which is a resume - so a resume is an
  // `execute` with `resume` set, and each invoke records its own.
  const { state } = fresh('vibe-origin-resume-');
  await run(state, false, 'phone:a');
  await run(state, true, 'phone:b');
  assert.deepEqual(origins(state).map((e) => e['origin']), ['phone:a', 'phone:b']);
});

test('no origin leaves state.json byte-identical, and the event sequence untouched', async () => {
  const { state } = fresh('vibe-origin-none-');
  const before = stateBytes(state);
  recordRunOrigin(state, null);
  assert.equal(stateBytes(state), before);

  const a = fresh('vibe-origin-omit-').state;
  const b = fresh('vibe-origin-null-').state;
  await run(a, false);
  await run(b, false, null);
  const types = (s: RunState) => s.events.map((e) => e.type);
  assert.deepEqual(types(a), types(b));
  assert.equal(types(a).includes('run_origin'), false);
});

test("main threads the origin through a resume, and the CLI's own call records nothing", async () => {
  // A finished run: the resume says `run_started` and has nothing to do, so no
  // probe and no turn runs - the same arrangement `cli-versions-state` uses.
  resetCliProbes();
  const fake: RunFn = (bin) =>
    Promise.resolve({ code: 0, signal: null, stdout: bin === 'c' ? '2.1.294 (Claude Code)' : 'codex-cli 0.157.1', stderr: '' });
  await detectCliVersions(fake, { claude: () => 'c', codex: () => 'x' });
  try {
    for (const [origin, expected] of [['phone:pixel', ['phone:pixel']], [null, []]] as const) {
      const targetDir = mkdtempSync(path.join(os.tmpdir(), 'vibe-origin-main-'));
      const state = createRun(targetDir, 'origin', false);
      state.status = 'done';
      state.phase = 'complete';
      saveState(state);
      await quiet(() =>
        origin === null
          ? main(['resume', state.id, '-C', targetDir, '--no-progress'])
          : main(['resume', state.id, '-C', targetDir, '--no-progress'], undefined, origin),
      );
      const events = (JSON.parse(stateBytes(state)) as { events: { type: string; origin?: string }[] }).events;
      assert.deepEqual(
        events.filter((e) => e.type === 'run_origin').map((e) => e.origin),
        [...expected],
        String(origin),
      );
    }
  } finally {
    resetCliProbes();
  }
});
