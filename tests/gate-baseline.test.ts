import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportInheritedGates } from '@src/cli.js';
import { DEFAULTS } from '@src/config.js';
import { commitFork, planFork } from '@src/fork.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import { listCheckpoints, loadRun } from '@src/run.js';
import { validateStoredState } from '@src/stored.js';
import type { Config, Finding, GatesConfig, LoopConfig, RunState, VerifyConfig } from '@src/types.js';
import {
  agents,
  commitTree,
  committing,
  config,
  freshRun,
  markerGate,
  markerRuns,
  planFixture,
  report,
  unlaunchableVerify,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';

/**
 * Each gate, run once against the tree the run started from (#484).
 *
 * The gates here decide by a marker file rather than by an execution count,
 * because a baseline is a question about a tree: a committed marker is a
 * failure the run inherited, a turn that deletes it is the run fixing it, and a
 * turn that creates it is the run breaking it.
 */

const MARKER = 'BROKEN';

function startRun(prefix: string, planOnly = false): RunState {
  return freshRun({ prefix: `vibe-baseline-${prefix}-`, task: 'baseline', planOnly, git: true, commit: true });
}

function matrix(over: Partial<GatesConfig> = {}): GatesConfig {
  return {
    'plan-round': 'auto',
    'question-round': 'auto',
    'plan-approved': 'auto',
    implemented: 'auto',
    'verify-round': 'auto',
    'review-round': 'auto',
    ...over,
  };
}

/** The legacy single-command gate, `verification`, failing while `MARKER` exists. */
function legacy(state: RunState, verify: Partial<VerifyConfig> = {}): Partial<VerifyConfig> {
  return { command: markerGate(state, 'verification', MARKER), ...verify };
}

function cfgFor(
  verify: Partial<VerifyConfig>,
  loop: Partial<LoopConfig> = {},
  over: Partial<Config> = {},
): Config {
  return config(
    { maxVerifyRounds: 2, ...loop },
    {
      ...committing(),
      gates: matrix(),
      verify: { ...DEFAULTS.verify, enabled: true, runs: 1, timeoutMs: 30_000, ...verify },
      ...over,
    },
  );
}

type Turn = (state: RunState) => void;

/**
 * A run whose implement and verify-fix turns do what the case says to the tree,
 * and always leave a file of their own, so every round has a diff to review.
 */
function handlers(state: RunState, turns: { implement?: Turn; verifyFix?: Turn } = {}): Handlers {
  return {
    claude: (label) => {
      if (label === 'plan' || label.startsWith('revise')) return planFixture();
      if (label === 'implement') turns.implement?.(state);
      if (label.startsWith('verify-fix')) turns.verifyFix?.(state);
      work(state, `${label}.txt`);
      return `did ${label}`;
    },
    codex: () => report([]),
  };
}

interface Driven {
  seen: Narration[];
  calls: string[];
  prompts: Map<string, string>;
  err: unknown;
}

async function drive(state: RunState, cfg: Config, h: Handlers, resume = false): Promise<Driven> {
  const seen: Narration[] = [];
  const calls: string[] = [];
  const prompts = new Map<string, string>();
  const wrapped: Handlers = {
    ...h,
    claude: (label, options) => {
      prompts.set(label, options.prompt);
      return h.claude?.(label, options);
    },
  };
  const realLog = console.log;
  const realError = console.error;
  log.setSink((n) => void seen.push(n));
  console.log = () => undefined;
  console.error = () => undefined;
  let err: unknown = null;
  try {
    await orchestrate(state, cfg, resume, agents(wrapped, calls));
  } catch (e) {
    err = e;
  } finally {
    log.setSink(null);
    console.log = realLog;
    console.error = realError;
  }
  return { seen, calls, prompts, err };
}

/** What `reportInheritedGates` says, as narration. */
function reported(state: RunState): Narration[] {
  const seen: Narration[] = [];
  const realLog = console.log;
  log.setSink((n) => void seen.push(n));
  console.log = () => undefined;
  try {
    reportInheritedGates(state);
  } finally {
    log.setSink(null);
    console.log = realLog;
  }
  return seen;
}

const said = (seen: readonly Narration[], id: string): Narration[] => seen.filter((n) => n.id === id);

function checkpointStates(state: RunState): Record<string, unknown>[] {
  return listCheckpoints(state.dir).map(
    (c) =>
      JSON.parse(readFileSync(path.join(state.dir, `checkpoint-${c.n}.json`), 'utf8')) as Record<string, unknown>,
  );
}

function assertNoBaseline(state: RunState, d: Driven): void {
  assert.equal(state.gateBaseline, undefined, 'no record in memory');
  assert.equal(state.baselineDue, undefined, 'no flag in memory');
  const stored = JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as Record<string, unknown>;
  assert.equal('gateBaseline' in stored, false, 'no record in state.json');
  assert.equal('baselineDue' in stored, false, 'no flag in state.json');
  for (const snapshot of checkpointStates(state)) {
    assert.equal('gateBaseline' in snapshot, false, 'no record at any checkpoint');
    assert.equal('baselineDue' in snapshot, false, 'no flag at any checkpoint');
  }
  assert.deepEqual(
    readdirSync(state.dir).filter((f) => f.startsWith('gate-baseline')),
    [],
    'no baseline artifact',
  );
  assert.deepEqual(said(d.seen, 'gate_baseline'), [], 'nothing said');
}

// ---- what is recorded -------------------------------------------------------

test('every gate passing at the start is recorded once each, from a clean tree, at info', async () => {
  const state = startRun('pass');
  const cfg = cfgFor(legacy(state));
  commitTree(state);
  const d = await drive(state, cfg, handlers(state));

  assert.equal(d.err, null, String(d.err));
  const record = state.gateBaseline;
  assert.ok(record !== undefined);
  assert.equal(record.sha, state.baseSha, "markBase's answer");
  assert.match(record.sha ?? '', /^[0-9a-f]{40}$/);
  assert.equal(record.clean, true);
  assert.deepEqual(record.gates, [
    {
      name: 'verification',
      command: `node vibe-marker-verification.mjs`,
      status: 'passed',
      exitCode: 0,
      required: true,
      runs: 1,
      log: null,
    },
  ]);
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(state.dir, 'gate-baseline.json'), 'utf8')),
    record,
    'the artifact is the state record',
  );
  assert.equal(state.baselineDue, undefined, 'the debt is paid');
  const lines = said(d.seen, 'gate_baseline');
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.level, 'info');
  assert.match(lines[0]?.message ?? '', /clean tree/);
  // One baseline run, then one verification.
  assert.equal(markerRuns(state, 'verification'), 2);
  assert.equal(state.events.some((e) => e.type === 'gate_baseline'), false, 'narration, not an event');
});

