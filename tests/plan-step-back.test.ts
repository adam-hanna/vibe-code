import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS } from '@src/config.js';
import { stepBackCount } from '@src/cli.js';
import { Escalation, EXIT, guardProgress, orchestrate, STALL_QUESTION } from '@src/orchestrator.js';
import { clearPromptOverrides, installPromptOverrides } from '@src/prompts.js';
import { planStall, recordRound } from '@src/run.js';
import type { Config, Finding, LoopConfig, RoundRecord, RunState } from '@src/types.js';
import {
  agents,
  answerNeedsInput,
  config,
  escalationFile,
  freshRun,
  p1,
  planFixture,
  report,
  reviewingRun,
} from './helpers/loop-harness.js';

/**
 * A plan loop that stops converging (#394): the first stall asks the planner to
 * step back, the second asks a person.
 *
 * The scripted critic finds new P1s every round - three on an odd round, two
 * on an even one - which beats the default tolerance of one and is the shape of
 * #246-b and #346: the count is not falling and every finding is new. With
 * `stallAfter` 3 the first stall is at record 3, and the earliest the next can
 * be judged is record 5. The count alternates rather than staying flat so that
 * `assessConvergence` sees it fall inside every window and never fires: these
 * cases are about the stall rule, and `maxPlanRounds` is high for the same
 * reason.
 */

const STEP_BACK = '## Stepping back';
const DEFAULT_TEXT = 'Patching each finding has not converged.';

/** New P1s every critique round, named for the round so none repeats. */
function churn(label: string): object {
  const round = Number(label.replace('critique-', ''));
  const ids = round % 2 === 1 ? ['a', 'b', 'c'] : ['a', 'b'];
  return report(ids.map((id) => p1(`r${round}-${id}`)));
}

function loop(over: Partial<LoopConfig> = {}): Config {
  return config({ maxPlanRounds: 20, ...over });
}

/** A run with a plan in hand, so the first turn is the critique. */
function planned(): RunState {
  const state = freshRun({ prefix: 'vibe-step-back-', task: 'step back' });
  state.plan = planFixture();
  return state;
}

interface Drive {
  calls: string[];
  prompts: Map<string, string>;
  error: unknown;
}

/** Run until the loop throws, recording every revision's prompt by label. */
async function drive(
  state: RunState,
  cfg: Config,
  over: { claude?: (label: string) => unknown; codex?: (label: string) => unknown } = {},
): Promise<Drive> {
  const calls: string[] = [];
  const prompts = new Map<string, string>();
  const turns = agents(
    {
      claude: (label, options) => {
        prompts.set(label, options.prompt);
        return over.claude?.(label) ?? planFixture({ plan_md: `# ${label}` });
      },
      codex: (label) => over.codex?.(label) ?? churn(label),
    },
    calls,
  );
  let error: unknown = null;
  try {
    await orchestrate(state, cfg, true, turns);
  } catch (err) {
    error = err;
  }
  return { calls, prompts, error };
}

function stalls(state: RunState): Record<string, unknown>[] {
  return state.events.filter((e) => e.type === 'plan_stalled');
}

function withBlock(prompts: Map<string, string>): string[] {
  return [...prompts].filter(([, p]) => p.includes(STEP_BACK)).map(([label]) => label);
}

// ---- the first stall: step back --------------------------------------------

test('the first stall sends the step-back to exactly the next findings revision', async () => {
  const state = planned();
  const { prompts, error } = await drive(state, loop());

  // The second stall stopped it, which is the next case's subject.
  assert.ok(error instanceof Escalation);
  assert.deepEqual(withBlock(prompts), ['revise-4']);
  const prompt = prompts.get('revise-4') ?? '';
  assert.match(
    prompt,
    /The last 3 critiques kept finding new blocking problems instead of fewer: 3 blocking \(3 new\), 2 \(2 new\), 3 \(3 new\)\./,
  );
  assert.ok(prompt.includes(DEFAULT_TEXT));
  // Placed after the findings it is about and before the boundary.
  assert.ok(prompt.indexOf('## Review findings') < prompt.indexOf(STEP_BACK));
  assert.ok(prompt.indexOf(STEP_BACK) < prompt.indexOf('## The boundary your current plan drew'));

  const first = stalls(state)[0];
  assert.deepEqual(
    { position: first?.['position'], counts: first?.['counts'], fresh: first?.['fresh'], action: first?.['action'] },
    { position: 3, counts: [3, 2, 3], fresh: [3, 2, 3], action: 'step-back' },
  );
  assert.equal(state.planStalls?.[0]?.sent, true);
  assert.equal(stepBackCount(state.events), 1);
});

