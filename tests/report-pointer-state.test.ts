import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun, loadRun } from '@src/run.js';
import { validateStoredState } from '@src/stored.js';
import type { RunState } from '@src/types.js';

/**
 * What `lastReport` does to a state file that has never heard of it, and what it
 * does to one that points somewhere it should not.
 *
 * This field is different in kind from its neighbours: it is not only read, it
 * is JOINED ONTO A PATH (`artifactText` does `path.join(state.dir, name)`) and
 * the file's contents are rendered into a prompt. So a stored `../../something`
 * is a stored state reading a file the run never wrote and presenting it to the
 * reviewer as the implementer's own report. It is checked on the way in for the
 * reason #23 exists, and dropped to absent rather than repaired into a guess -
 * which is honest, because the reviewer is then told there is no report.
 *
 * The fixtures are real post-run `state.json` files, for the reason
 * `review-coverage-state.test.ts` gives: a claim about what older state looks
 * like should be settled by an older state file.
 *
 * Nothing cleans up its temp directory - the same reason `loop-harness.ts`
 * gives: `rmSync` over a directory a child process has just touched is a Windows
 * flake source in a suite that has to pass three times running.
 */

const FIXTURES = [
  'oldest-planning',
  'stalled-planning',
  'done-pendingfindings-null',
  'done-widest',
] as const;

function stored(name: string): Record<string, unknown> {
  const file = fileURLToPath(new URL(`../../tests/fixtures/state/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

const read = (raw: Record<string, unknown>): ReturnType<typeof validateStoredState> =>
  validateStoredState(raw, String(raw['id']), 'C:/nowhere');

// ---- absence ----------------------------------------------------------------

test('every real state written before this field loads with no repairs and no pointer', () => {
  for (const name of FIXTURES) {
    const { state, repairs } = read(stored(name));
    assert.deepEqual(repairs, [], name);
    assert.equal('lastReport' in state, false, `${name} has no pointer invented for it`);
    assert.equal(state.lastReport, undefined, name);
  }
});

test('a basename this run wrote survives a round trip untouched', () => {
  for (const name of ['implementation-report.md', 'fix-report-2.md', 'verify-fix-11.md']) {
    const { state, repairs } = read({ ...stored('done-widest'), lastReport: name });
    assert.deepEqual(repairs, [], name);
    assert.equal(state.lastReport, name);
  }
});

// ---- fail closed ------------------------------------------------------------

test('a pointer that is not a plain basename is dropped, with exactly one repair logged', () => {
  const rejected: unknown[] = [
    '../../etc/passwd',
    '..',
    '.',
    'a/b.md',
    'a\\b.md',
    '/etc/passwd',
    'C:/x.md',
    'C:\\x.md',
    '\\\\server\\share\\x.md',
    'sub/../implementation-report.md',
    '',
    42,
    null,
    {},
    ['implementation-report.md'],
  ];

  for (const value of rejected) {
    const { state, repairs } = read({ ...stored('done-widest'), lastReport: value });
    const label = JSON.stringify(value) ?? String(value);
    assert.equal(state.lastReport, undefined, label);
    assert.equal('lastReport' in state, false, label);
    assert.deepEqual(
      repairs.map((r) => r.field),
      ['lastReport'],
      `${label} costs one repair and nothing else`,
    );
    assert.equal(repairs[0]?.replacedWith, 'nothing', label);
  }
});

test('a bad pointer costs only itself - the rest of the state still loads', () => {
  const raw = stored('done-widest');
  const { state } = read({ ...raw, lastReport: '../evil.md' });

  assert.equal(state.id, raw['id']);
  assert.equal(state.task, raw['task']);
  assert.equal(state.tokensUsed, raw['tokensUsed']);
  assert.equal(state.lastReport, undefined);
});

test('a real load records the repair as an event, so the drop is visible to the user', () => {
  const targetDir = mkdtempSync(path.join(tmpdir(), 'vibe-report-pointer-'));
  const fresh = createRun(targetDir, 'report pointer', true);
  const file = path.join(fresh.dir, 'state.json');

  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  raw['lastReport'] = '../evil.md';
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');

  const loaded: RunState = loadRun(targetDir, fresh.id);

  assert.equal(loaded.lastReport, undefined);
  const repaired = loaded.events.filter((e) => e.type === 'state_repaired');
  assert.deepEqual(
    repaired.map((e) => String(e['field'])),
    ['lastReport'],
  );
});

test('a good pointer survives a real load, so the drop is not indiscriminate', () => {
  const targetDir = mkdtempSync(path.join(tmpdir(), 'vibe-report-pointer-ok-'));
  const fresh = createRun(targetDir, 'report pointer', true);
  const file = path.join(fresh.dir, 'state.json');

  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  raw['lastReport'] = 'fix-report-3.md';
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');

  const loaded = loadRun(targetDir, fresh.id);

  assert.equal(loaded.lastReport, 'fix-report-3.md');
  assert.deepEqual(
    loaded.events.filter((e) => e.type === 'state_repaired'),
    [],
  );
});