test('a gate failing at the start that the run fixes is recorded with its log, and said at warn', async () => {
  const state = startRun('fixed');
  const cfg = cfgFor(legacy(state));
  writeFileSync(path.join(state.targetDir, MARKER), 'x', 'utf8');
  commitTree(state);
  const d = await drive(state, cfg, handlers(state, { implement: (s) => rmSync(path.join(s.targetDir, MARKER)) }));

  assert.equal(d.err, null, String(d.err));
  const entry = state.gateBaseline?.gates[0];
  assert.equal(entry?.status, 'failed');
  assert.equal(entry?.exitCode, 1);
  assert.equal(entry?.runs, 1);
  assert.equal(entry?.log, 'gate-baseline-verification.log');
  assert.match(readFileSync(path.join(state.dir, 'gate-baseline-verification.log'), 'utf8'), /MARKER BROKEN PRESENT/);
  const lines = said(d.seen, 'gate_baseline');
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.level, 'warn');
  assert.deepEqual(lines[0]?.data?.['gates'], [{ name: 'verification', status: 'failed' }]);
  assert.equal(d.calls.some((c) => c.startsWith('verify-fix')), false, 'the gate passed after implementation');

  const end = reported(state);
  assert.equal(end.length, 1);
  assert.equal(end[0]?.level, 'info');
  assert.match(end[0]?.message ?? '', /passed at the last verification/);
});

