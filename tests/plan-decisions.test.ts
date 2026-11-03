import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import {
  DECISIONS_FILE,
  decidedSections,
  decisionsPrefix,
  planDecisions,
  renderDecisions,
} from '@src/decisions.js';
import { commitFork, planFork } from '@src/fork.js';
import * as log from '@src/log.js';
import { Escalation, orchestrate, runTurn } from '@src/orchestrator.js';
import { answerPrompt, implementPrompt, renderPlanDoc } from '@src/prompts.js';
import { listCheckpoints, loadRun, saveState } from '@src/run.js';
import { validateStoredState } from '@src/stored.js';
import {
  agents,
  answerNeedsInput,
  answersReport,
  codexRaw,
  committing,
  config,
  escalationFile,
  freshRun,
  p1,
  planFixture,
  questionFixture,
  report,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type {
  AcceptanceCriterion,
  Assumption,
  Config,
  ModelAnswer,
  Plan,
  RunState,
} from '@src/types.js';

/**
 * The planner's assumptions and the decisions made without the person running
 * the loop, carried in the plan of record (#487).
 *
 * Before this, only the critique seats were told the assumptions, PLAN.md left
 * them out, and a model's answer folded into a revision read like any other
 * decision. A Claude implementer had the assumptions by resuming the planner's
 * conversation; a rotated one, and a Codex one, never did.
 */

const ASSUMPTIONS: Assumption[] = [
  { assumption: 'The cache is per process', why: 'Nothing shares it today.', blast_radius: 'Redo the eviction step.' },
  { assumption: 'Keys are ASCII', why: 'Every caller builds them from ids.', blast_radius: 'Normalise keys first.' },
];
const Q1 = questionFixture({ question: 'Should the widget be lazy or eager?', blocking: true });
const Q2 = questionFixture({
  question: 'Which log level should the eviction line use?',
  recommended: 'debug',
  kind: 'technical',
  blocking: false,
});
const CRITERION: AcceptanceCriterion = {
  id: 'evicts-oldest',
  criterion: 'The oldest entry is evicted first',
  check: 'command',
  how: 'npm test',
};
const OTHER: AcceptanceCriterion = {
  id: 'drifted-bar',
  criterion: 'A bar nobody approved',
  check: 'command',
  how: 'npm test',
};
const DEVIATIONS = 'if one turns out to be false, say so under **Deviations** in your report, with the evidence that showed it.';
const PREFIX_HEADING = '## Decisions the approved plan carries';

/** PLAN.md as `renderPlanDoc(planFixture())` wrote it before #487, byte for byte. */
const PLAN_MD_BEFORE =
  '# the plan\n\nDo the thing.\n\n## Out of scope\n\n(the planner considered this and declared nothing out of scope)\n\n## Acceptance criteria\n\n(the planner recorded no criteria - a claim that done-ness here is unobservable)\n';
const NONE_SECTIONS =
  "\n## Assumptions\n\n(the planner declared no material unresolved assumptions)\n\n## Decided without you\n\n(nothing - no question was answered by a model or left on the planner's default, and no plan critique finding was carried into implementation)\n";

function plan(over: Partial<Plan> = {}): Plan {
  return planFixture({ assumptions: ASSUMPTIONS, acceptance_criteria: [CRITERION], ...over });
}

function at(i: number, what: string): number {
  assert.ok(i >= 0, `${what} is present`);
  return i;
}

function read(state: RunState, name: string): string {
  return readFileSync(path.join(state.dir, name), 'utf8');
}

interface Driven {
  calls: string[];
  prompts: Map<string, string>;
  providers: Map<string, 'claude' | 'codex'>;
}

async function drive(state: RunState, cfg: Config, resume: boolean, handlers: Handlers): Promise<Driven> {
  const calls: string[] = [];
  const prompts = new Map<string, string>();
  const providers = new Map<string, 'claude' | 'codex'>();
  const wrapped: Handlers = {
    claude: (label, options) => {
      prompts.set(label, options.prompt);
      providers.set(label, 'claude');
      return handlers.claude?.(label, options);
    },
    codex: (label, options) => {
      prompts.set(label, options.prompt);
      providers.set(label, 'codex');
      return handlers.codex?.(label, options) ?? report([]);
    },
  };
  const realLog = console.log;
  const realError = console.error;
  log.setSink(() => undefined);
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(state, cfg, resume, agents(wrapped, calls));
  } finally {
    log.setSink(null);
    console.log = realLog;
    console.error = realError;
  }
  return { calls, prompts, providers };
}

