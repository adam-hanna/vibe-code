import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dispositionSummary, settlePlanDispositions } from '@src/dispositions.js';
import { fixPrompt, implementPrompt, revisePlanPrompt } from '@src/prompts.js';
import { PLAN_SCHEMA, REVISE_SCHEMA } from '@src/schemas.js';
import { validateStoredState } from '@src/stored.js';
import { parsePlanDispositions, ShapeError } from '@src/validate.js';
import type { Answer, Finding, ReviewSeat, Votes } from '@src/types.js';
import { BLOCKING, freshRun, p1 } from './helpers/loop-harness.js';
import { CRITERIA, OUT_OF_SCOPE, PLAN_MD } from './helpers/prompt-fixture-args.js';

/**
 * The pieces of #453 below the loop: the revision prompt's one change, the
 * schema, the strict parse, the join onto the critique's findings, and the
 * stored critic stamp.
 */

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../tests/fixtures/prompts/${name}`, import.meta.url)), 'utf8');
}

// ---- the prompt ------------------------------------------------------------

const BASE = { planMd: PLAN_MD, outOfScope: OUT_OF_SCOPE, acceptanceCriteria: CRITERIA };
const ANSWERS: Answer[] = [
  { question: 'Which file?', answer: 'src/widget.ts', confidence: 'high', defer_to_human: false, rationale: 'It is the only one.' },
];

test('an answers-only revision prompt is develop\'s, byte for byte', () => {
  assert.equal(revisePlanPrompt({ ...BASE, answers: ANSWERS, round: 0 }), fixture('revise-answers.txt'));
});

test('a findings revision prompt is develop\'s with exactly the rebuttal sentence replaced by the dispositions instruction', () => {
  // Case 2 of AGENTS.md: the findings revision's contract moved, by this and nothing else.
  const before =
    'For each P1: fix the plan, or, if you believe the finding is wrong, say so explicitly in the plan with your ' +
    'reasoning. Do not silently ignore one.';
  const after =
    'For each P1: fix the plan, or, if you believe the finding is wrong, rebut it. Do not silently ignore one.\n\n' +
    'For each finding listed above, answer its id in `dispositions`: `fixed`, `rebutted`, `deferred` or ' +
    '`not-addressed`, with a sentence of reason. Use only those ids. Still explain a rebuttal in the plan itself: ' +
    '`plan_md` is what the implementer reads, and `dispositions` is not shown to it.';
  const golden = fixture('revise-findings.txt');
  assert.ok(golden.includes(before), 'the golden carries the sentence this change replaces');
  // #482 moved three more regions, each spliced rather than the fixture
  // regenerated, so the assertion still proves nothing else in the prompt did.
  let expected = golden.replace(before, after);
  for (const [from, to] of [...PLAN_REVISION_482, ...PLAN_REVISION_506]) {
    assert.ok(expected.includes(from), `the golden carries ${JSON.stringify(from.slice(0, 40))}`);
    expected = expected.replace(from, to);
  }
  assert.equal(revisePlanPrompt({ ...BASE, findings: BLOCKING, round: 1 }), expected);
});

/**
 * What #482 changed in the findings revision, as `[develop's text, now]`.
 *
 * Case 2 of AGENTS.md: the pin held two defects. The block's heading and
 * opening line called the plan critique a reviewer, and `fix breadth`'s last
 * bullet asked for a three-way disposition in a prose report the planner never
 * writes, beside `plan dispositions` asking for four in `dispositions`.
 */
const FIX_REPORT_BULLET =
  '\n- In your report, state each finding\'s disposition (fixed, rebutted, or deferred)\n' +
  '  and its reason, what you changed, **what else you\n' +
  '  checked for the same class of problem**, and what you found. "Checked X and Y,\n' +
  '  they were already correct" is useful; silence is not.';
const PLAN_REVISION_482: readonly (readonly [string, string])[] = [
  ['## Review findings\n', '## Findings against the plan\n'],
  [
    'An independent reviewer raised the following. ',
    'The plan critique raised the following, except where a finding says a person raised it. ',
  ],
  ["The reviewer's proposed remedy is advisory;", "A finding's proposed remedy is advisory;"],
  [FIX_REPORT_BULLET, ''],
];

/**
 * What #506 changed in the same prompt: one sentence of `fix breadth`, shared
 * with every caller, which still called a finding's suggested fix the
 * reviewer's. Case 2 of AGENTS.md: the planner's findings come from the plan
 * critique, so the pin held the wording #482 fixed in the opening line.
 */
const PLAN_REVISION_506: readonly (readonly [string, string])[] = [
  [
    "even when you reject the reviewer's proposed remedy.",
    "even when you reject a finding's proposed remedy.",
  ],
];

test('a findings revision gives the planner one disposition instruction, and names the critique as the source (#482)', () => {
  const prompt = revisePlanPrompt({ ...BASE, findings: BLOCKING, round: 1 });
  assert.ok(prompt.includes('`not-addressed`'), 'the four-way `plan dispositions` instruction is there');
  assert.ok(!prompt.includes('(fixed, rebutted, or deferred)'), 'the three-way prose disposition sentence is not');
  assert.ok(!prompt.includes('In your report'), 'the planner writes no report to state it in');
  assert.ok(!/independent reviewer/i.test(prompt), 'the critique is not called a reviewer');
  assert.ok(prompt.includes('The plan critique raised the following'));
  // The rest of `fix breadth` still reaches the planner.
  assert.ok(prompt.includes('## Fix breadth\n\nFix the cause, not the line.'));
  assert.ok(prompt.includes('Resolve valid defects with the simplest coherent repair.'));
});

test('the implement and verify-fix turns still ask for the three-way prose disposition (#482)', () => {
  // The bullet is right where a report is written and nothing else records the
  // answer: the implement and verify-fix turns. Their pinned bytes are held by
  // `fix-dispositions.test.ts` against `fix-round1.txt` and by
  // `implementer-report-prompt.test.ts`; this says the split kept the bullet on
  // them, not only that their bytes match. A review fix turn keeps the bullet
  // with its values deferred to `## Dispositions` (#506), which
  // `fix-dispositions.test.ts` holds.
  const fix = fixPrompt(BLOCKING, 1);
  assert.ok(fix.includes(FIX_REPORT_BULLET));
  assert.ok(implementPrompt(PLAN_MD).includes(FIX_REPORT_BULLET));
});

// ---- the schema ------------------------------------------------------------

test('REVISE_SCHEMA is PLAN_SCHEMA, in order, with a required dispositions list last', () => {
  assert.deepEqual(Object.keys(REVISE_SCHEMA.properties), [...Object.keys(PLAN_SCHEMA.properties), 'dispositions']);
  assert.deepEqual(REVISE_SCHEMA.required, [...PLAN_SCHEMA.required, 'dispositions']);
  for (const key of Object.keys(PLAN_SCHEMA.properties) as (keyof typeof PLAN_SCHEMA.properties)[]) {
    assert.equal(REVISE_SCHEMA.properties[key], PLAN_SCHEMA.properties[key], `${key} is PLAN_SCHEMA's own`);
  }
  const item = REVISE_SCHEMA.properties.dispositions.items;
  assert.deepEqual(Object.keys(item.properties), ['id', 'disposition', 'reason']);
  assert.deepEqual(item.properties.disposition.enum, ['fixed', 'rebutted', 'deferred', 'not-addressed']);
  // The last key after content is a non-null string (the key-order note).
  assert.equal(item.properties.reason.type, 'string');
  assert.match(item.properties.disposition.description, /fixed = you changed the plan to resolve it/);
});

// ---- the parse -------------------------------------------------------------

test('parsePlanDispositions reads every entry beside the plan', () => {
  assert.deepEqual(
    parsePlanDispositions({ plan_md: 'x', dispositions: [{ id: 'a', disposition: 'rebutted', reason: 'no' }] }),
    [{ id: 'a', disposition: 'rebutted', reason: 'no' }],
  );
  assert.deepEqual(parsePlanDispositions({ dispositions: [] }), [], 'an empty list is a readable answer');
});

test('parsePlanDispositions throws on a missing list or any malformed entry rather than dropping it', () => {
  for (const bad of [
    {},
    { dispositions: 'none' },
    { dispositions: [{ id: 'a', disposition: 'maybe', reason: 'r' }] },
    { dispositions: [{ id: 'a', disposition: 'fixed' }] },
    { dispositions: [{ id: 'a', disposition: 'fixed', reason: 'r' }, 'b'] },
    'not an object',
  ]) {
    assert.throws(() => parsePlanDispositions(bad), ShapeError, JSON.stringify(bad));
  }
});

// ---- the join --------------------------------------------------------------

const STAMP: ReviewSeat = { round: 0, provider: 'codex', model: 'gpt-x' };
const CTX = { round: 1, label: 'revise-1', answers: 0, criticSeat: STAMP as ReviewSeat | undefined };

function voted(outcome: Votes['outcome']): Votes {
  return {
    quorum: 2,
    n: 1,
    real: outcome === 'confirmed' ? 1 : 0,
    notReal: outcome === 'unconfirmed' ? 1 : 0,
    cannotTell: outcome === 'undecided' ? 1 : 0,
    outcome,
    ballots: [
      {
        counted: outcome === 'confirmed' ? 'real' : outcome === 'unconfirmed' ? 'not-real' : 'cannot-tell',
      } as never,
    ],
  };
}

test('one disposition per finding shown, in order; left out, invented and repeated as on the review side', () => {
  const findings: Finding[] = [{ ...p1('a'), raisedBy: 'critic' }, { ...p1('b'), raisedBy: 'critic' }];
  const d = settlePlanDispositions(
    findings,
    [
      { id: 'b', disposition: 'fixed', reason: 'first' },
      { id: 'zzz', disposition: 'fixed', reason: 'invented' },
      { id: 'b', disposition: 'rebutted', reason: 'second' },
    ],
    CTX,
  );
  assert.deepEqual(
    d.dispositions.map((x) => [x.id, x.disposition, x.reason]),
    [
      ['a', 'not-addressed', ''],
      ['b', 'fixed', 'first'],
    ],
  );
  assert.deepEqual([d.round, d.label, d.answers, d.dropped, d.duplicates], [1, 'revise-1', 0, ['zzz'], ['b']]);
  assert.equal(
    dispositionSummary(d, 'planner'),
    'revise-1: 1 fixed, 0 rebutted by the planner, 0 deferred, 1 not addressed, of 2; ' +
      'ignored ids not in the prompt: zzz; duplicate ids, first kept: b',
  );
});

test('seats: every foundBy seat, else the critic stamp for the round answered, else none; never a reviewer, person or vibe', () => {
  const seatsOf = (f: Finding, ctx = CTX): unknown => settlePlanDispositions([f], [], ctx).dispositions[0]?.seats;
  const finders: Finding = {
    ...p1('two'),
    raisedBy: 'critic',
    foundBy: [
      { seat: 'roles.critic', provider: 'codex', model: 'gpt-x', id: 'two' },
      { seat: 'critique.finders[0]', provider: 'claude', model: 'default', id: 'two-f1' },
    ],
  };
  const plain: Finding = { ...p1('plain'), raisedBy: 'critic' };
  assert.deepEqual(seatsOf(finders), [
    { seat: 'roles.critic', provider: 'codex', model: 'gpt-x' },
    { seat: 'critique.finders[0]', provider: 'claude', model: 'default' },
  ]);
  assert.deepEqual(seatsOf(plain), [{ seat: 'roles.critic', provider: 'codex', model: 'gpt-x' }]);
  assert.equal(seatsOf(plain, { ...CTX, criticSeat: { ...STAMP, round: 3 } }), null);
  assert.equal(seatsOf(plain, { ...CTX, criticSeat: undefined }), null);
  assert.equal(seatsOf({ ...p1('h'), raisedBy: 'human' }), null);
  assert.equal(seatsOf({ ...p1('v'), raisedBy: 'vibe' }), null);
  assert.equal(seatsOf({ ...p1('r'), raisedBy: 'reviewer' }), null, 'only a critic finding falls back to the critic stamp');
});

test('the vote outcome rides along, and a damaged or absent vote is null; no reproducer is ever read', () => {
  const findings: Finding[] = [
    { ...p1('c'), raisedBy: 'critic', votes: voted('confirmed') },
    { ...p1('u'), raisedBy: 'critic', votes: voted('unconfirmed') },
    { ...p1('d'), raisedBy: 'critic', votes: voted('undecided') },
    { ...p1('none'), raisedBy: 'critic' },
    // Counts that do not add up: `readTally` refuses it, so nothing is taken from it.
    { ...p1('broken'), raisedBy: 'critic', votes: { ...voted('confirmed'), n: 4 } },
    {
      ...p1('reproduced'),
      raisedBy: 'critic',
      reproducerOutcomes: [{ verdict: 'reproduced', at: 'review', gate: 'g', command: 'c', baseline: null, reason: '' } as never],
    },
  ];
  const d = settlePlanDispositions(findings, [], CTX);
  assert.deepEqual(
    d.dispositions.map((x) => [x.id, x.vote, x.reproducer]),
    [
      ['c', 'confirmed', null],
      ['u', 'unconfirmed', null],
      ['d', 'undecided', null],
      ['none', null, null],
      ['broken', null, null],
      ['reproduced', null, null],
    ],
  );
});

// ---- the stored stamp ------------------------------------------------------

test('a stored criticSeat is read back, and a damaged one is dropped rather than repaired', () => {
  const state = freshRun({ prefix: 'vibe-critic-seat-' });
  const read = (criticSeat: unknown): { seat: unknown; repaired: boolean } => {
    const raw = JSON.parse(JSON.stringify({ ...state, criticSeat })) as Record<string, unknown>;
    const { state: loaded, repairs } = validateStoredState(raw, state.id, state.dir);
    return { seat: loaded.criticSeat, repaired: repairs.some((r) => JSON.stringify(r).includes('criticSeat')) };
  };
  assert.deepEqual(read({ round: 0, provider: 'codex', model: 'default' }), {
    seat: { round: 0, provider: 'codex', model: 'default' },
    repaired: false,
  });
  assert.deepEqual(read(undefined), { seat: undefined, repaired: false });
  for (const bad of [{ round: -1, provider: 'codex', model: 'm' }, { round: 0, provider: 'codex', model: '' }, 'codex']) {
    assert.deepEqual(read(bad), { seat: undefined, repaired: true }, JSON.stringify(bad));
  }
});
