import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { finalFixSummary } from '@src/cli.js';
import { DEFAULTS, loadConfig, withProjectFile } from '@src/config.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { orchestrate } from '@src/orchestrator.js';
import { loadRun } from '@src/run.js';
import { isToAddress } from '@src/stored.js';
import type { Config, Finding, RunState } from '@src/types.js';
import {
  agents,
  committing,
  config,
  findingFixture,
  freshRun,
  p1,
  planFixture,
  report,
  reviewingRun,
  verifying,
  verifyRuns,
  work,
} from './helpers/loop-harness.js';

/**
 * A passing round's non-blocking findings still reach somebody (#425).
 *
 * Run `20261022-224848` passed a review whose verdict was REVISE with two P2s
 * in the task's own files, said "Review clean", and ran no fix; neither finding
 * reached FOLLOW-UPS.md. What these cases pin is the shape the owner decided:
 * a P2 to address buys the one final round the carried-P1 path already has,
 * never re-reviewed; P3s alone buy nothing and are recorded; what the fixer
 * leaves goes to FOLLOW-UPS.md with its reason; an approved plan hands its
 * non-blocking findings to the implementer; and `loop.fixNonBlocking: false`
 * is the loop before any of it.
 */

const RUN = { prefix: 'vibe-nonblocking-', task: 'non-blocking findings', commit: true } as const;
const LEFT_HEADING = '## Left by the final fix round';
const SECTION_HEADING = '## Non-blocking findings from the plan critique';

const p2 = (id: string, over: Partial<Finding> = {}): Finding =>
  findingFixture({ id, severity: 'P2', title: `Finding ${id}`, ...over });
const p3 = (id: string): Finding => findingFixture({ id, severity: 'P3', title: `Finding ${id}` });

type Said = { id: string; disposition: string; reason: string };

/** What a fix turn returns under FIX_SCHEMA. */
function said(dispositions: readonly Said[]): object {
  return { report: '## Changed\nsome', dispositions: [...dispositions] };
}

interface Driven {
  state: RunState;
  calls: string[];
  prompts: Map<string, string>;
  seen: Narration[];
}

/**
 * A run parked at review, whose first review returns `findings` and whose
 * fixer answers with `fixer` - JSON dispositions, or raw text. Any second
 * review fails the case: the final round is never re-reviewed.
 */
async function review(
  findings: readonly Finding[],
  options: { loop?: Partial<Config['loop']>; fixer?: readonly Said[] | string; seed?: (s: RunState) => void } = {},
): Promise<Driven> {
  const state = reviewingRun(RUN);
  options.seed?.(state);
  return drive(state, config(options.loop ?? {}, { ...committing(), ...verifying(state) }), {
    resume: true,
    codex: (label) => {
      if (label !== 'review-0') assert.fail(`${label}: the final fix round was reviewed again`);
      return report([...findings]);
    },
    fixer: options.fixer,
  });
}

async function drive(
  state: RunState,
  cfg: Config,
  options: {
    resume: boolean;
    codex: (label: string) => unknown;
    fixer?: readonly Said[] | string | undefined;
  },
): Promise<Driven> {
  const calls: string[] = [];
  const prompts = new Map<string, string>();
  const seen: Narration[] = [];
  const realLog = console.log;
  const realError = console.error;
  log.setSink((n) => void seen.push(n));
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(
      state,
      cfg,
      options.resume,
      agents(
        {
          claude: (label, o) => {
            prompts.set(label, o.prompt);
            if (label === 'plan' || label.startsWith('revise-')) return planFixture();
            work(state, `${label}.txt`);
            if (!label.startsWith('final-fix-') && !label.startsWith('fix-')) return 'done';
            const fixer = options.fixer ?? [];
            return typeof fixer === 'string' ? fixer : said(fixer);
          },
          codex: options.codex,
        },
        calls,
      ),
    );
  } finally {
    log.setSink(null);
    console.log = realLog;
    console.error = realError;
  }
  return { state, calls, prompts, seen };
}

function approvals(d: Driven): Record<string, unknown>[] {
  return d.state.events.filter((e) => e.type === 'review_approved') as Record<string, unknown>[];
}