function prompt(driven: Driven, label: string): string {
  const got = driven.prompts.get(label);
  assert.ok(got !== undefined, `${label} ran (saw ${driven.calls.join(', ')})`);
  return got;
}

/** Plan with two assumptions and two questions; answer one, decline the advisory one; implement; approve. */
async function questionLoop(): Promise<{ state: RunState; driven: Driven }> {
  const state = freshRun({ prefix: 'vibe-decisions-loop-', task: 'decisions', planOnly: false, git: true, commit: true });
  const driven = await drive(state, config({}, committing()), false, {
    claude: (label) => {
      if (label === 'plan') return plan({ open_questions: [Q1, Q2] });
      if (label.startsWith('revise-')) return plan();
      work(state, `${label}.txt`);
      return `${label} done`;
    },
    codex: (label) =>
      label.startsWith('answers-')
        ? answersReport([
            { question: Q1.question, answer: 'Lazy.', confidence: 'high', rationale: 'It is never read at start-up.' },
            { question: Q2.question, defer_to_human: true, rationale: 'Taste.' },
          ])
        : report([]),
  });
  return { state, driven };
}

// ---- through the loop -------------------------------------------------------

test('through the loop, PLAN.md and DECISIONS.md list the assumptions, the model answer and the default', async () => {
  const { state, driven } = await questionLoop();
  assert.deepEqual(driven.calls, ['plan', 'answers-1', 'revise-q1', 'critique-0', 'implement', 'review-0']);

  assert.deepEqual(state.modelAnswers, [
    { round: 1, question: Q1.question, answer: 'Lazy.', confidence: 'high', rationale: 'It is never read at start-up.' },
  ] satisfies ModelAnswer[]);
  assert.equal(state.deferredQuestions.length, 1, 'the declined advisory question ran on its default');

  const doc = read(state, 'PLAN.md');
  const criteria = at(doc.indexOf('## Acceptance criteria'), 'the criteria section');
  const assumptions = at(doc.indexOf('\n## Assumptions\n'), 'the assumptions section');
  const decided = at(doc.indexOf('\n## Decided without you\n'), 'the decided section');
  assert.ok(criteria < assumptions && assumptions < decided, 'after the bar, in that order');
  for (const a of ASSUMPTIONS) {
    assert.ok(doc.indexOf(a.assumption) > assumptions && doc.indexOf(a.assumption) < decided, a.assumption);
  }
  const tail = doc.slice(decided);
  assert.ok(tail.includes(Q1.question) && tail.includes('Answer: Lazy.') && tail.includes('Confidence: high'));
  assert.ok(tail.includes(Q2.question) && tail.includes('Default used: debug'));
  assert.equal(doc, renderPlanDoc(plan(), undefined, planDecisions(state, plan())));

  const decisions = read(state, DECISIONS_FILE);
  const headings = ['## Assumptions', '## Answered by a model', "## Left on the planner's default", '## Carried into implementation'];
  let last = -1;
  for (const h of headings) {
    const i = at(decisions.indexOf(`\n${h}\n`), h);
    assert.ok(i > last, `${h} in order`);
    last = i;
  }
  for (const a of ASSUMPTIONS) assert.ok(decisions.includes(a.assumption));
  assert.ok(decisions.includes('Lazy.') && decisions.includes('It is never read at start-up.'));
  assert.ok(decisions.includes('Default used: debug'));
  assert.ok(decisions.endsWith('## Carried into implementation\n\nNone.\n'), 'an empty section says so');
});

test('through the loop, the implement prompt carries the assumptions and the Deviations instruction', async () => {
  const { driven } = await questionLoop();
  const impl = prompt(driven, 'implement');
  const bar = at(impl.indexOf('## Acceptance criteria - the bar this change must clear'), 'the frozen bar');
  const block = at(impl.indexOf('## Assumptions the plan rests on'), 'the assumptions block');
  const reportAt = at(impl.indexOf('## Your report'), 'the report request');
  assert.ok(bar < block && block < reportAt, 'after the frozen bar, before the report');
  for (const a of ASSUMPTIONS) assert.ok(impl.includes(a.assumption), a.assumption);
  assert.ok(impl.includes(DEVIATIONS));
  // A Claude implementer resuming `main` has the planner's conversation, so it
  // is handed no prefix.
  assert.equal(driven.providers.get('implement'), 'claude');
  assert.equal(impl.includes(PREFIX_HEADING), false);
});

