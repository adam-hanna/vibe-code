import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listRuns, RUNS_DIR } from '@src/run.js';
import { createSession } from '@src/serve.js';
import type { Outbound } from '@src/protocol.js';
import type { RunSummary } from '@src/types.js';
import { JUNCTION_SKIP, linkDir } from './helpers/links.js';

/**
 * The rounds fingerprint on every listed run (#114).
 *
 * The design's `p2 v1 r2` column needs four counters per run, and they are in
 * the state.json `listRuns` already parses for the row - so they ride on
 * `RunSummary` from that one read, and the `archive` frame carries them with no
 * second route. The claims worth pinning are the two that would otherwise be
 * invented: a counter a run never recorded is `null` rather than 0, and an entry
 * nothing was read from carries no fingerprint at all.
 */

function archive(runs: Record<string, Record<string, unknown> | string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-fingerprint-'));
  for (const [id, body] of Object.entries(runs)) {
    const runDir = path.join(dir, RUNS_DIR, id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, 'state.json'), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

const byId = (rows: RunSummary[]): Map<string, RunSummary> => new Map(rows.map((r) => [r.id, r]));

test('a readable run carries its four counters exactly as stored', () => {
  const dir = archive({
    full: { status: 'done', task: 't', planRound: 2, questionRound: 1, reviewRound: 2, verifyRound: 1 },
    zero: { status: 'done', task: 't', planRound: 0, questionRound: 0, reviewRound: 0, verifyRound: 0 },
  });
  const rows = byId(listRuns(dir));
  assert.deepEqual(rows.get('full')?.rounds, { plan: 2, question: 1, review: 2, verify: 1 });
  // Zero is a counter that was recorded and is zero, which is a fact; it must
  // not be confused with the null below.
  assert.deepEqual(rows.get('zero')?.rounds, { plan: 0, question: 0, review: 0, verify: 0 });
});

test('a counter the run never recorded, or recorded badly, is null and never 0', () => {
  const dir = archive({
    // Predates `questionRound` and `verifyRound`: it did not ask zero
    // questions, it never said.
    old: { status: 'done', task: 't', planRound: 3, reviewRound: 1 },
    odd: { status: 'done', task: 't', planRound: -1, questionRound: 1.5, reviewRound: '2', verifyRound: null },
  });
  const rows = byId(listRuns(dir));
  assert.deepEqual(rows.get('old')?.rounds, { plan: 3, question: null, review: 1, verify: null });
  assert.deepEqual(rows.get('odd')?.rounds, { plan: null, question: null, review: null, verify: null });
});

test('an entry nothing was read from carries no fingerprint', (t) => {
  const dir = archive({ broken: '{ broken', notAnObject: '[1,2,3]' });
  const rows = byId(listRuns(dir));
  for (const id of ['broken', 'notAnObject']) {
    const row = rows.get(id);
    assert.equal(row?.status, 'unreadable');
    assert.equal(row !== undefined && 'rounds' in row, false, `${id} carried rounds`);
  }

  const outside = mkdtempSync(path.join(tmpdir(), 'vibe-fingerprint-outside-'));
  writeFileSync(path.join(outside, 'state.json'), JSON.stringify({ status: 'done', planRound: 9 }));
  if (!linkDir(outside, path.join(dir, RUNS_DIR, 'sym-run'))) {
    t.skip(JUNCTION_SKIP);
    return;
  }
  const linked = byId(listRuns(dir)).get('sym-run');
  assert.equal(linked?.linked, true);
  assert.equal(linked !== undefined && 'rounds' in linked, false, 'a linked entry carried rounds');
});

test('the archive frame carries the fingerprint with no second route', async () => {
  // No `archive` dep: the real `listRuns` answers, so what reaches the window is
  // what `vibe list` reads, fingerprint included.
  const dir = archive({ r: { status: 'done', task: 't', planRound: 2, questionRound: 0, reviewRound: 1, verifyRound: 0 } });
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), { invoke: () => Promise.resolve(0) });
  session.receive(JSON.stringify({ type: 'archive', id: 1, dir }));
  await new Promise<void>((r) => setImmediate(r));
  const reply = sent.find((m) => m.type === 'archive');
  assert.ok(reply !== undefined && reply.type === 'archive');
  assert.deepEqual(reply.runs[0]?.rounds, { plan: 2, question: 0, review: 1, verify: 0 });
});
