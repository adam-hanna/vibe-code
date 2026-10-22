import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import * as log from '@src/log.js';
import { orchestrate } from '@src/orchestrator.js';
import { loadRun } from '@src/run.js';
import {
  agents,
  committing,
  config,
  freshRun,
  p1,
  planFixture,
  report,
  reviewingRun,
  work,
} from './helpers/loop-harness.js';
import { sh, shaOf } from './helpers/base-repo.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { Narration } from '@src/log.js';
import type { Config, Evidence, Finding, ReviewConfig, RunState } from '@src/types.js';

/**
 * The repository's REVIEW.md through the real loop (#389): read from the commit
 * the run started at, handed to the reviewer, every finder and every verifier
 * alike, settled once per run per process, and checked by blob on a resume.
 *
 * Agents are injected; git is real, because "the commit held this text and the
 * working tree held that one" is something only git can be asked.
 */

const HEADING = "## This repository's review standards (REVIEW.md)";
const START_TEXT = '# Standards\n\n- Inventing a number is a P1.\n';
const EDITED_TEXT = '# Standards\n\n- Anything goes.\n';
const HERE: Evidence = { kind: 'code', path: 'implemented.ts', line: 1 };

interface Driven {
  prompts: Map<string, string>;
  seen: Narration[];
  calls: string[];
}

async function drive(state: RunState, cfg: Config, handlers: Handlers, resume = true): Promise<Driven> {
  const prompts = new Map<string, string>();
  const seen: Narration[] = [];
  const calls: string[] = [];
  const wrapped: Handlers = {
    ...handlers,
    claude: (label, options) => {
      prompts.set(label, options.prompt);
      return handlers.claude?.(label, options) ?? work(state, `${label}.txt`);
    },
    codex: (label, options) => {
      prompts.set(label, options.prompt);
      return handlers.codex?.(label, options) ?? report([]);
    },
  };
  const realLog = console.log;
  const realError = console.error;
  log.setSink((n) => void seen.push(n));
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(state, cfg, resume, agents(wrapped, calls));
  } finally {
    log.setSink(null);
    console.log = realLog;
    console.error = realError;
  }
  return { prompts, seen, calls };
}

function commitAll(dir: string, message: string): string {
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', message);
  return shaOf(dir, 'HEAD');
}

/**
 * A run parked at review whose start commit holds `START_TEXT` as REVIEW.md,
 * and whose implement round then committed an EDITED REVIEW.md beside its work.
 */
function parked(prefix: string): { state: RunState; start: string } {
  const state = reviewingRun({ prefix, commit: true, change: false });
  writeFileSync(path.join(state.targetDir, 'REVIEW.md'), START_TEXT, 'utf8');
  const start = commitAll(state.targetDir, 'standards');
  state.start = { sha: start, ref: null };
  state.baseSha = start;
  work(state, 'implemented.ts', 'export const implemented = true;\n');
  writeFileSync(path.join(state.targetDir, 'REVIEW.md'), EDITED_TEXT, 'utf8');
  commitAll(state.targetDir, 'the round');
  return { state, start };
}

function withReview(review: Partial<ReviewConfig>): Config {
  return config({ p1Tolerance: 0 }, { review: { ...DEFAULTS.review, ...review } });
}

/** The REVIEW.md section of a prompt, up to the next `## ` heading after its text. */
function section(prompt: string | undefined): string | null {
  if (prompt === undefined) return null;
  const at = prompt.indexOf(HEADING);
  if (at === -1) return null;
  const end = prompt.indexOf('\n## ', at + HEADING.length);
  return prompt.slice(at, end === -1 ? undefined : end);
}

const ids = (seen: readonly Narration[], id: string): Narration[] => seen.filter((n) => n.id === id);

