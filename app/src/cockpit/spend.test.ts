import { describe, expect, test } from 'vitest';
import { emptyRun, reduce } from './model';
import { resumeArgv, launchArgv } from './argv';
import type { Run } from './model';
import type { Frame } from '../host';

/**
 * What the run spent, and the ending it can be picked up from (`5e`, `4g`, `4d`).
 *
 * Two rules the spend screen exists to keep, and neither is about arithmetic:
 *
 * 1. **The total is read off the charge, never summed here.** The charge seam is
 *    holding `state.tokensUsed` at the moment it charges, so a pane adding up a
 *    stream of turns has a second answer to a question that already has one -
 *    and the second one is the one on screen.
 * 2. **Cost is Claude-side and never a run total.** Codex returns no cost from
 *    any output mode, so a dollar figure covering both agents does not exist to
 *    be reported. That is settled, and the pane says which half it is.
 */

function say(id: string | null, data: Record<string, unknown> | null): Frame {
  return { type: 'narration', level: 'detail', message: 'x', id, data };
}

function fold(frames: readonly Frame[], t0 = 1_000_000): Run {
  return frames.reduce((run, frame, i) => reduce(run, frame, t0 + i), emptyRun());
}

describe('the run total is the loop’s figure', () => {
  test('it follows the last charge rather than a sum of them', () => {
    // 500 + 700 is 1200, and the loop says 5000 - because it is also counting
    // turns this window never saw, on a resumed run. The loop is right.
    const run = fold([
      say('claude_turn', { label: 'plan', provider: 'claude', tokens: 500, runTokens: 4300 }),
      say('codex_turn', { label: 'critique-0', provider: 'codex', tokens: 700, runTokens: 5000 }),
    ]);
    expect(run.spend.tokens).toBe(5000);
    expect(run.spend.charges.map((c) => c.tokens)).toEqual([500, 700]);
  });

  test('a charge with no run total leaves the last one standing', () => {
    // Absent is not zero, and here a zero would read as a run that has spent
    // nothing after one that had spent thousands.
    const run = fold([
      say('claude_turn', { label: 'plan', provider: 'claude', tokens: 500, runTokens: 4300 }),
      say('claude_turn', { label: 'implement', provider: 'claude', tokens: 900 }),
    ]);
    expect(run.spend.tokens).toBe(4300);
  });

  test('a charge missing its label or tokens is dropped whole', () => {
    const run = fold([say('claude_turn', { provider: 'claude', runTokens: 4300 })]);
    expect(run.spend.charges).toHaveLength(0);
    expect(run.spend.tokens).toBeNull();
  });

  test('the Codex share is carried separately, never folded into the total', () => {
    // A reader asking which agent spent this has no other way to find out, and
    // one ceiling covering both is the only honest ceiling the tool has.
    const run = fold([
      say('codex_turn', {
        label: 'review-0',
        provider: 'codex',
        tokens: 700,
        runTokens: 5000,
        codexTokens: 700,
      }),
    ]);
    expect(run.spend.tokens).toBe(5000);
    expect(run.spend.codexTokens).toBe(700);
  });

  test('a charge is stamped with the phase it happened in', () => {
    // What makes the per-phase breakdown possible without the pane inferring a
    // phase from a turn label.
    const run = fold([
      say('phase_started', { phase: 'planning' }),
      say('claude_turn', { label: 'plan', provider: 'claude', tokens: 500, runTokens: 500 }),
      say('phase_started', { phase: 'implementing' }),
      say('claude_turn', { label: 'implement', provider: 'claude', tokens: 900, runTokens: 1400 }),
    ]);
    expect(run.spend.charges.map((c) => c.phase)).toEqual(['planning', 'implementing']);
  });

  test('a charge before any phase belongs to none, which is a real state', () => {
    // Preflight spends before a phase opens, and filing it under `planning`
    // would put a probe's cost inside the plan phase's figure.
    const run = fold([
      say('claude_turn', { label: 'probe', provider: 'claude', tokens: 20, runTokens: 20 }),
    ]);
    expect(run.spend.charges[0]?.phase).toBeNull();
  });

  test('cost is carried and is Claude-side, which the pane has to be able to say', () => {
    const run = fold([
      say('claude_turn', {
        label: 'plan',
        provider: 'claude',
        tokens: 500,
        runTokens: 500,
        runCostUsd: 0.42,
      }),
    ]);
    expect(run.spend.costUsd).toBe(0.42);
  });
});

describe('a resume is the same four-slot argv the launch is', () => {
  test('the shape matches, because two builders is how two shapes happen', () => {
    expect(resumeArgv('20260907-001122-implement', 'C:/repo')).toEqual([
      'resume',
      '20260907-001122-implement',
      '-C',
      'C:/repo',
    ]);
    expect(launchArgv('do a thing', 'C:/repo', false)).toHaveLength(4);
  });

  test('it trims, for the reason launchArgv does', () => {
    // A trailing newline in a path is a directory that does not exist, and the
    // error it produces says so in the least helpful possible way.
    expect(resumeArgv(' id \n', ' C:/repo \n')).toEqual(['resume', 'id', '-C', 'C:/repo']);
  });
});
