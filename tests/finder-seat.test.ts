import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '@src/config.js';
import {
  codexSandbox,
  modelFor,
  effortFor,
  mcpServersFor,
  readFinders,
  ROLES,
  rolesFor,
  seatResolved,
  seatTable,
  slotForRole,
  turnTimeoutMs,
} from '@src/roles.js';
import type { RoleSetting } from '@src/roles.js';
import type { Config } from '@src/types.js';

/**
 * A finder is the reviewer's job on a swapped seat (#388 Part B, decision 2).
 *
 * The seat's slot is a fresh conversation on its own provider - never `main`
 * (the implementer's session), never `review` or `judge` (threads that resume) -
 * and its Codex sandbox is whatever a read-only Codex turn gets under this
 * config, which is `codex.sandbox`: `read-only` under the defaults.
 */

test('a finder sits on a fresh slot on either provider, never a conversation of the run', () => {
  assert.equal(slotForRole('reviewer', seatTable(ROLES, { provider: 'claude' })), 'fresh-claude');
  assert.equal(slotForRole('reviewer', seatTable(ROLES, { provider: 'codex' })), 'fresh-codex');
  for (const provider of ['claude', 'codex'] as const) {
    const slot = slotForRole('reviewer', seatTable(ROLES, { provider }));
    assert.ok(!['main', 'review', 'judge', 'write'].includes(slot), `${provider} finder on ${slot}`);
  }
});

test("a finder reads only, with the reviewer's schema and tools", () => {
  for (const provider of ['claude', 'codex'] as const) {
    const spec = seatTable(ROLES, { provider }).reviewer;
    assert.equal(spec.access, 'read-only');
    assert.equal(spec.schema, ROLES.reviewer.schema);
    assert.deepEqual(spec.tools, ROLES.reviewer.tools);
  }
  assert.equal(codexSandbox(seatTable(ROLES, { provider: 'codex' }).reviewer.access, DEFAULTS), 'read-only');
  assert.notEqual(codexSandbox(seatTable(ROLES, { provider: 'codex' }).reviewer.access, DEFAULTS), 'workspace-write');
});

test("a finder's sandbox follows codex.sandbox, as the reviewer's does", () => {
  const cfg: Config = { ...DEFAULTS, codex: { ...DEFAULTS.codex, sandbox: 'workspace-write' } };
  const finder = seatTable(rolesFor(cfg), { provider: 'codex' }).reviewer;
  assert.equal(codexSandbox(finder.access, cfg), codexSandbox(ROLES.reviewer.access, cfg));
});

test("the seat carries the entry's own settings, and no MCP key when it named none", () => {
  const seat: RoleSetting = {
    provider: 'codex',
    model: 'finder-model',
    effort: 'high',
    timeoutMs: 123_000,
    mcpServers: ['docs'],
  };
  const table = seatTable(ROLES, seat);
  assert.equal(modelFor('reviewer', DEFAULTS, table), 'finder-model');
  assert.equal(effortFor('reviewer', DEFAULTS, table), 'high');
  assert.equal(turnTimeoutMs('reviewer', DEFAULTS, table), 123_000);
  assert.deepEqual(mcpServersFor('reviewer', table), ['docs']);

  const bare = seatTable(ROLES, { provider: 'claude' }).reviewer;
  assert.equal('mcpServers' in bare, false);
  assert.equal('model' in bare, false);
  // Every other row is the run's own.
  assert.deepEqual({ ...table, reviewer: ROLES.reviewer }, ROLES);
});

test('a run asks the seat the same questions doctor answers about it', () => {
  for (const seat of [{ provider: 'claude' }, { provider: 'codex', effort: 'max' }] as RoleSetting[]) {
    const table = seatTable(ROLES, seat);
    const resolved = seatResolved(seat, DEFAULTS);
    assert.equal(turnTimeoutMs('reviewer', DEFAULTS, table), resolved.timeoutMs);
    assert.equal(modelFor('reviewer', DEFAULTS, table), resolved.model);
    assert.equal(effortFor('reviewer', DEFAULTS, table), resolved.effort);
  }
});

test('readFinders reads both spellings, 1-based, with focus carried', () => {
  const cfg: Config = {
    ...DEFAULTS,
    review: { ...DEFAULTS.review, finders: ['codex', { provider: 'claude', model: 'opus', focus: 'races' }] },
  };
  assert.deepEqual(readFinders(cfg), [
    { k: 1, path: 'review.finders[0]', setting: { provider: 'codex' } },
    { k: 2, path: 'review.finders[1]', setting: { provider: 'claude', model: 'opus' }, focus: 'races' },
  ]);
  assert.deepEqual(readFinders(DEFAULTS), []);
  // A config stored before the section existed is a run with no finders.
  const { review: _review, ...old } = DEFAULTS;
  assert.deepEqual(readFinders(old as unknown as Config), []);
});
