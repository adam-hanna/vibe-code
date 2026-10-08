import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrate } from '@src/orchestrator.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import {
  agents,
  committing,
  config,
  freshRun,
  p1,
  planFixture,
  report,
  verifying,
  work,
} from './helpers/loop-harness.js';
import type { RunState } from '@src/types.js';

/**
 * A fix round opens a code group of its own (#280).
 *
 * On the #248 run a review found two P1s, `fix-1` ran and committed, and the
 * next review passed - and the column read `review round 0 → review round 1`,
 * because the fix announced a turn and no phase, so it was filed inside the
 * review it answered. These pin the phase sequence a host sees, by id, for both
 * fix kinds that follow a review.
 */

async function phases(state: RunState, review0: unknown): Promise<string[]> {
  const seen: Narration[] = [];
  const realLog = console.log;
  const realError = console.error;
  log.setSink((n) => void seen.push(n));
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(
      state,
      config({}, { ...committing(), ...verifying(state) }),
      false,
      agents(
        {
          claude: (label) =>
            label === 'plan' || label.startsWith('revise-') ? planFixture() : work(state, `${label}.txt`),
          codex: (label) => (label === 'review-0' ? review0 : report([])),
        },
        [],
      ),
    );
  } finally {
    console.log = realLog;
    console.error = realError;
    log.setSink(null);
  }
  // Each phase, then the turn kinds filed under it, in the order a reducer sees them.
  const out: string[] = [];
  for (const n of seen) {
    const data = (n.data ?? {}) as Record<string, unknown>;
    if (n.id === 'phase_started' && data['phase'] !== 'planning' && data['phase'] !== 'critique') {
      out.push(`${String(data['phase'])}:${data['round'] === undefined ? '-' : String(data['round'])}`);
    } else if (n.id === 'turn_started' && data['role'] === 'implementer') {
      out.push(`  ${String(data['kind'])}`);
    }
  }
  return out;
}

const run = (prefix: string): RunState =>
  freshRun({ prefix, task: 'fix phases', planOnly: false, git: true, commit: true });

test('a review fix is its own code group: code, review, code, review', async () => {
  const state = run('vibe-fixphase-review-');
  const seen = await phases(state, report([p1('first'), p1('second')]));

  assert.deepEqual(seen, [
    'implementing:-',
    '  implement',
    'review:0',
    'implementing:1',
    '  review-fix',
    'review:1',
  ]);
});

test('the final fix after a tolerated P1 opens a code group too', async () => {
  const state = run('vibe-fixphase-final-');
  const seen = await phases(state, report([p1('tolerated')]));

  assert.deepEqual(seen, ['implementing:-', '  implement', 'review:0', 'implementing:1', '  final-fix']);
});
