import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { orchestrate } from '@src/orchestrator.js';
import { agents, config, freshRun, planFixture, report, work } from './helpers/loop-harness.js';
import type { RunState } from '@src/types.js';

/**
 * A whole run, and what its planning turn was told about the runs before it
 * (#52).
 *
 * The prompt tests pin the rendering; this pins the wiring - that the index is
 * built from the target repository's own `.vibe/runs/`, that the current run is
 * not in it, and that an archive with a corrupt run in it still plans.
 *
 * **The last case asserts injection, not exposure.** Under the default table
 * the implementer shares Claude's single `main` conversation with the planner
 * and therefore inherits its history, this section included, until a rotation
 * clears it. That is pre-existing behaviour of the whole plan prompt, is
 * documented in README.md and AGENTS.md, and is not what is being claimed here:
 * what is claimed is that no prompt other than the planner's is *given* the
 * section.
 */

const HEADING = '## Past runs in this repository';

/** A prior run in the target repo, with whatever `state.json` text is wanted. */
function plant(state: RunState, id: string, text: string): void {
  const dir = path.join(state.targetDir, '.vibe', 'runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'state.json'), text, 'utf8');
}

function healthy(id: string, task: string): string {
  return JSON.stringify({ id, status: 'done', task, costUsd: 0.5 });
}

/** Every prompt each label was handed, so a case can ask what a role saw. */
function capturing(state: RunState, prompts: Map<string, string[]>) {
  const record = (label: string, prompt: string): void => {
    const seen = prompts.get(label) ?? [];
    seen.push(prompt);
    prompts.set(label, seen);
  };
  return {
    claude: (label: string, options: { prompt: string }): unknown => {
      record(label, options.prompt);
      return label === 'plan' || label.startsWith('revise-')
        ? planFixture()
        : work(state, `${label}.txt`);
    },
    codex: (label: string, options: { prompt: string }): unknown => {
      record(label, options.prompt);
      return report([]);
    },
  };
}

async function runToCompletion(state: RunState, prompts: Map<string, string[]>): Promise<void> {
  const calls: string[] = [];
  await orchestrate(state, config(), false, agents(capturing(state, prompts), calls));
}

test('a repo whose only run is the current one plans exactly as it always did', async () => {
  const state = freshRun({ prefix: 'vibe-past-none-', task: 'no prior runs', planOnly: true });
  const prompts = new Map<string, string[]>();

  await runToCompletion(state, prompts);

  const plan = prompts.get('plan')?.[0] ?? '';
  assert.ok(plan.length > 0, 'the planning turn ran');
  assert.equal(plan.includes(HEADING), false);
});

test('prior runs reach the planning prompt, and a corrupt one does not stop the run', async () => {
  const state = freshRun({ prefix: 'vibe-past-some-', task: 'with prior runs', planOnly: true });
  plant(state, '20260101-000000-older-run', healthy('20260101-000000-older-run', 'the older task'));
  plant(state, '20260202-000000-newer-run', healthy('20260202-000000-newer-run', 'the newer task'));
  plant(state, '20260303-000000-broken-run', '{ not json');
  const prompts = new Map<string, string[]>();

  await runToCompletion(state, prompts);

  const plan = prompts.get('plan')?.[0] ?? '';
  assert.ok(plan.includes(HEADING));
  assert.ok(plan.includes('- `20260202-000000-newer-run` - done - the newer task'));
  assert.ok(plan.includes('- `20260101-000000-older-run` - done - the older task'));
  // The corrupt run is listed as unreadable rather than taking out the listing.
  assert.ok(plan.includes('- `20260303-000000-broken-run` - unreadable'));
  // Newest first.
  assert.ok(plan.indexOf('20260303-000000-broken-run') < plan.indexOf('20260101-000000-older-run'));
  // And the run doing the reading is not in its own index.
  assert.equal(plan.includes(state.id), false);
  assert.equal(state.status, 'planned');
});

test('no role other than the planner is given the index', async () => {
  const state = freshRun({
    prefix: 'vibe-past-scope-',
    task: 'scope of the index',
    planOnly: false,
    git: true,
    commit: true,
  });
  plant(state, '20260101-000000-older-run', healthy('20260101-000000-older-run', 'the older task'));
  const prompts = new Map<string, string[]>();

  await runToCompletion(state, prompts);

  const labels = [...prompts.keys()];
  assert.ok(labels.includes('plan'), 'the planner ran');
  assert.ok(
    labels.some((l) => l !== 'plan'),
    'at least one other role ran',
  );
  for (const [label, seen] of prompts) {
    if (label === 'plan') continue;
    for (const prompt of seen) {
      assert.equal(prompt.includes(HEADING), false, `${label} was not given the index`);
    }
  }
});