test('a gate failing at the start and after implementation is still the same P0, and the fixer is told', async () => {
  const state = startRun('inherited');
  // Two rounds, not one: `guardProgress` gets round 1 against a cap of 1 and
  // stops before any fix prompt is built.
  const cfg = cfgFor(legacy(state), { maxVerifyRounds: 2 });
  writeFileSync(path.join(state.targetDir, MARKER), 'x', 'utf8');
  commitTree(state);
  const d = await drive(state, cfg, handlers(state));

  assert.ok(d.err instanceof Escalation, String(d.err));
  assert.equal(d.err.code, EXIT.NO_CONVERGENCE);
  assert.ok(d.calls.includes('verify-fix-1'), 'the inherited failure still cost a verify round');
  const logPath = path.join(state.dir, 'gate-baseline-verification.log');
  const sentence =
    `This gate also failed at the start commit ${(state.gateBaseline?.sha ?? '').slice(0, 7)}, ` +
    `before this run changed anything; that output is ${logPath}.`;
  assert.ok(d.prompts.get('verify-fix-1')?.includes(sentence), 'the fixer was told');

  const finding: Finding | undefined = (d.err.findings ?? []).find((f) => f.id === 'verification-failing');
  assert.ok(finding !== undefined, 'the escalation carries the gate finding');
  assert.equal(finding.severity, 'P0');
  assert.ok(finding.detail.endsWith(sentence), finding.detail);

  const end = reported(state);
  assert.equal(end.length, 1);
  assert.equal(end[0]?.level, 'warn');
  assert.match(end[0]?.message ?? '', /failed again at the last verification/);
  assert.ok(end[0]?.message.includes(logPath));
});

test('a stop after a verification fix says what the last verification saw, not what the tree is', async () => {
  const state = startRun('stale');
  const cfg = cfgFor(legacy(state), { maxVerifyRounds: 2 }, { gates: matrix({ 'verify-round': 'stop' }) });
  writeFileSync(path.join(state.targetDir, MARKER), 'x', 'utf8');
  commitTree(state);
  const d = await drive(state, cfg, handlers(state, { verifyFix: (s) => rmSync(path.join(s.targetDir, MARKER)) }));

  assert.ok(d.err instanceof Escalation && d.err.code === EXIT.NEEDS_HUMAN, String(d.err));
  assert.equal(state.gateOutcomes?.[0]?.status, 'failed', 'the pre-fix outcome is what state holds');
  const runs = markerRuns(state, 'verification');
  const end = reported(state);
  assert.equal(end.length, 1);
  const message = end[0]?.message ?? '';
  assert.match(message, /at the last verification/);
  assert.doesNotMatch(message, /still fails|passes now/);
  assert.equal(markerRuns(state, 'verification'), runs, 'reporting never runs a gate');
});

test('a gate that passed at the start leaves the fixer prompt exactly as it was', async () => {
  const run = async (prefix: string, verify: Partial<VerifyConfig>): Promise<{ state: RunState; prompt: string }> => {
    const state = startRun(prefix);
    const cfg = cfgFor(legacy(state, verify));
    commitTree(state);
    const d = await drive(
      state,
      cfg,
      handlers(state, {
        implement: (s) => writeFileSync(path.join(s.targetDir, MARKER), 'x', 'utf8'),
        verifyFix: (s) => rmSync(path.join(s.targetDir, MARKER)),
      }),
    );
    assert.equal(d.err, null, String(d.err));
    const prompt = d.prompts.get('verify-fix-1');
    assert.ok(prompt !== undefined);
    return {
      state,
      prompt: prompt.split(state.dir).join('<dir>').split(state.targetDir).join('<target>').split(state.id).join('<id>'),
    };
  };
  const off = await run('prompt-off', { baseline: false });
  const on = await run('prompt-on', {});
  assert.equal(on.state.gateBaseline?.gates[0]?.status, 'passed');
  assert.equal(off.state.gateBaseline, undefined);
  assert.equal(on.prompt, off.prompt);
});

test('a failure at the start does not stop the sequence: every gate is run', async () => {
  const state = startRun('two');
  const cfg = cfgFor({
    gates: [
      { name: 'a', command: markerGate(state, 'a', 'MARK-A') },
      { name: 'b', command: markerGate(state, 'b', 'MARK-B') },
    ],
  });
  writeFileSync(path.join(state.targetDir, 'MARK-A'), 'x', 'utf8');
  commitTree(state);
  const d = await drive(state, cfg, handlers(state, { implement: (s) => rmSync(path.join(s.targetDir, 'MARK-A')) }));

  assert.equal(d.err, null, String(d.err));
  assert.deepEqual(
    state.gateBaseline?.gates.map((g) => [g.name, g.status, g.runs]),
    [
      ['a', 'failed', 1],
      ['b', 'passed', 1],
    ],
  );
  // Once at the baseline and once in verification.
  assert.equal(markerRuns(state, 'b'), 2, 'b ran at the baseline, behind a failing a');
});

