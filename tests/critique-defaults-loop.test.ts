import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { orchestrate } from '@src/orchestrator.js';
import { DEFAULTS } from '@src/config.js';
import { agents, BLOCKING, config, freshRun, planFixture, report } from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { Config, RunState } from '@src/types.js';

/**
 * A plan loop with `critique` at its defaults is the plan loop from before #405.
 *
 * Two runs of the same loop - a blocking critique, a revision, an approving
 * critique - one with `DEFAULTS.critique` and one whose config has no
 * `critique` key at all, which is what a `state.config` stored before the
 * section existed holds. Their labels, prompts, artifacts and events must be
 * the same; and the critic's prompt is held to the frozen
 * `critique-round1.txt` separately, in `critique-prompt-compat.test.ts`.
 */

const LABELS = ['plan', 'critique-0', 'revise-1', 'critique-1'];

interface Ran {
  calls: string[];
  prompts: Map<string, string>;
  state: RunState;
}

async function run(cfg: Config): Promise<Ran> {
  const state = freshRun({ prefix: 'vibe-critique-defaults-', task: 'critique defaults' });
  const calls: string[] = [];
  const prompts = new Map<string, string>();
  const handlers: Handlers = {
    claude: (label, options) => {
      prompts.set(label, options.prompt);
      return planFixture();
    },
    codex: (label, options) => {
      prompts.set(label, options.prompt);
      return report(label === 'critique-0' ? BLOCKING : []);
    },
  };
  await orchestrate(state, cfg, false, agents(handlers, calls));
  return { calls, prompts, state };
}

/** Every artifact a plan loop writes, by name, with the run's own id taken out. */
function artifacts(state: RunState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(state.dir).sort()) {
    if (!/^(plan-critique-\d+\.json|plan-\d+\.json|PLAN\.md|FOLLOW-UPS\.md)$/.test(name)) continue;
    out[name] = readFileSync(path.join(state.dir, name), 'utf8').split(state.id).join('<run>');
  }
  return out;
}

test('with critique at its defaults, the plan loop is the one from before the section existed', async () => {
  const withDefaults = config({ p1Tolerance: 0 }, { critique: DEFAULTS.critique });
  const { critique: _critique, ...rest } = withDefaults;
  const withoutSection = rest as Config;

  const seated = await run(withDefaults);
  const legacy = await run(withoutSection);

  assert.deepEqual(seated.calls, LABELS);
  assert.deepEqual(legacy.calls, LABELS);
  for (const label of LABELS) {
    assert.equal(seated.prompts.get(label), legacy.prompts.get(label), `the ${label} prompt moved`);
  }
  assert.deepEqual(artifacts(seated.state), artifacts(legacy.state));
  for (const name of ['plan-critique-0.json', 'plan-critique-1.json']) {
    const text = artifacts(seated.state)[name] ?? '';
    assert.ok(text.length > 0, `${name} was written`);
    assert.equal(text.includes('foundBy'), false, `${name} carries foundBy`);
    assert.equal(text.includes('"votes"'), false, `${name} carries votes`);
  }
  assert.deepEqual(
    seated.state.events.map((e) => e.type),
    legacy.state.events.map((e) => e.type),
  );
  assert.equal(seated.state.events.some((e) => e.type.startsWith('critique_')), false);
  assert.equal(seated.state.status, legacy.state.status);
});
