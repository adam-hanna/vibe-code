import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { describeMcp, mcpRefusals } from '@src/mcp.js';
import type { RunFn, RunResult } from '@src/proc.js';
import { DEFAULT_ROLE_PROVIDERS, readFinders, readVerifiers, ROLES, tableFor } from '@src/roles.js';
import type { Config, ReviewConfig } from '@src/types.js';
import { isMcpList } from './helpers/codex-mcp.js';

/**
 * A verifier's MCP grants are asked about before the first turn (#388 Part C),
 * as a finder's are - refused by the setting's path. It matters more for a
 * verifier: a vote turn that cannot start counts as `cannot-tell`, so a bad
 * grant would leave every blocking finding undecided and nobody told why.
 */

function config(review: Partial<ReviewConfig>): Config {
  return {
    ...DEFAULTS,
    roles: { ...DEFAULT_ROLE_PROVIDERS },
    review: { ...DEFAULTS.review, ...review },
    codex: { ...DEFAULTS.codex, readRateLimits: false },
  };
}

function tmp(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function listing(listed: readonly string[]): { exec: RunFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec: RunFn = (_bin, argv): Promise<RunResult> => {
    calls.push([...argv]);
    assert.ok(isMcpList(argv), `only the listing may be spawned, got ${argv.join(' ')}`);
    return Promise.resolve({
      code: 0,
      signal: null,
      stdout: JSON.stringify(listed.map((name) => ({ name, enabled: true }))),
      stderr: '',
    });
  };
  return { exec, calls };
}

const neverCalled: RunFn = () => {
  throw new Error('nothing should be spawned');
};

test('a Codex verifier naming a server codex does not list is refused by its path, after a finder', async () => {
  const dir = tmp('vibe-mcp-verifier-codex-');
  const rec = listing(['a']);
  const cfg = config({
    finders: [{ provider: 'codex', mcpServers: ['f'] }],
    verifiers: ['codex', { provider: 'codex', mcpServers: ['a', 'x'] }],
  });
  const refusals = await mcpRefusals(cfg, tableFor(cfg.roles), {
    cwd: dir,
    repoDir: dir,
    exec: rec.exec,
    codexBin: () => 'codex',
  });
  assert.deepEqual(refusals, [
    `review.finders[0].mcpServers names "f", which codex mcp list does not report in ${dir}.`,
    `review.verifiers[1].mcpServers names "x", which codex mcp list does not report in ${dir}.`,
  ]);
  assert.equal(rec.calls.length, 1, 'one listing, shared');
});

test('a Claude verifier naming a server nothing defines is refused by its path, spawning nothing', async () => {
  const dir = tmp('vibe-mcp-verifier-claude-');
  const home = tmp('vibe-mcp-verifier-home-');
  const cfg = config({ verifiers: [{ provider: 'claude', mcpServers: ['nowhere'] }] });
  const refusals = await mcpRefusals(cfg, tableFor(cfg.roles), {
    cwd: dir,
    repoDir: dir,
    exec: neverCalled,
    codexBin: () => 'codex',
    home,
  });
  assert.equal(refusals.length, 1);
  assert.match(refusals[0] ?? '', /^review\.verifiers\[0\]\.mcpServers names "nowhere", which is in none of/);
});

test('verifiers that name no server spawn nothing, and neither does none at all', async () => {
  for (const verifiers of [[], ['codex', { provider: 'claude', model: 'opus' }]] as ReviewConfig['verifiers'][]) {
    const cfg = config({ verifiers });
    const refusals = await mcpRefusals(cfg, tableFor(cfg.roles), {
      cwd: process.cwd(),
      repoDir: process.cwd(),
      exec: neverCalled,
      codexBin: () => 'codex',
    });
    assert.deepEqual(refusals, []);
  }
});

test("doctor's mcp lines list each verifier's grants after the finders', and nothing more without them", () => {
  const plain = describeMcp(ROLES);
  assert.deepEqual(describeMcp(ROLES, [], []), plain);
  const cfg = config({ finders: ['claude'], verifiers: [{ provider: 'codex', mcpServers: ['docs'] }] });
  const lines = describeMcp(ROLES, readFinders(cfg), readVerifiers(cfg));
  assert.deepEqual(lines.slice(0, 5), plain.slice(0, 5));
  assert.match(lines[5] ?? '', /^finder 1:\s+none/);
  assert.match(lines[6] ?? '', /^verifier 1:\s+docs {2}\(Codex: disabled by name\)/);
  assert.deepEqual(lines.slice(7), plain.slice(5));
});

test('readVerifiers reads each entry as a seat, by its path, and none when review is absent', () => {
  const cfg = config({ verifiers: ['codex', { provider: 'claude', effort: 'high' }] });
  assert.deepEqual(readVerifiers(cfg), [
    { k: 1, path: 'review.verifiers[0]', setting: { provider: 'codex' } },
    { k: 2, path: 'review.verifiers[1]', setting: { provider: 'claude', effort: 'high' } },
  ]);
  const { review: _review, ...legacy } = cfg;
  assert.deepEqual(readVerifiers(legacy as Config), []);
});
