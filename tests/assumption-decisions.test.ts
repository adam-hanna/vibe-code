import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, parseDecisions, parseHumanAnswers, reportDeferred } from '@src/cli.js';
import { Escalation, EXIT, orchestrate, writeEscalation } from '@src/orchestrator.js';
import {
  ASSUMPTIONS_HEADING,
  DECISION_MARKER,
  inert,
  normalize,
  REPHRASE_THRESHOLD,
  similarity,
} from '@src/questions.js';
import { parseMoves, parseRaised } from '@src/raise.js';
import { createRun, loadRun, saveState } from '@src/run.js';
import {
  agents,
  answerNeedsInput,
  answersReport,
  config,
  decideInNeedsInput,
  escalationFile,
  freshRun,
  p1,
  planFixture,
  questionFixture,
  report,
  stalledPlan,
  takeCarried,
} from './helpers/loop-harness.js';
import type { RunLoop } from '@src/cli.js';
import type { DeferredQuestion, Finding, RunState } from '@src/types.js';

/**
 * A person settles the assumptions a run is already making (#465).
 *
 * The bench run deferred one question and, a round later, asked it again in
 * other words as a blocking question. The person answered that one. The two
 * wordings scored 0.395 - below the 0.6 the census measured, rightly - so
 * `ASSUMED.md` went on calling the person's decision a guess. The run cannot
 * know two wordings are one question without a matcher, and the threshold may
 * not move; so `NEEDS-INPUT.md` lists the assumptions in force and the person
 * decides them in the file they are already editing.
 */

/** The deferred question, and its rewording a round later: a 0.375 pair. */
const X = 'Should the cache evict the least recently used entry when it is full?';
const Y = 'When the cache is full, which item should go first?';

const at = (state: RunState, name: string): string => path.join(state.dir, name);
const has = (state: RunState, name: string): boolean => existsSync(at(state, name));
const read = (state: RunState, name: string): string => readFileSync(at(state, name), 'utf8');

/** The questions an answerer turn was put, read back out of its prompt. */
const asked = (options: unknown): string[] =>
  [...(options as { prompt: string }).prompt.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1] ?? '');

/**
 * The bench's order of events: X deferred in round 1, a P1 critique, Y asked as
 * blocking in round 2 and declined, and the run stops for a person.
 */
async function benchStop(): Promise<{ state: RunState; stop: Escalation }> {
  const state = freshRun({ prefix: 'vibe-decide-', task: 'assumption decisions' });
  let critiques = 0;
  let revisions = 0;
  const stop = await orchestrate(
    state,
    // No P1 carried: the critique's finding has to buy the second round.
    config({ p1Tolerance: 0 }),
    false,
    agents(
      {
        claude: (label) => {
          if (label === 'plan') {
            return planFixture({
              open_questions: [questionFixture({ question: X, blocking: false, recommended: 'fallback-X' })],
            });
          }
          if (label.startsWith('revise-') && (revisions += 1) === 1) {
            return planFixture({ open_questions: [questionFixture({ question: Y, blocking: true })] });
          }
          return planFixture();
        },
        codex: (label, options) => {
          if (label.startsWith('answers-')) {
            return answersReport(asked(options).map((question) => ({ question, defer_to_human: true })));
          }
          critiques += 1;
          return report(critiques === 1 ? [p1('x')] : []);
        },
      },
      [],
    ),
  ).then(
    () => assert.fail('the blocking rewording should have stopped the run'),
    (err: unknown) => err as Escalation,
  );
  return { state, stop };
}

/** Resume to the end, keeping the first Claude prompt, then report as `execute` does. */
async function resumeAndReport(state: RunState): Promise<string> {
  const prompts: string[] = [];
  await orchestrate(
    state,
    config(),
    true,
    agents(
      {
        claude: (_label, options) => {
          prompts.push((options as { prompt: string }).prompt);
          return planFixture();
        },
        codex: () => report([]),
      },
      [],
    ),
  );
  reportDeferred(state);
  return prompts[0] ?? '';
}

