import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { move } from '@src/evidence.js';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import * as P from '@src/prompts.js';
import { changeSeverity, moveSection, parseMoves } from '@src/raise.js';
import { gate, severityChangesOf } from '@src/validate.js';
import type { Finding, FindingsReport, RunState } from '@src/types.js';
import {
  agents,
  config,
  escalationFile,
  moveInNeedsInput,
  p1,
  report,
  reviewingRun,
  takeCarried,
} from './helpers/loop-harness.js';

/**
 * A severity that can move both ways, and says who moved it (#142).
 *
 * Before this, a severity moved in exactly one direction, was written by exactly
 * one function, and could never be moved back. Every instance of
 * `Finding.downgraded` in the product came from `toP2`: made by a machine,
 * always landing on P2, always for a mechanical reason, and permanent.
 *
 * That is right for a rule running unattended, and both guards are deliberately
 * blunt - grounding *"cannot judge a claim; it can only check that the claim
 * names a real place"*. Bluntness is also why a true P1 that cited a file the
 * reviewer described from memory is demoted for the same reason a false one is,
 * and **the only thing in the system that can tell those apart is a person**.
 * They could see the downgrade, agree it was wrong, and do nothing about it.
 *
 * The three things the issue says are shaped wrong, and what each becomes:
 *
 * 1. `toP2` hardcoded the target -> `move` in `src/evidence.ts`, which takes the
 *    target from the caller and `from` from the finding. Every severity change in
 *    the product goes through it.
 * 2. `downgraded` had no author -> the human's changes carry `by`, in #141's
 *    `FindingAuthor` vocabulary rather than a second one invented a month later.
 * 3. A restore is not a downgrade -> `downgraded` is never rewritten, so the
 *    guard's reason is still readable after the move that overrode it.
 */

const AT = '2026-09-06T10:00:00.000Z';

/** A P1 that cites nothing, which is what grounding demotes. */
function ungrounded(id: string): Finding {
  return {
    id,
    severity: 'P1',
    title: `Finding ${id}`,
    detail: 'Detail.',
    suggested_fix: 'Fix it.',
  };
}

/**
 * A review run stalled at the cap, carrying one P1 grounding demoted to P2 and
 * one it left alone.
 *
 * `p1Tolerance: 0` so the surviving P1 fails the gate; `maxReviewRounds: 1` so
 * the round cap stops the run with both findings outstanding. That is the state
 * a person opens `NEEDS-INPUT.md` in.
 */
async function stalledWithDowngrade(): Promise<RunState> {
  const state = reviewingRun({ prefix: 'vibe-severity-', task: 'severity changes' });
  await orchestrate(
    state,
    config({ maxReviewRounds: 1, p1Tolerance: 0 }),
    true,
    agents({ codex: () => report([p1('cited-one'), ungrounded('demoted-one')]) }, []),
  ).catch((err: unknown) => {
    if (!(err instanceof Escalation)) throw err;
  });
  return state;
}

// ---- 1. the one construction ------------------------------------------------

test('the source of a move is taken from the finding, never from the caller', () => {
  const { from, next } = move(p1('a'), 'P3');
  assert.equal(from, 'P1');
  assert.equal(next.severity, 'P3');
  // There is no parameter through which a caller could name a `from` the
  // finding never had, and `extra` cannot smuggle one either: the target is
  // applied after it, so a caller that tries to set the severity itself is
  // overruled and still gets the true source back. That is the whole reason the
  // two guards shared a construction, and why #142 widened it rather than
  // adding a third path beside it.
  const smuggled = move({ ...p1('a'), severity: 'P0' }, 'P3', { severity: 'P1' } as Partial<Finding>);
  assert.equal(smuggled.from, 'P0');
  assert.equal(smuggled.next.severity, 'P3');
});

test('a change appends, and the record says who and why', () => {
  const changed = changeSeverity(p1('a'), 'P0', 'I read it and it blocks.', AT);

  assert.equal(changed.severity, 'P0');
  assert.deepEqual(severityChangesOf(changed), [
    { from: 'P1', to: 'P0', by: 'human', reason: 'I read it and it blocks.', at: AT },
  ]);
});

