import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { orchestrate } from '@src/orchestrator.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { rolesFor } from '@src/roles.js';
import { saveState } from '@src/run.js';
import { PLAN_SCHEMA, REVISE_SCHEMA } from '@src/schemas.js';
import { renderScorecard, scoreArchive } from '@src/scorecard.js';
import type { Config, CritiqueConfig, Evidence, Finding, PlanDispositions, RunState } from '@src/types.js';
import {
  agents,
  answersReport,
  config,
  findingFixture,
  freshRun,
  p1,
  planFixture,
  questionFixture,
  report,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';

/**
 * What the planner did with each critique finding, recorded as data (#453).
 *
 * Only `revise-<n>`, the revision answering a critique, is sent `REVISE_SCHEMA`;
 * its dispositions are split off the plan and land in
 * `plan-dispositions-<n>.json` and a `plan_dispositions` event. The plan of
 * record never carries them. The rule the cases guard is #393's: an id a
 * readable answer left out is `not-addressed`, and an answer that could not be
 * read records nothing at all.
 */

interface Driven {
  calls: string[];
  seen: Narration[];
  prompts: Map<string, string>;
  schemas: Map<string, unknown>;
}

/** A citation of the fixture's own file, so grounding and the finder merge resolve it. */
const HERE: Evidence = { kind: 'code', path: 'widget.ts', line: 1 };

function cited(id: string, title = `Finding ${id}`): Finding {
  return { ...p1(id), title, evidence: [HERE] };
}

function run(prefix: string): RunState {
  const state = freshRun({ prefix, task: 'what the planner did' });
  writeFileSync(path.join(state.targetDir, 'widget.ts'), 'export const widget = 1;\n', 'utf8');
  return state;
}

function withCritique(critique: Partial<CritiqueConfig>, over: Partial<Config> = {}): Config {
  return config({ p1Tolerance: 0 }, { ...over, critique: { ...DEFAULTS.critique, ...critique } });
}

/** A revision's output: the plan, plus its dispositions. */
function revised(dispositions: unknown): object {
  return { ...planFixture(), dispositions };
}

async function drive(state: RunState, cfg: Config, handlers: Handlers, resume = false): Promise<Driven> {
  const calls: string[] = [];
  const seen: Narration[] = [];
  const prompts = new Map<string, string>();
  const schemas = new Map<string, unknown>();
  const wrapped: Handlers = {
    claude: (label, options) => {
      prompts.set(label, options.prompt);
      schemas.set(label, options.jsonSchema);
      return handlers.claude?.(label, options) ?? planFixture();
    },
    codex: (label, options) => {
      prompts.set(label, options.prompt);
      return handlers.codex?.(label, options) ?? report([]);
    },
  };
  log.setSink((n) => void seen.push(n));
  const realLog = console.log;
  const realError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(state, cfg, resume, agents(wrapped, calls));
  } finally {
    log.setSink(null);
    console.log = realLog;
    console.error = realError;
  }
  return { calls, seen, prompts, schemas };
}

/** The critic's report per round, from `critique-<n>` alone. */
function critic(byRound: (round: number) => readonly Finding[]): (label: string) => unknown {
  return (label) => {
    const round = /^critique-(\d+)$/.exec(label)?.[1];
    return report(round === undefined ? [] : byRound(Number(round)));
  };
}

function file(state: RunState, n: number): PlanDispositions {
  return JSON.parse(readFileSync(path.join(state.dir, `plan-dispositions-${n}.json`), 'utf8')) as PlanDispositions;
}

function events(state: RunState, type: string): Record<string, unknown>[] {
  return state.events.filter((e) => e.type === type) as Record<string, unknown>[];
}

function criticSeat(cfg: Config): { seat: string; provider: string; model: string }[] {
  const spec = rolesFor(cfg).critic;
  return [{ seat: 'roles.critic', provider: spec.provider, model: spec.model ?? 'default' }];
}

