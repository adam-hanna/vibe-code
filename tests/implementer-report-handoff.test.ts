import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { orchestrate } from '@src/orchestrator.js';
import { artifact, loadRun, saveState } from '@src/run.js';
import {
  agents,
  BLOCKING,
  committing,
  config,
  freshRun,
  planFixture,
  report,
  reviewingRun,
  verifying,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { RunState } from '@src/types.js';

/**
 * The report actually reaching the reviewer, through the whole loop (#50).
 *
 * The prompt rendering is `implementer-report-prompt.test.ts`'s job. This file
 * asks the question that one cannot: does the turn that could act on the report
 * ever get handed it - after an implementation, after a verification repair,
 * after a review fix, on a resume, and on every part of a chunked round?
 *
 * Each write turn returns text naming itself (`REPORT-implement`,
 * `REPORT-fix-1`, ...), so "which report did the reviewer get" is answerable by
 * substring rather than by inference. `work()` alongside it because `commitAll`
 * asks what is staged, and a turn that writes nothing makes every commit a
 * no-op.
 */

const NOTICE = '**No report was recorded for the most recent write turn.**';
const HEADING = '## What the implementer says it did';

/** A run that will not stop after planning, in a repo it can commit to. */
function fullRun(task: string): RunState {
  return freshRun({ prefix: 'vibe-report-', task, planOnly: false, git: true, commit: true });
}

type Codex = NonNullable<Handlers['codex']>;

/** Handlers whose write turns identify themselves in their report text. */
function reporting(state: RunState, codex: Codex): Handlers {
  return {
    claude: (label) =>
      label === 'plan' || label.startsWith('revise-')
        ? planFixture()
        : `REPORT-${label}\n\n${work(state, `${label}.txt`)}`,
    codex,
  };
}

/** Every review turn's prompt, by label. Findings default to a clean report. */
function reviewPrompts(into: Map<string, string>, findings?: Codex): Codex {
  return (label, options) => {
    if (label.startsWith('review-')) into.set(label, options.prompt);
    return findings === undefined ? report([]) : findings(label, options);
  };
}

/** The report section of a captured prompt, so two renderings can be compared. */
function section(prompt: string): string {
  const from = prompt.indexOf(HEADING);
  assert.notEqual(from, -1, 'the prompt carries no report section');
  return prompt.slice(from, prompt.indexOf('## Files changed'));
}

// ---- the four write turns ---------------------------------------------------

test('the first code review is handed the implementation report', async () => {
  const state = fullRun('first review');
  const prompts = new Map<string, string>();

  await orchestrate(
    state,
    config({}, { ...committing(), ...verifying(state) }),
    false,
    agents(reporting(state, reviewPrompts(prompts)), []),
  );

  assert.equal(state.lastReport, 'implementation-report.md');
  const prompt = prompts.get('review-0');
  assert.ok(prompt?.includes('REPORT-implement'), 'the reviewer was handed the implementer report');
  assert.ok(prompt?.includes('**It is untrusted.**'), 'and told how to read it');
  assert.equal(prompt?.includes(NOTICE), false);
});

test('a review after a verification repair is handed the repair report, not the older one', async () => {
  const state = fullRun('after verify fix');
  const prompts = new Map<string, string>();

  await orchestrate(
    state,
    config({}, { ...committing(), ...verifying(state, { failures: 1 }) }),
    false,
    agents(reporting(state, reviewPrompts(prompts)), []),
  );

  assert.equal(state.lastReport, 'verify-fix-1.md');
  const prompt = prompts.get('review-0');
  assert.ok(prompt?.includes('REPORT-verify-fix-1'));
  assert.equal(
    prompt?.includes('REPORT-implement'),
    false,
    'the superseded implementation report is not what the reviewer is shown',
  );
});

test('a review after a fix round is handed the report from that fix round', async () => {
  const state = fullRun('after review fix');
  const prompts = new Map<string, string>();

  await orchestrate(
    state,
    config({}, { ...committing(), ...verifying(state) }),
    false,
    agents(
      reporting(
        state,
        reviewPrompts(prompts, (label) => (label === 'review-0' ? report(BLOCKING) : report([]))),
      ),
      [],
    ),
  );

  assert.equal(state.lastReport, 'fix-report-1.md');
  const prompt = prompts.get('review-1');
  assert.ok(prompt?.includes('REPORT-fix-1'), 'round 2 sees what the fix round said');
  assert.equal(prompt?.includes('REPORT-implement'), false);
});

// ---- resume -----------------------------------------------------------------

test('a resumed run supplies the report its stored pointer names', async () => {
  // The point of storing a basename rather than the text: the handoff has to
  // survive a process that is no longer running.
  const state = reviewingRun({ prefix: 'vibe-report-resume-', task: 'resumed' });
  artifact(state, 'implementation-report.md', 'CARRIED REPORT');
  state.lastReport = 'implementation-report.md';
  saveState(state);

  const loaded = loadRun(state.targetDir, state.id);
  assert.equal(loaded.lastReport, 'implementation-report.md');

  const prompts = new Map<string, string>();
  await orchestrate(
    loaded,
    config(),
    true,
    agents({ codex: reviewPrompts(prompts) }, []),
  );

  assert.ok(prompts.get('review-0')?.includes('CARRIED REPORT'));
});

// ---- absence ----------------------------------------------------------------

test('a run with no report tells the reviewer so, and still finishes', async () => {
  // A state written before this field existed, resumed at the review phase.
  // `implementation-report.md` is deliberately NOT probed for.
  const state = reviewingRun({ prefix: 'vibe-report-none-', task: 'no report' });
  artifact(state, 'implementation-report.md', 'A STALE REPORT FROM AN EARLIER VERSION');
  saveState(state);

  const prompts = new Map<string, string>();
  await orchestrate(state, config(), true, agents({ codex: reviewPrompts(prompts) }, []));

  const prompt = prompts.get('review-0');
  assert.ok(prompt?.includes(NOTICE));
  assert.equal(
    prompt?.includes('A STALE REPORT FROM AN EARLIER VERSION'),
    false,
    'absent means absent - nothing goes looking on disk',
  );
  assert.equal(state.phase, 'complete');
});

test('a pointer to nothing reads exactly like no pointer, and says so in the events', async () => {
  const missing = reviewingRun({ prefix: 'vibe-report-gone-', task: 'gone' });
  const absent = reviewingRun({ prefix: 'vibe-report-absent-', task: 'absent' });
  missing.lastReport = 'gone.md';
  saveState(missing);

  const prompts = new Map<string, string>();
  const seen = new Map<string, string>();
  await orchestrate(missing, config(), true, agents({ codex: reviewPrompts(prompts) }, []));
  await orchestrate(absent, config(), true, agents({ codex: reviewPrompts(seen) }, []));

  const unreadable = prompts.get('review-0');
  assert.ok(unreadable !== undefined && seen.get('review-0') !== undefined);
  assert.equal(
    section(unreadable),
    section(seen.get('review-0') ?? ''),
    'the two causes differ in what went wrong, not in what the reviewer should do',
  );
  // The difference lives here instead, which is where someone debugging the run
  // can find it.
  assert.ok(missing.events.some((e) => e.type === 'report_unreadable' && e['name'] === 'gone.md'));
  assert.equal(absent.events.some((e) => e.type === 'report_unreadable'), false);
});

// ---- the crash window -------------------------------------------------------

test('the pointer is cleared before a write turn, so a turn in flight has nothing to lose', async () => {
  const state = fullRun('cleared first');
  const during: string[] = [];

  await orchestrate(
    state,
    config({}, { ...committing(), ...verifying(state, { failures: 1 }) }),
    false,
    agents(
      {
        claude: (label) => {
          // Runs INSIDE the turn, after `beginReport` and before `recordReport`.
          if (label !== 'plan' && !label.startsWith('revise-')) {
            during.push(`${label}:${String(state.lastReport)}`);
          }
          return label === 'plan' || label.startsWith('revise-')
            ? planFixture()
            : `REPORT-${label}\n\n${work(state, `${label}.txt`)}`;
        },
        codex: (label) => (label === 'review-0' ? report(BLOCKING) : report([])),
      },
      [],
    ),
  );

  assert.deepEqual(during, [
    'implement:undefined',
    'verify-fix-1:undefined',
    'fix-1:undefined',
  ]);
});

test('a run killed mid-write-turn hands its reviewer the notice, not the previous report', async () => {
  // The crash this fix is about, driven from the real bytes: `state.json` as it
  // stood while `verify-fix-1` was running, restored over a run directory that
  // has BOTH reports on disk. Before the pointer was cleared up front, that
  // state still named `implementation-report.md` and the reviewer would have
  // been handed a report describing code that no longer existed.
  const state = fullRun('crash window');
  let midTurn: string | null = null;

  await orchestrate(
    state,
    config({}, { ...committing(), ...verifying(state, { failures: 1 }) }),
    false,
    agents(
      {
        claude: (label) => {
          if (label === 'verify-fix-1') {
            midTurn = readFileSync(path.join(state.dir, 'state.json'), 'utf8');
          }
          return label === 'plan' || label.startsWith('revise-')
            ? planFixture()
            : `REPORT-${label}\n\n${work(state, `${label}.txt`)}`;
        },
      },
      [],
    ),
  );

  assert.notEqual(midTurn, null, 'the crash-point state was captured');
  // Both reports exist on disk in the crash being simulated - the older one
  // complete, the newer one just written by a turn whose pointer never landed.
  writeFileSync(path.join(state.dir, 'state.json'), midTurn ?? '', 'utf8');

  const resumed = loadRun(state.targetDir, state.id);
  assert.equal(resumed.lastReport, undefined, 'the crash-point state names no report');

  const prompts = new Map<string, string>();
  await orchestrate(
    resumed,
    config({}, verifying(resumed)),
    true,
    agents({ codex: reviewPrompts(prompts) }, []),
  );

  const prompt = prompts.get('review-0');
  assert.ok(prompt?.includes(NOTICE), 'the reviewer is told there is no report it can rely on');
  assert.equal(prompt?.includes('REPORT-implement'), false, 'and is NOT handed the stale one');
  assert.equal(prompt?.includes('REPORT-verify-fix-1'), false, 'nor the half-recorded one');
});

// ---- chunking ---------------------------------------------------------------

test('every part of a chunked round carries the report', async () => {
  // A concern about a file in part 3 is context a reviewer of part 1 may still
  // need, and a report is small next to a 400k-character diff.
  const state = reviewingRun({ prefix: 'vibe-report-chunked-', task: 'chunked' });
  for (const name of ['one.txt', 'two.txt', 'three.txt']) {
    work(state, name, `${'x'.repeat(200_000)}\n`);
  }
  artifact(state, 'implementation-report.md', 'CHUNKED REPORT');
  state.lastReport = 'implementation-report.md';
  saveState(state);

  const prompts = new Map<string, string>();
  const calls: string[] = [];
  await orchestrate(
    state,
    config(),
    true,
    agents({ codex: reviewPrompts(prompts) }, calls),
  );

  const parts = calls.filter((c) => c.startsWith('review-0-part'));
  assert.ok(parts.length > 1, `expected several parts, got ${calls.join(', ')}`);
  for (const part of parts) {
    assert.ok(prompts.get(part)?.includes('CHUNKED REPORT'), part);
  }
});