test('two moves are two steps, oldest first', () => {
  const once = changeSeverity(p1('a'), 'P2', 'Not blocking.', AT);
  const twice = changeSeverity(once, 'P0', 'Changed my mind.', '2026-09-06T11:00:00.000Z');

  assert.deepEqual(
    severityChangesOf(twice).map((c) => `${c.from}->${c.to}`),
    ['P1->P2', 'P2->P0'],
  );
});

// ---- 2. a restore is not a downgrade ----------------------------------------

test('restoring a guard\'s downgrade leaves the guard\'s reason readable', async () => {
  const state = await stalledWithDowngrade();
  const demoted = takeCarried(state, 'review').find((f) => f.id === 'demoted-one');

  assert.equal(demoted?.severity, 'P2', 'grounding demoted it');
  assert.equal(demoted?.downgraded?.from, 'P1');

  moveInNeedsInput(state, [
    { id: 'demoted-one', to: 'P0', why: 'It is real - the reviewer just cited it badly.' },
  ]);
  const restored = takeCarried(state, 'review').find((f) => f.id === 'demoted-one');

  assert.equal(restored?.severity, 'P0');
  // Untouched, which is the whole point: #48 put the downgrade on the finding so
  // it would be visible to whoever reads the round's artifact, and overwriting
  // it on a restore would erase the fact that the guard fired at all.
  assert.deepEqual(restored?.downgraded, demoted?.downgraded);
  assert.match(restored?.downgraded?.reason ?? '', /cited no evidence/);
  // And the second transition is beside it, with its own author.
  const changes = severityChangesOf(restored as Finding);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.from, 'P2');
  assert.equal(changes[0]?.to, 'P0');
  assert.equal(changes[0]?.by, 'human');
});

test('the artifact holds both transitions, and the round\'s own record is not rewritten', async () => {
  const state = await stalledWithDowngrade();
  const before = readFileSync(path.join(state.dir, 'code-review-0.json'), 'utf8');

  moveInNeedsInput(state, [{ id: 'demoted-one', to: 'P0', why: 'Real.' }]);

  const written = path.join(state.dir, `severity-review-${state.planRound}-${state.reviewRound}.json`);
  const findings = JSON.parse(readFileSync(written, 'utf8')) as Finding[];
  const moved = findings.find((f) => f.id === 'demoted-one');
  assert.equal(moved?.downgraded?.from, 'P1');
  assert.equal(severityChangesOf(moved as Finding)[0]?.to, 'P0');

  // Deliberately unchanged. `code-review-0.json` is the record of what the
  // reviewer produced in that round, and editing it afterwards would make it a
  // record of something else - the same reason #141 keeps a human's finding out
  // of it. What the next round reads is `pendingFindings`, and that has both.
  assert.equal(readFileSync(path.join(state.dir, 'code-review-0.json'), 'utf8'), before);
});

// ---- 3. what the change reaches ---------------------------------------------

test('the gate reads the severity a person set - a restored P0 blocks', async () => {
  const state = await stalledWithDowngrade();
  moveInNeedsInput(state, [{ id: 'demoted-one', to: 'P0', why: 'Real.' }]);
  const carried = takeCarried(state, 'review');

  // No new control flow: `reviewPhase` calls the gate at the top of every
  // iteration, so a severity changed before the loop advances is read on the
  // next pass. What is asserted here is that the gate has no exception for a
  // severity a person set.
  assert.equal(gate(carried, 1).pass, false);
  assert.equal(gate(carried, 99).pass, false, 'a P0 is never carried, whatever the tolerance');
});

test('a demotion stops forcing a round', async () => {
  const state = await stalledWithDowngrade();
  moveInNeedsInput(state, [{ id: 'cited-one', to: 'P3', why: 'Real, but not for this change.' }]);

  const carried = takeCarried(state, 'review');
  assert.equal(carried.find((f) => f.id === 'cited-one')?.severity, 'P3');
  assert.equal(gate(carried, 0).pass, true, 'nothing blocking is left');
});