test('a stop between the stall and its revision sends the block on resume', async () => {
  const state = planned();
  const first = await drive(state, loop(), {
    claude: (label) => {
      if (label === 'revise-4') throw new Error('the process died here');
      return undefined;
    },
  });
  assert.ok(!(first.error instanceof Escalation), 'the stop must be the injected death');
  assert.equal(state.planStalls?.[0]?.sent, undefined, 'nothing saved the revision');

  // The retried revision is `revise-5`, not `revise-4`: `revisePlan` saves the
  // advanced round before its turn, so a death mid-turn spends the number. That
  // predates #394; what matters here is that the retry carries the block.
  const second = await drive(state, loop());
  assert.equal(second.calls[0], 'revise-5');
  assert.deepEqual(withBlock(second.prompts), ['revise-5']);
});

test('once the revision has saved, a resume does not send the block again', async () => {
  const state = planned();
  const first = await drive(state, loop(), {
    codex: (label) => {
      if (label === 'critique-4') throw new Error('the process died here');
      return churn(label);
    },
  });
  assert.ok(!(first.error instanceof Escalation));
  assert.deepEqual(withBlock(first.prompts), ['revise-4']);
  assert.equal(state.planStalls?.[0]?.sent, true);

  const second = await drive(state, loop());
  assert.equal(second.calls[0], 'critique-4');
  assert.deepEqual(withBlock(second.prompts), []);
});

test('prompts.stall replaces the instruction and keeps the counts line', async (t) => {
  installPromptOverrides({ stall: 'Rethink it from the brief.' });
  t.after(() => clearPromptOverrides());

  const state = planned();
  const { prompts } = await drive(state, loop());
  const prompt = prompts.get('revise-4') ?? '';
  assert.ok(prompt.includes('Rethink it from the brief.'));
  assert.ok(!prompt.includes(DEFAULT_TEXT));
  assert.match(prompt, /The last 3 critiques kept finding new blocking problems instead of fewer: /);
});

test('stallAfter 0 never stalls and never sends the block', async () => {
  const state = planned();
  // Capped well before `TREND_FLOOR`, so it is the cap that stops it.
  const { prompts, error } = await drive(state, loop({ stallAfter: 0, maxPlanRounds: 7 }));
  assert.ok(error instanceof Escalation);
  assert.equal(error.code, EXIT.NO_CONVERGENCE);
  assert.deepEqual(stalls(state), []);
  assert.deepEqual(withBlock(prompts), []);
  assert.equal(state.planStalls, undefined);
});

// ---- the second stall: ask a person ----------------------------------------