function sectionIndex(md: string, heading: string): number {
  const i = md.indexOf(`\n${heading}\n`);
  assert.notEqual(i, -1, `${heading} is in the file`);
  return i;
}

// ---- the bench ---------------------------------------------------------------

test('the bench shape: the rewording is a question, the deferral an assumption', async () => {
  assert.ok(similarity(X, Y) < REPHRASE_THRESHOLD, `the pair scores ${similarity(X, Y)}, below the threshold`);
  const { state, stop } = await benchStop();
  assert.deepEqual(state.deferredQuestions.map((q) => q.question), [X]);
  assert.deepEqual(stop.questions?.map((q) => q.question), [Y]);

  const md = readFileSync(escalationFile(state, stop), 'utf8');
  const questions = sectionIndex(md, '## Questions');
  const assumptions = sectionIndex(md, ASSUMPTIONS_HEADING);
  const raise = sectionIndex(md, '## Raise a finding');
  assert.ok(questions < md.indexOf(`### 1. ${Y}`) && md.indexOf(`### 1. ${Y}`) < assumptions);
  assert.ok(assumptions < md.indexOf(`### A1. ${X}`) && md.indexOf(`### A1. ${X}`) < raise);
  assert.ok(md.includes(`### A1. ${X}\n*Proceeding with:* fallback-X\n\n${DECISION_MARKER}\n\n> \n`));
  assert.ok(assumptions < raise);
});

test('answering the rewording and deciding the deferral leaves no assumption and no fuzzy record', async () => {
  const { state, stop } = await benchStop();
  escalationFile(state, stop);
  decideInNeedsInput(state, () => 'Decided: evict LRU.');
  answerNeedsInput(state, () => 'Y answer: the oldest.');

  assert.deepEqual(
    state.humanAnswered,
    [Y, X],
    'the decision is recorded under the deferred question\'s own wording',
  );
  const prompt = await resumeAndReport(state);
  assert.ok(prompt.includes('Y answer: the oldest.'), 'the next revision carries the answer');
  assert.ok(prompt.includes('Decided: evict LRU.'), 'and the decision');
  assert.ok(prompt.includes('Decided by the user.'));

  assert.equal(has(state, 'ASSUMED.md'), false, 'the decision settled the only assumption');
  assert.equal(has(state, 'REPHRASED.md'), false, 'by the exact rule, so nothing fuzzy is recorded');
  assert.deepEqual(state.resolvedByHuman ?? [], []);
});

test('a decision left empty keeps the assumption, with the answers listed beside it', async () => {
  const { state, stop } = await benchStop();
  escalationFile(state, stop);
  answerNeedsInput(state, () => 'Y answer: the oldest.');
  await resumeAndReport(state);

  const assumed = read(state, 'ASSUMED.md');
  const entry = assumed.indexOf(`### 1. ${X}`);
  const yours = assumed.indexOf('## Your answers in this run');
  assert.ok(entry !== -1 && yours > entry, 'the assumption, then the answers');
  assert.ok(assumed.slice(yours).includes(`### 1. ${Y}\n*You answered:* Y answer: the oldest.`));
  assert.match(assumed, /did not match these to the assumptions above/);
});

// ---- resumes through the real command ---------------------------------------