test('an unlaunchable command is recorded at the start and escalates only in verification', async () => {
  const state = startRun('unlaunchable');
  const cfg = cfgFor((unlaunchableVerify().verify ?? {}) as Partial<VerifyConfig>);
  // Nothing to commit: this gate has no script in the tree, so it starts clean.
  const d = await drive(state, cfg, handlers(state));

  const entry = state.gateBaseline?.gates[0];
  assert.equal(entry?.status, 'unlaunchable');
  assert.equal(entry?.runs, 1);
  assert.equal(entry?.log, 'gate-baseline-verification.log');
  assert.ok(existsSync(path.join(state.dir, 'gate-baseline-verification.log')));
  const lines = said(d.seen, 'gate_baseline');
  assert.equal(lines[0]?.level, 'info');
  assert.match(lines[0]?.message ?? '', /unlaunchable/);
  assert.ok(d.calls.includes('implement'), 'the baseline did not escalate');
  assert.ok(d.err instanceof Escalation, String(d.err));
  assert.equal(d.err.code, EXIT.PREFLIGHT);
});

test('a dirty start tree is recorded as not clean', async () => {
  const state = startRun('dirty');
  const cfg = cfgFor(legacy(state));
  commitTree(state);
  writeFileSync(path.join(state.targetDir, 'uncommitted.txt'), 'x', 'utf8');
  const d = await drive(state, cfg, handlers(state));
  assert.equal(d.err, null, String(d.err));
  assert.equal(state.gateBaseline?.clean, false);
  assert.match(said(d.seen, 'gate_baseline')[0]?.message ?? '', /uncommitted changes/);
});

// ---- when it is taken -------------------------------------------------------

test('a run stopped at plan approval takes the baseline on its resume, once', async () => {
  const state = startRun('stop-plan');
  const cfg = cfgFor(legacy(state), {}, { gates: matrix({ 'plan-approved': 'stop' }) });
  commitTree(state);
  const first = await drive(state, cfg, handlers(state));
  assert.ok(first.err instanceof Escalation && first.err.code === EXIT.NEEDS_HUMAN, String(first.err));

  const stopped = loadRun(state.targetDir, state.id);
  assert.equal(stopped.baselineDue, true, 'still owed');
  assert.equal(stopped.gateBaseline, undefined);
  assert.equal(markerRuns(state, 'verification'), 0);

  const second = await drive(stopped, cfg, handlers(stopped), true);
  assert.equal(second.err, null, String(second.err));
  assert.equal(said(second.seen, 'gate_baseline').length, 1);
  assert.equal(loadRun(state.targetDir, state.id).gateBaseline?.gates[0]?.status, 'passed');
  assert.equal(loadRun(state.targetDir, state.id).baselineDue, undefined);
  // One baseline run and one verification.
  assert.equal(markerRuns(state, 'verification'), 2);
});

test('a run killed in the implement turn takes no baseline when it resumes', async () => {
  const state = startRun('killed');
  const cfg = cfgFor(legacy(state));
  commitTree(state);
  let killed = false;
  const dying: Handlers = {
    ...handlers(state),
    claude: (label, options) => {
      if (label === 'implement' && !killed) {
        killed = true;
        work(state, 'half-written.txt');
        throw new Error('the process died here');
      }
      return handlers(state).claude?.(label, options);
    },
  };
  const first = await drive(state, cfg, dying);
  assert.ok(first.err !== null, 'the implement turn died');

  const loaded = loadRun(state.targetDir, state.id);
  assert.equal(loaded.baselineDue, undefined, 'no longer owed');
  const before = loaded.gateBaseline;
  assert.ok(before !== undefined);
  assert.equal(markerRuns(state, 'verification'), 1);

  const second = await drive(loaded, cfg, handlers(loaded), true);
  assert.equal(second.err, null, String(second.err));
  assert.deepEqual(said(second.seen, 'gate_baseline'), []);
  assert.deepEqual(loaded.gateBaseline, before, 'the record is the one taken before the turn');
  assert.equal(markerRuns(state, 'verification'), 2, 'only the verification ran');
});

