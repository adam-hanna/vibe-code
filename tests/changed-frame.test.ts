import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { createSession } from '@src/serve.js';
import type { SessionDeps } from '@src/serve.js';
import type { Outbound } from '@src/protocol.js';

/**
 * Every write is announced to every client (#354).
 *
 * A phone is about to become a second client of the service host, beside the
 * window, and each keeps a cache in front of what it reads. Without a signal, a
 * phone's save would be overwritten by the window's stale cache on its next
 * save. So the three writes - `memory_save`, `chat_save` and a config patch -
 * each say `changed` once the file is on disk, after the write's own reply,
 * and nothing else does: not a read, not a refusal, not a failed write.
 */

const line = (v: unknown): string => JSON.stringify(v);
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function session(deps: SessionDeps = {}): { sent: Outbound[]; receive: (v: unknown) => void } {
  const sent: Outbound[] = [];
  const s = createSession((m) => void sent.push(m), { invoke: () => Promise.resolve(0), ...deps });
  return { sent, receive: (v) => s.receive(line(v)) };
}

type Changed = Extract<Outbound, { type: 'changed' }>;
const changes = (sent: readonly Outbound[]): Changed[] => sent.filter((m): m is Changed => m.type === 'changed');

/** Run the body with the app's data directory pointed somewhere of its own. */
async function withAppData(body: () => Promise<void>): Promise<void> {
  const before = process.env['VIBE_APP_DATA'];
  process.env['VIBE_APP_DATA'] = mkdtempSync(path.join(tmpdir(), 'vibe-changed-'));
  try {
    await body();
  } finally {
    if (before === undefined) delete process.env['VIBE_APP_DATA'];
    else process.env['VIBE_APP_DATA'] = before;
  }
}

/** A config seam whose writes succeed and say where they went. */
const configured: SessionDeps = {
  writeConfig: () => ({ path: '/repo/vibe.config.json' }),
  config: () => ({ ...DEFAULTS, configPath: '/repo/vibe.config.json', findersDefaulted: false }),
};

test('a memory save, value or deletion, announces itself once, after its reply', async () => {
  await withAppData(async () => {
    for (const [id, value] of [[3, '["/r"]'], [4, null]] as const) {
      const { sent, receive } = session();
      receive({ type: 'memory_save', id, key: 'vibe.projects', value });
      await tick();
      assert.deepEqual(changes(sent), [{ type: 'changed', what: 'memory', key: 'vibe.projects', id }]);
      // After the reply, so a writer's own promise has settled before its echo.
      assert.deepEqual(sent.map((m) => m.type), ['memory_saved', 'changed']);
    }
  });
});

test('a chat save, value or deletion, announces itself once, after its reply', async () => {
  await withAppData(async () => {
    for (const [id, value] of [[5, '{"replies":[]}'], [6, null]] as const) {
      const { sent, receive } = session();
      receive({ type: 'chat_save', id, key: 'vibe.chat./r::none', value });
      await tick();
      assert.deepEqual(changes(sent), [{ type: 'changed', what: 'chat', key: 'vibe.chat./r::none', id }]);
      assert.deepEqual(sent.map((m) => m.type), ['chat_saved', 'changed']);
    }
  });
});

test('a config write names the project directory as sent, or "global"', () => {
  const project = session(configured);
  project.receive({ type: 'config', id: 7, dir: 'C:\\Repo\\', patch: { gates: {} } });
  assert.deepEqual(project.sent.map((m) => m.type), ['config', 'changed']);
  // Exactly as the frame named it: comparing directories is the window's job.
  assert.deepEqual(changes(project.sent), [{ type: 'changed', what: 'config', key: 'C:\\Repo\\', id: 7 }]);

  const global = session(configured);
  global.receive({ type: 'config', id: 8, dir: '/repo', patch: { gates: {} }, scope: 'global' });
  assert.deepEqual(changes(global.sent), [{ type: 'changed', what: 'config', key: 'global', id: 8 }]);
});

