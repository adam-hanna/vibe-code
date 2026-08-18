import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS } from '@src/config.js';
import { adjudicate, preflight, type AgentPreflight, type PreflightProbes } from '@src/preflight.js';
import { providerAccess } from '@src/roles.js';
import type {
  AgentProvider,
  ContractViolation,
  EnvMechanism,
  Phase,
  PreparedEnvironment,
  ViolationReason,
} from '@src/runtime.js';
import type { Config, Sandbox } from '@src/types.js';

/**
 * Preflight's enforcement level, driven through injected probes.
 *
 * Nothing is spawned: `preflight` takes its probes as an argument, so the
 * verdict construction and the routing are both exercised without a `claude` or
 * `codex` child, which would need a logged-in account and cost money per case.
 */

const PHASES: readonly Phase[] = ['plan', 'implement', 'review'];

function config(sandbox: Sandbox): Config {
  return { ...DEFAULTS, codex: { ...DEFAULTS.codex, sandbox } };
}

function violation(
  provider: AgentProvider,
  tool: string,
  reason: ViolationReason,
): ContractViolation {
  return {
    provider,
    tool,
    reason,
    detail: `"${tool}" did not run in the ${provider} shell.`,
    required: reason === 'version' ? '20.0.0' : null,
    found: reason === 'version' ? '18.1.0' : null,
    hostExecutable: null,
  };
}

function prepared(mechanisms: readonly EnvMechanism[]): PreparedEnvironment {
  return { spawnEnv: {}, extraArgs: [], artifacts: [], promptHint: null, mechanisms };
}

function result(over: Partial<AgentPreflight> = {}): AgentPreflight {
  return { runtime: null, violations: [], prepared: null, probeError: null, ...over };
}

function probes(claude: AgentPreflight, codex: AgentPreflight): PreflightProbes {
  return { claude: () => Promise.resolve(claude), codex: () => Promise.resolve(codex) };
}

function report(cfg: Config, codex: AgentPreflight, claude: AgentPreflight = result()) {
  return preflight('/target', cfg, PHASES, '/work', probes(claude, codex));
}

test('a write-capable agent fails preflight on a tool probe, naming the tool and the agent', async () => {
  const codex = result({ violations: [violation('codex', 'node', 'missing')] });
  const out = await report(config('workspace-write'), codex);

  assert.equal(out.ok, false);
  assert.equal(out.blockingReasons.length, 1);
  assert.match(out.blockingReasons[0] ?? '', /node/);
  assert.match(out.blockingReasons[0] ?? '', /codex/);
  assert.deepEqual(out.warnings, []);
});

test('a write-capable agent fails preflight on a version contract violation', async () => {
  const codex = result({ violations: [violation('codex', 'node', 'version')] });
  const out = await report(config('workspace-write'), codex);

  assert.equal(out.ok, false);
  assert.equal(out.blockingReasons.length, 1);
  assert.match(out.blockingReasons[0] ?? '', /node/);
  assert.deepEqual(out.warnings, []);
});

test('a write-capable agent fails preflight when its probe itself failed', async () => {
  const out = await report(config('workspace-write'), result({ probeError: 'no output' }));

  assert.equal(out.ok, false);
  assert.deepEqual(out.blockingReasons, ['Codex probe failed: no output']);
  assert.deepEqual(out.warnings, []);
});

test('the same failures for a read-only agent still only warn', async () => {
  const codex = result({
    probeError: 'no output',
    violations: [violation('codex', 'node', 'missing'), violation('codex', 'npm', 'version')],
  });
  const out = await report(config('read-only'), codex);

  assert.equal(out.ok, true);
  assert.deepEqual(out.blockingReasons, []);
  assert.equal(out.warnings.length, 3);
  assert.ok(out.warnings.includes('Codex probe failed: no output'));
  assert.ok(out.warnings.some((warning) => warning.includes('node')));
  assert.ok(out.warnings.some((warning) => warning.includes('npm')));
});

test('a sandbox-policy violation blocks whatever the agent is permitted to do', async () => {
  for (const sandbox of ['read-only', 'workspace-write'] as const) {
    const codex = result({ prepared: prepared(['sandbox-policy', 'spawn-env']) });
    const out = await report(config(sandbox), codex);

    assert.equal(out.ok, false);
    assert.equal(out.blockingReasons.length, 1);
    assert.match(out.blockingReasons[0] ?? '', /danger-full-access/);
  }
});

test('Claude keeps blocking on a contract violation under the default config', async () => {
  const claude = result({ violations: [violation('claude', 'node', 'missing')] });
  const out = await report(config('read-only'), result(), claude);

  assert.equal(out.ok, false);
  assert.equal(out.blockingReasons.length, 1);
  assert.match(out.blockingReasons[0] ?? '', /node/);
  assert.deepEqual(out.warnings, []);
});

test('a blocked tool is reported alongside the sandbox policy, not folded into it', () => {
  const { blockingReasons } = adjudicate(
    [
      {
        provider: 'codex',
        access: 'write',
        result: result({
          violations: [violation('codex', 'node', 'unreachable')],
          prepared: prepared(['sandbox-policy', 'spawn-env']),
        }),
      },
    ],
    config('workspace-write'),
  );

  assert.equal(blockingReasons.length, 2);
  assert.ok(blockingReasons.some((reason) => reason.includes('node')));
  assert.ok(blockingReasons.some((reason) => reason.includes('danger-full-access')));
});

test('access follows what the agent may do, not which agent it is', () => {
  assert.equal(providerAccess('codex', config(DEFAULTS.codex.sandbox)), 'read-only');
  assert.equal(providerAccess('codex', config('workspace-write')), 'write');
  assert.equal(providerAccess('codex', config('danger-full-access')), 'write');

  for (const sandbox of ['read-only', 'workspace-write', 'danger-full-access'] as const) {
    assert.equal(providerAccess('claude', config(sandbox)), 'write');
  }
});