test('a revision answering fixed, rebutted and leaving one out records all three, and the plan never carries them', async () => {
  const state = run('vibe-plan-disp-');
  const cfg = withCritique({});
  const { calls, schemas, prompts } = await drive(state, cfg, {
    codex: critic((r) => (r === 0 ? [cited('one'), cited('two'), cited('three')] : [])),
    claude: (label) =>
      label === 'revise-1'
        ? revised([
            { id: 'one', disposition: 'fixed', reason: 'step 2 now guards it' },
            { id: 'two', disposition: 'rebutted', reason: 'the path is unreachable' },
          ])
        : planFixture(),
  });

  assert.deepEqual(calls, ['plan', 'critique-0', 'revise-1', 'critique-1']);
  assert.equal(schemas.get('revise-1'), REVISE_SCHEMA, 'the findings revision is sent the schema');
  assert.equal(schemas.get('plan'), PLAN_SCHEMA, 'the first plan turn is sent the role schema, as before');
  const prompt = prompts.get('revise-1') ?? '';
  assert.match(prompt, /answer its id in `dispositions`/);
  assert.match(prompt, /Still explain a rebuttal in the plan itself/);
  assert.equal(prompt.includes('say so explicitly in the plan'), false);

  const seats = criticSeat(cfg);
  const d = file(state, 1);
  assert.deepEqual(d, {
    round: 1,
    label: 'revise-1',
    answers: 0,
    dispositions: [
      { id: 'one', severity: 'P1', raisedBy: 'critic', disposition: 'fixed', reason: 'step 2 now guards it', seats, reproducer: null, vote: null },
      { id: 'two', severity: 'P1', raisedBy: 'critic', disposition: 'rebutted', reason: 'the path is unreachable', seats, reproducer: null, vote: null },
      { id: 'three', severity: 'P1', raisedBy: 'critic', disposition: 'not-addressed', reason: '', seats, reproducer: null, vote: null },
    ],
    dropped: [],
    duplicates: [],
  });
  const [event, ...more] = events(state, 'plan_dispositions');
  assert.equal(more.length, 0);
  const { at: _at, type: _type, ...data } = event ?? {};
  assert.deepEqual(data, d, 'the event carries exactly what the artifact does');
  assert.equal(events(state, 'plan_dispositions_unreadable').length, 0);

  const plan = JSON.parse(readFileSync(path.join(state.dir, 'plan-1.json'), 'utf8')) as Record<string, unknown>;
  assert.equal('dispositions' in plan, false, 'plan-1.json keeps the plan shape');
  assert.equal('dispositions' in (state.plan ?? {}), false, 'and so does the plan of record');
  assert.deepEqual(state.criticSeat, { round: 1, provider: seats[0]?.provider, model: seats[0]?.model });

  // `two` was rebutted and critique-1 approved without it: not raised again,
  // recorded on the critique that approved.
  const [compared] = events(state, 'critique_rebuttal_disputed');
  assert.deepEqual(
    { round: compared?.['round'], rebutted: compared?.['rebutted'], disputed: compared?.['disputed'], notRaisedAgain: compared?.['notRaisedAgain'] },
    { round: 1, rebutted: ['two'], disputed: [], notRaisedAgain: ['two'] },
  );
});

