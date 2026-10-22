import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CHECK_EVERY_MS,
  REGISTRY_URL,
  compareVersions,
  fetchLatest,
  isNewer,
  noticeFor,
  readUpdateCache,
  runWithNotice,
  updateCachePath,
  updateNotice,
  type FetchLike,
  type NoticeDeps,
} from '@src/updatecheck.js';
import { DEFAULTS, loadConfig } from '@src/config.js';

/**
 * The update notice (#323): the version comparison, the once-a-day cache, every
 * switch that turns it off, a failing or slow registry, and the order - the line
 * comes after the command and never changes its exit code.
 *
 * No case touches the network: every fetch is injected, and every time is
 * computed from `Date.now()` rather than written down.
 */

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'vibe-updatecheck-'));
}

/** A fetch that answers `version`, and counts how often it was asked. */
function registry(version: unknown, ok = true): FetchLike & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    return { ok, json: async () => ({ name: '@adam-hanna/vibe-code', version }) };
  }) as unknown as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}

/**
 * A fetch that never answers and ends only when its signal aborts, as a real one
 * would. The held timer stands in for the open socket a real request keeps the
 * event loop alive with: `AbortSignal.timeout`'s own timer is unref'd, so
 * without it the loop would drain before the abort fired.
 */
function hanging(): FetchLike {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      const socket = setTimeout(() => reject(new Error('the timeout never fired')), 10_000);
      init.signal.addEventListener('abort', () => {
        clearTimeout(socket);
        reject(init.signal.reason);
      });
    });
}

function deps(over: Partial<NoticeDeps> = {}): NoticeDeps {
  const dir = tmp();
  return {
    env: {},
    stdoutIsTTY: true,
    cwd: dir,
    now: () => Date.now(),
    fetchFn: registry('9.0.0'),
    current: () => '1.7.1',
    configCheck: () => true,
    cachePath: path.join(dir, 'vibe', 'update-check.json'),
    ...over,
  };
}

const LINE = 'vibe 9.0.0 is available (you have 1.7.1): npm install -g @adam-hanna/vibe-code';

// ---- The version compare ------------------------------------------------------

test('compare: newer, equal and older, part by part', () => {
  assert.equal(compareVersions('1.8.0', '1.7.1'), 1);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.7.10', '1.7.9'), 1, 'numeric, not lexical');
  assert.equal(compareVersions('1.7.1', '1.7.1'), 0);
  assert.equal(compareVersions('1.7.0', '1.7.1'), -1);
  assert.equal(compareVersions('0.9.9', '1.0.0'), -1);
});

test('compare: a pre-release sorts below its release and above the one before', () => {
  assert.equal(compareVersions('1.8.0-rc.1', '1.8.0'), -1);
  assert.equal(compareVersions('1.8.0', '1.8.0-rc.1'), 1);
  assert.equal(compareVersions('1.8.0-rc.1', '1.7.1'), 1);
  // Semver 2.0.0 section 11's own ordering example.
  const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 0; i + 1 < chain.length; i++) {
    assert.equal(compareVersions(chain[i] ?? '', chain[i + 1] ?? ''), -1, `${chain[i]} < ${chain[i + 1]}`);
  }
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.1'), 0);
  assert.equal(compareVersions('1.0.0+build.5', '1.0.0'), 0, 'build metadata takes no part');
});

test('compare: anything that is not a version is null, and never newer', () => {
  for (const bad of ['', 'latest', '1.7', '1.7.1.2', '01.7.1', '1.7.x', '1.7.1-']) {
    assert.equal(compareVersions(bad, '1.7.1'), null, bad);
    assert.equal(isNewer(bad, '1.7.1'), false, bad);
  }
  assert.equal(isNewer('1.8.0', '1.7.1'), true);
  assert.equal(isNewer('1.7.1', '1.7.1'), false);
  assert.equal(isNewer('1.7.0', '1.7.1'), false);
});

test('the line is the issue\'s sentence', () => {
  assert.equal(updateNotice('9.0.0', '1.7.1'), LINE);
});

// ---- The request ----------------------------------------------------------------

test('the request is one GET of the public URL, with a timeout and no credentials', async () => {
  let seen: { url: string; init: Parameters<FetchLike>[1] } | null = null;
  const fn: FetchLike = async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => ({ version: '1.8.0' }) };
  };
  assert.equal(await fetchLatest(fn), '1.8.0');
  const got = seen as { url: string; init: Parameters<FetchLike>[1] } | null;
  assert.ok(got !== null);
  assert.equal(got.url, 'https://registry.npmjs.org/@adam-hanna/vibe-code/latest');
  assert.equal(got.url, REGISTRY_URL);
  assert.ok(got.init.signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(got.init).sort(), ['headers', 'signal'], 'no method, body or credentials option');
  assert.deepEqual(got.init.headers, { accept: 'application/json' });
});