test("the answerer's prompt is the one it was before: the plan without its decisions", async () => {
  const { driven } = await questionLoop();
  const asked = prompt(driven, 'answers-1');
  assert.ok(asked.includes(answerPrompt([Q1, Q2], renderPlanDoc(plan({ open_questions: [Q1, Q2] })))));
  assert.equal(asked.includes('## Decided without you'), false);
  assert.equal(asked.includes('\n## Assumptions\n'), false);
  // And `renderPlanDoc` with no decisions is still the bytes it always was.
  assert.equal(renderPlanDoc(planFixture()), PLAN_MD_BEFORE);
});

// ---- a rotated implementer --------------------------------------------------

function approvedRun(prefix: string): RunState {
  const state = freshRun({ prefix, task: 'rotated', planOnly: false, git: true, commit: true });
  // Drifted after the gate, so the case can say which bar reached the turn.
  state.plan = plan({ acceptance_criteria: [OTHER] });
  state.acceptanceCriteria = [CRITERION];
  state.questionRound = 1;
  state.modelAnswers = [{ round: 1, question: Q1.question, answer: 'Lazy.', confidence: 'high', rationale: 'Cheap.' }];
  state.deferredQuestions = [{ question: Q2.question, kind: 'technical', recommended: 'debug', reason: 'Taste.' }];
  state.handoff = 'a briefing that names no decision';
  return state;
}

test('a rotated implementer, on the production implement turn, is handed the decisions and the frozen bar', async () => {
  const state = approvedRun('vibe-decisions-rotated-');
  // A rotation leaves the main slot with no conversation: the implement turn is
  // a fresh session, which is what makes `freshConversationPrefix` run.
  state.status = 'implementing';
  state.phase = 'implementing';
  saveState(state);

  const driven = await drive(state, config({}, committing()), true, {
    claude: (label) => {
      work(state, `${label}.txt`);
      return `${label} done`;
    },
  });
  const impl = prompt(driven, 'implement');
  assert.ok(impl.includes('## Handoff from your previous session'), 'the briefing travelled');
  const prefix = at(impl.indexOf(PREFIX_HEADING), 'the decisions prefix');
  const body = at(impl.indexOf('The plan below has been reviewed.'), 'the implement prompt');
  assert.ok(prefix < body, 'beside the prompt, before it');
  const decided = impl.slice(prefix, body);
  assert.ok(decided.includes('## Decided without you'));
  assert.ok(decided.includes('Answer: Lazy.') && decided.includes('Default used: debug'));
  assert.ok(impl.includes('## Assumptions the plan rests on'));
  assert.ok(impl.includes(CRITERION.criterion), 'the approved bar');
  assert.equal(impl.includes(OTHER.criterion), false, 'never the drifted one');
});

/** One memoryless turn for a role, with the plan withheld from the prompt - `planOfRecord`'s own road. */
async function bareTurn(state: RunState, role: 'implementer' | 'planner'): Promise<string> {
  const seen = new Map<string, string>();
  await runTurn(
    state,
    config(),
    { role, prompt: 'TURN BODY', cwd: state.targetDir, label: role },
    agents({ claude: (label, turn) => void seen.set(label, turn.prompt) }, []),
  );
  const got = seen.get(role);
  assert.ok(got !== undefined, 'the turn ran');
  return got;
}

test("an implementer's plan of record carries both sections, and a planner's carries neither", async () => {
  const implementer = await bareTurn(approvedRun('vibe-decisions-por-impl-'), 'implementer');
  assert.ok(implementer.includes('\n## Assumptions\n') && implementer.includes('## Decided without you'));
  assert.ok(implementer.includes(CRITERION.criterion) && !implementer.includes(OTHER.criterion));
  assert.equal(implementer.includes(PREFIX_HEADING), false, 'the plan of record already carries them');

  const planner = await bareTurn(approvedRun('vibe-decisions-por-planner-'), 'planner');
  assert.equal(planner.includes('## Decided without you'), false);
  assert.equal(planner.includes('\n## Assumptions\n'), false);
});

