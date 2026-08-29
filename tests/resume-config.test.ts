import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs, resumeConfig } from '@src/cli.js';
import { DEFAULTS } from '@src/config.js';
import { shouldRotate } from '@src/context.js';
import {
  createRun,
  loadRun,
  measuredRatio,
  recordContextMeasurement,
  saveState,
} from '@src/run.js';
import type { Config, RunState } from '@src/types.js';

/** A run on disk, with whatever `state.config` the case is about. */
function runWith(task: string, config: Config | undefined): { dir: string; state: RunState } {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-resume-'));
  const state = createRun(dir, task, false);
  if (config !== undefined) state.config = config;
  saveState(state);
  return { dir, state };
}

/** Resume the run as a second process would: reload from disk, then apply flags. */
function resume(dir: string, id: string, args: readonly string[]): { state: RunState; cfg: Config } {
  const state = loadRun(dir, id);
  return { state, cfg: resumeConfig(dir, state, parseArgs(args).flags) };
}

function resumeEvents(state: RunState): unknown[] {
  return state.events.filter((e) => e.type === 'resume_config');
}

test('a flag given on resume survives the next resume', () => {
  const { dir, state } = runWith('resume override persistence', structuredClone(DEFAULTS) as Config);

  resumeConfig(dir, state, parseArgs(['--max-question-rounds', '5']).flags);

  assert.equal(loadRun(dir, state.id).config?.loop.maxQuestionRounds, 5);
  // Resumed again with no flag at all, which is where it used to revert to 3.
  const again = resume(dir, state.id, []);
  assert.equal(again.cfg.loop.maxQuestionRounds, 5);
  assert.equal(loadRun(dir, state.id).config?.loop.maxQuestionRounds, 5);
});

test('flags given now still beat the stored settings', () => {
  const stored = structuredClone(DEFAULTS) as Config;
  stored.claude.model = 'sonnet';
  const { dir, state } = runWith('resume flag precedence', stored);

  const { cfg } = resume(dir, state.id, ['--claude-model', 'opus']);

  assert.equal(cfg.claude.model, 'opus');
  assert.equal(loadRun(dir, state.id).config?.claude.model, 'opus');
});

test('a legacy run resumed under one --claude-model and then another does not reuse the first measurement', () => {
  // The run predates state.config entirely, which is the case where the stored
  // config is most obviously not evidence of what any turn ran under.
  const { dir, state } = runWith('legacy two model resumes', undefined);
  delete state.config;
  saveState(state);

  const first = resume(dir, state.id, ['--claude-model', 'sonnet']);
  assert.equal(first.cfg.claude.model, 'sonnet');
  assert.equal(loadRun(dir, state.id).config?.claude.model, 'sonnet');

  // One turn under sonnet reports usage, at 40% of sonnet's window.
  recordContextMeasurement(first.state, 'sonnet', 0.4, 1_000_000);
  first.state.sessionStarted = true;
  saveState(first.state);

  const second = resume(dir, state.id, ['--claude-model', 'haiku']);

  assert.equal(second.cfg.claude.model, 'haiku');
  // state.config now names haiku - and that must not be read as provenance for
  // a measurement that sonnet produced.
  assert.equal(second.state.contextModel, 'sonnet');
  assert.equal(measuredRatio(second.state, 'haiku'), null);
  assert.equal(shouldRotate(second.state, second.cfg), true);
});

test('a stored config missing keys added later gets the defaults, then keeps them', () => {
  const stored = structuredClone(DEFAULTS) as unknown as Record<string, unknown>;
  delete stored['progress'];
  const { dir, state } = runWith('resume default fill', stored as unknown as Config);

  const { cfg } = resume(dir, state.id, []);

  assert.deepEqual(cfg.progress, DEFAULTS.progress);
  assert.deepEqual(loadRun(dir, state.id).config?.progress, DEFAULTS.progress);
});

test('a resume that changes settings records what changed', () => {
  const { dir, state } = runWith('resume records change', structuredClone(DEFAULTS) as Config);

  const { state: resumed } = resume(dir, state.id, ['--claude-model', 'sonnet', '--verify-runs', '5']);

  const events = resumeEvents(resumed);
  assert.equal(events.length, 1);
  assert.deepEqual(loadRun(dir, state.id).events.at(-1)?.['changed'], ['claude.model', 'verify.runs']);
});