test('the second stall stops for a person, with the counts, the question and the blockers', async () => {
  const state = planned();
  const { error, calls } = await drive(state, loop());

  assert.ok(error instanceof Escalation);
  assert.equal(error.code, EXIT.NEEDS_HUMAN);
  assert.equal(calls[calls.length - 1], 'critique-5');
  assert.deepEqual(
    state.planStalls?.map((s) => [s.position, s.action]),
    [
      [3, 'step-back'],
      [5, 'escalated'],
    ],
  );
  assert.equal(stalls(state)[1]?.['action'], 'escalated');
  assert.equal(stepBackCount(state.events), 1);

  const md = readFileSync(escalationFile(state, error), 'utf8');
  assert.match(md, /step back at critique record 3/);
  assert.match(md, /Blocking findings per critique record since then \(excluding any a person raised\): 3, 2, 3\./);
  assert.ok(md.includes(STALL_QUESTION.question));
  assert.match(md, /demote each under 'Change a severity' below and leave this answer empty, then resume/);
  assert.match(md, /\*Options:\* narrow the brief \| accept the remaining P1s \| continue/);
  assert.doesNotMatch(md, /Claude would default to/);
  assert.match(md, /## Outstanding P1 findings/);
  assert.match(md, /### Move: `r5-a`/);
  assert.match(md, /### Move: `r5-b`/);
  assert.match(md, /### Move: `r5-c`/);
});

test('an answer reaches the planner, the next round is not judged, and the next stall steps back', async () => {
  const state = planned();
  const { error } = await drive(state, loop());
  assert.ok(error instanceof Escalation);
  escalationFile(state, error);
  answerNeedsInput(state, () => 'Narrow the brief to the parser alone.');

  const resumed = await drive(state, loop());
  assert.equal(resumed.calls[0], 'revise-q0');
  assert.match(resumed.prompts.get('revise-q0') ?? '', /Narrow the brief to the parser alone\./);
  // The answer revision does not carry the step-back; it is the person's steer.
  assert.ok(!(resumed.prompts.get('revise-q0') ?? '').includes(STEP_BACK));

  // Record 6, the round right after the resume, is not judged at all: the
  // escalation at 5 windows it. Record 7 stalls, and steps back.
  assert.deepEqual(
    state.planStalls?.map((s) => [s.position, s.action]),
    [
      [3, 'step-back'],
      [5, 'escalated'],
      [7, 'step-back'],
      [9, 'escalated'],
    ],
  );
  assert.deepEqual(withBlock(resumed.prompts), ['revise-8']);
});

// ---- guardProgress, directly -----------------------------------------------

/** Three earlier records, then the current round's blockers. */
function history(): RoundRecord[] {
  const h: RoundRecord[] = [];
  recordRound(h, null, 1, ['a']);
  recordRound(h, null, 2, ['b', 'c']);
  recordRound(h, null, 3, ['d', 'e', 'f']);
  return h;
}

const NOW: readonly Finding[] = [p1('g'), p1('h'), p1('i')];

/** Late enough that `assessConvergence` judges the trend: 2 -> 3 -> 3 has not fallen. */
const ARGS = { cap: 20, round: 8, capName: 'maxPlanRounds', deadlockMsg: 'deadlocked' };

function guarded(state: RunState, args: Partial<typeof ARGS> & { human?: Set<string> } = {}): unknown {
  const { human, ...rest } = args;
  try {
    guardProgress(DEFAULTS, history(), NOW, NOW, {
      ...ARGS,
      ...rest,
      stall: { state, human: human ?? new Set() },
    });
  } catch (err) {
    return err;
  }
  return null;
}

test('without the stall check the same round stops on the trend - the control', () => {
  let caught: unknown = null;
  try {
    guardProgress(DEFAULTS, history(), NOW, NOW, ARGS);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof Escalation);
  assert.equal(caught.code, EXIT.NO_CONVERGENCE);
  assert.match(caught.message, /^Stopping early: the P1 count has not fallen/);
});

test('a stall and assessConvergence on the same round: the stall wins and the run continues', () => {
  const state = freshRun({ prefix: 'vibe-step-back-' });
  assert.equal(guarded(state), null);
  assert.deepEqual(state.planStalls?.map((s) => [s.position, s.action]), [[3, 'step-back']]);
  assert.equal(stalls(state).length, 1);
});

test('a step-back on the cap round still stops at the cap, with the cap message unchanged', () => {
  const state = freshRun({ prefix: 'vibe-step-back-' });
  const caught = guarded(state, { cap: 8 });
  assert.ok(caught instanceof Escalation);
  assert.equal(caught.code, EXIT.NO_CONVERGENCE);
  assert.equal(caught.message, 'Hit maxPlanRounds (8) with 3 blocking finding(s) outstanding.');
  assert.equal(caught.questions, null);
  assert.deepEqual(state.planStalls?.map((s) => s.action), ['step-back']);
});

test('an escalation on the cap round stops at the cap and still asks the question', () => {
  const state = freshRun({ prefix: 'vibe-step-back-' });
  state.planStalls = [{ position: 1, action: 'step-back', counts: [1, 1, 1], fresh: [1, 1, 1], sent: true }];
  const caught = guarded(state, { cap: 8 });
  assert.ok(caught instanceof Escalation);
  assert.equal(caught.code, EXIT.NO_CONVERGENCE);
  assert.match(caught.message, /^Hit maxPlanRounds \(8\) with 3 blocking finding\(s\) outstanding\. The plan loop stopped converging again/);
  assert.deepEqual(caught.questions, [STALL_QUESTION]);
  assert.deepEqual(state.planStalls.map((s) => s.action), ['step-back', 'escalated']);
});

test("the escalation's counts leave out a person's ids exactly as planStall does", () => {
  const state = freshRun({ prefix: 'vibe-step-back-' });
  state.planStalls = [{ position: 1, action: 'step-back', counts: [1, 1, 1], fresh: [1, 1, 1], sent: true }];
  const human = new Set(['g']);
  const caught = guarded(state, { human });
  assert.ok(caught instanceof Escalation);
  assert.equal(caught.code, EXIT.NEEDS_HUMAN);

  const h = history();
  recordRound(h, null, 3, ['g', 'h', 'i']);
  const measured = planStall(h, { stallAfter: 3, lastStall: 1, human });
  assert.deepEqual(measured?.counts, [2, 3, 2]);
  assert.match(caught.message, /\(excluding any a person raised\): 2, 3, 2\./);
});

// ---- what must not change --------------------------------------------------

test('the review loop never consults planStall', async () => {
  const state = reviewingRun({ prefix: 'vibe-step-back-' });
  const calls: string[] = [];
  const turns = agents(
    {
      claude: () => 'fixed it',
      codex: (label) => {
        const round = label.replace(/\D+/g, '');
        return report([p1(`rv${round}-a`), p1(`rv${round}-b`)]);
      },
    },
    calls,
  );
  await assert.rejects(() => orchestrate(state, config({ maxReviewRounds: 6 }), true, turns));
  // Long enough that the plan loop's rule would have fired on this history.
  assert.ok(state.p1Rounds.length >= 4, `only ${state.p1Rounds.length} review round(s) ran`);
  assert.deepEqual(stalls(state), []);
  assert.equal(state.planStalls, undefined);
});

test('a converging plan loop never stalls and never sends the block', async () => {
  const state = planned();
  const { prompts, error } = await drive(state, loop(), {
    codex: (label) => (label === 'critique-0' ? churn(label) : report([])),
  });
  assert.equal(error, null);
  assert.deepEqual(stalls(state), []);
  assert.deepEqual(withBlock(prompts), []);
  assert.equal(state.planStalls, undefined);
  assert.equal(stepBackCount(state.events), 0);
});
