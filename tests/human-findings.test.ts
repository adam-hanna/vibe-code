import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { downgradeInert, refusePlaceholderPlan } from '@src/evidence.js';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import * as P from '@src/prompts.js';
import { parseRaised, raisePhase, raiseSection } from '@src/raise.js';
import { takePendingFindings } from '@src/run.js';
import { authorOf, gate } from '@src/validate.js';
import type { Finding, FindingsReport, RunState, TurnActivity } from '@src/types.js';
import {
  agents,
  config,
  escalationFile,
  findingFixture,
  p1,
  planFixture,
  raiseInNeedsInput,
  report,
  reviewingRun,
  stalledReview,
  work,
} from './helpers/loop-harness.js';

/**
 * A stalled review, in a tree with a file a citation can name.
 *
 * Every case that raises something cites `notes.md`, because grounding is real
 * here (decision 1) and a case citing nothing would be testing the downgrade
 * path by accident in every assertion it makes about severity.
 */
async function stalledWithFile(): Promise<RunState> {
  const { state } = await stalledReview();
  work(state, 'notes.md', 'one line\n');
  return state;
}

/**
 * A finding a human raised (#141).
 *
 * The asymmetry this closes: a person could dispose of a finding and answer a
 * question, and could not raise one. Every `Finding` came from `parseFindings`
 * reading a model's structured output, so the human was the judge of the
 * argument between the two agents but never a party to it - and the case this
 * tool most needs to handle is the one where both agents missed the same thing.
 *
 * Four things are on trial here and they are separable:
 *
 * 1. **Attribution**, which had to exist first. A severity is a claim with an
 *    owner and nothing recorded the owner, because "a model said it" was true by
 *    construction and therefore never written down.
 * 2. **The file**, which is the whole CLI surface: `NEEDS-INPUT.md` gains a block
 *    somebody fills in, parsed on the same resume that reads their answers.
 * 3. **Which guards apply**, which is the substance of the issue's five
 *    decisions - grounding does, the inert rule does not, the gate counts one,
 *    the oscillation census does not.
 * 4. **That a run where nobody raised anything is unchanged.** Asserted here as
 *    a byte comparison of the fixer's prompt, and by `durable-narration.test.ts`
 *    over the events of a clean pass.
 */

const TEMPLATE = raiseSection('20260906-000000-a-run');

function block(over: Partial<Record<'title' | 'severity' | 'file' | 'detail' | 'fix', string>> = {}): string {
  const file = over.file === undefined ? '' : `*File:* ${over.file}\n`;
  return `### Finding: ${over.title ?? 'The retry loop never backs off'}

*Severity:* ${over.severity ?? 'P1'}
${file}
**What is wrong:**

> ${over.detail ?? 'It retries immediately, three times, with no delay between attempts.'}

**Suggested fix:**

> ${over.fix ?? 'Sleep between attempts.'}
`;
}

// ---- 1. attribution --------------------------------------------------------

test('the two agent writers stamp themselves, and neither can be mistaken for the other', async () => {
  const state = reviewingRun({ prefix: 'vibe-raise-', task: 'attribution' });
  await orchestrate(
    state,
    config(),
    true,
    agents({ codex: () => report([findingFixture({ id: 'reviewer-said', severity: 'P2' })]) }, []),
  );

  const written = JSON.parse(
    readFileSync(path.join(state.dir, 'code-review-0.json'), 'utf8'),
  ) as FindingsReport;
  assert.equal(written.findings[0]?.raisedBy, 'reviewer');
  assert.equal(authorOf(written.findings[0] as Finding), 'reviewer');
});

test('the critic stamps itself, in the artifact a later reader opens', async () => {
  const state = reviewingRun({ prefix: 'vibe-raise-', task: 'critic attribution' });
  state.phase = 'planning';
  state.plan = null;
  await orchestrate(
    state,
    config({ maxPlanRounds: 1 }),
    false,
    agents(
      {
        claude: () => planFixture(),
        codex: () => report([findingFixture({ id: 'critic-said', severity: 'P2' })]),
      },
      [],
    ),
  ).catch(() => undefined);

  const written = JSON.parse(
    readFileSync(path.join(state.dir, 'plan-critique-0.json'), 'utf8'),
  ) as FindingsReport;
  assert.equal(written.findings.find((f) => f.id === 'critic-said')?.raisedBy, 'critic');
});

test("vibe's own mechanical finding is not recorded as the critic's judgement", () => {
  const { raised } = refusePlaceholderPlan(
    { verdict: 'APPROVE', summary: '', findings: [] },
    '« see below »',
    'plan-0.json',
  );
  assert.equal(raised?.raisedBy, 'vibe');
  assert.equal(authorOf(raised as Finding), 'vibe');
});