test('a failing, refusing or nonsensical registry is no version', async () => {
  assert.equal(await fetchLatest(registry('1.8.0', false)), null, 'non-2xx');
  assert.equal(await fetchLatest(registry(42)), null, 'version not a string');
  assert.equal(await fetchLatest(registry('not-a-version')), null);
  assert.equal(await fetchLatest(async () => { throw new Error('ECONNREFUSED'); }), null);
  assert.equal(
    await fetchLatest(async () => ({ ok: true, json: async () => { throw new SyntaxError('bad json'); } })),
    null,
  );
});

test('a slow registry is cut off by the timeout and is no version', async () => {
  const hang = hanging();
  const started = Date.now();
  assert.equal(await fetchLatest(hang, 50), null);
  assert.ok(Date.now() - started < 5_000, 'the timeout ended it, not the test runner');
});

// ---- The cache ------------------------------------------------------------------

test('cache: within a day the registry is not asked again', async () => {
  const d = deps();
  const fetchFn = registry('9.0.0');
  assert.equal(await noticeFor(['run', 'x'], { ...d, fetchFn }), LINE);
  assert.equal(fetchFn.calls.length, 1);
  // An hour later: the cached answer, and no second request.
  const later = Date.now() + 60 * 60 * 1000;
  assert.equal(await noticeFor(['doctor'], { ...d, fetchFn, now: () => later }), LINE);
  assert.equal(fetchFn.calls.length, 1);
  // A day and a minute later: asked again.
  const tomorrow = Date.now() + CHECK_EVERY_MS + 60_000;
  await noticeFor(['plan', 'x'], { ...d, fetchFn, now: () => tomorrow });
  assert.equal(fetchFn.calls.length, 2);
});

test('cache: a failed check is cached too, so a machine offline pays the timeout once a day', async () => {
  const d = deps();
  let calls = 0;
  const down: FetchLike = async () => {
    calls++;
    throw new Error('ENOTFOUND');
  };
  assert.equal(await noticeFor(['run', 'x'], { ...d, fetchFn: down }), null);
  assert.equal(await noticeFor(['run', 'x'], { ...d, fetchFn: down }), null);
  assert.equal(calls, 1);
  const cached = readUpdateCache(d.cachePath ?? '', Date.now());
  assert.equal(cached?.latest, null);
});

test('cache: a corrupt, misshapen or future-dated file counts as no cache', async () => {
  const now = Date.now();
  const file = path.join(tmp(), 'update-check.json');
  for (const body of [
    '{not json',
    '[]',
    'null',
    JSON.stringify({ latest: '9.0.0' }),
    JSON.stringify({ checkedAt: 'yesterday', latest: '9.0.0' }),
    JSON.stringify({ checkedAt: now - 1000, latest: 7 }),
    JSON.stringify({ checkedAt: now + CHECK_EVERY_MS, latest: '9.0.0' }),
  ]) {
    writeFileSync(file, body);
    assert.equal(readUpdateCache(file, now), null, body);
    const fetchFn = registry('9.0.0');
    assert.equal(await noticeFor(['run', 'x'], { ...deps(), cachePath: file, fetchFn }), LINE, body);
    assert.equal(fetchFn.calls.length, 1, `${body}: asked the registry instead`);
    // And the request rewrote it into a good one.
    assert.equal(readUpdateCache(file, Date.now())?.latest, '9.0.0');
  }
});

test('cache: it lives next to the global config, and nowhere when that layer is off', () => {
  const dir = tmp();
  assert.equal(
    updateCachePath({ VIBE_GLOBAL_CONFIG: path.join(dir, 'config.json') }),
    path.join(dir, 'update-check.json'),
  );
  if (process.platform !== 'win32') {
    assert.equal(updateCachePath({ XDG_CONFIG_HOME: dir }), path.join(dir, 'vibe', 'update-check.json'));
  }
  assert.equal(updateCachePath({ VIBE_GLOBAL_CONFIG: '' }), null);
});

test('with nowhere to cache, there is no check at all', async () => {
  const fetchFn = registry('9.0.0');
  assert.equal(await noticeFor(['run', 'x'], deps({ cachePath: null, fetchFn })), null);
  assert.equal(fetchFn.calls.length, 0);
});

// ---- When it says something ------------------------------------------------------

test('a newer version is said; the same or an older one is not', async () => {
  assert.equal(await noticeFor(['run', 'x'], deps({ fetchFn: registry('9.0.0') })), LINE);
  assert.equal(await noticeFor(['run', 'x'], deps({ fetchFn: registry('1.7.1') })), null);
  assert.equal(await noticeFor(['run', 'x'], deps({ fetchFn: registry('1.7.0') })), null);
  assert.equal(await noticeFor(['run', 'x'], deps({ current: () => null })), null, 'own version unknown');
});

