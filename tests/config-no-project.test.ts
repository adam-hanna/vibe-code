import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decode } from '@src/protocol.js';
import { createSession } from '@src/serve.js';
import { DEFAULTS, writeConfigPatch } from '@src/config.js';
import type { Outbound } from '@src/protocol.js';

/**
 * The settings for all projects, on an install with no project (#385).
 *
 * The left bar's ⚙ read its frame with `dir: ''` on a machine that had never
 * added a repository, the decoder refused it as `config carried no dir`, and the
 * screen drew that sentence and nothing settable - not a key, not remote
 * access. The global view only ever needed the global fields. These cases pin
 * the line: a global read or write may name no project, a project one may not.
 *
 * Each case that touches disk points `VIBE_GLOBAL_CONFIG` at a file of its own
 * and puts it back, as `global-config.test.ts` does.
 */

const line = (v: unknown): string => JSON.stringify(v);

function scratchGlobal(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibe-noproject-'));
  return path.join(root, 'home', 'vibe', 'config.json');
}

function withGlobal<T>(at: string, body: () => T): T {
  const before = process.env['VIBE_GLOBAL_CONFIG'];
  process.env['VIBE_GLOBAL_CONFIG'] = at;
  try {
    return body();
  } finally {
    if (before === undefined) delete process.env['VIBE_GLOBAL_CONFIG'];
    else process.env['VIBE_GLOBAL_CONFIG'] = before;
  }
}

test('a global read may name no project, by an absent dir or an empty one', () => {
  for (const frame of [
    { type: 'config', id: 1, scope: 'global' },
    { type: 'config', id: 1, scope: 'global', dir: '' },
  ]) {
    const got = decode(line(frame));
    assert.equal(got.ok, true, `${line(frame)} was refused`);
    if (!got.ok) continue;
    assert.deepEqual(got.message, { type: 'config', id: 1, dir: null, scope: 'global' });
  }
});

test('a project read or write with no dir is still refused', () => {
  // No scope is the project, which is what every window before the global
  // layer sent, so it is refused exactly as it always was.
  for (const frame of [
    { type: 'config', id: 1, dir: '' },
    { type: 'config', id: 1 },
    { type: 'config', id: 1, dir: '', scope: 'project' },
    { type: 'config', id: 1, dir: '', patch: { loop: { maxPlanRounds: 4 } } },
    { type: 'config', id: 1, patch: { loop: { maxPlanRounds: 4 } }, scope: 'project' },
  ]) {
    const got = decode(line(frame));
    assert.equal(got.ok, false, `${line(frame)} was accepted`);
    if (got.ok) continue;
    assert.equal(got.reason, 'config carried no dir');
  }
});

test('a dir of the wrong type is refused even in the global scope', () => {
  // A malformed frame is not an absent project.
  const got = decode(line({ type: 'config', id: 1, scope: 'global', dir: 7 }));
  assert.equal(got.ok, false);
});

test('a read with a scope this build does not know is refused rather than ignored', () => {
  const got = decode(line({ type: 'config', id: 1, dir: '/repo', scope: 'everywhere' }));
  assert.equal(got.ok, false);
});

test('a project read is decoded exactly as before', () => {
  const got = decode(line({ type: 'config', id: 1, dir: '/repo' }));
  assert.equal(got.ok, true);
  if (got.ok) assert.deepEqual(got.message, { type: 'config', id: 1, dir: '/repo' });
});

test('a global write may name no project', () => {
  const got = decode(line({ type: 'config', id: 1, scope: 'global', patch: { loop: { maxPlanRounds: 4 } } }));
  assert.equal(got.ok, true);
  if (got.ok) {
    assert.deepEqual(got.message, {
      type: 'config',
      id: 1,
      dir: null,
      scope: 'global',
      patch: { loop: { maxPlanRounds: 4 } },
    });
  }
});

