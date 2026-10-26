import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { main, reportRoles } from '@src/cli.js';
import { DEFAULTS } from '@src/config.js';
import { describeMcp, mcpRefusals } from '@src/mcp.js';
import { EXIT } from '@src/orchestrator.js';
import { preflight } from '@src/preflight.js';
import type { AgentPreflight, PreflightProbes } from '@src/preflight.js';
import type { RunFn } from '@src/proc.js';
import { readFinders, readVerifiers, ROLES, seatProviders, seatTable, slotForRole, tableFor } from '@src/roles.js';
import type { RoleProviders } from '@src/roles.js';
import type { EnvMechanism, Phase, PreparedEnvironment } from '@src/runtime.js';
import type { Config, CritiqueConfig } from '@src/types.js';

// `doctor-review-seats.test.ts`' reason: only so `resolveBin` succeeds where
// neither CLI is installed. Nothing here spawns either.
process.env['VIBE_CLAUDE_BIN'] = process.execPath;
process.env['VIBE_CODEX_BIN'] = process.execPath;

/**
 * The plan critique's seats (#405), everywhere the review's seats are named:
 * the seat's row, the readers, the preflight, the MCP refusals and listing,
 * doctor and the line before the first turn. Each case also holds that the
 * review's own output is what it was.
 */

function withCritique(critique: Partial<CritiqueConfig>, over: Partial<Config> = {}): Config {
  return { ...DEFAULTS, codex: { ...DEFAULTS.codex, readRateLimits: false }, critique: { ...DEFAULTS.critique, ...critique }, ...over };
}

test("a critique seat copies the critic's row, on a fresh slot, and leaves every other row alone", () => {
  for (const provider of ['claude', 'codex'] as const) {
    const table = seatTable(ROLES, { provider, model: 'seat-model' }, undefined, 'critic');
    assert.equal(table.critic.access, 'read-only');
    assert.equal(table.critic.schema, ROLES.critic.schema);
    assert.equal(table.critic.provider, provider);
    assert.equal(table.critic.model, 'seat-model');
    assert.equal(slotForRole('critic', table), provider === 'claude' ? 'fresh-claude' : 'fresh-codex');
    assert.deepEqual(table.reviewer, ROLES.reviewer);
  }
  const schema = { type: 'object' };
  assert.equal(seatTable(ROLES, { provider: 'codex' }, schema, 'critic').critic.schema, schema);
  // The default is the reviewer's row, as every review caller has it.
  assert.deepEqual(seatTable(ROLES, { provider: 'codex' }).critic, ROLES.critic);
});

test('the readers take the section, and name its paths', () => {
  const cfg = withCritique({ finders: ['codex', { provider: 'claude', focus: 'the brief' }], verifiers: ['claude'] });
  assert.deepEqual(
    readFinders(cfg, 'critique').map((f) => [f.k, f.path, f.setting.provider, f.focus]),
    [
      [1, 'critique.finders[0]', 'codex', undefined],
      [2, 'critique.finders[1]', 'claude', 'the brief'],
    ],
  );
  assert.deepEqual(readVerifiers(cfg, 'critique').map((v) => v.path), ['critique.verifiers[0]']);
  assert.deepEqual(readFinders(cfg), [], 'the review list is its own');
  const { critique: _c, ...legacy } = cfg;
  assert.deepEqual(readFinders(legacy as Config, 'critique'), [], 'no section is no seats');
});

const ALL_CLAUDE: RoleProviders = {
  planner: 'claude',
  implementer: 'claude',
  critic: 'claude',
  answerer: 'claude',
  reviewer: 'claude',
};

function blockedCodex(): PreflightProbes {
  const ok = (over: Partial<AgentPreflight> = {}): AgentPreflight => ({
    runtime: null,
    violations: [],
    prepared: null,
    probeError: null,
    ...over,
  });
  const prepared: PreparedEnvironment = {
    spawnEnv: {},
    extraArgs: [],
    artifacts: [],
    promptHint: null,
    mechanisms: ['sandbox-policy', 'spawn-env'] as EnvMechanism[],
  };
  return { claude: () => Promise.resolve(ok()), codex: () => Promise.resolve(ok({ prepared })) };
}