// ---- a Codex implementer ----------------------------------------------------

test('a Codex implementer is given the assumptions, and the decisions on every writer turn, with no rotation text', async () => {
  const state = freshRun({ prefix: 'vibe-decisions-codex-', task: 'codex writer', planOnly: false, git: true, commit: true });
  const writer = (label: string): unknown => {
    work(state, `${label}.txt`);
    return codexRaw(`${label} done`);
  };
  const driven = await drive(
    state,
    config({ p1Tolerance: 0, maxReviewRounds: 3 }, { ...committing(), roles: { ...DEFAULTS.roles, implementer: 'codex' } }),
    false,
    {
      claude: () => plan(),
      codex: (label) => {
        if (label === 'implement' || label.startsWith('fix-')) return writer(label);
        return label === 'review-0' ? report([p1('finding-one')]) : report([]);
      },
    },
  );
  for (const label of ['implement', 'fix-1']) {
    assert.equal(driven.providers.get(label), 'codex', label);
    const got = prompt(driven, label);
    assert.ok(got.startsWith(PREFIX_HEADING), `${label} opens with the decisions, and no briefing`);
    assert.equal(got.includes('rotated'), false, `${label} is not told it was rotated`);
    for (const a of ASSUMPTIONS) assert.ok(got.includes(a.assumption), `${label}: ${a.assumption}`);
  }
  assert.ok(prompt(driven, 'implement').includes('## Assumptions the plan rests on'));
});

// ---- nothing to say ---------------------------------------------------------

test('no assumptions and no questions: PLAN.md gains the two headings with one line each, and the prompt is unchanged', async () => {
  const state = freshRun({ prefix: 'vibe-decisions-none-', task: 'none' });
  const driven = await drive(state, config(), false, { claude: () => planFixture() });
  assert.deepEqual(driven.calls, ['plan', 'critique-0']);
  assert.equal(read(state, 'PLAN.md'), PLAN_MD_BEFORE + NONE_SECTIONS);

  const md = planFixture().plan_md;
  assert.equal(
    implementPrompt(md, [], [], [CRITERION], [], [], null, []),
    implementPrompt(md, [], [], [CRITERION], [], [], null),
  );
  assert.equal(implementPrompt(md, [], [], [CRITERION], [], [], null, []).includes('## Assumptions the plan rests on'), false);
});

// ---- a run from before #487 -------------------------------------------------

test('a state with no record past round 0 says "not recorded for this run", never none', () => {
  const state = freshRun({ prefix: 'vibe-decisions-legacy-' });
  state.questionRound = 2;
  const d = planDecisions(state, planFixture());
  assert.equal(d.modelAnswers, undefined);
  for (const [what, text] of [
    ['PLAN.md', decidedSections(d)],
    ['DECISIONS.md', renderDecisions(state, d)],
    ['the prefix', decisionsPrefix(d)],
  ] as const) {
    assert.ok(text.includes('Not recorded for this run.'), what);
    assert.equal(text.includes('(nothing'), false, `${what} does not say nothing over a missing record`);
  }
  assert.ok(renderDecisions(state, d).includes('## Answered by a model\n\nNot recorded for this run.\n'));

  // No question round ever ran: no model could have answered, so none is a fact.
  state.questionRound = 0;
  const none = planDecisions(state, planFixture());
  assert.deepEqual(none.modelAnswers, []);
  assert.ok(renderDecisions(state, none).includes('## Answered by a model\n\nNone.\n'));
});

test('a run from before #487 that answers round 3 stays unrecorded, and does not list round 3 as the whole', async () => {
  const state = freshRun({ prefix: 'vibe-decisions-round3-', task: 'round three' });
  // What a state written before the field existed looks like, two question rounds in.
  state.questionRound = 2;
  const driven = await drive(state, config({ maxQuestionRounds: 5 }), false, {
    claude: (label) => (label === 'plan' ? planFixture({ open_questions: [Q1] }) : planFixture()),
    codex: (label) =>
      label.startsWith('answers-') ? answersReport([{ question: Q1.question, answer: 'Eager.' }]) : report([]),
  });
  assert.ok(driven.calls.includes('answers-3'), `round 3 ran (saw ${driven.calls.join(', ')})`);
  assert.equal(state.modelAnswers, undefined);
  assert.equal('modelAnswers' in loadRun(state.targetDir, state.id), false, 'and on disk');
  for (const name of ['PLAN.md', DECISIONS_FILE]) {
    const text = read(state, name);
    assert.ok(text.includes('Not recorded for this run.'), name);
    assert.equal(text.includes('Eager.'), false, `${name} does not list round 3 alone`);
  }
});