test('owed, then the resume config makes nothing eligible: the debt is cleared and nothing is said', async () => {
  for (const verify of [{ baseline: false }, { enabled: false }] as Partial<VerifyConfig>[]) {
    const state = startRun('changed');
    const command = markerGate(state, 'verification', MARKER);
    commitTree(state);
    const stop = cfgFor({ command }, {}, { gates: matrix({ 'plan-approved': 'stop' }) });
    const first = await drive(state, stop, handlers(state));
    assert.ok(first.err instanceof Escalation, String(first.err));
    const stopped = loadRun(state.targetDir, state.id);
    assert.equal(stopped.baselineDue, true);

    const second = await drive(stopped, cfgFor({ command, ...verify }), handlers(stopped), true);
    assert.equal(second.err, null, String(second.err));
    assert.deepEqual(said(second.seen, 'gate_baseline'), [], JSON.stringify(verify));
    const after = loadRun(state.targetDir, state.id);
    assert.equal(after.baselineDue, undefined, 'the flag is cleared');
    assert.equal(after.gateBaseline, undefined, 'and nothing is recorded');
    assert.equal(existsSync(path.join(state.dir, 'gate-baseline.json')), false);
  }
});

// ---- when it is not ---------------------------------------------------------

test('verify.baseline false writes no record, no flag, no artifact and says nothing', async () => {
  const state = startRun('off');
  const cfg = cfgFor(legacy(state, { baseline: false }));
  commitTree(state);
  const d = await drive(state, cfg, handlers(state));
  assert.equal(d.err, null, String(d.err));
  assertNoBaseline(state, d);
  assert.equal(markerRuns(state, 'verification'), 1, 'only the verification ran');
});

test('a gate whose own baseline is off is skipped while the others run', async () => {
  const state = startRun('skipped');
  const cfg = cfgFor({
    gates: [
      { name: 'a', command: markerGate(state, 'a', 'MARK-A'), baseline: false },
      { name: 'b', command: markerGate(state, 'b', 'MARK-B') },
    ],
  });
  commitTree(state);
  const d = await drive(state, cfg, handlers(state));
  assert.equal(d.err, null, String(d.err));
  assert.deepEqual(state.gateBaseline?.gates[0], {
    name: 'a',
    command: 'node vibe-marker-a.mjs',
    status: 'skipped',
    exitCode: null,
    required: true,
    runs: null,
    log: null,
  });
  assert.equal(state.gateBaseline?.gates[1]?.status, 'passed');
  assert.equal(markerRuns(state, 'a'), 1, 'a ran in verification only');
  assert.equal(markerRuns(state, 'b'), 2);
});

test('every gate with its baseline off, under verify.baseline true, writes nothing', async () => {
  const state = startRun('all-off');
  const cfg = cfgFor({ gates: [{ name: 'a', command: markerGate(state, 'a', 'MARK-A'), baseline: false }] });
  commitTree(state);
  const d = await drive(state, cfg, handlers(state));
  assert.equal(d.err, null, String(d.err));
  assertNoBaseline(state, d);
});

test('verification off, and a plan-only run, write nothing', async () => {
  const off = startRun('verify-off');
  const offRun = await drive(off, cfgFor(legacy(off, { enabled: false })), handlers(off));
  assert.equal(offRun.err, null, String(offRun.err));
  assertNoBaseline(off, offRun);

  const planned = startRun('plan-only', true);
  const plannedRun = await drive(planned, cfgFor(legacy(planned)), handlers(planned));
  assert.equal(plannedRun.err, null, String(plannedRun.err));
  assert.equal(planned.status, 'planned');
  assertNoBaseline(planned, plannedRun);
});

// ---- stored state -----------------------------------------------------------