function followUps(state: RunState): string {
  const file = path.join(state.dir, 'FOLLOW-UPS.md');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

function leftSection(state: RunState): string {
  const text = followUps(state);
  const at = text.indexOf(LEFT_HEADING);
  return at === -1 ? '' : text.slice(at);
}

const outstandingFile = (state: RunState): string => path.join(state.dir, 'OUTSTANDING.md');

// ---- the review side --------------------------------------------------------

test('a review passing with two P2s runs one final fix, then the gates, and is not reviewed again', async () => {
  const d = await review([p2('p2-a'), p2('p2-b')], {
    fixer: [
      { id: 'p2-a', disposition: 'fixed', reason: 'done' },
      { id: 'p2-b', disposition: 'not-addressed', reason: 'out of the task' },
    ],
  });

  assert.deepEqual(d.calls, ['review-0', 'final-fix-1']);
  const prompt = d.prompts.get('final-fix-1') ?? '';
  assert.match(prompt, /p2-a/);
  assert.match(prompt, /p2-b/);
  // Once before the review, once after the fix: the gates prove it broke nothing.
  assert.equal(verifyRuns(d.state), 2);
  assert.equal(d.state.phase, 'complete');

  const approved = approvals(d);
  assert.equal(approved.length, 1, 'exactly one review_approved');
  const message = d.seen.find((n) => n.id === 'review_approved')?.message ?? '';
  assert.doesNotMatch(message, /clean/);
  assert.doesNotMatch(message, /0 carried/);
  assert.match(message, /1 of 2 non-blocking finding\(s\) fixed, 1 recorded in FOLLOW-UPS\.md/);
  assert.deepEqual(approved[0]?.['carriedAndFixed'], []);
  assert.deepEqual(approved[0]?.['nonBlocking'], ['p2-a', 'p2-b']);
  assert.deepEqual(approved[0]?.['nonBlockingFixed'], ['p2-a']);
  assert.deepEqual(approved[0]?.['followUps'], ['p2-b']);

  // No P1 was carried, so there is no OUTSTANDING.md - not after the round,
  // and not after the gate-time rewrites either.
  assert.equal(existsSync(outstandingFile(d.state)), false);
  assert.deepEqual(d.state.outstanding, []);
  assert.deepEqual(d.state.finalFixNonBlocking, ['p2-a', 'p2-b']);
  assert.equal(d.state.pendingFindings, null);

  // The completion line says what the round worked on.
  assert.ok(
    d.seen.some(
      (n) => n.message === 'The final fix round worked on 2 non-blocking finding(s), and verification still passes.',
    ),
  );
  // The step line counts what it carried, and `carried` keeps meaning the P1s.
  const started = d.seen.find((n) => n.id === 'turn_started' && n.data?.['kind'] === 'final-fix');
  assert.equal(started?.message, 'Incorporating 2 non-blocking finding(s), then finishing: p2-a, p2-b');
  assert.deepEqual(started?.data?.['carried'], []);
  assert.deepEqual(started?.data?.['nonBlocking'], ['p2-a', 'p2-b']);
});

test('a round where the fixer fixed every non-blocking finding names no FOLLOW-UPS.md', async () => {
  const d = await review([p2('p2-a'), p2('p2-b')], {
    fixer: [
      { id: 'p2-a', disposition: 'fixed', reason: 'done' },
      { id: 'p2-b', disposition: 'fixed', reason: 'done' },
    ],
  });

  assert.deepEqual(d.calls, ['review-0', 'final-fix-1']);
  assert.deepEqual(d.state.unaddressed, []);
  assert.equal(leftSection(d.state), '');
  const approved = approvals(d);
  assert.equal(approved.length, 1);
  const message = d.seen.find((n) => n.id === 'review_approved')?.message ?? '';
  assert.equal(message, 'Review approved after a final fix round - 2 of 2 non-blocking finding(s) fixed');
  assert.doesNotMatch(message, /FOLLOW-UPS/);
  assert.doesNotMatch(finalFixSummary(d.state, null) ?? '', /FOLLOW-UPS/);
});

test('a review passing with only P3s to address runs no fix turn and records them', async () => {
  const d = await review([p3('p3-a'), p3('p3-b')]);

  assert.deepEqual(d.calls, ['review-0']);
  assert.notEqual(d.state.finalFixDone, true);
  const section = leftSection(d.state);
  assert.match(section, /p3-a/);
  assert.match(section, /p3-b/);
  assert.equal(section.match(/\*Fixer's disposition:\* not attempted: P3s only/g)?.length, 2);
  assert.match(section, /\*Severity:\* P3/);

  const approved = approvals(d);
  assert.equal(approved.length, 1);
  const message = d.seen.find((n) => n.id === 'review_approved')?.message ?? '';
  assert.doesNotMatch(message, /clean/);
  assert.equal(message, 'Review approved - 2 P3 finding(s) recorded in FOLLOW-UPS.md, no fix round run');
  assert.deepEqual(approved[0]?.['followUps'], ['p3-a', 'p3-b']);
});

test('a review passing with only deferred findings runs no fix turn, and says what it always said', async () => {
  const d = await review([p2('deferred-a', { defer: true }), findingFixture({ id: 'deferred-b', severity: 'P3', defer: true })]);

  assert.deepEqual(d.calls, ['review-0']);
  const text = followUps(d.state);
  assert.match(text, /## Deferred by review[\s\S]*deferred-a/);
  assert.match(text, /deferred-b/);
  assert.equal(leftSection(d.state), '');
  const approved = approvals(d);
  assert.equal(approved.length, 1);
  assert.equal(d.seen.find((n) => n.id === 'review_approved')?.message, 'Review clean - 2 non-blocking finding(s)');
  assert.deepEqual(
    Object.keys(approved[0] ?? {}).filter((k) => k !== 'at' && k !== 'type' && k !== 'message'),
    ['findings'],
  );
  assert.equal(d.state.unaddressed, undefined);
});

test('what counts as to address: a P2 or P3 that is not deferred or vote-moved', () => {
  assert.equal(isToAddress(p2('plain')), true);
  assert.equal(isToAddress(p3('plain-p3')), true);
  assert.equal(isToAddress(p1('a-p1')), false);
  assert.equal(isToAddress(p2('deferred', { defer: true })), false);
  const moved = p2('moved', {
    votes: { quorum: 2, n: 2, real: 0, notReal: 2, cannotTell: 0, outcome: 'unconfirmed', ballots: [] },
    downgraded: { from: 'P1', reason: 'the vote did not confirm it' },
  });
  assert.equal(isToAddress(moved), false, 'a vote-moved finding is deferrable');
  // A P1 a guard downgraded is a P2 like any other here (Decision 2 of #425).
  assert.equal(isToAddress(p2('guarded', { downgraded: { from: 'P1', reason: 'used no tools' } })), true);
});

test('tolerated P1s plus P2s are one final fix, and OUTSTANDING.md lists only the P1s', async () => {
  const d = await review([p1('carried-one'), p2('p2-a')], {
    fixer: [
      { id: 'carried-one', disposition: 'fixed', reason: 'done' },
      { id: 'p2-a', disposition: 'rebutted', reason: 'already guarded upstream' },
    ],
  });

  assert.deepEqual(d.calls, ['review-0', 'final-fix-1']);
  const outstanding = readFileSync(outstandingFile(d.state), 'utf8');
  assert.match(outstanding, /carried-one/);
  assert.doesNotMatch(outstanding, /p2-a/);
  assert.match(outstanding, /raised 1 P1 finding\(s\)/);

  assert.equal(approvals(d).length, 1);
  assert.equal(
    d.seen.find((n) => n.id === 'review_approved')?.message,
    'Review approved after a final fix round - 1 carried P1(s) fixed - carried-one, ' +
      '0 of 1 non-blocking finding(s) fixed, 1 recorded in FOLLOW-UPS.md',
  );
  // The P1 is not in FOLLOW-UPS.md: its header claims everything there was non-blocking.
  const section = leftSection(d.state);
  assert.match(section, /p2-a/);
  assert.doesNotMatch(section, /carried-one/);
  assert.ok(
    d.seen.some(
      (n) =>
        n.message ===
        'The final fix round worked on 1 carried P1(s) and 1 non-blocking finding(s), and verification still passes.',
    ),
  );
  const summary = finalFixSummary(d.state, null) ?? '';
  assert.match(summary, /^Finished after a final fix round for 1 carried P1\(s\): carried-one\./);
  assert.match(summary, /It also worked on 1 non-blocking finding\(s\); 1 of them is in FOLLOW-UPS\.md/);
});

test('a round for tolerated P1s alone says, records and writes exactly what it did before', async () => {
  const d = await review([p1('carried-one')]);

  assert.deepEqual(d.calls, ['review-0', 'final-fix-1']);
  assert.equal(
    d.seen.find((n) => n.id === 'review_approved')?.message,
    'Review approved with 1 carried finding(s) fixed - carried-one',
  );
  const approved = approvals(d)[0] ?? {};
  assert.deepEqual(approved['carriedAndFixed'], ['carried-one']);
  assert.equal('nonBlocking' in approved, false);
  assert.equal(
    d.seen.find((n) => n.id === 'turn_started' && n.data?.['kind'] === 'final-fix')?.message,
    'Incorporating 1 carried P1(s), then finishing: carried-one',
  );
  assert.ok(d.seen.some((n) => n.message === 'Carried findings addressed and verification still passes.'));
  assert.equal(d.state.finalFixNonBlocking, undefined);
  assert.equal(d.state.unaddressed, undefined);
});

test('what the fixer did not fix goes to FOLLOW-UPS.md with its disposition and reason', async () => {
  const d = await review([p2('fixed-one'), p2('ignored-one'), p2('deferred-one'), p2('rebutted-one')], {
    fixer: [
      { id: 'fixed-one', disposition: 'fixed', reason: 'changed it' },
      { id: 'ignored-one', disposition: 'not-addressed', reason: 'ran out of scope' },
      { id: 'deferred-one', disposition: 'deferred', reason: 'separate work' },
      { id: 'rebutted-one', disposition: 'rebutted', reason: 'the path is unreachable' },
    ],
  });

  const section = leftSection(d.state);
  assert.doesNotMatch(section, /fixed-one/);
  assert.match(section, /`ignored-one`\n\n\*Severity:\* P2\n\n\*Fixer's disposition:\* not addressed - ran out of scope/);
  assert.match(section, /`deferred-one`\n\n\*Severity:\* P2\n\n\*Fixer's disposition:\* deferred by the fixer - separate work/);
  assert.match(section, /`rebutted-one`\n\n\*Severity:\* P2\n\n\*Fixer's disposition:\* rebutted - the path is unreachable/);
  assert.deepEqual(
    d.state.unaddressed?.map((u) => [u.finding.id, u.outcome]),
    [
      ['ignored-one', 'not-addressed'],
      ['deferred-one', 'deferred'],
      ['rebutted-one', 'rebutted'],
    ],
  );
});

test('an unreadable answer puts every non-blocking finding in FOLLOW-UPS.md as unreadable, never as ignored', async () => {
  const d = await review([p2('p2-a'), p2('p2-b')], { fixer: 'I fixed things but this is not JSON.' });

  assert.deepEqual(d.calls, ['review-0', 'final-fix-1']);
  const section = leftSection(d.state);
  assert.equal(section.match(/\*Fixer's disposition:\* the fixer's answer could not be read/g)?.length, 2);
  assert.doesNotMatch(section, /not addressed/);
  const message = d.seen.find((n) => n.id === 'review_approved')?.message ?? '';
  assert.match(message, /could not be read/);
  assert.match(message, /2 recorded in FOLLOW-UPS\.md/);
});

test('a final round that died inside its turn with only P2s resumes as itself and writes the same record', async () => {
  const finding = p2('p2-a');
  const d = await review([], {
    fixer: [{ id: 'p2-a', disposition: 'not-addressed', reason: 'ran out of scope' }],
    seed: (state) => {
      state.reviewRound = 1;
      state.finalFixDone = true;
      state.outstanding = [];
      state.finalFixNonBlocking = ['p2-a'];
      state.fixInFlight = { round: 1, final: true };
      state.pendingFindings = { phase: 'review', findings: [finding] };
    },
  });

  // `review` fails on any review turn other than `review-0`, and none ran.
  assert.deepEqual(d.calls, ['final-fix-1']);
  assert.equal(verifyRuns(d.state), 1, 'the gate ran after the resumed round');
  assert.equal(d.state.phase, 'complete');
  assert.match(leftSection(d.state), /`p2-a`\n\n\*Severity:\* P2\n\n\*Fixer's disposition:\* not addressed - ran out of scope/);
  assert.equal(existsSync(outstandingFile(d.state)), false);
  assert.equal(approvals(d).length, 1);
});

test('with loop.fixNonBlocking off, a P2 pass is what it always was', async () => {
  const d = await review([p2('p2-a')], { loop: { fixNonBlocking: false } });

  assert.deepEqual(d.calls, ['review-0']);
  assert.equal(d.seen.find((n) => n.id === 'review_approved')?.message, 'Review clean - 1 non-blocking finding(s)');
  assert.equal(d.state.unaddressed, undefined);
  assert.equal(d.state.finalFixNonBlocking, undefined);
  assert.equal(followUps(d.state), '');
});

// ---- the plan side ----------------------------------------------------------

/** A full run from planning: the critique returns `findings` once, the review nothing. */
async function plan(findings: readonly Finding[], loop: Partial<Config['loop']> = {}): Promise<Driven> {
  const state = freshRun({ ...RUN, planOnly: false, git: true });
  return drive(state, config(loop, { ...committing(), ...verifying(state) }), {
    resume: false,
    codex: (label) => (label.startsWith('critique') ? report([...findings]) : report([])),
  });
}

test('an approved plan hands its non-blocking findings to the implementer, in their own section', async () => {
  const d = await plan([p1('carried-one'), p2('plain-p2'), p3('plain-p3'), p2('deferred-p2', { defer: true })]);

  // No extra revision and no re-critique: the plan loop's round count is unchanged.
  assert.deepEqual(d.calls, ['plan', 'critique-0', 'implement', 'review-0']);
  const prompt = d.prompts.get('implement') ?? '';
  const at = prompt.indexOf(SECTION_HEADING);
  const known = prompt.indexOf('## Known open issues with this plan');
  const declined = prompt.indexOf('## Declined by the reviewer');
  assert.ok(at !== -1, 'the section is there');
  assert.ok(at < known, 'before the carried section, which stays where it was');
  const section = prompt.slice(at, known);
  assert.match(section, /Address each one that belongs to the task as you implement, and leave the rest/);
  assert.match(section, /plain-p2/);
  assert.match(section, /plain-p3/);
  assert.doesNotMatch(section, /deferred-p2/);
  assert.doesNotMatch(section, /carried-one/);
  assert.match(prompt.slice(declined), /deferred-p2/);

  assert.deepEqual(d.state.planNonBlocking?.map((f) => f.id), ['plain-p2', 'plain-p3']);
  const approved: Record<string, unknown> = d.state.events.find((e) => e.type === 'plan_approved') ?? {};
  assert.deepEqual(approved['nonBlocking'], ['plain-p2', 'plain-p3']);
  assert.equal(
    d.seen.find((n) => n.id === 'plan_approved')?.message,
    'Plan accepted with 1 P1(s) carried into implementation - carried-one; 2 non-blocking finding(s) go to the implementer',
  );
});

test('with the setting off, an approved plan with a P2 gives the prompt and state it always did', async () => {
  const off = await plan([p2('plain-p2')], { fixNonBlocking: false });
  const clean = await plan([]);

  const prompt = off.prompts.get('implement') ?? '';
  assert.equal(prompt.includes(SECTION_HEADING), false);
  assert.equal('planNonBlocking' in off.state, false);
  assert.equal(off.seen.find((n) => n.id === 'plan_approved')?.message, 'Plan approved - 1 non-blocking finding(s)');
  // The prompt is the clean run's prompt, byte for byte.
  assert.equal(prompt, (clean.prompts.get('implement') ?? '').replaceAll(clean.state.id, off.state.id));
});

test('a plan approved with the setting on and resumed with it off gives the old prompt', async () => {
  const state = freshRun({ ...RUN, planOnly: false, git: true });
  // Park before implementation by killing the implement turn.
  await assert.rejects(() =>
    orchestrate(
      state,
      config({}, committing()),
      false,
      agents(
        {
          claude: (label) => {
            if (label === 'plan') return planFixture();
            throw new Error('the implementation turn died');
          },
          codex: () => report([p2('plain-p2')]),
        },
        [],
      ),
    ),
  );
  assert.deepEqual(state.planNonBlocking?.map((f) => f.id), ['plain-p2']);

  const loaded = loadRun(state.targetDir, state.id);
  const d = await drive(loaded, config({ fixNonBlocking: false }, committing()), {
    resume: true,
    codex: () => report([]),
  });
  assert.equal((d.prompts.get('implement') ?? '').includes(SECTION_HEADING), false);
});

// ---- the CLI summary --------------------------------------------------------

function summaryState(over: Partial<RunState>): RunState {
  const state = freshRun(RUN);
  Object.assign(state, over);
  return state;
}

const left = (id: string): NonNullable<RunState['unaddressed']>[number] => ({
  finding: p2(id),
  outcome: 'not-addressed',
  reason: 'no',
});

test('the CLI summary says what a final round carried, and fails closed on what it left', () => {
  const p1Only = summaryState({ finalFixDone: true, outstanding: [p1('a')] });
  assert.equal(
    finalFixSummary(p1Only, null),
    'Finished after a final fix round for 1 carried P1(s): a. Verification passed, and that round was not ' +
      're-reviewed - see OUTSTANDING.md.',
  );

  const p2Left = summaryState({
    finalFixDone: true,
    outstanding: [],
    finalFixNonBlocking: ['x', 'y'],
    unaddressed: [left('y')],
  });
  const leftText = finalFixSummary(p2Left, null) ?? '';
  assert.equal(
    leftText,
    'Finished after a final fix round for 2 non-blocking finding(s): x, y. Verification passed, and that ' +
      "round was not re-reviewed; 1 of them is in FOLLOW-UPS.md with the fixer's reason.",
  );
  assert.doesNotMatch(leftText, /repaired|OUTSTANDING\.md/);

  const p2Fixed = summaryState({ finalFixDone: true, outstanding: [], finalFixNonBlocking: ['x'], unaddressed: [] });
  const fixedText = finalFixSummary(p2Fixed, 'the gate "core" never ran') ?? '';
  assert.match(fixedText, /But the gate "core" never ran/);
  assert.match(fixedText, /the fixer marked every one of them fixed\.$/);
  assert.doesNotMatch(fixedText, /FOLLOW-UPS|repaired/);

  const mixed = summaryState({
    finalFixDone: true,
    outstanding: [p1('a')],
    finalFixNonBlocking: ['x'],
    unaddressed: [left('x')],
  });
  assert.equal(
    finalFixSummary(mixed, null),
    `${finalFixSummary(p1Only, null) ?? ''} It also worked on 1 non-blocking finding(s); 1 of them is in ` +
      "FOLLOW-UPS.md with the fixer's reason.",
  );

  // A record that could not be read back is never "every one fixed".
  const absent = summaryState({ finalFixDone: true, outstanding: [], finalFixNonBlocking: ['x'] });
  assert.match(finalFixSummary(absent, null) ?? '', /could not be read back/);
  const repaired = summaryState({ finalFixDone: true, outstanding: [], finalFixNonBlocking: ['x'], unaddressed: [] });
  repaired.events.push({ at: new Date().toISOString(), type: 'state_repaired', field: 'unaddressed' });
  const repairedText = finalFixSummary(repaired, null) ?? '';
  assert.match(repairedText, /could not be read back/);
  assert.doesNotMatch(repairedText, /marked every one of them fixed/);

  const damaged = summaryState({ finalFixDone: true, outstanding: [] });
  assert.equal(
    finalFixSummary(damaged, null),
    'Finished after a final fix round, but the record of what it carried is empty - ' +
      'state.json was repaired on load. See OUTSTANDING.md for what was actually carried.',
  );

  assert.equal(finalFixSummary(summaryState({}), null), null);
});

test('a malformed unaddressed record that the loader drops is reported as unreadable, not fixed', () => {
  const state = freshRun(RUN);
  const file = path.join(state.dir, 'state.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  raw['finalFixDone'] = true;
  raw['outstanding'] = [];
  raw['finalFixNonBlocking'] = ['p2-a'];
  raw['unaddressed'] = [{ finding: { id: 'p2-a' }, outcome: 'not-addressed', reason: 'x' }];
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');

  const loaded = loadRun(state.targetDir, state.id);
  assert.deepEqual(loaded.unaddressed, []);
  assert.match(finalFixSummary(loaded, null) ?? '', /could not be read back/);
});

// ---- the setting ------------------------------------------------------------

test('loop.fixNonBlocking is on by default, a missing key reads as on, and a non-boolean is refused', () => {
  assert.equal(DEFAULTS.loop.fixNonBlocking, true);
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-nonblocking-config-'));
  assert.equal(loadConfig(dir).loop.fixNonBlocking, true);

  // A run stored before the key existed resumes with it on.
  const { fixNonBlocking: _dropped, ...olderLoop } = DEFAULTS.loop;
  const older = { ...DEFAULTS, loop: olderLoop } as unknown as Config;
  assert.equal(withProjectFile(older, dir).loop.fixNonBlocking, true);

  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ loop: { fixNonBlocking: false } }));
  assert.equal(loadConfig(dir).loop.fixNonBlocking, false);
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ loop: { fixNonBlocking: 'yes' } }));
  assert.throws(() => loadConfig(dir), /loop\.fixNonBlocking must be true or false/);
});

// ---- across a stop ----------------------------------------------------------

test('a P3-only pass consumes its findings on the write that records them, so a stop cannot buy a fix', async () => {
  // What a process killed the moment the approval is recorded leaves on disk:
  // read at the instant `review_approved` is said, which is after its event is
  // saved and before anything after it runs.
  const state = reviewingRun(RUN);
  let onDisk: Record<string, unknown> | null = null;
  const realLog = console.log;
  const realError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  log.setSink((n) => {
    if (n.id !== 'review_approved') return;
    onDisk = JSON.parse(readFileSync(path.join(state.dir, 'state.json'), 'utf8')) as Record<string, unknown>;
  });
  try {
    await orchestrate(state, config({}, committing()), true, agents({ codex: () => report([p3('p3-a')]) }, []));
  } finally {
    log.setSink(null);
    console.log = realLog;
    console.error = realError;
  }

  const saved: Record<string, unknown> = onDisk ?? {};
  assert.ok(onDisk !== null, 'the approval was said');
  assert.equal(saved['pendingFindings'], null, 'nothing is left pending for a resume to fix');
  assert.ok(Array.isArray(saved['unaddressed']));
  assert.ok((saved['events'] as { type: string }[]).some((e) => e.type === 'review_approved'));
});

test('a resume over a repaired unaddressed record keeps FOLLOW-UPS.md rather than deleting it', async () => {
  const d = await review([p2('p2-a')], {
    fixer: [{ id: 'p2-a', disposition: 'rebutted', reason: 'already guarded' }],
  });
  const before = followUps(d.state);
  assert.match(before, /p2-a/);

  const file = path.join(d.state.dir, 'state.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  raw['unaddressed'] = 'not a list';
  writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');
  const loaded = loadRun(d.state.targetDir, d.state.id);
  assert.deepEqual(loaded.unaddressed, []);

  await drive(loaded, config({}, committing()), {
    resume: true,
    codex: () => assert.fail('a completed run is not reviewed again'),
  });
  assert.equal(followUps(loaded), before, 'the record is kept, not re-rendered from the repair');
});
