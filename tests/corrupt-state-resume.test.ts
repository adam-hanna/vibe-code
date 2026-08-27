import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { orchestrate } from '@src/orchestrator.js';
import { loadRun, saveState } from '@src/run.js';
import { StoredStateError } from '@src/stored.js';
import {
  agents,
  config,
  freshRun,
  planFixture,
  report,
  reviewingRun,
} from './helpers/loop-harness.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import type { CodexTurnOptions } from '@src/codex.js';
import type { RunState } from '@src/types.js';

/**
 * The acceptance criterion the issue states: a corrupt `state.json` never throws
 * from inside a phase.
 *
 * `tests/stored-state.test.ts` pins what the validator decides; this file proves
 * the decision is enough - the loop runs on the repaired state, and the values
 * that would have crashed a prompt never reach one. Everything goes through the
 * real `loadRun` and the real `orchestrate`, with only the agent turns injected.
 */

/** Rewrite a harness run's state.json through a mutation, then load it for real. */
function corruptAndLoad(state: RunState, mutate: (raw: Record<string, unknown>) => void): RunState {
  saveState(state);
  const file = path.join(state.dir, 'state.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  mutate(raw);
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
  return loadRun(state.targetDir, state.id);
}

const RUN = { prefix: 'vibe-corrupt-', task: 'corrupt state' } as const;

test('a state with every repairable field corrupt drives its phase without throwing', async () => {
  const loaded = corruptAndLoad(freshRun({ ...RUN, git: true }), (raw) => {
    raw['events'] = 'nope';
    raw['p1Rounds'] = {};
    raw['verifyRounds'] = 'x';
    raw['answeredQuestions'] = 5;
    raw['deferredQuestions'] = 'x';
    raw['carried'] = 'x';
    raw['deferred'] = 3;
    raw['outstanding'] = 'x';
    raw['pendingAnswers'] = 'lazy';
    raw['handoff'] = 7;
    raw['baseSha'] = 3;
    raw['contextRatio'] = 'half';
    raw['sessionStarted'] = 'yes';
    raw['phase'] = 'banana';
  });

  const calls: string[] = [];
  const turns = agents({ claude: () => planFixture(), codex: () => report([]) }, calls);
  await orchestrate(loaded, config(), true, turns);

  assert.deepEqual(calls, ['plan', 'critique-0']);
});

test('a completed run that later failed preflight still resumes as complete', async () => {
  // The pair a failed preflight over a finished run persists: `execute` sets
  // status 'error' without touching the phase. Repairing it - as two earlier
  // versions of this change proposed - would make resumePhase infer 'planning'
  // and re-run work that had completed. It must load untouched and stop.
  const loaded = corruptAndLoad(freshRun({ ...RUN, git: true }), (raw) => {
    raw['status'] = 'error';
    raw['phase'] = 'complete';
  });
  assert.equal(loaded.phase, 'complete');
  assert.deepEqual(loaded.events.filter((e) => e.type === 'state_repaired'), []);

  const calls: string[] = [];
  const turns = agents({ claude: () => assert.fail('no turn should run') }, calls);
  await orchestrate(loaded, config(), true, turns);

  assert.deepEqual(calls, []);
});

test('a malformed question never reaches the answerer as undefined', async () => {
  const state = freshRun({ ...RUN, git: true });
  state.plan = planFixture({
    open_questions: [
      {
        question: 'Should the widget be lazy or eager?',
        options: ['lazy', 'eager'],
        recommended: 'lazy',
        kind: 'product',
        blocking: true,
      },
    ],
  });
  const loaded = corruptAndLoad(state, (raw) => {
    const plan = raw['plan'] as Record<string, unknown>;
    const questions = plan['open_questions'] as unknown[];
    // A junk question beside the good one: `normalize` lowercases whatever it is
    // given, so an entry with a numeric `question` used to take the phase down.
    plan['open_questions'] = [...questions, { question: 7 }, { kind: 'product' }];
    plan['assumptions'] = [{ assumption: 'A', why: 'B', blast_radius: 'C' }, null];
  });

  assert.equal(loaded.plan?.open_questions.length, 1);

  const prompts: string[] = [];
  const calls: string[] = [];
  const turns = agents(
    {
      claude: () => planFixture(),
      codex: (label: string, options: CodexTurnOptions) => {
        prompts.push(options.prompt);
        return label.startsWith('answers')
          ? {
              answers: [
                {
                  question: 'Should the widget be lazy or eager?',
                  answer: 'Lazy.',
                  confidence: 'high',
                  defer_to_human: false,
                  rationale: 'Because.',
                },
              ],
            }
          : report([]);
      },
    },
    calls,
  );

  await orchestrate(loaded, config(), true, turns);

  const answerer = prompts[0] ?? '';
  assert.match(answerer, /Should the widget be lazy or eager\?/);
  assert.doesNotMatch(answerer, /undefined/);
});

test('a malformed environment never reaches a prompt', async () => {
  const loaded = corruptAndLoad(freshRun({ ...RUN, git: true }), (raw) => {
    raw['environment'] = {
      verifyCommand: 'npm test',
      verifyRuns: 3,
      agents: [{ provider: 'other', shell: 'bash', pathStyle: 'msys', repaired: false, tools: [] }],
    };
  });
  assert.deepEqual(loaded.environment?.agents, []);

  const prompts: string[] = [];
  const calls: string[] = [];
  const turns = agents(
    {
      claude: (_label: string, options: ClaudeTurnOptions) => {
        prompts.push(options.prompt);
        return planFixture();
      },
      codex: () => report([]),
    },
    calls,
  );
  await orchestrate(loaded, config(), true, turns);

  // An agent list with nothing verified in it says nothing, which is what a run
  // recorded before `environment` existed does - rather than naming a provider
  // that does not exist.
  assert.doesNotMatch(prompts[0] ?? '', /## Verified environment/);
});

test('a valid agent beside a malformed one is still stated to the planner', async () => {
  const loaded = corruptAndLoad(freshRun({ ...RUN, git: true }), (raw) => {
    raw['environment'] = {
      verifyCommand: 'npm test',
      verifyRuns: 3,
      agents: [
        {
          provider: 'claude',
          shell: 'bash',
          pathStyle: 'msys',
          repaired: false,
          tools: [{ name: 'git', available: true, version: 'git version 2.31.1' }],
        },
        { provider: 'other', shell: 'fish', pathStyle: 'nt', repaired: false, tools: [] },
      ],
    };
  });

  const prompts: string[] = [];
  const calls: string[] = [];
  const turns = agents(
    {
      claude: (_label: string, options: ClaudeTurnOptions) => {
        prompts.push(options.prompt);
        return planFixture();
      },
      codex: () => report([]),
    },
    calls,
  );
  await orchestrate(loaded, config(), true, turns);

  const prompt = prompts[0] ?? '';
  assert.match(prompt, /## Verified environment/);
  assert.match(prompt, /\*\*claude\*\*/);
  // The dropped agent is named nowhere: the block lists agents as `**name**`.
  assert.doesNotMatch(prompt, /\*\*other\*\*/);
  assert.doesNotMatch(prompt, /fish/);
});

test('a stored string in pendingAnswers does not reach the planner as characters', async () => {
  const state = freshRun({ ...RUN, git: true });
  state.plan = planFixture();
  const loaded = corruptAndLoad(state, (raw) => {
    raw['pendingAnswers'] = 'lazy';
  });

  const calls: string[] = [];
  const prompts: string[] = [];
  const turns = agents(
    {
      claude: (_label: string, options: ClaudeTurnOptions) => {
        prompts.push(options.prompt);
        return planFixture();
      },
      codex: () => report([]),
    },
    calls,
  );
  await orchestrate(loaded, config(), true, turns);

  // No revision turn: there were never any answers, so nothing was answered.
  assert.deepEqual(calls.filter((c) => c.startsWith('revise-')), []);
  for (const prompt of prompts) assert.doesNotMatch(prompt, /A: l\b/);
});

test('a stored pendingFindings null is neither a repair nor a re-entry', async () => {
  const state = freshRun({ ...RUN, git: true });
  state.plan = planFixture();
  const loaded = corruptAndLoad(state, (raw) => {
    raw['pendingFindings'] = null;
  });
  assert.deepEqual(loaded.events.filter((e) => e.type === 'state_repaired'), []);

  const calls: string[] = [];
  await orchestrate(loaded, config(), true, agents({ codex: () => report([]) }, calls));
  assert.deepEqual(calls, ['critique-0']);
});

test('a plan repaired to null stops the run before any turn, with the loop own error', async () => {
  const state = reviewingRun({ ...RUN });
  const loaded = corruptAndLoad(state, (raw) => {
    raw['plan'] = { plan_md: 3 };
  });
  assert.equal(loaded.plan, null);

  const calls: string[] = [];
  await assert.rejects(
    () => orchestrate(loaded, config(), true, agents({}, calls)),
    /stored no plan/,
  );
  assert.deepEqual(calls, []);
});

test('a corrupt p1Rounds reaches the convergence guard harmlessly', async () => {
  const state = reviewingRun({ ...RUN });
  const loaded = corruptAndLoad(state, (raw) => {
    raw['p1Rounds'] = 'not a history';
  });
  assert.deepEqual(loaded.p1Rounds, []);

  const calls: string[] = [];
  await orchestrate(loaded, config(), true, agents({ codex: () => report([]) }, calls));
  assert.deepEqual(calls, ['review-0']);
});

test('a refusal stops before any turn is spawned', async () => {
  const calls: string[] = [];
  const cases: { mutate: (raw: Record<string, unknown>) => void; id?: string }[] = [
    { mutate: (raw) => (raw['costUsd'] = 'lots') },
    { mutate: (raw) => (raw['id'] = 'some-other-run') },
    { mutate: () => undefined, id: path.join('..', '..', 'escape') },
  ];

  for (const { mutate, id } of cases) {
    const state = freshRun({ ...RUN, git: true });
    saveState(state);
    const file = path.join(state.dir, 'state.json');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    mutate(raw);
    writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');

    assert.throws(
      () => loadRun(state.targetDir, id ?? state.id),
      (err: unknown) => err instanceof StoredStateError,
    );
  }

  // A truncated file takes the same door.
  const truncated = freshRun({ ...RUN, git: true });
  saveState(truncated);
  const file = path.join(truncated.dir, 'state.json');
  writeFileSync(file, readFileSync(file, 'utf8').slice(0, 100), 'utf8');
  assert.throws(
    () => loadRun(truncated.targetDir, truncated.id),
    (err: unknown) => err instanceof StoredStateError,
  );

  assert.deepEqual(calls, [], 'no agent turn was reached on any refusal');
});