test('a move does not rewrite the round the census already recorded', async () => {
  const state = await stalledWithDowngrade();
  const before = JSON.stringify(state.p1Rounds ?? []);

  moveInNeedsInput(state, [{ id: 'cited-one', to: 'P3', why: 'Not blocking.' }]);

  // The same answer #141 gives, for a different structural reason: the census is
  // taken from the review report at the moment the round was recorded, and a
  // decision made afterwards does not go back and change what happened.
  assert.equal(JSON.stringify(state.p1Rounds ?? []), before);
  assert.equal(
    (state.events ?? []).filter((e) => e.type === 'finding_severity_changed').length,
    1,
  );
});

test('the change is recorded durably, with both severities and the reason', async () => {
  const state = await stalledWithDowngrade();
  moveInNeedsInput(state, [{ id: 'demoted-one', to: 'P0', why: 'The citation was lazy, not wrong.' }]);

  const e = (state.events ?? []).find((x) => x.type === 'finding_severity_changed');
  assert.equal(e?.['id'], 'demoted-one');
  assert.equal(e?.['from'], 'P2');
  assert.equal(e?.['to'], 'P0');
  assert.equal(e?.['by'], 'human');
  assert.equal(e?.['reason'], 'The citation was lazy, not wrong.');
});

// ---- 4. the file ------------------------------------------------------------