test('the start commit\'s REVIEW.md reaches the reviewer and every finder, not the run\'s own edit', async () => {
  const { state, start } = parked('vibe-review-md-start-');
  const { prompts, seen } = await drive(state, withReview({ finders: ['codex'] }), {});

  const first = section(prompts.get('review-0'));
  const finder = section(prompts.get('review-0-f1'));
  assert.ok(first !== null, 'the reviewer was not given REVIEW.md');
  assert.ok(first.includes(START_TEXT));
  assert.ok(first.includes(`\`${start.slice(0, 7)}\``));
  assert.ok(!first.includes('Anything goes'), "the run's own edit reached its own review");
  // Through `reviewPromptFor`, so the two cannot differ.
  assert.equal(finder, first);

  // The edit is a judge file: listed for a verdict, and recorded.
  assert.match(prompts.get('review-0') ?? '', /## Changes to the judge[\s\S]*`REVIEW\.md` - modified/);
  assert.ok(state.testChanges?.files.some((f) => f.path === 'REVIEW.md'));

  // Recorded once, with its narration, and both on disk.
  assert.equal(ids(seen, 'review_md').length, 1);
  const blob = sh(state.targetDir, 'rev-parse', `${start}:REVIEW.md`);
  const expected = { commit: start, outcome: 'present', blob, bytes: Buffer.byteLength(START_TEXT) };
  assert.deepEqual(state.reviewMd, expected);
  const stored = loadRun(state.targetDir, state.id);
  assert.deepEqual(stored.reviewMd, expected);
  assert.equal(stored.events.filter((e) => e.type === 'review_md').length, 1);
});

test('a verifier is given the same REVIEW.md, with its own severity sentence', async () => {
  const { state } = parked('vibe-review-md-vote-');
  const claim: Finding = { ...p1('the-claim'), evidence: [HERE] };
  const { prompts } = await drive(state, withReview({ verifiers: ['codex'] }), {
    codex: (label) =>
      label.startsWith('vote-')
        ? { vote: 'real', reason: 'It is there.', evidence: [] }
        : label === 'review-0'
          ? report([claim])
          : report([]),
    claude: (label) => work(state, `${label}.txt`),
  });
  const vote = [...prompts.entries()].find(([label]) => label.startsWith('vote-'));
  assert.ok(vote !== undefined, `no vote turn ran: ${[...prompts.keys()].join(', ')}`);
  const got = section(vote[1]);
  assert.ok(got !== null && got.includes(START_TEXT), 'the verifier was not given REVIEW.md');
  assert.match(got, /severity rules in it are not your question/);
});

test('read once per process: a later round reuses the first answer and narrates nothing', async () => {
  const { state } = parked('vibe-review-md-once-');
  const claim: Finding = { ...p1('fix-me'), evidence: [HERE] };
  const { prompts, seen } = await drive(state, withReview({}), {
    codex: (label) => (label === 'review-0' ? report([claim]) : report([])),
    claude: (label) => {
      // Between the two review rounds, make the record disagree with the
      // repository. A re-read would now see a mismatch and send nothing; the
      // settled answer must be what round two gets.
      if (state.reviewMd !== undefined) state.reviewMd = { ...state.reviewMd, blob: 'a'.repeat(40) };
      return work(state, `${label}.txt`);
    },
  });

  assert.ok(prompts.has('review-1'), `no second review round: ${[...prompts.keys()].join(', ')}`);
  assert.equal(section(prompts.get('review-1')), section(prompts.get('review-0')));
  assert.ok(section(prompts.get('review-1')) !== null);
  assert.equal(ids(seen, 'review_md').length, 1);
  assert.equal(ids(seen, 'review_md_mismatch').length, 0);
});

test('a resume reads the same blob; a record that disagrees with the repository sends nothing', async () => {
  const { state, start } = parked('vibe-review-md-resume-');
  await drive(state, withReview({}), {});
  const blob = state.reviewMd?.blob;
  assert.ok(blob !== undefined);

  // A new process: the state comes back from disk.
  const resumed = loadRun(state.targetDir, state.id);
  resumed.phase = 'reviewing';
  const again = await drive(resumed, withReview({}), {});
  const round = `review-${resumed.reviewRound}`;
  const label = [...again.prompts.keys()].find((l) => l.startsWith('review-'));
  assert.ok(label !== undefined, `no review turn after the resume (${round})`);
  assert.ok(section(again.prompts.get(label))?.includes(START_TEXT));
  assert.equal(resumed.reviewMd?.blob, blob);
  assert.equal(ids(again.seen, 'review_md').length, 0, 'a resume does not narrate the first read again');

  // The record tampered with: it now names a blob the start commit does not hold.
  const tampered = loadRun(state.targetDir, state.id);
  tampered.phase = 'reviewing';
  tampered.reviewMd = { commit: start, outcome: 'present', blob: 'b'.repeat(40), bytes: 1 };
  const failed = await drive(tampered, withReview({}), {});
  const shown = [...failed.prompts.entries()].filter(([l]) => l.startsWith('review-'));
  assert.ok(shown.length > 0);
  for (const [, prompt] of shown) assert.equal(section(prompt), null);
  assert.equal(ids(failed.seen, 'review_md_mismatch').length, 1);
  assert.equal(tampered.reviewMd?.outcome, 'unreadable');
  assert.match(tampered.reviewMd?.reason ?? '', /no longer matches/);
});

test('no role but the review seats is given REVIEW.md, across a full loop with a fix round', async () => {
  const state = freshRun({ prefix: 'vibe-review-md-roles-', task: 'roles', planOnly: false, git: true, commit: true });
  writeFileSync(path.join(state.targetDir, 'REVIEW.md'), START_TEXT, 'utf8');
  commitAll(state.targetDir, 'standards');
  let reviews = 0;
  const { prompts } = await drive(
    state,
    config({ p1Tolerance: 0 }, committing()),
    {
      claude: (label) =>
        label === 'plan' || label.startsWith('revise-') ? planFixture() : work(state, `${label}.txt`),
      codex: (label) => {
        if (!label.startsWith('review-')) return report([]);
        reviews += 1;
        return reviews === 1 ? report([{ ...p1('fix-me'), evidence: [{ kind: 'external', ref: 'fixture' }] }]) : report([]);
      },
    },
    false,
  );

  const review = [...prompts.entries()].filter(([l]) => l.startsWith('review-'));
  assert.ok(review.length >= 2, `expected two review rounds: ${[...prompts.keys()].join(', ')}`);
  for (const [, prompt] of review) assert.ok(prompt.includes(HEADING));
  const others = [...prompts.entries()].filter(([l]) => !l.startsWith('review-') && !l.startsWith('vote-'));
  // The planner, the critic, the implementer and the fixer all ran.
  assert.ok(others.length >= 4, `too few other turns: ${others.map(([l]) => l).join(', ')}`);
  for (const [label, prompt] of others) assert.ok(!prompt.includes(HEADING), `${label} was given REVIEW.md`);
});
