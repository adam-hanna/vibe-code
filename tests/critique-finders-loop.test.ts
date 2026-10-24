import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { orchestrate } from '@src/orchestrator.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { DEFAULTS } from '@src/config.js';
import { agents, config, freshRun, p1, planFixture, report } from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { Config, CritiqueConfig, Evidence, Finding, RunState } from '@src/types.js';

/**
 * Additional critique finders, driven through the real plan loop (#405).
 *
 * Each finder is the critic's job on a swapped seat: one turn per plan round,
 * after `roles.critic`, labelled `critique-<n>-f<k>`, and the round's findings
 * are merged across finders by claim before anything downstream reads them.
 * The agents are injected; grounding and the artifacts are real.
 */

interface Driven {
  calls: string[];
  seen: Narration[];
  prompts: Map<string, string>;
}

/** A citation of a file the fixture writes, so grounding resolves it and the merge can match on it. */
const HERE: Evidence = { kind: 'code', path: 'widget.ts', line: 1 };

function cited(id: string, title = `Finding ${id}`): Finding {
  return { ...p1(id), title, evidence: [HERE] };
}

function withCritique(critique: Partial<CritiqueConfig>): Config {
  return config({ p1Tolerance: 0 }, { critique: { ...DEFAULTS.critique, ...critique } });
}

function run(): RunState {
  const state = freshRun({ prefix: 'vibe-critique-finders-', task: 'critique finders' });
  writeFileSync(path.join(state.targetDir, 'widget.ts'), 'export const widget = 1;\n', 'utf8');
  return state;
}

async function drive(state: RunState, cfg: Config, codex: (label: string) => unknown): Promise<Driven> {
  const calls: string[] = [];
  const seen: Narration[] = [];
  const prompts = new Map<string, string>();
  const handlers: Handlers = {
    claude: (label, options) => {
      prompts.set(label, options.prompt);
      return planFixture();
    },
    codex: (label, options) => {
      prompts.set(label, options.prompt);
      return codex(label);
    },
  };
  log.setSink((n) => void seen.push(n));
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(state, cfg, false, agents(handlers, calls));
  } finally {
    log.setSink(null);
    console.log = originalLog;
    console.error = originalError;
  }
  return { calls, seen, prompts };
}

function critiqueArtifact(state: RunState, n = 0): Finding[] {
  return (JSON.parse(readFileSync(path.join(state.dir, `plan-critique-${n}.json`), 'utf8')) as { findings: Finding[] })
    .findings;
}

test('one finder takes one turn per plan round, after the critic, and its finding merges by citation', async () => {
  const state = run();
  const { calls, seen } = await drive(state, withCritique({ finders: ['codex'] }), (label) => {
    if (label === 'critique-0') return report([cited('critic-sees-it')]);
    if (label === 'critique-0-f1') return report([cited('finder-sees-it', 'Something else said about the same line')]);
    return report([]);
  });
  assert.deepEqual(calls, ['plan', 'critique-0', 'critique-0-f1', 'revise-1', 'critique-1', 'critique-1-f1']);
  assert.equal(state.planRound, 1, 'finder turns are not plan rounds');

  const [found, ...rest] = critiqueArtifact(state);
  assert.equal(rest.length, 0, 'merged into one');
  assert.equal(found?.id, 'critic-sees-it');
  assert.deepEqual(
    found?.foundBy?.map((s) => [s.seat, s.id]),
    [
      ['roles.critic', 'critic-sees-it'],
      ['critique.finders[0]', 'finder-sees-it'],
    ],
  );
  const merged = state.events.filter((e) => e.type === 'critique_finders_merged');
  assert.equal(merged.length, 2);
  assert.deepEqual(
    { round: merged[0]?.['round'], finders: merged[0]?.['finders'], reported: merged[0]?.['reported'], byCitation: merged[0]?.['byCitation'] },
    { round: 0, finders: 2, reported: 2, byCitation: 1 },
  );
  const started = seen.find((n) => n.id === 'turn_started' && n.data?.['finder'] === 1);
  assert.deepEqual(started?.data, { role: 'critic', kind: 'critique', round: 0, finder: 1, seat: 'critique.finders[0]' });
});

test("a finder is handed the critic's prompt with no memory, plus its focus", async () => {
  const state = run();
  const { prompts } = await drive(
    state,
    withCritique({ finders: [{ provider: 'codex', focus: 'whether the plan matches the brief' }] }),
    (label) => (label === 'critique-0' ? report([cited('a')]) : report([])),
  );
  // Round 1 renders no memory note either way, so the first finder's prompt is the critic's plus the focus.
  assert.equal(
    prompts.get('critique-0-f1'),
    `${prompts.get('critique-0') ?? ''}\n\n## Focus for this review\n\nwhether the plan matches the brief`,
  );
  // From round 2 a fresh finder is told it does not have the earlier findings.
  assert.match(prompts.get('critique-1-f1') ?? '', /\*\*you do not have those findings\*\*/);
  assert.doesNotMatch(prompts.get('critique-1-f1') ?? '', /you have your previous findings in context/);
});

test('a failed finder is recorded, contributes nothing, and the round goes on', async () => {
  const state = run();
  const { calls } = await drive(state, withCritique({ finders: ['codex'] }), (label) => {
    if (label === 'critique-0-f1') throw new Error('finder fell over\nsecond line');
    return report([]);
  });
  assert.deepEqual(calls, ['plan', 'critique-0', 'critique-0-f1']);
  assert.equal(state.status, 'planned', 'the plan was approved as with no finder');
  const failed = state.events.find((e) => e.type === 'critique_finder_failed');
  assert.deepEqual(
    { round: failed?.['round'], finder: failed?.['finder'], seat: failed?.['seat'], label: failed?.['label'], error: failed?.['error'] },
    { round: 0, finder: 1, seat: 'critique.finders[0]', label: 'critique-0-f1', error: 'finder fell over' },
  );
  const merged = state.events.find((e) => e.type === 'critique_finders_merged');
  assert.equal(merged?.['finders'], 2);
  assert.equal(merged?.['reported'], 1);
  assert.deepEqual(critiqueArtifact(state), []);
});