for (const [name, dispositions] of [
  ['no dispositions key', undefined],
  ['dispositions that are not a list', 'none'],
  ['an entry outside the vocabulary', [{ id: 'one', disposition: 'maybe', reason: 'r' }]],
] as const) {
  test(`unreadable dispositions (${name}): the plan stands, the warning is recorded, and no file is left`, async () => {
    const state = run('vibe-plan-disp-bad-');
    // A previous attempt's readable file, which this attempt's warning must not sit beside.
    writeFileSync(path.join(state.dir, 'plan-dispositions-1.json'), '{"stale":true}', 'utf8');
    const { calls } = await drive(state, withCritique({}), {
      codex: critic((r) => (r === 0 ? [cited('one')] : [])),
      claude: (label) =>
        label === 'revise-1'
          ? { ...planFixture({ plan_md: '# revised' }), ...(dispositions === undefined ? {} : { dispositions }) }
          : planFixture(),
    });
    assert.deepEqual(calls, ['plan', 'critique-0', 'revise-1', 'critique-1']);
    const plan = JSON.parse(readFileSync(path.join(state.dir, 'plan-1.json'), 'utf8')) as { plan_md: string };
    assert.equal(plan.plan_md, '# revised', 'the plan is recorded');
    assert.equal(state.plan?.plan_md, '# revised');
    const [warning, ...more] = events(state, 'plan_dispositions_unreadable');
    assert.equal(more.length, 0);
    assert.equal(warning?.['round'], 1);
    assert.equal(warning?.['label'], 'revise-1');
    assert.equal(warning?.['answers'], 0);
    assert.equal(events(state, 'plan_dispositions').length, 0);
    assert.equal(existsSync(path.join(state.dir, 'plan-dispositions-1.json')), false);
  });
}

test('an invented id is dropped and a repeated one keeps the first, and the narration names both', async () => {
  const state = run('vibe-plan-disp-ids-');
  const { seen } = await drive(state, withCritique({}), {
    codex: critic((r) => (r === 0 ? [cited('a'), cited('b')] : [])),
    claude: (label) =>
      label === 'revise-1'
        ? revised([
            { id: 'b', disposition: 'fixed', reason: 'first' },
            { id: 'zzz', disposition: 'fixed', reason: 'invented' },
            { id: 'b', disposition: 'rebutted', reason: 'second' },
          ])
        : planFixture(),
  });
  const d = file(state, 1);
  assert.deepEqual(
    d.dispositions.map((x) => [x.id, x.disposition, x.reason]),
    [
      ['a', 'not-addressed', ''],
      ['b', 'fixed', 'first'],
    ],
  );
  const said = seen.find((n) => n.id === 'plan_dispositions');
  assert.equal(said?.level, 'warn');
  assert.equal(
    said?.message,
    'revise-1: 1 fixed, 0 rebutted by the planner, 0 deferred, 1 not addressed, of 2; ' +
      'ignored ids not in the prompt: zzz; duplicate ids, first kept: b',
  );
});

test('a critique that approves first time sends the plan schema and writes what it always wrote', async () => {
  const state = run('vibe-plan-disp-clean-');
  const { calls, schemas, prompts } = await drive(state, withCritique({}), { codex: critic(() => []) });
  assert.deepEqual(calls, ['plan', 'critique-0']);
  assert.equal(schemas.get('plan'), PLAN_SCHEMA);
  assert.equal((prompts.get('plan') ?? '').includes('dispositions'), false, 'no dispositions instruction');
  assert.equal(readFileSync(path.join(state.dir, 'plan-0.json'), 'utf8'), JSON.stringify(planFixture(), null, 2));
  assert.deepEqual(readdirSync(state.dir).filter((f) => f.startsWith('plan-dispositions')), []);
  assert.equal(events(state, 'plan_dispositions').length + events(state, 'plan_dispositions_unreadable').length, 0);
  assert.equal(events(state, 'critique_rebuttal_disputed').length, 0);
});

test('an answers-only revision sends the plan schema and a prompt with no dispositions in it', async () => {
  const state = run('vibe-plan-disp-answers-');
  const { calls, schemas, prompts } = await drive(state, withCritique({}), {
    claude: (label) =>
      label === 'plan' ? planFixture({ open_questions: [questionFixture({ blocking: true })] }) : planFixture(),
    codex: (label) => (label.startsWith('answers-') ? answersReport([{ answer: 'yes' }]) : report([])),
  });
  assert.deepEqual(calls, ['plan', 'answers-1', 'revise-q1', 'critique-0']);
  assert.equal(schemas.get('revise-q1'), PLAN_SCHEMA, 'not REVISE_SCHEMA');
  const prompt = prompts.get('revise-q1') ?? '';
  assert.equal(prompt.includes('dispositions'), false);
  assert.equal(readFileSync(path.join(state.dir, 'plan-0.json'), 'utf8'), JSON.stringify(planFixture(), null, 2));
  assert.deepEqual(readdirSync(state.dir).filter((f) => f.startsWith('plan-dispositions')), []);
  assert.equal(events(state, 'plan_dispositions').length + events(state, 'plan_dispositions_unreadable').length, 0);
});