test('absent is not "an agent", and neither is a label nobody recognises', () => {
  // A finding recorded before attribution existed. Every run in any real archive
  // is one of these, which is why absent has to read as "nothing here says".
  assert.equal(authorOf(findingFixture()), null);
  // And a hand-edited state.json. `readFinding` carries this through
  // unvalidated, exactly as it carries `evidence`, so the narrowing is here.
  assert.equal(authorOf({ ...findingFixture(), raisedBy: 'the-boss' } as unknown as Finding), null);
  assert.equal(authorOf({ ...findingFixture(), raisedBy: 7 } as unknown as Finding), null);
});

// ---- 2. the file -----------------------------------------------------------

test('the template as it ships parses to nothing at all', () => {
  const { findings, problems } = parseRaised(TEMPLATE);
  assert.deepEqual(findings, []);
  assert.deepEqual(problems, []);
});

test('every stop offers the block, including one that asked no questions', async () => {
  const { state } = await stalledReview();
  const file = readFileSync(
    escalationFile(state, new Escalation(EXIT.NO_CONVERGENCE, 'the round cap')),
    'utf8',
  );
  assert.match(file, /## Raise a finding/);
  assert.match(file, /### Finding: /);
  // The round-cap stop is precisely the moment somebody reads the findings and
  // disagrees with them, so this is the stop that most needs the block.
  assert.equal(file.includes('**Your answer:**'), false);
});

test('a filled block becomes a finding, with the citation it named', () => {
  const { findings, problems } = parseRaised(
    `${TEMPLATE}\n${block({ file: 'src/run.ts:120' })}`,
  );
  assert.deepEqual(problems, []);
  assert.equal(findings.length, 1);
  const f = findings[0] as Finding;
  assert.equal(f.severity, 'P1');
  assert.equal(f.title, 'The retry loop never backs off');
  assert.equal(f.detail, 'It retries immediately, three times, with no delay between attempts.');
  assert.equal(f.suggested_fix, 'Sleep between attempts.');
  assert.equal(f.raisedBy, 'human');
  assert.deepEqual(f.evidence, [{ kind: 'code', path: 'src/run.ts', line: 120 }]);
});

test('an id says human in it, so it can never merge with a slug the reviewer derived', () => {
  const [f] = parseRaised(block({ title: 'The retry loop never backs off' })).findings;
  assert.equal(f?.id, 'human-the-retry-loop-never-backs-off');
});

test('a trailing :120 is a line number and a drive letter is not', () => {
  const cited = (file: string): unknown => parseRaised(block({ file })).findings[0]?.evidence;
  assert.deepEqual(cited('src/run.ts:120'), [{ kind: 'code', path: 'src/run.ts', line: 120 }]);
  assert.deepEqual(cited('src/run.ts'), [{ kind: 'code', path: 'src/run.ts' }]);
  assert.deepEqual(cited('C:\\repo\\src\\run.ts'), [{ kind: 'code', path: 'C:\\repo\\src\\run.ts' }]);
  assert.deepEqual(cited('C:\\repo\\src\\run.ts:12'), [
    { kind: 'code', path: 'C:\\repo\\src\\run.ts', line: 12 },
  ]);
});

test('a block somebody began and did not finish is reported, never guessed at', () => {
  const noSeverity = parseRaised(block({ severity: '' }));
  assert.deepEqual(noSeverity.findings, []);
  assert.equal(noSeverity.problems.length, 1);
  assert.match(noSeverity.problems[0]?.reason ?? '', /Severity/);

  // Named rather than silently coerced: "critical" is a word people use, and a
  // run that quietly read it as P0 would have a blocking claim nobody made.
  const wrongWord = parseRaised(block({ severity: 'critical' }));
  assert.deepEqual(wrongWord.findings, []);
  assert.match(wrongWord.problems[0]?.reason ?? '', /"critical"/);

  // Two blocks whose titles reduce to one id. Not merged and not dropped: an id
  // is the key the carry, the round history and the artifact all use, so losing
  // the second silently is the failure the report exists to prevent.
  const twice = parseRaised(`${block()}\n${block()}`);
  assert.equal(twice.findings.length, 1);
  assert.match(twice.problems[0]?.reason ?? '', /repeats the id/);

  const noDetail = parseRaised(block({ detail: '' }));
  assert.equal(noDetail.problems.length, 1);
  assert.match(noDetail.problems[0]?.reason ?? '', /What is wrong/);
  // The heading is quoted back, because a file can hold several blocks and
  // "one of them is incomplete" is not something a person can act on.
  assert.match(noDetail.problems[0]?.heading ?? '', /The retry loop never backs off/);
});

test('a suggested fix is optional - reporting a defect is not designing the repair', () => {
  const { findings, problems } = parseRaised(block({ fix: '' }));
  assert.deepEqual(problems, []);
  assert.equal(findings[0]?.suggested_fix, '');
});

test('the two parsers of one file cannot read each other\'s blocks', async () => {
  const { state } = await stalledReview();
  const file = escalationFile(
    state,
    new Escalation(EXIT.NEEDS_HUMAN, 'needs you', [
      {
        question: 'Lazy or eager?',
        options: ['lazy', 'eager'],
        recommended: 'lazy',
        kind: 'product',
        blocking: true,
      },
    ]),
  );
  const answered = readFileSync(file, 'utf8').replace(
    '**Your answer:**\n\n> \n',
    '**Your answer:**\n\n> Lazy.\n',
  );
  writeFileSync(file, `${answered}\n${block()}`, 'utf8');
  const raw = readFileSync(file, 'utf8');

  // The finding parser skips the question block; the answer parser skips the
  // finding block. Both share the `### ` split, and each is keyed on its own
  // marker rather than on position in the file.
  assert.equal(parseRaised(raw).findings.length, 1);
  const { parseHumanAnswers } = await import('@src/cli.js');
  const answers = parseHumanAnswers(raw);
  assert.equal(answers.length, 1);
  assert.equal(answers[0]?.answer, 'Lazy.');
});

// ---- 3. what the guards do with one ----------------------------------------

test('grounding runs, and catches a line typed by hand that does not exist', async () => {
  const { state } = await stalledReview();
  work(state, 'notes.md', 'one line\n');
  const { downgraded } = raiseInNeedsInput(state, state.targetDir, [
    {
      title: 'Nothing is at this line',
      severity: 'P1',
      detail: 'A citation typed by hand.',
      file: 'notes.md:99999',
    },
  ]);
  assert.equal(downgraded.length, 1);
  assert.equal(downgraded[0]?.severity, 'P2');
  assert.equal(downgraded[0]?.downgraded?.from, 'P1');
  assert.match(downgraded[0]?.downgraded?.reason ?? '', /has no line 99999/);
});

test('a citation that resolves keeps its severity, and the finding is carried', async () => {
  const state = await stalledWithFile();
  const { added, downgraded } = raiseInNeedsInput(state, state.targetDir, [
    { title: 'The state is wrong', severity: 'P1', detail: 'Look here.', file: 'notes.md' },
  ]);
  assert.deepEqual(downgraded, []);
  assert.equal(added[0]?.severity, 'P1');
  assert.equal(added[0]?.raisedBy, 'human');
});

test('the inert rule is about a turn, so it does not touch a finding with no turn behind it', () => {
  const activity: TurnActivity = { tool: 0, items: { agent_message: 3 } };
  const human: Finding = { ...p1('human-mine'), raisedBy: 'human' };
  const reviewer: Finding = { ...p1('reviewer-said'), raisedBy: 'reviewer' };
  const { report: out, downgraded } = downgradeInert(
    { verdict: 'REVISE', summary: '', findings: [human, reviewer] },
    activity,
  );
  assert.deepEqual(
    downgraded.map((f) => f.id),
    ['reviewer-said'],
  );
  assert.equal(out.findings.find((f) => f.id === 'human-mine')?.severity, 'P1');
});

test('the gate counts a human P1 - a person can block their own run', () => {
  const human: Finding = { ...p1('human-mine'), raisedBy: 'human' };
  assert.equal(gate([human], 0).pass, false);
  assert.equal(gate([human], 1).pass, true);
  // And it is carried like any other tolerated P1, not skipped for being ours.
  assert.deepEqual(
    gate([human], 1).tolerated.map((f) => f.id),
    ['human-mine'],
  );
});

test('a raise merges into what the run already paid for, and does not delete it', async () => {
  const state = await stalledWithFile();
  const carried = takePendingFindings(state, 'review') ?? [];
  assert.equal(carried.length, 2, 'the stall left the reviewer\'s two P1s outstanding');

  raiseInNeedsInput(state, state.targetDir, [
    { title: 'And this too', severity: 'P2', detail: 'Mine.', file: 'notes.md' },
  ]);

  const after = takePendingFindings(state, 'review') ?? [];
  assert.deepEqual(
    after.map((f) => f.id),
    ['finding-one', 'finding-two', 'human-and-this-too'],
  );
  // The reviewer's are untouched, attribution included - which is the whole
  // point of the field: one list, two owners, and the record says which is which.
  assert.equal(after[0]?.raisedBy, 'reviewer');
  assert.equal(after[2]?.raisedBy, 'human');
});

test('raising the same thing twice is one claim, and the second time says so', async () => {
  const state = await stalledWithFile();
  const same = { title: 'And this too', severity: 'P2' as const, detail: 'Mine.', file: 'notes.md' };
  raiseInNeedsInput(state, state.targetDir, [same]);
  const second = raiseInNeedsInput(state, state.targetDir, [same]);

  assert.deepEqual(second.added, [], 'already carried, so nothing was added a second time');
  assert.deepEqual(second.repeated, ['human-and-this-too']);
  const events = state.events ?? [];
  assert.equal(events.filter((e) => e.type === 'finding_reraised').length, 1);
  // Deliberately NOT the oscillation guard. A fixer failing to satisfy a person
  // is a different diagnosis from two models failing to agree, and the guard's
  // remedies - decide it yourself, swap the reviewer - fit only the second.
  assert.equal(events.filter((e) => e.type === 'no_convergence').length, 0);
  assert.equal(
    (state.p1Rounds ?? []).some((r) => (r.ids ?? []).some((id) => id.startsWith('human-'))),
    false,
    'and no round of the convergence census counts one',
  );
});

test('the raise is recorded durably, with what it was and where it went', async () => {
  const state = await stalledWithFile();
  raiseInNeedsInput(state, state.targetDir, [
    { title: 'A thing', severity: 'P1', detail: 'Mine.', file: 'notes.md' },
  ]);
  const raised = (state.events ?? []).filter((e) => e.type === 'finding_raised');
  assert.equal(raised.length, 1);
  assert.equal(raised[0]?.['id'], 'human-a-thing');
  assert.equal(raised[0]?.['severity'], 'P1');
  assert.equal(raised[0]?.['phase'], 'review');
  assert.equal(raised[0]?.['carried'], true);
  // And the words themselves, on disk, written before the merge so a process
  // that dies between the two keeps what the person actually wrote.
  const artifact = JSON.parse(
    readFileSync(path.join(state.dir, `raised-review-${state.planRound}-${state.reviewRound}.json`), 'utf8'),
  ) as Finding[];
  assert.equal(artifact[0]?.detail, 'Mine.');
});

test('a finished run has no round left, and says so rather than carrying one', () => {
  assert.equal(raisePhase('complete'), null);
  assert.equal(raisePhase('planning'), 'plan');
  assert.equal(raisePhase('implementing'), 'review');
  assert.equal(raisePhase('reviewing'), 'review');
});

// ---- 4. the prompt ---------------------------------------------------------

test('the fixer is told a person raised it, and why that reads differently', () => {
  const human: Finding = {
    id: 'human-mine',
    severity: 'P1',
    title: 'Mine',
    detail: 'What I saw.',
    suggested_fix: '',
    raisedBy: 'human',
    evidence: [{ kind: 'code', path: 'src/run.ts', line: 3 }],
  };
  const prompt = P.fixPrompt([human], 1);
  assert.match(prompt, /Raised by the person running this/);
  assert.match(prompt, /`src\/run\.ts:3`/);
  // Never `*Suggested fix:* ` with nothing after it - a label with no content
  // reads as a fix somebody forgot to write down.
  assert.equal(prompt.includes('*Suggested fix:*'), false);
});

test('a run in which nobody raised anything renders exactly the prompt it did before', () => {
  const agentFinding = p1('finding-one');
  const rendered = P.fixPrompt([agentFinding], 2);
  assert.equal(rendered.includes('Raised by the person running this'), false);
  assert.match(rendered, /\*Suggested fix:\* Fix it\./);
  // The shape #48 pinned: heading, detail, blank line, the fix label.
  assert.match(rendered, /### \[P1\] Finding finding-one {2}`finding-one`\nDetail\.\n\n\*Suggested fix:\*/);
});

test('a finding stamped by an agent renders no attribution line either', () => {
  const reviewed: Finding = { ...p1('finding-one'), raisedBy: 'reviewer' };
  assert.equal(P.fixPrompt([reviewed], 1), P.fixPrompt([p1('finding-one')], 1));
});

// ---- the state a raise leaves behind ---------------------------------------

test('a raised finding survives a stop the way a bought one does', async () => {
  const state = await stalledWithFile();
  raiseInNeedsInput(state, state.targetDir, [
    { title: 'Carry me', severity: 'P1', detail: 'Mine.', file: 'notes.md' },
  ]);

  // Re-read from disk, which is the whole claim: `pendingFindings` is what a
  // resume in a different process picks up, and a raise that lived only in
  // memory would be the loss the mechanism exists to prevent.
  const stored = JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as RunState;
  const carried = takePendingFindings(stored, 'review') ?? [];
  assert.deepEqual(
    carried.map((f) => f.id),
    ['finding-one', 'finding-two', 'human-carry-me'],
  );
  assert.equal(carried[2]?.raisedBy, 'human');
});
