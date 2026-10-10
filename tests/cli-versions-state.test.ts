import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, noteCliVersions } from '@src/cli.js';
import { detectCliVersions, resetCliProbes } from '@src/cliversions.js';
import { setSink } from '@src/log.js';
import type { Narration } from '@src/log.js';
import { createRun, saveState } from '@src/run.js';
import { validateStoredState } from '@src/stored.js';
import type { RunFn } from '@src/proc.js';
import type { RunState } from '@src/types.js';

/**
 * Every run records the CLI versions it ran under (#298): on `state.json`, on
 * the `run_started` narration, and - when a resume finds them moved - as a
 * durable `cli_versions_changed` event naming the old and the new.
 */

function scratch(): { targetDir: string; state: RunState } {
  const targetDir = mkdtempSync(path.join(os.tmpdir(), 'vibe-cli-state-'));
  return { targetDir, state: createRun(targetDir, 'cli versions', false) };
}

const stored = (state: RunState): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as Record<string, unknown>;

const changes = (state: RunState) => state.events.filter((e) => e.type === 'cli_versions_changed');

test('a fresh run writes the versions and records no change', () => {
  const { state } = scratch();
  noteCliVersions(state, { claude: '2.1.294', codex: '0.157.1' });
  assert.deepEqual(stored(state)['cliVersions'], { claude: '2.1.294', codex: '0.157.1' });
  assert.equal(changes(state).length, 0);
});

test('a resume under the same versions records no change', () => {
  const { state } = scratch();
  noteCliVersions(state, { claude: '2.1.294', codex: '0.157.1' });
  noteCliVersions(state, { claude: '2.1.294', codex: '0.157.1' });
  assert.equal(changes(state).length, 0);
});

test('a resume under a different version records one event naming old and new', () => {
  const { state } = scratch();
  noteCliVersions(state, { claude: '2.1.294', codex: '0.157.1' });
  const seen: Narration[] = [];
  setSink((n) => seen.push(n));
  try {
    noteCliVersions(state, { claude: '2.1.300', codex: '0.157.1' });
  } finally {
    setSink(null);
  }
  const events = changes(state);
  assert.equal(events.length, 1);
  // Flat, like every event: the data is spread onto the record.
  assert.deepEqual(
    { cli: events[0]?.['cli'], from: events[0]?.['from'], to: events[0]?.['to'] },
    { cli: 'claude', from: '2.1.294', to: '2.1.300' },
  );
  assert.deepEqual(stored(state)['cliVersions'], { claude: '2.1.300', codex: '0.157.1' });
  // The narration id is the event type.
  assert.equal(seen.filter((n) => n.id === 'cli_versions_changed').length, 1);
  // And it is durable: the event is on disk, not only said.
  const onDisk = (stored(state)['events'] as { type: string }[]).filter((e) => e.type === 'cli_versions_changed');
  assert.equal(onDisk.length, 1);
});

test('a version not detected on either side is not evidence of a change', () => {
  const { state } = scratch();
  noteCliVersions(state, { claude: null, codex: '0.157.1' });
  noteCliVersions(state, { claude: '2.1.294', codex: null });
  assert.equal(changes(state).length, 0);
  assert.deepEqual(state.cliVersions, { claude: '2.1.294', codex: null });
});

function validate(extra: Record<string, unknown>): ReturnType<typeof validateStoredState> {
  const { state } = scratch();
  const raw = { ...stored(state), ...extra };
  return validateStoredState(raw, state.id, state.dir);
}

test('a state written before #298 loads with no cliVersions and no repair', () => {
  const { state, repairs } = validate({});
  assert.equal('cliVersions' in state, false);
  assert.deepEqual(repairs, []);
});

test('a stored cliVersions is kept, and a malformed one dropped with a repair', () => {
  const kept = validate({ cliVersions: { claude: '2.1.294', codex: null } });
  assert.deepEqual(kept.state.cliVersions, { claude: '2.1.294', codex: null });
  assert.deepEqual(kept.repairs, []);

  for (const bad of [{ claude: 3, codex: null }, { claude: '', codex: null }, 'nope', { claude: '1' }]) {
    const dropped = validate({ cliVersions: bad });
    assert.equal(dropped.state.cliVersions, undefined, JSON.stringify(bad));
    assert.ok(dropped.repairs.some((r) => r.field === 'cliVersions'), JSON.stringify(bad));
  }
});

test('run_started carries the detected versions, and the resume writes them to state', async () => {
  // Primed with a fake, so nothing real is spawned: detection is read once per
  // process, and `main` reads the same cache.
  resetCliProbes();
  const fake: RunFn = (bin) =>
    Promise.resolve({
      code: 0,
      signal: null,
      stdout: bin === 'c' ? '2.1.294 (Claude Code)' : 'codex-cli 0.157.1',
      stderr: '',
    });
  await detectCliVersions(fake, { claude: () => 'c', codex: () => 'x' });

  // A finished run: the resume says `run_started` and then has nothing to do,
  // so no probe and no turn runs.
  const { targetDir, state } = scratch();
  state.status = 'done';
  state.phase = 'complete';
  state.cliVersions = { claude: '2.1.200', codex: '0.157.1' };
  saveState(state);

  const seen: Narration[] = [];
  setSink((n) => seen.push(n));
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await main(['resume', state.id, '-C', targetDir, '--no-progress']);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    setSink(null);
    resetCliProbes();
  }

  const started = seen.find((n) => n.id === 'run_started');
  assert.ok(started, 'run_started was said');
  assert.deepEqual(started.data?.['cliVersions'], { claude: '2.1.294', codex: '0.157.1' });
  const after = stored(state);
  assert.deepEqual(after['cliVersions'], { claude: '2.1.294', codex: '0.157.1' });
  const events = (after['events'] as Record<string, unknown>[]).filter((e) => e['type'] === 'cli_versions_changed');
  assert.deepEqual(
    events.map((e) => ({ cli: e['cli'], from: e['from'], to: e['to'] })),
    [{ cli: 'claude', from: '2.1.200', to: '2.1.294' }],
  );
});

test('all three run_started sites in the CLI carry cliVersions', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cli = readFileSync(path.join(here, '..', '..', 'src', 'cli.ts'), 'utf8');
  const sites = [...cli.matchAll(/id: 'run_started',\s*data: \{([^}]*)\}/g)];
  assert.equal(sites.length, 3);
  for (const m of sites) assert.match(m[1] ?? '', /\bcliVersions\b/);
});
