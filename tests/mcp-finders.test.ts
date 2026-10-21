import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { describeMcp, mcpRefusals } from '@src/mcp.js';
import type { RunFn, RunResult } from '@src/proc.js';
import { DEFAULT_ROLE_PROVIDERS, readFinders, ROLES, tableFor } from '@src/roles.js';
import type { RoleProviders } from '@src/roles.js';
import type { Config, ReviewConfig } from '@src/types.js';
import { isMcpList } from './helpers/codex-mcp.js';

/**
 * A finder's MCP grants are asked about before the first turn (#388 Part B, P1),
 * exactly as a role's are - refused by the setting's path, so a mistyped name
 * costs a sentence rather than a review round. A config whose finders name no
 * server spawns nothing here, as a default config never has.
 */

function config(review: Partial<ReviewConfig>, roles: Partial<RoleProviders> = {}): Config {
  return {
    ...DEFAULTS,
    roles: { ...DEFAULT_ROLE_PROVIDERS, ...roles },
    review: { ...DEFAULTS.review, ...review },
    codex: { ...DEFAULTS.codex, readRateLimits: false },
  };
}

function tmp(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** A codex whose `mcp list` reports `listed`, counting every call. */
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

test('a Codex finder naming a server codex does not list is refused by its path', async () => {
  const dir = tmp('vibe-mcp-finder-codex-');
  const rec = listing(['a']);
  const cfg = config({ finders: ['codex', { provider: 'codex', mcpServers: ['a', 'x'] }] });
  const refusals = await mcpRefusals(cfg, tableFor(cfg.roles), {
    cwd: dir,
    repoDir: dir,
    exec: rec.exec,
    codexBin: () => 'codex',
  });
  assert.deepEqual(refusals, [
    `review.finders[1].mcpServers names "x", which codex mcp list does not report in ${dir}.`,
  ]);
  assert.equal(rec.calls.length, 1, 'one listing, shared');
});

test('a Claude finder naming a server nothing defines is refused by its path, spawning nothing', async () => {
  const dir = tmp('vibe-mcp-finder-claude-');
  const home = tmp('vibe-mcp-finder-home-');
  const cfg = config({ finders: [{ provider: 'claude', mcpServers: ['nowhere', 'claude.ai Gmail'] }] });
  const refusals = await mcpRefusals(cfg, tableFor(cfg.roles), {
    cwd: dir,
    repoDir: dir,
    exec: neverCalled,
    codexBin: () => 'codex',
    home,
  });
  assert.equal(refusals.length, 2);
  assert.match(refusals[0] ?? '', /^review\.finders\[0\]\.mcpServers names "nowhere", which is in none of/);
  assert.match(refusals[1] ?? '', /^review\.finders\[0\]\.mcpServers names "claude\.ai Gmail", a claude\.ai connector/);
});

test("a role's refusal still reads as it did, beside a finder's", async () => {
  const dir = tmp('vibe-mcp-finder-both-');
  const rec = listing([]);
  const cfg = config(
    { finders: [{ provider: 'codex', mcpServers: ['y'] }] },
    { reviewer: { provider: 'codex', mcpServers: ['missing'] } },
  );
  const refusals = await mcpRefusals(cfg, tableFor(cfg.roles), {
    cwd: dir,
    repoDir: dir,
    exec: rec.exec,
    codexBin: () => 'codex',
  });
  assert.deepEqual(refusals, [
    `roles.reviewer.mcpServers names "missing", which codex mcp list does not report in ${dir}.`,
    `review.finders[0].mcpServers names "y", which codex mcp list does not report in ${dir}.`,
  ]);
  assert.equal(rec.calls.length, 1);
});

test('finders that name no server spawn nothing, and neither does no finder at all', async () => {
  for (const finders of [[], ['codex', { provider: 'claude', model: 'opus' }]] as ReviewConfig['finders'][]) {
    const cfg = config({ finders });
    const refusals = await mcpRefusals(cfg, tableFor(cfg.roles), {
      cwd: process.cwd(),
      repoDir: process.cwd(),
      exec: neverCalled,
      codexBin: () => 'codex',
    });
    assert.deepEqual(refusals, []);
  }
});

test("doctor's mcp lines list each finder's grants after the roles', and nothing more without them", () => {
  const plain = describeMcp(ROLES);
  assert.deepEqual(describeMcp(ROLES, []), plain);
  const cfg = config({ finders: ['claude', { provider: 'codex', mcpServers: ['docs'] }] });
  const lines = describeMcp(ROLES, readFinders(cfg));
  assert.deepEqual(lines.slice(0, 5), plain.slice(0, 5));
  assert.match(lines[5] ?? '', /^finder 1:\s+none {2}\(Claude: replaced/);
  assert.match(lines[6] ?? '', /^finder 2:\s+docs {2}\(Codex: disabled by name\)/);
  assert.deepEqual(lines.slice(7), plain.slice(5));
});