test('a Codex that only a critique verifier uses counts for the preflight', async () => {
  const cfg = withCritique(
    { verifiers: ['codex'] },
    { roles: ALL_CLAUDE, codex: { ...DEFAULTS.codex, readRateLimits: false, sandbox: 'workspace-write' } },
  );
  assert.deepEqual(seatProviders(cfg), ['codex']);
  const phases: readonly Phase[] = ['plan', 'implement', 'review'];
  const report = await preflight('/target', cfg, phases, '/work', blockedCodex());
  assert.equal(report.ok, false);
  assert.ok(report.blockingReasons.some((r) => r.includes('sandbox blocks required tools')));
});

const neverCalled: RunFn = () => {
  throw new Error('nothing should be spawned');
};

test("a critique seat's MCP grant is refused by its own path", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-mcp-critique-'));
  const home = mkdtempSync(path.join(tmpdir(), 'vibe-mcp-critique-home-'));
  const cfg = withCritique({ verifiers: ['codex', { provider: 'claude', mcpServers: ['nowhere'] }] });
  const refusals = await mcpRefusals(cfg, tableFor(cfg.roles), {
    cwd: dir,
    repoDir: dir,
    exec: neverCalled,
    codexBin: () => 'codex',
    home,
  });
  assert.equal(refusals.length, 1);
  assert.match(refusals[0] ?? '', /^critique\.verifiers\[1\]\.mcpServers names "nowhere", which is in none of/);
});