test('only run, plan and doctor carry it', async () => {
  for (const argv of [['run', 'x'], ['plan', 'x'], ['doctor']]) {
    assert.equal(await noticeFor(argv, deps()), LINE, argv.join(' '));
  }
  for (const argv of [[], ['resume', 'r'], ['list'], ['stats'], ['fork', 'r'], ['nope'], ['run', '--help']]) {
    const fetchFn = registry('9.0.0');
    assert.equal(await noticeFor(argv, deps({ fetchFn })), null, argv.join(' '));
    assert.equal(fetchFn.calls.length, 0, `${argv.join(' ')} asked the registry`);
  }
});

test('-C is the directory whose config is read', async () => {
  const seen: string[] = [];
  const d = deps({ configCheck: (dir) => { seen.push(dir); return true; } });
  await noticeFor(['doctor', '-C', 'elsewhere'], d);
  assert.deepEqual(seen, [path.join(d.cwd, 'elsewhere')]);
});

// ---- Every switch -------------------------------------------------------------------

test('each opt-out suppresses the line, and makes no request', async () => {
  const cases: [string, Partial<NoticeDeps>][] = [
    ['CI', { env: { CI: 'true' } }],
    ['CI=1', { env: { CI: '1' } }],
    ['VIBE_NO_UPDATE_CHECK=1', { env: { VIBE_NO_UPDATE_CHECK: '1' } }],
    ['stdout not a TTY', { stdoutIsTTY: false }],
    ['updates.check false', { configCheck: () => false }],
    ['config unreadable', { configCheck: () => null }],
  ];
  for (const [name, over] of cases) {
    const fetchFn = registry('9.0.0');
    assert.equal(await noticeFor(['run', 'x'], deps({ ...over, fetchFn })), null, name);
    assert.equal(fetchFn.calls.length, 0, `${name} still asked the registry`);
  }
  // And an empty or explicitly-false value is not an opt-out.
  for (const env of [{ CI: '' }, { CI: 'false' }, { VIBE_NO_UPDATE_CHECK: '0' }]) {
    assert.equal(await noticeFor(['run', 'x'], deps({ env })), LINE, JSON.stringify(env));
  }
});

test('updates.check is a config key, on by default, settable and refused when not a boolean', () => {
  assert.deepEqual(DEFAULTS.updates, { check: true });
  const dir = tmp();
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ updates: { check: false } }));
  assert.equal(loadConfig(dir).updates.check, false);
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ updates: { check: 'false' } }));
  assert.throws(() => loadConfig(dir), /updates\.check must be true or false/);
});

// ---- The order, and the exit code ------------------------------------------------------

test('the line comes after the command has finished, never before', async () => {
  const order: string[] = [];
  await runWithNotice(
    async () => {
      order.push('command started');
      await new Promise((r) => setTimeout(r, 5));
      order.push('command ended');
      return 0;
    },
    async () => {
      order.push('check started');
      return LINE;
    },
    { setExitCode: (c) => order.push(`exit ${c}`), write: (l) => order.push(l) },
  );
  assert.deepEqual(order, ['command started', 'command ended', 'exit 0', 'check started', LINE]);
});

test('a failed, throwing or slow check prints nothing and leaves the exit code alone', async () => {
  for (const [name, notice] of [
    ['no newer version', async () => null],
    ['rejects', async () => { throw new Error('boom'); }],
    ['times out', () => noticeFor(['run', 'x'], deps({ fetchFn: hanging(), timeoutMs: 20 }))],
    ['registry down', () => noticeFor(['run', 'x'], deps({ fetchFn: async () => { throw new Error('ECONNRESET'); } }))],
  ] as [string, () => Promise<string | null>][]) {
    for (const code of [0, 1, 2, 3]) {
      const codes: number[] = [];
      const written: string[] = [];
      await runWithNotice(async () => code, notice, {
        setExitCode: (c) => codes.push(c),
        write: (l) => written.push(l),
      });
      assert.deepEqual(codes, [code], `${name}: exit ${code}`);
      assert.deepEqual(written, [], `${name}: printed something`);
    }
  }
});

test('a stdout that throws on the line does not fail a finished command', async () => {
  const codes: number[] = [];
  await runWithNotice(async () => 2, async () => LINE, {
    setExitCode: (c) => codes.push(c),
    write: () => { throw new Error('EPIPE'); },
  });
  assert.deepEqual(codes, [2]);
});

test('the cache file is plain JSON a person can read', async () => {
  const d = deps();
  await noticeFor(['run', 'x'], d);
  const raw = JSON.parse(readFileSync(d.cachePath ?? '', 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(raw).sort(), ['checkedAt', 'latest']);
  assert.equal(raw['latest'], '9.0.0');
});