test('the block names what you would be overriding, and shows the guard its reason', async () => {
  const state = await stalledWithDowngrade();
  const file = readFileSync(
    escalationFile(state, new Escalation(EXIT.NO_CONVERGENCE, 'the round cap')),
    'utf8',
  );

  assert.match(file, /## Change a severity/);
  assert.match(file, /### Move: `demoted-one`/);
  // "Overriding a guard should be possible and never inviting" - showing the
  // guard's own reason is what makes it the first without making it the second.
  assert.match(file, /a guard downgraded it from P1 - it cited no evidence/);
  assert.match(file, /### Move: `cited-one`/);
  assert.match(file, /\*Currently:\* P1\n/, 'a finding no guard touched says only its severity');
});

test('nothing carried means no form at all', () => {
  assert.equal(moveSection([]), '');
});

test('the untouched form changes nothing', async () => {
  const state = await stalledWithDowngrade();
  const file = readFileSync(
    escalationFile(state, new Escalation(EXIT.NO_CONVERGENCE, 'the round cap')),
    'utf8',
  );

  const { moves, problems } = parseMoves(file, takeCarried(state, 'review'));
  assert.deepEqual(moves, []);
  assert.deepEqual(problems, []);
});

// ---- 5. refuse, never repair ------------------------------------------------

const CARRIED = [p1('some-id')];

function block(to: string, why: string): string {
  return `### Move: \`some-id\`\n\n*Currently:* P1\n*Move to:* ${to}\n\n**Why:**\n\n> ${why}\n`;
}

test('a move with no reason is reported, not accepted with an empty one', () => {
  const { moves, problems } = parseMoves(block('P0', ''), CARRIED);
  assert.deepEqual(moves, []);
  assert.match(problems[0]?.reason ?? '', /Why/);
});

test('a reason with no move is reported, not dropped', () => {
  const { moves, problems } = parseMoves(block('', 'I think this blocks.'), CARRIED);
  assert.deepEqual(moves, []);
  assert.match(problems[0]?.reason ?? '', /Move to/);
});

test('a severity nobody recognises is named back rather than coerced', () => {
  const { problems } = parseMoves(block('critical', 'It blocks.'), CARRIED);
  assert.match(problems[0]?.reason ?? '', /"critical"/);
});

test('an id the run is not carrying is reported - the file may be from an earlier stop', () => {
  const { moves, problems } = parseMoves(block('P0', 'It blocks.'), [p1('a-different-one')]);
  assert.deepEqual(moves, []);
  assert.match(problems[0]?.reason ?? '', /not one of the findings this run is carrying/);
});

test('a move to the severity it already has is reported, not silently ignored', () => {
  // Somebody typed a severity and a reason. Proceeding in silence would leave
  // them believing the run had been changed.
  const { moves, problems } = parseMoves(block('P1', 'Leave it blocking.'), CARRIED);
  assert.deepEqual(moves, []);
  assert.match(problems[0]?.reason ?? '', /already P1/);
});

// ---- 6. what a stored change reads back as ----------------------------------

test('absent is no history, and a malformed entry costs only itself', () => {
  assert.deepEqual(severityChangesOf(p1('a')), []);

  const dirty = {
    ...p1('a'),
    severityChanges: [
      { from: 'P1', to: 'P0', by: 'human', reason: 'ok', at: AT },
      { from: 'P1', to: 'sideways', by: 'human', reason: 'bad severity', at: AT },
      { from: 'P1', to: 'P0', by: 'the-boss', reason: 'bad author', at: AT },
      'not a record',
    ],
  } as unknown as Finding;

  // Dropped individually, the direction `readEvidence` takes: this is a record
  // of what happened, not an input anything computes from - the severity the
  // loop acts on is `f.severity`, which moved when the change was made.
  assert.deepEqual(
    severityChangesOf(dirty).map((c) => c.reason),
    ['ok'],
  );
});

// ---- 7. the prompt ----------------------------------------------------------

test('the fixer is told a person moved it, and that the guard still fired', async () => {
  const state = await stalledWithDowngrade();
  moveInNeedsInput(state, [{ id: 'demoted-one', to: 'P0', why: 'Real - the citation was lazy.' }]);
  const restored = takeCarried(state, 'review').find((f) => f.id === 'demoted-one') as Finding;

  const prompt = P.fixPrompt([restored], 1);
  assert.match(prompt, /Severity moved from P2 to P0 by the person running this/);
  assert.match(prompt, /Real - the citation was lazy/);
  // Both facts, because both are true and they point in opposite directions:
  // the severity is deliberate, and the citation is still missing.
  assert.match(prompt, /A guard had downgraded it from P1/);
});

test('a run in which nobody moved a severity renders exactly the prompt it did before', () => {
  const untouched = p1('finding-one');
  const rendered = P.fixPrompt([untouched], 2);
  assert.equal(rendered.includes('Severity moved from'), false);
  assert.equal(rendered, P.fixPrompt([{ ...untouched, severityChanges: [] }], 2));
});

// ---- 8. the loop reads it ---------------------------------------------------

test('the next round fixes what the person made blocking', async () => {
  const state = await stalledWithDowngrade();
  moveInNeedsInput(state, [{ id: 'demoted-one', to: 'P0', why: 'Real.' }]);
  // The other one out of the way, so the round below is unambiguously about the
  // finding a person restored.
  moveInNeedsInput(state, [{ id: 'cited-one', to: 'P3', why: 'Not for this change.' }]);

  const prompts: string[] = [];
  await orchestrate(
    state,
    config({ maxReviewRounds: 3, p1Tolerance: 0 }),
    true,
    agents(
      {
        claude: (label, options): string => {
          prompts.push((options as { prompt: string }).prompt);
          return `did ${label}`;
        },
        codex: () => report([]),
      },
      [],
    ),
  );

  // The carried findings are answered before anything is re-reviewed, so the
  // first turn is the fix round - and it was given the restored P0.
  assert.match(prompts[0] ?? '', /\[P0\] Finding demoted-one/);
  assert.match(prompts[0] ?? '', /Severity moved from P2 to P0/);
  assert.equal(existsSync(path.join(state.dir, 'code-review-1.json')), true);
});

// A guard rewriting a finding a person already moved cannot happen today and is
// not defended against here: grounding runs at parse time, before anybody can
// have seen the finding, and carried findings are handed to the fixer without
// being re-grounded. If that order ever changes, `move` is the one place both
// paths meet.
test('grounding runs before anyone can move a severity, so the order is guard then person', async () => {
  const state = await stalledWithDowngrade();
  const carried = takeCarried(state, 'review');
  const written = JSON.parse(
    readFileSync(path.join(state.dir, 'code-review-0.json'), 'utf8'),
  ) as FindingsReport;

  // The downgrade is already in the round's artifact - it happened inside the
  // review turn, not afterwards.
  assert.equal(written.findings.find((f) => f.id === 'demoted-one')?.severity, 'P2');
  assert.equal(carried.every((f) => severityChangesOf(f).length === 0), true);
});