test('with critique finders, a finding is credited to every seat that raised it', async () => {
  const state = run('vibe-plan-disp-finders-');
  const cfg = withCritique({ finders: ['codex'] });
  await drive(state, cfg, {
    codex: (label) => {
      if (label === 'critique-0') return report([cited('critic-sees-it')]);
      if (label === 'critique-0-f1') return report([cited('finder-sees-it', 'Something else said about the same line')]);
      return report([]);
    },
    claude: (label) =>
      label === 'revise-1' ? revised([{ id: 'critic-sees-it', disposition: 'fixed', reason: 'done' }]) : planFixture(),
  });
  const critique = JSON.parse(readFileSync(path.join(state.dir, 'plan-critique-0.json'), 'utf8')) as { findings: Finding[] };
  const foundBy = critique.findings[0]?.foundBy ?? [];
  assert.equal(foundBy.length, 2);
  const [d] = file(state, 1).dispositions;
  assert.deepEqual(
    d?.seats,
    foundBy.map((s) => ({ seat: s.seat, provider: s.provider, model: s.model })),
  );
});

/** A run stopped after `critique-0`, carrying its findings into the revision. */
function carrying(findings: readonly Finding[], stamp: RunState['criticSeat']): RunState {
  const state = run('vibe-plan-disp-resume-');
  state.plan = planFixture();
  state.pendingFindings = { phase: 'plan', findings: [...findings] };
  if (stamp !== undefined) state.criticSeat = stamp;
  saveState(state);
  return state;
}

const CARRIED: Finding[] = [
  { ...p1('critic-said'), raisedBy: 'critic' },
  { ...p1('human-mine'), raisedBy: 'human' },
  { ...p1('placeholder'), raisedBy: 'vibe' },
];

const ANSWER_ALL = revised([
  { id: 'critic-said', disposition: 'rebutted', reason: 'wrong' },
  { id: 'human-mine', disposition: 'fixed', reason: 'done' },
  { id: 'placeholder', disposition: 'fixed', reason: 'done' },
]);

test('a resume that moved roles.critic credits the seat that critiqued; a person and vibe are credited to nobody', async () => {
  // Critiqued by claude/model-a; the resumed config seats codex as the critic.
  const state = carrying(CARRIED, { round: 0, provider: 'claude', model: 'model-a' });
  const { calls } = await drive(state, withCritique({}), { claude: (label) => (label === 'revise-1' ? ANSWER_ALL : planFixture()) }, true);
  assert.deepEqual(calls, ['revise-1', 'critique-1']);
  const byId = new Map(file(state, 1).dispositions.map((d) => [d.id, d]));
  assert.deepEqual(byId.get('critic-said')?.seats, [{ seat: 'roles.critic', provider: 'claude', model: 'model-a' }]);
  assert.equal(byId.get('human-mine')?.seats, null);
  assert.equal(byId.get('placeholder')?.seats, null);

  const card = scoreArchive(state.targetDir).findings.critiqueOutcomes;
  assert.deepEqual(card.total, { of: 1, fixed: 0, rebutted: 1, deferred: 0, notAddressed: 0 });
  assert.deepEqual(Object.keys(card.bySeat), ['claude/model-a'], 'never the seat that holds it now');
  assert.deepEqual(card.excluded, { human: 1, vibe: 1 });
});