/** Both streams, as `resume-lock.test.ts` captures them. */
async function captureLog<T>(work: () => Promise<T>): Promise<{ result: T; said: string }> {
  const lines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  const collect = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  console.log = collect;
  console.error = collect;
  try {
    return { result: await work(), said: lines.join('\n') };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

interface Resumed {
  result: number;
  said: string;
  loopRan: boolean;
  /** What `pendingAnswers` held when the loop was reached, if it was. */
  pendingAtLoop: unknown;
  after: RunState;
}

async function resume(state: RunState): Promise<Resumed> {
  let loopRan = false;
  let pendingAtLoop: unknown;
  const loop: RunLoop = (s) => {
    loopRan = true;
    pendingAtLoop = s.pendingAnswers;
    return Promise.resolve();
  };
  const { result, said } = await captureLog(() =>
    main(['resume', state.id, '-C', state.targetDir, '--skip-probe', '--no-progress'], loop),
  );
  return { result, said, loopRan, pendingAtLoop, after: loadRun(state.targetDir, state.id) };
}

const DEFERRED: DeferredQuestion = { question: X, kind: 'technical', recommended: 'LRU', reason: 'Codex declined.' };

/** A run carrying one assumption, stopped on whatever `escalation` says. */
function stoppedWith(escalation: Escalation, deferred: DeferredQuestion = DEFERRED): RunState {
  const state = freshRun({ prefix: 'vibe-decide-', task: 'assumption decisions' });
  state.deferredQuestions.push(deferred);
  saveState(state);
  writeEscalation(state, escalation);
  return state;
}

const findingsStop = (findings?: Finding[]): Escalation =>
  new Escalation(EXIT.NO_CONVERGENCE, 'the round cap', undefined, findings);

/** Replace the empty blockquote under the decision marker with `body`, verbatim. */
function writeUnderDecision(state: RunState, body: string): string {
  const file = at(state, 'NEEDS-INPUT.md');
  const raw = readFileSync(file, 'utf8');
  const marker = `${DECISION_MARKER}\n\n> \n`;
  assert.ok(raw.includes(marker), 'the template carries an empty decision');
  const filled = raw.replace(marker, `${DECISION_MARKER}\n\n${body}\n`);
  writeFileSync(file, filled, 'utf8');
  return filled;
}

const retired = (state: RunState): string[] =>
  readdirSync(state.dir).filter((n) => /^(stalled|answered)-\d+\.md$/.test(n));

test('on a round-cap stall, a decision is taken on the findings path and revises nothing', async () => {
  const { state } = await stalledPlan();
  state.deferredQuestions.push(DEFERRED);
  saveState(state);
  writeEscalation(state, findingsStop(takeCarried(state, 'plan')));

  const md = read(state, 'NEEDS-INPUT.md');
  assert.equal(md.includes('**Your answer:**'), false, 'still a findings stop');
  assert.ok(sectionIndex(md, ASSUMPTIONS_HEADING) < sectionIndex(md, '## Change a severity'));
  assert.ok(sectionIndex(md, '## Outstanding P1 findings') < sectionIndex(md, ASSUMPTIONS_HEADING));

  decideInNeedsInput(state, () => 'Decided: LRU it is.');
  const { said, after, loopRan, pendingAtLoop } = await resume(state);

  assert.match(said, /continuing with raised limits/);
  assert.equal(has(state, 'NEEDS-INPUT.md'), false);
  assert.equal(retired(state).some((n) => n.startsWith('stalled-')), true);
  assert.deepEqual(after.humanAnswered, [X]);
  assert.equal(after.humanAnswers?.[0]?.answer, 'Decided: LRU it is.');
  assert.equal(after.pendingAnswers, null, 'no revision the stop did not ask for');
  if (loopRan) assert.equal(pendingAtLoop, null);
  if (has(state, 'ASSUMED.md')) assert.equal(read(state, 'ASSUMED.md').includes(X), false);
});

interface Snapshot {
  humanAnswered: unknown;
  humanAnswers: unknown;
  pendingAnswers: unknown;
  pendingFindings: unknown;
  resolvedByHuman: unknown;
  spend: unknown;
}
const snapshot = (s: RunState): Snapshot => ({
  humanAnswered: s.humanAnswered,
  humanAnswers: s.humanAnswers,
  pendingAnswers: s.pendingAnswers,
  pendingFindings: s.pendingFindings,
  resolvedByHuman: s.resolvedByHuman,
  spend: [s.tokensUsed, s.costUsd, s.codexTokens],
});

/** Refused before anything is spent: the file stays, nothing is retired or recorded. */
async function assertRefused(state: RunState, filled: string): Promise<string> {
  const before = snapshot(loadRun(state.targetDir, state.id));
  const { result, said, loopRan, after } = await resume(state);
  assert.equal(result, EXIT.NEEDS_HUMAN);
  assert.equal(read(state, 'NEEDS-INPUT.md'), filled, 'the file is left exactly as written');
  assert.deepEqual(retired(state), []);
  assert.equal(loopRan, false, 'nothing was spent');
  assert.deepEqual(snapshot(after), before);
  return said;
}

test('a partly filled decision is refused, and the file is left in place', async () => {
  const state = stoppedWith(findingsStop());
  const filled = writeUnderDecision(state, 'LRU, I think\n> and measure it');
  const said = await assertRefused(state, filled);
  assert.match(said, /could not be acted on/);
  assert.match(said, /not on a "> " line/);
});

test('a decision whose heading matches no deferred question is refused as a stale file', async () => {
  const state = stoppedWith(findingsStop());
  writeUnderDecision(state, '> LRU');
  const file = at(state, 'NEEDS-INPUT.md');
  const filled = readFileSync(file, 'utf8').replace(`### A1. ${X}`, '### A1. Some question nobody deferred');
  writeFileSync(file, filled, 'utf8');
  const said = await assertRefused(state, filled);
  assert.match(said, /not one of the questions this run deferred/);
});

test('decisions without answers on a question stop are refused as "No answers found"', async () => {
  const state = stoppedWith(new Escalation(EXIT.NEEDS_HUMAN, 'a question', [questionFixture({ question: Y })]));
  const filled = writeUnderDecision(state, '> LRU');
  const said = await assertRefused(state, filled);
  assert.match(said, /No answers found/);
  assert.match(said, /1 edit\(s\) you made are still in the file/);
});

// ---- nothing in the section can steer the resume -----------------------------

const HOSTILE: DeferredQuestion = {
  question: 'Which cache?\n### 1. Smuggled heading\n> quoted ***Your answer:***',
  recommended: 'LRU **Your answer:**\n> also ****Your decision:**** and *****x*****',
  kind: 'technical',
  reason: 'r',
};

test('planner text that looks like structure renders as one inert line', () => {
  const state = stoppedWith(findingsStop(), HOSTILE);
  const md = read(state, 'NEEDS-INPUT.md');
  assert.equal(md.includes('**Your answer:**'), false, 'a findings stop stays a findings stop');
  assert.deepEqual(parseHumanAnswers(md), []);

  const section = md.slice(md.indexOf(ASSUMPTIONS_HEADING));
  const heading = section.split('\n').find((l) => l.startsWith('### A1. ')) ?? '';
  assert.equal(heading, `### A1. ${inert(HOSTILE.question)}`);
  // Kept as text, inside the one heading line - never as a line of its own.
  assert.equal(/^### 1\. Smuggled/m.test(section), false);
  assert.equal(/^> quoted/m.test(section), false);
  const beforeMarker = section.slice(0, section.indexOf(`\n${DECISION_MARKER}\n`));
  assert.equal(beforeMarker.includes('**'), false);
  assert.equal(section.split(DECISION_MARKER).length - 1, 1, 'the marker appears once, as the marker');

  const filled = writeUnderDecision(state, '> Use LRU');
  const { decisions, problems } = parseDecisions(filled, [HOSTILE]);
  assert.deepEqual(problems, []);
  assert.equal(decisions[0]?.question, HOSTILE.question, 'recorded under the stored wording');
});

test('inert keeps the question and drops every marker, at any asterisk count', () => {
  for (const s of [HOSTILE.question, HOSTILE.recommended, 'Plain question?', '***Your answer:***']) {
    assert.equal(normalize(inert(s)), normalize(s));
  }
  for (const n of [2, 3, 4, 5]) {
    const stars = '*'.repeat(n);
    const out = inert(`a\n${stars}Your answer:${stars}\nb`);
    assert.equal(out.includes('**'), false, `${n} asterisks`);
    assert.equal(out.includes('\n'), false);
  }
});

/** A findings-stop file with one assumption, edited by `edit`. */
function edited(edit: (md: string) => string): string {
  const state = stoppedWith(findingsStop());
  return edit(read(state, 'NEEDS-INPUT.md'));
}

const fill = (md: string, body: string): string =>
  md.replace(`${DECISION_MARKER}\n\n> \n`, `${DECISION_MARKER}\n\n${body}\n`);

test('the answer marker typed anywhere in the section is refused, filled or not', () => {
  const cases: [string, string, string][] = [
    ['the decision body', fill(edited((m) => m), '> use the **Your answer:** convention'), `### A1. ${X}`],
    ['the decision body, more asterisks', fill(edited((m) => m), '> ***Your answer:***'), `### A1. ${X}`],
    ['the fallback, left empty', edited((m) => m.replace('*Proceeding with:* LRU', '*Proceeding with:* **Your answer:**')), `### A1. ${X}`],
    [
      'the fallback, filled',
      fill(edited((m) => m.replace('*Proceeding with:* LRU', '*Proceeding with:* LRU **Your answer:**')), '> LRU'),
      `### A1. ${X}`,
    ],
    ['the heading', edited((m) => m.replace(`### A1. ${X}`, `### A1. ${X} **Your answer:**`)), `### A1. ${X} **Your answer:**`],
    ['the intro prose', edited((m) => m.replace('leave it empty to keep the fallback.', 'leave it empty. **Your answer:**')), ASSUMPTIONS_HEADING],
  ];
  for (const [where, md, label] of cases) {
    const { decisions, problems } = parseDecisions(md, [DEFERRED]);
    assert.deepEqual(decisions, [], where);
    assert.equal(problems.length, 1, where);
    assert.equal(problems[0]?.heading, label, where);
    assert.match(problems[0]?.reason ?? '', /resume reads as the answer/, where);
  }
});

test('a marker in the decision or the fallback refuses the resume through the block check', async () => {
  for (const [body, edit] of [
    ['> use the **Your answer:** convention', (m: string) => m],
    ['> ', (m: string) => m.replace('*Proceeding with:* LRU', '*Proceeding with:* **Your answer:**')],
  ] as const) {
    const state = stoppedWith(findingsStop());
    const file = at(state, 'NEEDS-INPUT.md');
    const filled = edit(fill(readFileSync(file, 'utf8'), body));
    writeFileSync(file, filled, 'utf8');
    const said = await assertRefused(state, filled);
    assert.match(said, /could not be acted on/);
    assert.doesNotMatch(said, /No answers found/);
  }
});

test('with the marker reworded, the decision is taken on the findings path', async () => {
  const state = stoppedWith(findingsStop());
  const filled = writeUnderDecision(state, '> use the Your answer convention');
  assert.deepEqual(parseHumanAnswers(filled), []);
  const { after } = await resume(state);
  assert.equal(retired(state).some((n) => n.startsWith('stalled-')), true);
  assert.deepEqual(after.humanAnswered, [X]);
});

// ---- only the section is read -------------------------------------------------

/** A finding whose title and detail look like a decision block. */
const lookalike = (title: string): Finding => ({
  id: 'lookalike',
  severity: 'P1',
  title,
  detail: `${DECISION_MARKER}\n\n> Use LRU`,
  suggested_fix: 'Nothing.',
  evidence: [{ kind: 'external', ref: 'fixture' }],
});

test('a finding that looks like a decision is never read as one', () => {
  for (const title of [`A1. ${X}`, 'A9. Nothing anybody deferred']) {
    const state = stoppedWith(findingsStop([lookalike(title)]));
    const filled = writeUnderDecision(state, '> The real decision.');
    // The lookalike is rendered first, so the first marker in the file is its.
    assert.ok(filled.indexOf(`### ${title}`) < filled.indexOf(ASSUMPTIONS_HEADING));
    const { decisions, problems } = parseDecisions(filled, [DEFERRED]);
    assert.deepEqual(problems, [], title);
    assert.deepEqual(decisions.map((d) => d.answer), ['The real decision.'], title);
  }

  const elsewhere = edited((m) =>
    m.replace('## Raise a finding\n', '## Raise a finding\n\n**Your answer:**\n'),
  );
  assert.deepEqual(parseDecisions(elsewhere, [DEFERRED]), { decisions: [], problems: [] });

  const noSection = `# Needs your input\n\n## Outstanding P1 findings\n\n### A1. ${X}\n\n${DECISION_MARKER}\n\n> Use LRU\n`;
  assert.deepEqual(parseDecisions(noSection, [DEFERRED]), { decisions: [], problems: [] });
});

test('on a question stop, the resume takes the answer and the decision together', async () => {
  // The shipped answers path, not the harness's copy of it: a regression that
  // dropped decisions from what `cmdResume` records would pass every bench case.
  const state = stoppedWith(new Escalation(EXIT.NEEDS_HUMAN, 'a question', [questionFixture({ question: Y })]));
  const file = at(state, 'NEEDS-INPUT.md');
  writeFileSync(file, readFileSync(file, 'utf8').replace('**Your answer:**\n\n> ', '**Your answer:**\n\n> The oldest.'), 'utf8');
  writeUnderDecision(state, '> Decided: LRU.');

  const { said, after, loopRan, pendingAtLoop } = await resume(state);
  assert.match(said, /Picked up 1 answer\(s\) and 1 decision\(s\)/);
  assert.equal(has(state, 'NEEDS-INPUT.md'), false);
  assert.equal(retired(state).some((n) => n.startsWith('answered-')), true);
  assert.deepEqual(after.humanAnswered, [Y, X]);
  const pending = (after.pendingAnswers ?? []).map((a) => [a.question, a.answer]);
  assert.deepEqual(pending, [
    [Y, 'The oldest.'],
    [X, 'Decided: LRU.'],
  ]);
  if (loopRan) assert.deepEqual(pendingAtLoop, after.pendingAnswers);
  if (has(state, 'ASSUMED.md')) assert.equal(read(state, 'ASSUMED.md').includes(`### 1. ${X}`), false);
});

test('a plan stop resumed on severity moves alone takes the decision and revises nothing', async () => {
  const { state } = await stalledPlan();
  state.deferredQuestions.push(DEFERRED);
  saveState(state);
  const carried = takeCarried(state, 'plan');
  const id = carried[0]?.id ?? '';
  // A question stop - the file carries the answer marker - left unanswered.
  writeEscalation(state, new Escalation(EXIT.NEEDS_HUMAN, 'a question', [questionFixture({ question: Y })], carried));
  const file = at(state, 'NEEDS-INPUT.md');
  const raw = readFileSync(file, 'utf8');
  const head = raw.indexOf(`### Move: \`${id}\``);
  assert.notEqual(head, -1, 'the carried finding has a move block');
  const rest = raw
    .slice(head)
    .replace(/\*Move to:\* <[^>]*>/, '*Move to:* P2')
    .replace('**Why:**\n\n>', '**Why:**\n\n> Not blocking.');
  writeFileSync(file, `${raw.slice(0, head)}${rest}`, 'utf8');
  writeUnderDecision(state, '> Decided: LRU.');
  assert.deepEqual(parseHumanAnswers(read(state, 'NEEDS-INPUT.md')), []);

  const { said, after } = await resume(state);
  assert.match(said, /taking your severity changes/);
  assert.equal(retired(state).some((n) => n.startsWith('stalled-')), true);
  assert.deepEqual(after.humanAnswered, [X]);
  assert.equal(after.pendingAnswers, null, 'no revision the stop did not ask for');
});

test('a lookalike finding does not stop a findings resume, and only the real decision is taken', async () => {
  const state = stoppedWith(findingsStop([lookalike('A9. Nothing anybody deferred')]));
  writeUnderDecision(state, '> The real decision.');
  const { after } = await resume(state);
  assert.equal(retired(state).some((n) => n.startsWith('stalled-')), true);
  assert.deepEqual(after.humanAnswers?.map((a) => a.answer), ['The real decision.']);
});

// ---- the parser on its own ----------------------------------------------------

test('parseDecisions: filled, empty, partly filled, unknown, repeated, verbatim', () => {
  const md = edited((m) => m);
  assert.deepEqual(parseDecisions(md, [DEFERRED]), { decisions: [], problems: [] }, 'empty keeps the fallback');

  // Keyed on the heading's text, not its punctuation, and recorded as stored.
  const shouty = md.replace(`### A1. ${X}`, `### A7. ${X.toUpperCase().replace('?', '')}`);
  const filled = parseDecisions(fill(shouty, '> same as 1'), [DEFERRED]);
  assert.deepEqual(filled.problems, []);
  assert.deepEqual(filled.decisions, [
    {
      question: X,
      answer: 'same as 1',
      confidence: 'high',
      defer_to_human: false,
      rationale: 'Decided by the user.',
    },
  ]);

  // Joined as `parseHumanAnswers` joins: every quote line, blank ones included.
  const joined = parseDecisions(fill(md, '> Evict LRU.\n> Measure it.'), [DEFERRED]);
  assert.equal(joined.decisions[0]?.answer, 'Evict LRU. Measure it.');

  const partly = parseDecisions(fill(md, 'LRU'), [DEFERRED]);
  assert.equal(partly.decisions.length, 0);
  assert.match(partly.problems[0]?.reason ?? '', /not on a "> " line/);

  const stale = parseDecisions(fill(md, '> LRU'), []);
  assert.match(stale.problems[0]?.reason ?? '', /not one of the questions this run deferred/);

  const block = `### A1. ${X}\n\n${DECISION_MARKER}\n\n> LRU\n`;
  const twice = parseDecisions(md.replace('## Raise a finding', `${block}\n### A2. ${X}\n\n${DECISION_MARKER}\n\n> FIFO\n\n## Raise a finding`), [DEFERRED]);
  assert.equal(twice.decisions.length, 1);
  assert.match(twice.problems[0]?.reason ?? '', /same question as an earlier block/);
});

/** Everything from the section heading to the next `## `, gone. */
function withoutSection(md: string): string {
  const start = md.indexOf(`${ASSUMPTIONS_HEADING}\n`);
  const end = md.indexOf('\n## ', start + 1);
  return md.slice(0, start) + md.slice(end + 1);
}

test('the other parsers read a file with the section exactly as without it', async () => {
  const { state } = await stalledPlan();
  state.deferredQuestions.push(DEFERRED);
  saveState(state);
  const carried = takeCarried(state, 'plan');
  writeEscalation(
    state,
    new Escalation(EXIT.NEEDS_HUMAN, 'both', [questionFixture({ question: Y })], carried),
  );
  let md = read(state, 'NEEDS-INPUT.md');
  md = md.replace('**Your answer:**\n\n> ', '**Your answer:**\n\n> The oldest.');
  md = fill(md, '> Decided.');
  assert.ok(md.includes(ASSUMPTIONS_HEADING));
  const bare = withoutSection(md);
  assert.equal(bare.includes(ASSUMPTIONS_HEADING), false);

  assert.deepEqual(parseHumanAnswers(md), parseHumanAnswers(bare));
  assert.equal(parseHumanAnswers(md).length, 1);
  assert.deepEqual(parseRaised(md), parseRaised(bare));
  assert.deepEqual(parseMoves(md, carried), parseMoves(bare, carried));
});

// ---- byte-identical when there is nothing to show ---------------------------

/**
 * Today's output, pinned. Captured from `develop` at `32f49e3` before this
 * change, with the run id replaced: a run with no assumption in force, and an
 * `ASSUMED.md` with no human answer, write exactly what they always wrote.
 */
const RAISE =
  '## Raise a finding\n\nAnything the review missed. Fill in one block per finding and resume with:\n\n```\nvibe resume RUNID\n```\n\nLeave the block exactly as it is and nothing is raised. A block you have *partly*\nfilled in is reported rather than guessed at - the resume stops and says which\npart is missing, and nothing is spent.\n\nA P0 or P1 that cites no `*File:*` line that resolves is carried as a P2 with\nthe reason recorded, which is the same rule the reviewer\'s findings are held to.\n\n### Finding: <one line saying what is wrong>\n\n*Severity:* P2\n*File:* <path/to/file.ts:120, or delete this line>\n\n**What is wrong:**\n\n>\n\n**Suggested fix:**\n\n>\n';
const HEAD = (why: string): string =>
  `# Needs your input\n\n**Run:** \`RUNID\`\n**Task:** pin task\n\n## Why the run stopped\n\n${why}\n\n`;
const PINNED_QUESTION_STOP =
  HEAD('one question') +
  '## Questions\n\nAnswer inline under each question, then resume with:\n\n```\nvibe resume RUNID\n```\n\n### 1. Should the widget be lazy or eager?\n*Kind:* product\n*Options:* lazy | eager\n*Claude would default to:* lazy\n\n**Your answer:**\n\n> \n\n' +
  RAISE;
const PINNED_FINDINGS_STOP = HEAD('the round cap') + RAISE;
const PINNED_CARRIED_STOP =
  HEAD('the round cap') +
  "## Outstanding P1 findings\n\n### Finding one `finding-one`\nIt is wrong.\n\n*Suggested fix:* Fix it.\n\n## Change a severity\n\nThese are the findings the next round will act on. To move one, replace the\n`*Move to:*` placeholder and say why; leave it exactly as it is and nothing\nchanges. A move with no reason, or a reason with no move, is reported rather than\nguessed at.\n\nA guard's downgrade is shown with the reason it fired, so you can see what you\nwould be overriding. Overriding one is legitimate: grounding checks that a claim\nnames a real place and cannot judge whether it is true, so a finding that was\nright and cited a file from memory is demoted for the same reason a wrong one is.\nThe guard's reason stays on the record either way.\n\n### Move: `finding-one`\n\n*Finding one*\n\n*Currently:* P1\n*Move to:* <P0, P1, P2 or P3 - leave this to change nothing>\n\n**Why:**\n\n>\n\n" +
  RAISE;
const PINNED_ASSUMED =
  "# Questions answered by assumption\n\n**Run:** `RUNID`\n\nCodex declined these and they were not blocking, so the run continued on the\nplanner's fallback. Nothing is wrong with the run - but these are the points\nwhere the result rests on a guess rather than a decision.\n\n### 1. Which cache?\n*Kind:* technical\n*Proceeded with:* LRU\n*Why Codex declined:* Codex declined.\n";

function pinRun(): RunState {
  return createRun(mkdtempSync(path.join(os.tmpdir(), 'vibe-decide-pin-')), 'pin task', true);
}
const scrub = (state: RunState, file: string): string => readFileSync(file, 'utf8').replaceAll(state.id, 'RUNID');

test('with no assumption in force, NEEDS-INPUT.md is byte-identical to before', () => {
  const state = pinRun();
  const q = { question: 'Should the widget be lazy or eager?', options: ['lazy', 'eager'], recommended: 'lazy', kind: 'product' as const, blocking: true };
  assert.equal(scrub(state, writeEscalation(state, new Escalation(EXIT.NEEDS_HUMAN, 'one question', [q]))), PINNED_QUESTION_STOP);
  assert.equal(scrub(state, writeEscalation(state, new Escalation(EXIT.NO_CONVERGENCE, 'the round cap'))), PINNED_FINDINGS_STOP);

  const f: Finding = {
    id: 'finding-one',
    severity: 'P1',
    title: 'Finding one',
    detail: 'It is wrong.',
    suggested_fix: 'Fix it.',
    evidence: [{ kind: 'external', ref: 'harness fixture' }],
  };
  state.pendingFindings = { phase: 'plan', findings: [f] };
  saveState(state);
  assert.equal(scrub(state, writeEscalation(state, findingsStop([f]))), PINNED_CARRIED_STOP);
});

test('with no human answer, ASSUMED.md is byte-identical to before', () => {
  const state = pinRun();
  state.deferredQuestions.push({ question: 'Which cache?', kind: 'technical', recommended: 'LRU', reason: 'Codex declined.' });
  saveState(state);
  reportDeferred(state);
  assert.equal(scrub(state, at(state, 'ASSUMED.md')), PINNED_ASSUMED);
});
