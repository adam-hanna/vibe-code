import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '@src/config.js';

/**
 * `roleSetting` takes a config path now, not a `Role` (#388, owner 2026-10-20),
 * so `roles.<role>` and `review.finders[i]` go through one validator. The claim
 * that change has to keep: every `roles.<role>` message reads byte for byte as
 * it did before. Each is asserted whole, through `loadConfig` of a project file
 * - the road a person's mistake actually takes - and each expected string is
 * the message as the code before the change built it.
 */

function refusal(roles: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibe-role-path-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ roles }));
  try {
    loadConfig(dir);
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error('expected a refusal');
}

const CASES: readonly [string, unknown, string][] = [
  [
    'a provider that is not one',
    { reviewer: 'gemini' },
    'roles.reviewer is "gemini"; expected "claude" or "codex", or an object naming a provider and ' +
      'optionally a model, an effort, a timeout and MCP servers',
  ],
  [
    'a value that is neither form',
    { critic: 42 },
    'roles.critic is 42; expected "claude" or "codex", or an object naming a provider and ' +
      'optionally a model, an effort, a timeout and MCP servers',
  ],
  [
    'an unknown key',
    { planner: { provider: 'claude', focus: 'x' } },
    'roles.planner has unknown key "focus"; a role object takes provider, model, effort, timeoutMs and mcpServers',
  ],
  [
    'no provider',
    { reviewer: { effort: 'max' } },
    'roles.reviewer is an object with no provider. provider is required so that adding an ' +
      'effort cannot silently move a role back to the default agent.',
  ],
  [
    'a bad provider inside the object',
    { answerer: { provider: 'gemini' } },
    'roles.answerer is "gemini"; expected "claude" or "codex", or an object naming a provider and ' +
      'optionally a model, an effort, a timeout and MCP servers',
  ],
  [
    'an effort outside the enum',
    { reviewer: { provider: 'codex', effort: 'huge' } },
    'roles.reviewer.effort is "huge"; must be one of low, medium, high, xhigh, max',
  ],
  [
    'a blank model',
    { implementer: { provider: 'claude', model: ' ' } },
    'roles.implementer.model is " "; must be a non-empty model name string, or absent for claude.model',
  ],
  [
    'a timeout that is not positive',
    { critic: { provider: 'codex', timeoutMs: 0 } },
    "roles.critic.timeoutMs is 0; must be a positive number of milliseconds, or absent for codex's own timeout",
  ],
  [
    'MCP servers that are not a list of names',
    { reviewer: { provider: 'codex', mcpServers: [''] } },
    'roles.reviewer.mcpServers is [""]; must be an array of MCP server names, or absent for none',
  ],
];

for (const [what, roles, message] of CASES) {
  test(`roles.<role> reads as it always has: ${what}`, () => {
    assert.equal(refusal(roles), message);
  });
}
