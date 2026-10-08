import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { decode } from '@src/protocol.js';
import { RUNS_DIR } from '@src/run.js';
import { scoreArchive } from '@src/scorecard.js';
import { createSession } from '@src/serve.js';
import type { Outbound } from '@src/protocol.js';

/**
 * The scorecard over the wire (#114) - the ninth read frame.
 *
 * Its own frame rather than a field on `archive`, because the sidebar asks for
 * `archive` every time a project section opens and scoring reads every
 * state.json. What it shares with `archive` is the reason it may run beside a
 * run: it never writes, so the one-at-a-time rule - about runs interleaving
 * their narration - has nothing to protect.
 */

const line = (v: unknown): string => JSON.stringify(v);
const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const s = statSync(full);
        out.push(`${path.relative(root, full)} ${s.size} ${s.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

test('a stats frame decodes, and a missing dir is refused rather than defaulted', () => {
  assert.equal(decode(line({ type: 'stats', id: 1, dir: 'C:/repo' })).ok, true);
  // An empty dir would score the host's own cwd: another repository's archive
  // presented as this one's.
  for (const bad of ['', undefined, 7]) {
    assert.equal(decode(line({ type: 'stats', id: 1, dir: bad })).ok, false, `dir ${String(bad)} was accepted`);
  }
});

test('it is answered while a run is going, and a second run is still refused', async () => {
  const sent: Outbound[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-stats-frame-'));
  const session = createSession((m) => void sent.push(m), {
    invoke: () => new Promise<number>(() => undefined),
    stats: scoreArchive,
  });
  session.receive(line({ type: 'invoke', id: 1, argv: ['run', 'x'] }));
  session.receive(line({ type: 'stats', id: 2, dir }));
  await settle();

  assert.equal(sent.some((m) => m.type === 'error'), false, 'stats was refused while a run was going');
  const reply = sent.find((m) => m.type === 'stats');
  assert.ok(reply !== undefined && reply.type === 'stats');
  assert.equal(reply.id, 2);
  assert.equal(reply.dir, dir);
  assert.equal(reply.scorecard.archive.entries, 0);

  session.receive(line({ type: 'invoke', id: 3, argv: ['run', 'y'] }));
  await settle();
  assert.equal(sent.some((m) => m.type === 'error' && m.id === 3), true);
});

test('a scorer that threw becomes an error, never silence', async () => {
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => Promise.resolve(0),
    stats: () => {
      throw new Error('disk on fire');
    },
  });
  session.receive(line({ type: 'stats', id: 4, dir: 'C:/repo' }));
  await settle();
  assert.deepEqual(sent, [{ type: 'error', id: 4, message: 'disk on fire' }]);
});

test('answering it leaves every byte under .vibe/runs as it was', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-stats-frame-nowrite-'));
  const runDir = path.join(dir, RUNS_DIR, 'a');
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    path.join(runDir, 'state.json'),
    JSON.stringify({
      status: 'done',
      planRound: 2,
      events: [{ at: new Date().toISOString(), type: 'codex_turn', label: 'critique-0', tokens: 40 }],
    }),
  );
  const root = path.join(dir, RUNS_DIR);
  const before = snapshot(root);

  const sent: Outbound[] = [];
  // No `stats` dep: the real default answers.
  const session = createSession((m) => void sent.push(m), { invoke: () => Promise.resolve(0) });
  session.receive(line({ type: 'stats', id: 5, dir }));
  await settle();

  const reply = sent.find((m) => m.type === 'stats');
  assert.ok(reply !== undefined && reply.type === 'stats');
  assert.deepEqual(reply.scorecard.turns.byKind, { critique: { turns: 1, median: 40, p90: 40 } });
  assert.deepEqual(snapshot(root), before);
});