function widest(): Record<string, unknown> {
  const file = fileURLToPath(new URL('../../tests/fixtures/state/done-widest.json', import.meta.url));
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

const read = (raw: Record<string, unknown>): ReturnType<typeof validateStoredState> =>
  validateStoredState(raw, String(raw['id']), path.join('nowhere'));

const GOOD = {
  name: 'test',
  command: 'npm test',
  status: 'failed',
  exitCode: 1,
  required: true,
  runs: 1,
  log: 'gate-baseline-test.log',
};

test('a stored baseline round-trips, and a damaged entry is dropped with a repair', () => {
  const record = { sha: 'a'.repeat(40), clean: true, gates: [GOOD] };
  const clean = read({ ...widest(), gateBaseline: record, baselineDue: true });
  assert.deepEqual(clean.repairs, []);
  assert.deepEqual(clean.state.gateBaseline, record);
  assert.equal(clean.state.baselineDue, true);

  for (const bad of [{ ...GOOD, status: 'flaky' }, { ...GOOD, log: '../x' }, { ...GOOD, runs: 3 }, 'test']) {
    const { state, repairs } = read({ ...widest(), gateBaseline: { ...record, gates: [GOOD, bad] } });
    assert.deepEqual(state.gateBaseline?.gates, [GOOD], JSON.stringify(bad));
    assert.ok(
      repairs.some((r) => r.field === 'gateBaseline.gates' && r.droppedPaths.includes('gateBaseline.gates[1]')),
      JSON.stringify(repairs),
    );
  }
});

test('a damaged baseline record drops the key, and only true counts as owed', () => {
  for (const bad of [
    'nope',
    { sha: 'a'.repeat(40), clean: true, gates: 'test' },
    { sha: 'abc', clean: true, gates: [] },
    { sha: null, clean: 'yes', gates: [] },
  ]) {
    const { state, repairs } = read({ ...widest(), gateBaseline: bad });
    assert.equal(state.gateBaseline, undefined, JSON.stringify(bad));
    assert.ok(repairs.some((r) => r.field === 'gateBaseline'), JSON.stringify(repairs));
  }
  for (const bad of ['yes', false, 1]) {
    const { state, repairs } = read({ ...widest(), baselineDue: bad });
    assert.equal(state.baselineDue, undefined, JSON.stringify(bad));
    assert.ok(repairs.some((r) => r.field === 'baselineDue'));
  }
  const absent = read(widest());
  assert.equal(absent.state.gateBaseline, undefined);
  assert.equal(absent.state.baselineDue, undefined);
});

// ---- a fork -----------------------------------------------------------------

test('a fork carries neither the baseline nor the debt of the run it came from', async () => {
  const parent = startRun('fork');
  const cfg = cfgFor(legacy(parent));
  commitTree(parent);
  const d = await drive(parent, cfg, handlers(parent));
  assert.equal(d.err, null, String(d.err));

  const points = listCheckpoints(parent.dir);
  const approved = points.find((c) => c.meta?.boundary === 'plan-approved');
  const implemented = points.find((c) => c.meta?.boundary === 'implemented');
  assert.ok(approved !== undefined && implemented !== undefined);
  const snapshot = (n: number): Record<string, unknown> =>
    JSON.parse(readFileSync(path.join(parent.dir, `checkpoint-${n}.json`), 'utf8')) as Record<string, unknown>;
  assert.equal(snapshot(approved.n)['baselineDue'], true, 'the plan-approved checkpoint carries the debt');
  assert.notEqual(snapshot(implemented.n)['gateBaseline'], undefined, 'a later one carries the record');

  for (const [n, overrides] of [
    [approved.n, { git: { useBranch: false } }],
    [implemented.n, {}],
  ] as const) {
    const plan = await planFork(parent.targetDir, parent.id, n, overrides);
    const { state: child } = await commitFork(parent.targetDir, plan);
    assert.equal(child.gateBaseline, undefined);
    assert.equal(child.baselineDue, undefined);
    const stored = loadRun(child.targetDir, child.id);
    assert.equal(stored.gateBaseline, undefined);
    assert.equal(stored.baselineDue, undefined);
  }
});

// ---- the end of the run -----------------------------------------------------

test('the end of the run says nothing with no baseline, or for a gate that passed at the start', () => {
  const state = startRun('silent');
  state.gateOutcomes = [{ name: 'verification', status: 'failed', command: 'x', runs: 1, failed: 1, required: true }];
  assert.deepEqual(reported(state), [], 'no baseline is unknown, never a pass at the start');

  state.gateBaseline = {
    sha: null,
    clean: true,
    gates: [
      { name: 'verification', command: 'x', status: 'passed', exitCode: 0, required: true, runs: 1, log: null },
    ],
  };
  assert.deepEqual(reported(state), []);
});
