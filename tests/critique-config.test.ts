import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDiff, DEFAULTS, loadConfig, PROJECT_ONLY, writeConfigPatch } from '@src/config.js';

/**
 * The `critique` section (#405): the review's five keys for the plan critique,
 * validated by the same code with the same words, `critique.` in place of
 * `review.`. `review-config.test.ts` pins the review's messages and is not
 * touched by this; what a run does with the section is pinned in
 * `critique-finders-loop.test.ts` and `critique-votes-loop.test.ts`.
 */

function project(contents: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibe-critique-config-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), `${JSON.stringify(contents, null, 2)}\n`);
  return dir;
}

const load = (critique: unknown): unknown => loadConfig(project({ critique })).critique;

function refused(critique: unknown, message: string | RegExp): void {
  assert.throws(() => load(critique), message instanceof RegExp ? message : { message });
}

test('the defaults are no extra seats, a majority, and an unconfirmed P0 that blocks', () => {
  assert.deepEqual(DEFAULTS.critique, { finders: [], verifiers: [], quorum: null, unconfirmedP0: 'block', maxParallel: 1 });
  assert.deepEqual(loadConfig(project({})).critique, DEFAULTS.critique);
});

test('seats are written like roles, a finder may name a focus, and it is apart from review', () => {
  const critique = {
    finders: ['codex', { provider: 'claude', model: 'opus', effort: 'high', focus: 'the brief' }],
    verifiers: [{ provider: 'codex', mcpServers: ['github'] }, 'claude', 'codex'],
    quorum: 2,
    unconfirmedP0: 'halt',
  };
  const cfg = loadConfig(project({ critique }));
  // `maxParallel` filled from the default, as every key a file leaves out is (#452).
  assert.deepEqual(cfg.critique, { ...critique, maxParallel: 1 });
  assert.deepEqual(cfg.review, DEFAULTS.review, 'the review panel is not the critique panel');
});

test('every refusal is the review\'s, under critique. paths', () => {
  refused(
    { verifiers: ['codex', 'codex'], quorum: 0 },
    'critique.quorum must be a positive whole number of verifiers, or null for a majority',
  );
  refused({ quorum: 1 }, 'critique.quorum is 1 but critique.verifiers is empty; a quorum needs verifiers to count');
  refused({ verifiers: ['codex', 'claude'], quorum: 3 }, 'critique.quorum is 3 but there are only 2 verifiers');
  refused({ unconfirmedP0: 'skip' }, 'critique.unconfirmedP0 must be one of block, halt, demote');
  refused(
    { finders: ['codex', { provider: 'codex', effort: 'huge' }] },
    'critique.finders[1].effort is "huge"; must be one of low, medium, high, xhigh, max',
  );
  refused(
    { finders: [{ provider: 'codex', focus: '  ' }] },
    'critique.finders[0].focus is "  "; must be a non-empty string, or absent for the shared prompt',
  );
  refused({ verifiers: ['gemini'] }, /Error: critique\.verifiers\[0\] is "gemini"; expected "claude" or "codex"/);
  refused(
    { quorom: 2 },
    'critique.quorom is not a setting; critique takes finders, verifiers, quorum, unconfirmedP0 and maxParallel',
  );
  refused(null, 'critique must be an object with finders, verifiers, quorum, unconfirmedP0 and maxParallel');
  refused({ finders: 'codex' }, 'critique.finders must be a list of seats, or [] for none');
  refused({ verifiers: {} }, 'critique.verifiers must be a list of seats, or [] for none');
});

test('critique.maxParallel is a positive whole number of turns, defaulting to 1 (#452)', () => {
  const message = 'critique.maxParallel must be a positive whole number of turns at once (1 runs them one after another)';
  for (const bad of [0, -1, 1.5, '2', null]) refused({ maxParallel: bad }, message);
  assert.equal(DEFAULTS.critique.maxParallel, 1);
  assert.equal((load({}) as { maxParallel: number }).maxParallel, 1);
  assert.equal((load({ maxParallel: 1 }) as { maxParallel: number }).maxParallel, 1);
  assert.equal((load({ maxParallel: 8 }) as { maxParallel: number }).maxParallel, 8);
});

test("raising review.maxParallel alone leaves the critique's bound at 1 (#452)", () => {
  const cfg = loadConfig(project({ review: { maxParallel: 4 } }));
  assert.equal(cfg.review.maxParallel, 4);
  assert.equal(cfg.critique.maxParallel, 1);
});

test('a focus on a critique verifier is refused as an unknown key', () => {
  refused(
    { verifiers: [{ provider: 'codex', focus: 'security' }] },
    'critique.verifiers[0] has unknown key "focus"; a verifier takes provider, model, effort, timeoutMs and mcpServers',
  );
});

test('critique is set globally and per project, the project winning key by key and lists whole', () => {
  assert.equal(PROJECT_ONLY['critique'], undefined);
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibe-critique-global-'));
  const global = path.join(root, 'home', 'vibe', 'config.json');
  mkdirSync(path.dirname(global), { recursive: true });
  writeFileSync(global, JSON.stringify({ critique: { finders: ['claude', 'codex'], verifiers: ['codex', 'claude'], quorum: 2 } }));
  const before = process.env['VIBE_GLOBAL_CONFIG'];
  process.env['VIBE_GLOBAL_CONFIG'] = global;
  try {
    assert.deepEqual(loadConfig(project({ critique: { finders: [{ provider: 'codex', focus: 'tests' }] } })).critique, {
      finders: [{ provider: 'codex', focus: 'tests' }],
      verifiers: ['codex', 'claude'],
      quorum: 2,
      unconfirmedP0: 'block',
      maxParallel: 1,
    });
  } finally {
    if (before === undefined) delete process.env['VIBE_GLOBAL_CONFIG'];
    else process.env['VIBE_GLOBAL_CONFIG'] = before;
  }
});

test('a settings save writes under critique, and a refused one writes nothing', () => {
  const dir = project({ critique: { verifiers: ['codex'] } });
  const file = (): unknown => JSON.parse(readFileSync(path.join(dir, 'vibe.config.json'), 'utf8'));
  writeConfigPatch(dir, { critique: { finders: [{ provider: 'claude' }] } });
  assert.deepEqual(file(), { critique: { verifiers: ['codex'], finders: [{ provider: 'claude' }] } });
  const kept = file();
  assert.throws(() => writeConfigPatch(dir, { critique: { quorum: 5 } }), {
    message: 'critique.quorum is 5 but there are only 1 verifiers',
  });
  assert.deepEqual(file(), kept);
});

test('a moved critique list is named in a resume\'s config diff', () => {
  const before = loadConfig(project({}));
  assert.deepEqual(configDiff(before, loadConfig(project({ critique: { verifiers: ['codex'] } }))), [
    'critique.verifiers',
  ]);
});