test('a stamp for another critique round, or none, credits no seat', async () => {
  for (const stamp of [{ round: 3, provider: 'claude', model: 'model-a' }, undefined]) {
    const state = carrying(CARRIED, stamp);
    await drive(state, withCritique({}), { claude: (label) => (label === 'revise-1' ? ANSWER_ALL : planFixture()) }, true);
    assert.equal(file(state, 1).dispositions[0]?.seats, null, JSON.stringify(stamp));
    assert.equal(scoreArchive(state.targetDir).findings.critiqueOutcomes.unattributed, 1);
  }
});

const REAL = { vote: 'real', reason: 'It is there.', evidence: [] };
const NOT_REAL = { vote: 'not-real', reason: 'The plan handles it in step 2.', evidence: [{ ...HERE, excerpt: null, ref: null }] };

test('with critique verifiers, each disposition carries its finding s vote outcome, and the scorecard counts it', async () => {
  const state = run('vibe-plan-disp-votes-');
  await drive(state, withCritique({ verifiers: ['codex', 'codex', 'codex'] }), {
    codex: (label) => {
      // The first finding is confirmed, the second is not; the P2 is not voted on.
      if (/^critique-0-vote-1-v\d$/.test(label)) return REAL;
      if (/^critique-0-vote-2-v\d$/.test(label)) return NOT_REAL;
      if (label === 'critique-0') {
        return report([cited('confirmed-one'), cited('weak-one'), findingFixture({ id: 'minor', severity: 'P2', evidence: [HERE] })]);
      }
      return report([]);
    },
    claude: (label) =>
      label === 'revise-1'
        ? revised([
            { id: 'confirmed-one', disposition: 'fixed', reason: 'done' },
            { id: 'weak-one', disposition: 'rebutted', reason: 'the vote agreed' },
            { id: 'minor', disposition: 'fixed', reason: 'done' },
          ])
        : planFixture(),
  });
  const votes = new Map(file(state, 1).dispositions.map((d) => [d.id, d.vote]));
  assert.deepEqual(Object.fromEntries(votes), { 'confirmed-one': 'confirmed', 'weak-one': 'unconfirmed', minor: null });

  const card = scoreArchive(state.targetDir).findings.critiqueOutcomes;
  assert.deepEqual(card.byVote, {
    confirmed: { of: 1, fixed: 1, rebutted: 0, deferred: 0, notAddressed: 0 },
    unconfirmed: { of: 1, fixed: 0, rebutted: 1, deferred: 0, notAddressed: 0 },
    'not voted': { of: 1, fixed: 1, rebutted: 0, deferred: 0, notAddressed: 0 },
  });
  const text = renderScorecard(scoreArchive(state.targetDir)).join('\n');
  assert.match(text, /vote unconfirmed: +0 fixed, 1 rebutted by the planner, 0 deferred, 0 not addressed, of 1/);
});

test('a rebuttal raised again under the same id is a disagreement; one left alone is not', async () => {
  const state = run('vibe-plan-disp-again-');
  await drive(state, withCritique({}), {
    codex: critic((r) => {
      if (r === 0) return [cited('insisted'), cited('accepted')];
      if (r === 1) return [cited('insisted')];
      return [];
    }),
    claude: (label) =>
      label === 'revise-1' || label === 'revise-2'
        ? revised([
            { id: 'insisted', disposition: 'rebutted', reason: 'wrong' },
            { id: 'accepted', disposition: 'rebutted', reason: 'also wrong' },
          ])
        : planFixture(),
  });
  const compared = events(state, 'critique_rebuttal_disputed').find((e) => e['round'] === 1);
  assert.deepEqual(compared?.['disputed'], ['insisted']);
  assert.deepEqual(compared?.['notRaisedAgain'], ['accepted']);

  const card = scoreArchive(state.targetDir).findings.critiqueOutcomes;
  // revise-1 rebutted both (one disputed, one not); revise-2 rebutted
  // `insisted` again and the next critique approved.
  assert.equal(card.rebuttals.matched, 1);
  assert.equal(card.rebuttals.measured, 3);
  assert.equal(card.rebuttals.unmeasured, 0);
});