test('a new run creates the record at round 1, and holds that round', async () => {
  const state = freshRun({ prefix: 'vibe-decisions-round1-', task: 'round one' });
  await drive(state, config(), false, {
    claude: (label) => (label === 'plan' ? planFixture({ open_questions: [Q1] }) : planFixture()),
    codex: (label) =>
      label.startsWith('answers-') ? answersReport([{ question: Q1.question, answer: 'Eager.' }]) : report([]),
  });
  assert.deepEqual(state.modelAnswers?.map((a) => [a.round, a.answer]), [[1, 'Eager.']]);
});

test('the record is created before the first answerer turn, so a turn that dies there does not lose it', async () => {
  const state = freshRun({ prefix: 'vibe-decisions-kill-', task: 'killed answerer' });
  const planner = (label: string): Plan => (label === 'plan' ? planFixture({ open_questions: [Q1] }) : planFixture());
  await assert.rejects(() =>
    drive(state, config(), false, {
      claude: planner,
      codex: (label) => {
        if (label.startsWith('answers-')) throw new Error('the answerer died');
        return report([]);
      },
    }),
  );
  assert.equal(state.questionRound, 1);
  assert.deepEqual(loadRun(state.targetDir, state.id).modelAnswers, [], 'on disk, recorded and empty');

  const resumed = loadRun(state.targetDir, state.id);
  const driven = await drive(resumed, config(), true, {
    claude: planner,
    codex: (label) =>
      label.startsWith('answers-') ? answersReport([{ question: Q1.question, answer: 'Eager.' }]) : report([]),
  });
  assert.ok(driven.calls.includes('answers-2'), `the question was asked again (saw ${driven.calls.join(', ')})`);
  assert.deepEqual(resumed.modelAnswers?.map((a) => [a.round, a.answer]), [[2, 'Eager.']]);
});

