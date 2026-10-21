import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '@src/config.js';
import { preflight } from '@src/preflight.js';
import type { AgentPreflight, PreflightProbes } from '@src/preflight.js';
import type { RoleProviders } from '@src/roles.js';
import type { EnvMechanism, Phase, PreparedEnvironment } from '@src/runtime.js';
import type { Config, ReviewConfig } from '@src/types.js';

/**
 * Preflight covers every seat (#388 Part C, from Part B's follow-ups).
 *
 * Both agents are probed on every run, so a provider only a review seat uses
 * is already probed before the first turn; this pins it. What used to ignore
 * the seats is the one verdict preflight draws from vibe's own resolution - a
 * Codex sandbox that blocks the toolchain - which was gated on Codex holding a
 * role. A Codex verifier is spawned into that sandbox too, and one that cannot
 * run casts `cannot-tell` on every vote: the vote would silently do nothing.
 */

const ALL_CLAUDE: RoleProviders = {
  planner: 'claude',
  implementer: 'claude',
  critic: 'claude',
  answerer: 'claude',
  reviewer: 'claude',
};

const PHASES: readonly Phase[] = ['plan', 'implement', 'review'];

function config(review: Partial<ReviewConfig>): Config {
  return {
    ...DEFAULTS,
    roles: ALL_CLAUDE,
    codex: { ...DEFAULTS.codex, readRateLimits: false, sandbox: 'workspace-write' },
    review: { ...DEFAULTS.review, ...review },
  };
}

function result(over: Partial<AgentPreflight> = {}): AgentPreflight {
  return { runtime: null, violations: [], prepared: null, probeError: null, ...over };
}

function prepared(mechanisms: readonly EnvMechanism[]): PreparedEnvironment {
  return { spawnEnv: {}, extraArgs: [], artifacts: [], promptHint: null, mechanisms };
}

function recording(codex: AgentPreflight): { probes: PreflightProbes; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    probes: {
      claude: () => {
        asked.push('claude');
        return Promise.resolve(result());
      },
      codex: () => {
        asked.push('codex');
        return Promise.resolve(codex);
      },
    },
  };
}

const BLOCKED = result({ prepared: prepared(['sandbox-policy', 'spawn-env']) });

test('a Codex verifier under an all-Claude table is probed, and its blocked sandbox refuses the run', async () => {
  const { probes, asked } = recording(BLOCKED);
  const report = await preflight('/target', config({ verifiers: ['codex'] }), PHASES, '/work', probes);
  assert.deepEqual(asked, ['claude', 'codex']);
  assert.equal(report.ok, false);
  assert.ok(report.blockingReasons.some((r) => r.includes('sandbox blocks required tools')));
});

test('a Codex finder alone counts the same way', async () => {
  const { probes } = recording(BLOCKED);
  const report = await preflight('/target', config({ finders: ['codex'] }), PHASES, '/work', probes);
  assert.equal(report.ok, false);
});

test('the same verdict with no seat on Codex does not block, as before', async () => {
  for (const review of [{}, { verifiers: ['claude'] }] as Partial<ReviewConfig>[]) {
    const { probes } = recording(BLOCKED);
    const report = await preflight('/target', config(review), PHASES, '/work', probes);
    assert.equal(report.ok, true);
    assert.deepEqual(report.blockingReasons, []);
  }
});

test("a seat's failed probe stays a warning, as a read-only role's does", async () => {
  const { probes } = recording(result({ probeError: 'no output' }));
  const report = await preflight('/target', config({ verifiers: ['codex'] }), PHASES, '/work', probes);
  assert.equal(report.ok, true);
  assert.ok(report.warnings.some((w) => w.includes('Codex probe failed: no output')));
});