test('a resume that changes nothing records nothing, but still persists the config', () => {
  const stored = structuredClone(DEFAULTS) as Config;
  const { dir, state } = runWith('resume records nothing', stored);

  const { state: resumed } = resume(dir, state.id, []);

  assert.deepEqual(resumeEvents(resumed), []);
  assert.equal(loadRun(dir, state.id).config?.claude.model, DEFAULTS.claude.model);
});

test('filling in defaults for an older config is not reported as a user change', () => {
  const stored = structuredClone(DEFAULTS) as unknown as Record<string, unknown>;
  delete stored['progress'];
  const { dir, state } = runWith('resume default fill event', stored as unknown as Config);

  const { state: resumed } = resume(dir, state.id, []);

  assert.deepEqual(resumeEvents(resumed), []);
});

/**
 * A per-role flag on resume, and what it takes with it (#89).
 *
 * `--role` is the first thing that can move a run's role table after the run
 * exists: a resume reads `state.config`, not the file, so before this the table
 * was fixed for the life of a run. Two consequences follow, and both are here -
 * the diff already names the role at role granularity, and the probed
 * environment facts stop describing the run.
 */
test('a per-role flag is named in the resume diff, at role granularity', () => {
  const { dir, state } = runWith('resume role diff', structuredClone(DEFAULTS) as Config);

  const { cfg } = resume(dir, state.id, ['--role', 'reviewer:effort=max']);

  assert.deepEqual(cfg.roles.reviewer, { provider: 'codex', effort: 'max' });
  assert.deepEqual(loadRun(dir, state.id).events.at(-1)?.['changed'], ['roles.reviewer']);
});

/** Probed facts, as a successful preflight would have left them. */
function withEnvironment(state: RunState): RunState {
  state.environment = {
    agents: [
      {
        provider: 'claude',
        shell: 'bash',
        pathStyle: 'msys',
        repaired: false,
        tools: [{ name: 'node', available: true, version: 'v24.18.0' }],
      },
    ],
    verifyCommand: 'npm test',
    verifyRuns: 3,
  };
  saveState(state);
  return state;
}

test('a resume that moves a provider drops the environment facts the probe took', () => {
  // They describe the agents the OLD contract asked about, and `environmentBlock`
  // labels each of them through the CURRENT table - so keeping them would state,
  // as verified fact, that the agent now called "the implementer" was observed
  // with the tools some other role's provider needed. Nothing can recompute a
  // probe, so they go; preflight rewrites them, or the prompt omits the section.
  const stored = structuredClone(DEFAULTS) as Config;
  stored.codex.persistSession = false;
  const { dir, state } = runWith('resume moves implementer', stored);
  withEnvironment(state);

  const { cfg } = resume(dir, state.id, ['--role', 'implementer:provider=codex']);

  assert.deepEqual(cfg.roles.implementer, { provider: 'codex' });
  assert.deepEqual(cfg.toolchain['node']?.agents, ['codex'], 'the contract moved with the role');
  const reloaded = loadRun(dir, state.id);
  assert.equal(reloaded.environment, undefined, 'the stale facts are gone');
  const event = reloaded.events.at(-1);
  assert.deepEqual(event?.['changed'], ['roles.implementer', 'toolchain']);
  assert.equal(event?.['environmentCleared'], true);
});

test('a resume that changes only an effort keeps the environment facts', () => {
  // The narrow half of the trigger, and the one that costs something if it is
  // wrong: a run with no environment block re-opens the false "no Node runtime"
  // findings that block exists to prevent. A model, effort or timeout appears
  // nowhere in it.
  const { dir, state } = runWith('resume keeps facts', structuredClone(DEFAULTS) as Config);
  const before = structuredClone(withEnvironment(state).environment);

  resume(dir, state.id, ['--role', 'reviewer:effort=max']);

  const reloaded = loadRun(dir, state.id);
  assert.deepEqual(reloaded.environment, before);
  assert.equal(reloaded.events.at(-1)?.['environmentCleared'], undefined);
});