test('a model answer the person overrode on resume is not listed as decided without them', async () => {
  // A `question-round` stop hands back every question of the round, answered or
  // not, and on resume the person wins where both answered (#169).
  const state = freshRun({ prefix: 'vibe-decisions-override-', task: 'person wins', planOnly: false, git: true, commit: true });
  const Q3 = questionFixture({ question: 'Should eviction run on write or on a timer?' });
  const stop = { ...DEFAULTS.gates, 'question-round': 'stop' as const };
  let err: unknown = null;
  try {
    await drive(state, config({}, { gates: stop }), false, {
      claude: (label) => (label === 'plan' ? plan({ open_questions: [Q1, Q3] }) : plan()),
      codex: (label) =>
        label.startsWith('answers-')
          ? answersReport([
              { question: Q1.question, answer: 'MODEL-Q1' },
              { question: Q3.question, answer: 'MODEL-Q3' },
            ])
          : report([]),
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof Escalation, String(err));
  // Recorded as it arrived: both were the model's answers when the turn returned.
  assert.deepEqual(state.modelAnswers?.map((a) => a.answer), ['MODEL-Q1', 'MODEL-Q3']);
  escalationFile(state, err);
  answerNeedsInput(state, (question) => (question.startsWith(Q1.question) ? 'PERSON-Q1' : ''));

  await drive(state, config({}, committing()), true, {
    claude: (label) => {
      if (label.startsWith('revise-')) return plan();
      work(state, `${label}.txt`);
      return `${label} done`;
    },
  });
  for (const name of ['PLAN.md', DECISIONS_FILE]) {
    const text = read(state, name);
    assert.equal(text.includes('MODEL-Q1'), false, `${name} does not list the answer the person replaced`);
    assert.ok(text.includes('MODEL-Q3'), `${name} keeps the one the person left to the model`);
  }
  const d = planDecisions(state, plan());
  assert.ok(decisionsPrefix(d).includes('MODEL-Q3') && !decisionsPrefix(d).includes('MODEL-Q1'));
  // The record itself is untouched: what a model said is still what it said.
  assert.deepEqual(state.modelAnswers?.map((a) => a.answer), ['MODEL-Q1', 'MODEL-Q3']);
});

// ---- a fork -----------------------------------------------------------------

test("a fork's PLAN.md and DECISIONS.md are written from the child's state", async () => {
  const parent = freshRun({ prefix: 'vibe-decisions-fork-', task: 'forking decisions', planOnly: false, git: true, commit: true });
  let round = 0;
  await drive(parent, config({}, committing()), false, {
    claude: (label) => {
      if (label === 'plan') return plan({ open_questions: [Q1] });
      if (label.startsWith('revise')) return plan();
      round += 1;
      work(parent, `work-${round}.txt`);
      return `did ${label}`;
    },
    codex: (label) =>
      label.startsWith('answers-') ? answersReport([{ question: Q1.question, answer: 'Lazy.' }]) : report([]),
  });
  const point = listCheckpoints(parent.dir).find((c) => c.meta?.commit != null);
  assert.ok(point !== undefined, 'the parent recorded a checkpoint with a commit');

  const result = await commitFork(parent.targetDir, await planFork(parent.targetDir, parent.id, point.n, {}));
  const child = result.state;
  assert.ok(child.plan !== null);
  assert.deepEqual(child.modelAnswers, parent.modelAnswers, "the checkpoint's record travelled");

  const file = path.join(child.dir, DECISIONS_FILE);
  assert.ok(existsSync(file));
  const text = readFileSync(file, 'utf8');
  assert.equal(text, renderDecisions(child, planDecisions(child, child.plan)));
  assert.ok(text.includes(`**Run:** \`${child.id}\``), 'under the child, not the parent');
  assert.ok(text.includes('Lazy.'), "the parent's model answer");
  assert.ok(readFileSync(path.join(child.dir, 'PLAN.md'), 'utf8').includes('## Decided without you'));
});

// ---- the stored record ------------------------------------------------------

test('a malformed modelAnswers entry is dropped with a repair note, and a non-list drops the field', () => {
  const state = freshRun({ prefix: 'vibe-decisions-stored-' });
  const good: ModelAnswer = { round: 1, question: Q1.question, answer: 'Lazy.', confidence: 'high', rationale: 'Cheap.' };
  const raw = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;

  raw['modelAnswers'] = [good, { round: 1, question: 'q', answer: 'a', rationale: 'r' }];
  const read1 = validateStoredState(raw, state.id, state.dir);
  assert.deepEqual(read1.state.modelAnswers, [good]);
  const repair = read1.repairs.find((r) => r.field === 'modelAnswers');
  assert.ok(repair !== undefined, 'the drop is said');
  assert.deepEqual(repair.droppedPaths, ['modelAnswers[1]']);

  raw['modelAnswers'] = { round: 1 };
  const read2 = validateStoredState(raw, state.id, state.dir);
  assert.equal(read2.state.modelAnswers, undefined, 'absent - never an empty list nobody wrote');
  assert.ok(read2.repairs.some((r) => r.field === 'modelAnswers'));

  delete raw['modelAnswers'];
  const read3 = validateStoredState(raw, state.id, state.dir);
  assert.equal('modelAnswers' in read3.state, false);
  assert.equal(read3.repairs.some((r) => r.field === 'modelAnswers'), false, 'absent is not damage');
});

// ---- inert text -------------------------------------------------------------

test('planner and model text cannot begin a line of its own', () => {
  const state = freshRun({ prefix: 'vibe-decisions-inert-' });
  state.modelAnswers = [
    { round: 1, question: 'Q?\n### forged', answer: 'A\n## Carried into implementation', confidence: 'low', rationale: '**x**' },
  ];
  state.questionRound = 1;
  const d = planDecisions(state, planFixture({ assumptions: [{ assumption: 'a\n# heading', why: 'w', blast_radius: 'b' }] }));
  const text = renderDecisions(state, d);
  assert.equal(text.includes('\n### forged'), false);
  assert.equal(text.split('\n## Carried into implementation').length, 2, 'only the real heading');
  assert.equal(text.includes('\n# heading'), false);
});