test('the host answers a global read with no project, and reads no project to do it', () => {
  const global = scratchGlobal();
  withGlobal(global, () => {
    writeConfigPatch(null, { loop: { maxPlanRounds: 9 } }, 'global');
    const sent: Outbound[] = [];
    const session = createSession((m) => void sent.push(m), {
      invoke: () => Promise.resolve(0),
      config: () => {
        throw new Error('a project was read for a read that named none');
      },
    });
    session.receive(line({ type: 'config', id: 1, scope: 'global' }));

    const reply = sent[0];
    assert.equal(reply?.type, 'config', JSON.stringify(sent));
    if (reply?.type !== 'config') return;
    // The project's fields are null: no file was read, and `{}` would claim one.
    assert.equal(reply.dir, null);
    assert.equal(reply.effective, null);
    assert.equal(reply.raw, null);
    assert.equal(reply.path, null);
    // Everything the global view draws is there.
    assert.equal(reply.globalPath, global);
    assert.deepEqual(reply.globalRaw, { loop: { maxPlanRounds: 9 } });
    const effective = reply.globalEffective as { loop: { maxPlanRounds: number; maxReviewRounds: number } };
    assert.equal(effective.loop.maxPlanRounds, 9);
    assert.equal(effective.loop.maxReviewRounds, DEFAULTS.loop.maxReviewRounds);
    assert.ok(reply.gateable.length > 0);
  });
});

test('a global write with no project is validated alone, and refused alone', () => {
  const global = scratchGlobal();
  withGlobal(global, () => {
    assert.throws(() => writeConfigPatch(null, { loop: { maxPlanRounds: -1 } }, 'global'));
    assert.equal(existsSync(global), false, 'an invalid write left a file');

    const wrote = writeConfigPatch(null, { budget: { maxTokens: 30_000_000 } }, 'global');
    assert.equal(wrote.path, global);
    assert.deepEqual(JSON.parse(readFileSync(global, 'utf8')), { budget: { maxTokens: 30_000_000 } });

    // The rules that refuse a key in the global file still apply with no
    // project in front of it.
    assert.throws(
      () => writeConfigPatch(null, { verify: { command: 'make test' } }, 'global'),
      /only a project's own vibe\.config\.json can/,
    );
  });
});

test('a project write with no project is refused before anything is read', () => {
  assert.throws(() => writeConfigPatch(null, { loop: { maxPlanRounds: 4 } }, 'project'), /directory/);
});

test('the host writes a global patch with no project and announces it as global', () => {
  const global = scratchGlobal();
  withGlobal(global, () => {
    const sent: Outbound[] = [];
    const session = createSession((m) => void sent.push(m), {
      invoke: () => Promise.resolve(0),
      config: () => {
        throw new Error('a project was read for a write that named none');
      },
    });
    session.receive(
      line({ type: 'config', id: 1, scope: 'global', patch: { loop: { maxPlanRounds: 7 } }, origin: 'phone:x' }),
    );

    const reply = sent.find((m) => m.type === 'config');
    assert.ok(reply !== undefined, JSON.stringify(sent));
    if (reply?.type !== 'config') return;
    assert.equal(reply.dir, null);
    assert.deepEqual(reply.globalRaw, { loop: { maxPlanRounds: 7 } });
    assert.deepEqual(
      sent.find((m) => m.type === 'changed'),
      { type: 'changed', what: 'config', key: 'global', id: 1, origin: 'phone:x' },
    );
  });
});

test('a global write with no project is still refused while a run is going', async () => {
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => new Promise<number>(() => undefined),
    writeConfig: () => {
      throw new Error('a write should not have been attempted');
    },
  });
  session.receive(line({ type: 'invoke', id: 1, argv: ['run', 'x'] }));
  await new Promise<void>((r) => setImmediate(r));

  session.receive(line({ type: 'config', id: 2, scope: 'global', patch: { loop: { maxPlanRounds: 4 } } }));
  const refusal = sent.find((m) => m.type === 'error' && m.id === 2);
  assert.match(refusal?.type === 'error' ? refusal.message : '', /still running/);
});
