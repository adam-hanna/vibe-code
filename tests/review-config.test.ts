import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configDiff, DEFAULTS, loadConfig, PROJECT_ONLY, writeConfigPatch } from '@src/config.js';

/**
 * The `review` section (#388 Part A): accepted, validated, and read by no run.
 *
 * Every refusal the brief lists is pinned by name and, for a seat, by index -
 * because `validateConfig` naming the key is the only way somebody who believes
 * they configured a vote finds out they did not. The seats go through the same
 * `roleSetting` that reads `roles.<role>`; `role-setting-path.test.ts` pins that
 * the role messages did not move when it took a path.
 */

function project(contents: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibe-review-config-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), `${JSON.stringify(contents, null, 2)}\n`);
  return dir;
}

const load = (review: unknown): unknown => loadConfig(project({ review })).review;

function refused(review: unknown, message: string | RegExp): void {
  assert.throws(() => load(review), message instanceof RegExp ? message : { message });
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

test('the defaults are no extra seats, a majority, and an unconfirmed P0 that blocks', () => {
  assert.deepEqual(DEFAULTS.review, { finders: [], verifiers: [], quorum: null, unconfirmedP0: 'block' });
  assert.deepEqual(loadConfig(project({})).review, DEFAULTS.review);
});

test('seats are written like roles, and a finder may name a focus', () => {
  const review = {
    finders: ['codex', { provider: 'claude', model: 'opus', effort: 'high', timeoutMs: 60_000, focus: 'security' }],
    verifiers: [{ provider: 'codex', mcpServers: ['github'] }, 'claude', 'codex'],
    quorum: 2,
    unconfirmedP0: 'halt',
  };
  assert.deepEqual(load(review), review);
  // Absent focus is the shared prompt, and accepted.
  assert.deepEqual(load({ finders: [{ provider: 'codex' }] }), { ...DEFAULTS.review, finders: [{ provider: 'codex' }] });
});

test('a quorum that is not a positive whole number is refused by name', () => {
  for (const quorum of [0, -1, 1.5, '2', true]) {
    refused(
      { verifiers: ['codex', 'codex'], quorum },
      'review.quorum must be a positive whole number of verifiers, or null for a majority',
    );
  }
});

test('a quorum with no verifiers, or above how many there are, is refused', () => {
  refused({ quorum: 1 }, 'review.quorum is 1 but review.verifiers is empty; a quorum needs verifiers to count');
  refused({ verifiers: ['codex', 'claude'], quorum: 3 }, 'review.quorum is 3 but there are only 2 verifiers');
  assert.equal((load({ verifiers: ['codex', 'claude'], quorum: 2 }) as { quorum: number }).quorum, 2);
});

test('an unconfirmedP0 outside the three is refused', () => {
  refused({ unconfirmedP0: 'skip' }, 'review.unconfirmedP0 must be one of block, halt, demote');
  for (const v of ['block', 'halt', 'demote']) {
    assert.equal((load({ unconfirmedP0: v }) as { unconfirmedP0: string }).unconfirmedP0, v);
  }
});

test('a bad seat is refused by its index, in the words a role gets', () => {
  refused(
    { finders: ['codex', { provider: 'codex', effort: 'huge' }] },
    'review.finders[1].effort is "huge"; must be one of low, medium, high, xhigh, max',
  );
  refused(
    { finders: ['codex', { provider: 'codex', x: 1 }] },
    'review.finders[1] has unknown key "x"; a finder takes provider, model, effort, timeoutMs, mcpServers and focus',
  );
  refused(
    { verifiers: [{ effort: 'low' }] },
    /Error: review\.verifiers\[0\] is an object with no provider\./,
  );
  refused(
    { verifiers: ['gemini'] },
    /Error: review\.verifiers\[0\] is "gemini"; expected "claude" or "codex"/,
  );
});

test('focus: empty, blank or not a string is refused; on a verifier it is an unknown key', () => {
  for (const [focus, shown] of [
    ['', '""'],
    ['  ', '"  "'],
    [3, '3'],
    [null, 'null'],
  ] as const) {
    refused(
      { finders: [{ provider: 'codex', focus }] },
      `review.finders[0].focus is ${shown}; must be a non-empty string, or absent for the shared prompt`,
    );
  }
  refused(
    { verifiers: [{ provider: 'codex', focus: 'security' }] },
    'review.verifiers[0] has unknown key "focus"; a verifier takes provider, model, effort, timeoutMs and mcpServers',
  );
});

test('the section is strict: no dropped key, no swallowed null', () => {
  refused({ quorom: 2 }, 'review.quorom is not a setting; review takes finders, verifiers, quorum and unconfirmedP0');
  refused(null, 'review must be an object with finders, verifiers, quorum and unconfirmedP0');
  refused({ finders: 'codex' }, 'review.finders must be a list of seats, or [] for none');
  refused({ verifiers: {} }, 'review.verifiers must be a list of seats, or [] for none');
});

test('review is set globally and per project, the project winning key by key and lists whole', () => {
  assert.equal(PROJECT_ONLY['review'], undefined, 'a review policy, not a fact about one repository');
  const root = mkdtempSync(path.join(os.tmpdir(), 'vibe-review-global-'));
  const global = path.join(root, 'home', 'vibe', 'config.json');
  mkdirSync(path.dirname(global), { recursive: true });
  writeFileSync(
    global,
    JSON.stringify({ review: { finders: ['claude', 'codex'], verifiers: ['codex', 'codex', 'claude'], quorum: 3 } }),
  );
  withGlobal(global, () => {
    // Accepted from the global file alone.
    assert.deepEqual(loadConfig(project({})).review, {
      finders: ['claude', 'codex'],
      verifiers: ['codex', 'codex', 'claude'],
      quorum: 3,
      unconfirmedP0: 'block',
    });
    // The project's finders replace the global list; the global quorum and verifiers stand.
    assert.deepEqual(loadConfig(project({ review: { finders: [{ provider: 'codex', focus: 'tests' }] } })).review, {
      finders: [{ provider: 'codex', focus: 'tests' }],
      verifiers: ['codex', 'codex', 'claude'],
      quorum: 3,
      unconfirmedP0: 'block',
    });
    // A global write goes to the global file and is validated there.
    writeConfigPatch(null, { review: { unconfirmedP0: 'demote' } }, 'global');
    assert.equal((JSON.parse(readFileSync(global, 'utf8')) as { review: { unconfirmedP0: string } }).review.unconfirmedP0, 'demote');
  });
});

test('a settings save merges into the file one level deep, and a refused one writes nothing', () => {
  const dir = project({ review: { verifiers: ['codex'] } });
  const file = (): unknown => JSON.parse(readFileSync(path.join(dir, 'vibe.config.json'), 'utf8'));
  writeConfigPatch(dir, { review: { finders: [{ provider: 'claude', focus: 'security' }] } });
  assert.deepEqual(file(), { review: { verifiers: ['codex'], finders: [{ provider: 'claude', focus: 'security' }] } });
  const before = file();
  assert.throws(
    () => writeConfigPatch(dir, { review: { quorum: 5 } }),
    { message: 'review.quorum is 5 but there are only 1 verifiers' },
  );
  assert.deepEqual(file(), before);
});

test('a moved seat list is named in a resume\'s config diff', () => {
  const before = loadConfig(project({}));
  const after = loadConfig(project({ review: { finders: ['codex'] } }));
  assert.deepEqual(configDiff(before, after), ['review.finders']);
  assert.deepEqual(configDiff(before, loadConfig(project({}))), []);
});