test("doctor's mcp lines name critique seats by section, after the review's, and nothing without them", () => {
  const plain = describeMcp(ROLES);
  assert.deepEqual(describeMcp(ROLES, [], [], { finders: [], verifiers: [] }), plain);
  const cfg = withCritique({ finders: ['claude'], verifiers: [{ provider: 'codex', mcpServers: ['docs'] }] });
  const lines = describeMcp(ROLES, [], [], {
    finders: readFinders(cfg, 'critique'),
    verifiers: readVerifiers(cfg, 'critique'),
  });
  assert.match(lines[5] ?? '', /^critique finder 1:\s+none {2}\(Claude: replaced/);
  assert.match(lines[6] ?? '', /^critique verifier 1:\s+docs {2}\(Codex: disabled by name\)/);
  assert.equal(lines.length, plain.length + 2);
});

function captured(work: () => unknown): string[] {
  const out: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...parts: unknown[]): void => void out.push(parts.map((p) => String(p)).join(' '));
  console.log = collect;
  console.error = collect;
  try {
    work();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return out;
}

test("the run's startup names the critique seats, and says nothing without them", () => {
  const seated = withCritique({ finders: [{ provider: 'claude', model: 'opus', effort: 'high' }], verifiers: ['codex', 'claude'] });
  const named = (out: readonly string[]): string[] => out.filter((l) => l.includes('Critique '));
  assert.deepEqual(named(captured(() => reportRoles(seated))), [
    '  Critique finders: claude@opus/high',
    '  Critique verifiers: codex claude',
    '  Critique vote: 2 of 2 (a majority), unconfirmed P0 block',
  ]);
  const halting = withCritique({ verifiers: ['codex', 'claude', 'codex'], quorum: 2, unconfirmedP0: 'halt' });
  assert.deepEqual(
    named(captured(() => reportRoles(halting))).filter((l) => l.includes('Critique vote')),
    ['  Critique vote: 2 of 3, unconfirmed P0 halt'],
  );
  // Finders alone cast no vote, so there is no policy to state.
  const findersOnly = withCritique({ finders: ['codex'] });
  assert.equal(named(captured(() => reportRoles(findersOnly))).some((l) => l.includes('Critique vote')), false);
  assert.deepEqual(named(captured(() => reportRoles(DEFAULTS))), []);
});

async function doctor(critique: unknown): Promise<{ code: number; lines: string[] }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-doctor-critique-'));
  writeFileSync(
    path.join(dir, 'vibe.config.json'),
    JSON.stringify({
      codex: { readRateLimits: false, model: 'gpt-fixture', effort: 'high', timeoutMs: 111_000 },
      claude: { model: 'claude-fixture', effort: 'low', planTimeoutMs: 333_000 },
      // No review finder, the default one included (#447): these cases are the
      // critique's block, and say no review block is printed beside it.
      review: { finders: [] },
      ...(critique === undefined ? {} : { critique }),
    }),
    'utf8',
  );
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const collect = (...parts: unknown[]): void => void lines.push(parts.map((p) => String(p)).join(' '));
  console.log = collect;
  console.error = collect;
  try {
    return { code: await main(['doctor', '-C', dir, '--skip-probe']), lines };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test('doctor lists the critique seats, quorum and unconfirmed P0 under their own headers', async () => {
  const { code, lines } = await doctor({
    finders: [{ provider: 'codex', model: 'finder-fixture', focus: 'the brief' }],
    verifiers: ['claude', 'codex', 'codex'],
    quorum: 2,
    unconfirmedP0: 'halt',
  });
  assert.equal(code, EXIT.OK);
  const findersAt = lines.findIndex((l) => l.includes('critique finders (each critiques every plan round; one extra turn per plan round per finder)'));
  const verifiersAt = lines.findIndex((l) =>
    l.includes('critique verifiers (each votes on every blocking plan finding not deferred; one extra turn per such finding per verifier)'),
  );
  assert.ok(findersAt >= 0 && verifiersAt > findersAt, 'both headers, finders first');
  assert.match(lines[findersAt + 1] ?? '', /finder 1\s+codex\s+finder-fixture \/ high \/ 111000ms {2}focus: "the brief"$/);
  assert.match(lines[verifiersAt + 1] ?? '', /verifier 1\s+claude\s+claude-fixture \/ low \/ 333000ms$/);
  assert.match(lines[verifiersAt + 4] ?? '', /quorum\s+2 of 3$/);
  assert.match(lines[verifiersAt + 5] ?? '', /unconfirmed P0\s+halt$/);
  assert.equal(lines.some((l) => l.includes('review finders') || l.includes('review verifiers')), false);
  assert.ok(lines.some((l) => /^\s+critique verifier 3:/.test(l)), 'the mcp lines name the critique seats');
});

test('under the defaults doctor prints no critique block', async () => {
  const { code, lines } = await doctor(undefined);
  assert.equal(code, EXIT.OK);
  assert.equal(lines.some((l) => l.includes('critique finders') || l.includes('critique verifiers') || l.includes('critique finder')), false);
});

test("the startup says the critique's own bound only when its seats can overlap (#452)", () => {
  const named = (out: readonly string[]): string[] => out.filter((l) => /parallel:/i.test(l));
  const four = withCritique({ verifiers: ['codex', 'claude'], maxParallel: 4 });
  assert.deepEqual(named(captured(() => reportRoles(four))), ['  Critique parallel: up to 4 seat turns at once']);
  // At 1, and with no seats at 4, nothing; and the review's bound is not the critique's.
  assert.deepEqual(named(captured(() => reportRoles(withCritique({ verifiers: ['codex'], maxParallel: 1 })))), []);
  assert.deepEqual(named(captured(() => reportRoles(withCritique({ maxParallel: 4 })))), []);
  const reviewOnly = withCritique({ verifiers: ['codex'] }, { review: { ...DEFAULTS.review, verifiers: ['codex'], maxParallel: 4 } });
  assert.deepEqual(named(captured(() => reportRoles(reviewOnly))), ['  Parallel: up to 4 seat turns at once']);
});

test("doctor says how many critique seat turns may run at once, and what that costs (#452)", async () => {
  const parallel = (lines: readonly string[]): string[] => lines.filter((l) => /^\s+parallel\s/.test(l));
  const one = await doctor({ verifiers: ['codex', 'codex'] });
  assert.equal(one.code, EXIT.OK);
  const [row] = parallel(one.lines);
  assert.match(row ?? '', /\s1 \(one after another\)$/);
  const p0 = one.lines.findIndex((l) => /^\s+unconfirmed P0\s/.test(l));
  assert.equal(one.lines.indexOf(row ?? ''), p0 + 1, 'the parallel row follows unconfirmed P0');

  const four = await doctor({ finders: ['codex'], maxParallel: 4 });
  assert.deepEqual(
    parallel(four.lines).map((l) => l.trim()),
    ["parallel  4 at once (Codex turns can overshoot budget.maxTokens by up to 4 turns' spend)"],
  );
  // And with no critique seats, no row.
  assert.deepEqual(parallel((await doctor(undefined)).lines), []);
});