test('reads, refusals and a save with nowhere to go announce nothing', async () => {
  await withAppData(async () => {
    const reads = session(configured);
    reads.receive({ type: 'config', id: 1, dir: '/repo' });
    reads.receive({ type: 'memory', id: 2 });
    reads.receive({ type: 'chats', id: 3 });
    await tick();
    assert.deepEqual(changes(reads.sent), []);
    assert.equal(reads.sent.length, 3, JSON.stringify(reads.sent));
  });

  const refused = session({
    config: () => ({ ...DEFAULTS, configPath: null, findersDefaulted: false }),
    writeConfig: () => {
      throw new Error('gates["plan-round"] must be one of auto, step, stop');
    },
  });
  refused.receive({ type: 'config', id: 4, dir: '/repo', patch: { gates: { 'plan-round': 'x' } } });
  assert.deepEqual(refused.sent.map((m) => m.type), ['error']);

  // Refused while a run is going, before anything was written.
  const busy = session({
    ...configured,
    invoke: () => new Promise<number>(() => undefined),
    writeConfig: () => {
      throw new Error('a write should not have been attempted');
    },
  });
  busy.receive({ type: 'invoke', id: 5, argv: ['run', 'x'] });
  await tick();
  busy.receive({ type: 'config', id: 6, dir: '/repo', patch: { gates: {} } });
  assert.deepEqual(changes(busy.sent), []);
  assert.ok(busy.sent.some((m) => m.type === 'error' && m.id === 6));

  const before = process.env['VIBE_APP_DATA'];
  delete process.env['VIBE_APP_DATA'];
  try {
    const homeless = session();
    homeless.receive({ type: 'memory_save', id: 7, key: 'vibe.projects', value: '[]' });
    homeless.receive({ type: 'chat_save', id: 8, key: 'vibe.chat./r::none', value: '{}' });
    await tick();
    assert.deepEqual(homeless.sent.map((m) => m.type), ['error', 'error']);
  } finally {
    if (before !== undefined) process.env['VIBE_APP_DATA'] = before;
  }
});

test('a write that landed and then could not be read back is still announced, after the error', () => {
  // The file was renamed into place before the read failed, so other clients'
  // caches are stale whatever the writer was told.
  const { sent, receive } = session({
    writeConfig: () => ({ path: '/repo/vibe.config.json' }),
    config: () => {
      throw new Error('vibe.config.json could not be read');
    },
  });
  receive({ type: 'config', id: 9, dir: '/repo', patch: { gates: {} }, origin: 'phone:x' });
  assert.deepEqual(sent, [
    { type: 'error', id: 9, message: 'vibe.config.json could not be read' },
    { type: 'changed', what: 'config', key: '/repo', id: 9, origin: 'phone:x' },
  ]);
});

test("a config write's origin travels on changed, and only a readable one", () => {
  const good = session(configured);
  good.receive({ type: 'config', id: 1, dir: '/repo', patch: { gates: {} }, origin: ' phone:x ' });
  assert.equal(changes(good.sent)[0]?.origin, 'phone:x');

  for (const origin of ['x'.repeat(41), '', 7]) {
    const bad = session(configured);
    bad.receive({ type: 'config', id: 2, dir: '/repo', patch: { gates: {} }, origin });
    const [changed] = changes(bad.sent);
    assert.ok(changed, `still written and announced for ${JSON.stringify(origin)}`);
    assert.equal('origin' in changed, false, JSON.stringify(origin));
  }
});

test("a config write's origin is written nowhere on disk", () => {
  // The real writer, into a repository of its own: `vibe.config.json` is a
  // committed file and must not gain a field for who saved it.
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-changed-config-'));
  const { sent, receive } = session();
  receive({ type: 'config', id: 1, dir, patch: { gates: { 'plan-round': 'auto' } }, origin: 'phone:x' });
  assert.equal(changes(sent)[0]?.origin, 'phone:x', JSON.stringify(sent.filter((m) => m.type === 'error')));
  const written = readFileSync(path.join(dir, 'vibe.config.json'), 'utf8');
  assert.match(written, /plan-round/);
  assert.doesNotMatch(written, /origin/);
  assert.doesNotMatch(written, /phone/);
});
