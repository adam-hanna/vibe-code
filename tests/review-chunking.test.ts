import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execute } from '@src/cli.js';
import { DEFAULTS } from '@src/config.js';
import { orchestrate } from '@src/orchestrator.js';
import {
  agents,
  BLOCKING,
  config,
  findingFixture,
  p1,
  report,
  reviewingRun,
  work,
} from './helpers/loop-harness.js';
import type { AgentTurns } from '@src/orchestrator.js';
import type { Config, Finding, RunState } from '@src/types.js';

/**
 * A change too large for one turn, driven through the real loop.
 *
 * The diffs here are real and really over the 400,000-character limit - no
 * test-only knob lowers it, because the figure is out of scope for #49 and a
 * config surface that exists for tests is production API that exists for tests.
 * Three ~200k files cost about half a megabyte of temp writes and a second of
 * wall clock, which is cheaper than the seam.
 *
 * `tests/diff-chunking.test.ts` covers the packer. What is asserted here is
 * everything the packer cannot see: that n turns still make ONE round, that the
 * reports merge, that the coverage record never claims more than a turn bought,
 * and that each part is told the truth about what it has and has not seen.
 */

/** Roughly `chars` of content, in lines, so the diff looks like a diff. */
function bulk(chars: number): string {
  const line = `${'x'.repeat(79)}\n`;
  return line.repeat(Math.ceil(chars / line.length));
}

/** A tree whose diff needs three reviewer turns at the real limit. */
function bigTree(state: RunState): void {
  for (const name of ['one.txt', 'two.txt', 'three.txt']) work(state, name, bulk(200_000));
}

/** A tree with one file too big to show whole, even on its own. */
function oversizedTree(state: RunState): void {
  work(state, 'huge.txt', bulk(500_000));
}

function reviewing(task: string): RunState {
  return reviewingRun({ prefix: 'vibe-chunked-', task });
}

/** Every `code-review-*.json` the run wrote, so "one artifact per round" is observable. */
function reviewArtifacts(state: RunState): string[] {
  return readdirSync(state.dir)
    .filter((f) => /^code-review-\d+\.json$/.test(f))
    .sort();
}

function artifactJson(state: RunState, name: string): {
  verdict: string;
  summary: string;
  findings: Finding[];
} {
  return JSON.parse(readFileSync(path.join(state.dir, name), 'utf8')) as {
    verdict: string;
    summary: string;
    findings: Finding[];
  };
}

/** Console output of one run, so a case can assert on what the `Done` block said. */
async function captureLog<T>(work: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]): void => {
    lines.push(parts.map((p) => String(p)).join(' '));
  };
  try {
    return { result: await work(), lines };
  } finally {
    console.log = original;
  }
}

/** `execute` around the real loop, with the preflight probe skipped. */
function run(state: RunState, cfg: Config, turns: AgentTurns): Promise<number> {
  return execute(state, cfg, true, true, () => Promise.resolve(null), (s, c, r) =>
    orchestrate(s, c, r, turns),
  );
}

test('a chunked round is one round, with one artifact, exactly like a single-turn round', async () => {
  // The paired control. Everything the loop counts must come out the same
  // whether the change took one turn to review or three: `reviewRound` is
  // advanced by the FIX round, not by the review, so a per-chunk increment
  // would show up here as a second artifact and a second p1Rounds entry.
  const small = reviewing('small');
  const smallCalls: string[] = [];
  work(small, 'small.txt', 'one line\n');
  await orchestrate(
    small,
    config(),
    true,
    agents({ codex: (label) => (label === 'review-0' ? report(BLOCKING) : report([])) }, smallCalls),
  );

  const big = reviewing('big');
  const bigCalls: string[] = [];
  bigTree(big);
  await orchestrate(
    big,
    config(),
    true,
    agents({ codex: (label) => (label.startsWith('review-0') ? report(BLOCKING) : report([])) }, bigCalls),
  );

  assert.deepEqual(smallCalls, ['review-0', 'fix-1', 'review-1']);
  assert.deepEqual(bigCalls, [
    'review-0-part1',
    'review-0-part2',
    'review-0-part3',
    'fix-1',
    'review-1-part1',
    'review-1-part2',
    'review-1-part3',
  ]);
  assert.equal(big.reviewRound, small.reviewRound);
  assert.equal(big.p1Rounds.length, small.p1Rounds.length);
  assert.deepEqual(reviewArtifacts(big), reviewArtifacts(small));
});

test('the parts merge into one report, and the artifact holds all of them', async () => {
  const state = reviewing('merge');
  bigTree(state);
  const perPart: Record<string, Finding[]> = {
    'review-0-part1': [findingFixture({ id: 'from-one' })],
    'review-0-part2': [findingFixture({ id: 'from-two' })],
    'review-0-part3': [findingFixture({ id: 'from-three' })],
  };

  await orchestrate(
    state,
    config(),
    true,
    agents({ codex: (label) => report(perPart[label] ?? []) }, []),
  );

  const found = artifactJson(state, 'code-review-0.json');
  assert.deepEqual(
    found.findings.map((f) => f.id).sort(),
    ['from-one', 'from-three', 'from-two'],
  );
  assert.deepEqual(reviewArtifacts(state), ['code-review-0.json']);
});

test('a duplicate id keeps the most blocking severity whichever part raised it', async () => {
  for (const order of [
    ['P2', 'P1'],
    ['P1', 'P2'],
  ] as const) {
    const state = reviewing(`severity-${order.join('-')}`);
    bigTree(state);
    const answers: Record<string, Finding[]> = {
      'review-0-part1': [findingFixture({ id: 'same-defect', severity: order[0] })],
      'review-0-part2': [findingFixture({ id: 'same-defect', severity: order[1] })],
    };

    await orchestrate(
      state,
      config({ maxReviewRounds: 9 }),
      true,
      agents(
        { codex: (label) => report(label.startsWith('review-0') ? (answers[label] ?? []) : []) },
        [],
      ),
    );

    const merged = artifactJson(state, 'code-review-0.json').findings;
    assert.equal(merged.length, 1, order.join(' then '));
    assert.equal(merged[0]?.severity, 'P1', order.join(' then '));
  }
});

test('a finding deferred in one part is not still deferred once it merges as a P1', async () => {
  // `parseFindings` strips `defer` from a P0/P1 per chunk, so a P2 deferral
  // merging with a P1 would otherwise arrive blocking AND deferred - an
  // invariant the boundary states and would then stop keeping.
  const state = reviewing('defer');
  bigTree(state);
  const answers: Record<string, Finding[]> = {
    'review-0-part1': [findingFixture({ id: 'both-ways', severity: 'P2', defer: true })],
    'review-0-part2': [p1('both-ways')],
  };

  await orchestrate(
    state,
    config({ maxReviewRounds: 9 }),
    true,
    agents(
      { codex: (label) => report(label.startsWith('review-0') ? (answers[label] ?? []) : []) },
      [],
    ),
  );

  const merged = artifactJson(state, 'code-review-0.json').findings;
  assert.equal(merged[0]?.severity, 'P1');
  assert.equal(merged[0]?.defer, false);
});

test('the merged verdict is REVISE if any part said so, and the summary names its parts', async () => {
  const state = reviewing('verdict');
  bigTree(state);
  const answers: Record<string, object> = {
    'review-0-part1': { verdict: 'APPROVE', summary: 'first looks fine', findings: [] },
    'review-0-part2': { verdict: 'REVISE', summary: 'second is suspicious', findings: [] },
    'review-0-part3': { verdict: 'APPROVE', summary: '', findings: [] },
  };

  await orchestrate(
    state,
    config(),
    true,
    agents({ codex: (label) => answers[label] ?? report([]) }, []),
  );

  const found = artifactJson(state, 'code-review-0.json');
  assert.equal(found.verdict, 'REVISE');
  assert.equal(found.summary, 'Part 1/3: first looks fine\n\nPart 2/3: second is suspicious');
});

test('every part approving is an APPROVE', async () => {
  const state = reviewing('approve');
  bigTree(state);

  await orchestrate(
    state,
    config(),
    true,
    agents({ codex: () => ({ verdict: 'APPROVE', summary: 'fine', findings: [] }) }, []),
  );

  assert.equal(artifactJson(state, 'code-review-0.json').verdict, 'APPROVE');
});

test('coverage names every file the parts were shown, and the split is recorded', async () => {
  const state = reviewing('coverage');
  bigTree(state);

  await orchestrate(state, config(), true, agents({ codex: () => report([]) }, []));

  assert.deepEqual(state.reviewCoverage?.files, ['one.txt', 'three.txt', 'two.txt']);
  assert.equal(state.reviewCoverage?.chunks, 3);
  assert.equal(state.reviewCoverage?.round, 1);
  assert.deepEqual(state.reviewCoverage?.truncated, []);

  const chunked = state.events.filter((e) => e.type === 'review_chunked');
  assert.equal(chunked.length, 1);
  assert.equal(chunked[0]?.['chunks'], 3);
  assert.equal(chunked[0]?.['files'], 3);
});

test('an ordinary round records its coverage too, and says nothing about chunking', async () => {
  const state = reviewing('ordinary');
  work(state, 'small.txt', 'one line\n');

  await orchestrate(state, config(), true, agents({ codex: () => report([]) }, []));

  assert.deepEqual(state.reviewCoverage, {
    round: 1,
    chunks: 1,
    files: ['small.txt'],
    truncated: [],
  });
  assert.equal(
    state.events.some((e) => e.type === 'review_chunked'),
    false,
  );
});

test('a round that dies part-way records only the parts it actually bought', async () => {
  const state = reviewing('partial');
  bigTree(state);

  await assert.rejects(() =>
    orchestrate(
      state,
      config(),
      true,
      agents(
        {
          codex: (label) => {
            if (label === 'review-0-part2') throw new Error('codex fell over');
            return report([]);
          },
        },
        [],
      ),
    ),
  );

  assert.deepEqual(state.reviewCoverage?.files, ['one.txt']);
  assert.equal(state.reviewCoverage?.chunks, 1);
});

test('a round whose first part dies claims no coverage at all', async () => {
  const state = reviewing('first-part-dies');
  bigTree(state);

  await assert.rejects(() =>
    orchestrate(
      state,
      config(),
      true,
      agents(
        {
          codex: (label) => {
            if (label === 'review-0-part1') throw new Error('codex fell over');
            return report([]);
          },
        },
        [],
      ),
    ),
  );

  assert.equal(state.reviewCoverage, undefined);
});

test('a report left by a previous process is dropped before the round is bought again', async () => {
  // Written between the artifact and `recordPendingFindings`, a report for a
  // round the resume is about to review from scratch describes nothing. With
  // several turns to a round the window is wide enough to matter.
  const state = reviewing('stale');
  bigTree(state);
  writeFileSync(
    path.join(state.dir, 'code-review-0.json'),
    JSON.stringify({ verdict: 'APPROVE', summary: 'from a process that died', findings: [] }),
    'utf8',
  );

  await assert.rejects(() =>
    orchestrate(
      state,
      config(),
      true,
      agents(
        {
          codex: (label) => {
            if (label === 'review-0-part1') throw new Error('codex fell over');
            return report([]);
          },
        },
        [],
      ),
    ),
  );

  assert.equal(existsSync(path.join(state.dir, 'code-review-0.json')), false);
});

test('a file too big for one turn is told to the reviewer, recorded, and said at the end', async () => {
  const state = reviewing('oversized');
  oversizedTree(state);
  const prompts: string[] = [];
  const calls: string[] = [];

  const { result: code, lines } = await captureLog(() =>
    run(
      state,
      config(),
      agents(
        {
          codex: (_label, options) => {
            prompts.push(options.prompt);
            return report([]);
          },
        },
        calls,
      ),
    ),
  );

  // One chunk, so the label and the turn count are what they always were.
  assert.deepEqual(calls, ['review-0']);
  assert.ok(prompts[0]?.includes('**The diff below is incomplete for `huge.txt`.**'));
  assert.equal(prompts[0]?.includes('## This is part'), false);
  assert.deepEqual(state.reviewCoverage?.truncated, ['huge.txt']);
  assert.ok(state.events.some((e) => e.type === 'review_file_truncated' && e['file'] === 'huge.txt'));
  assert.ok(
    lines.some((l) => l.includes('The last review saw a cut diff for `huge.txt`')),
    lines.join('\n'),
  );
  // Recorded and reported, but not a new exit rule: the review is not incomplete
  // in the sense the exit code speaks about.
  assert.equal(code, 0);
});

test('the Done block reports a chunked round once, and says nothing about an ordinary one', async () => {
  const big = reviewing('done-chunked');
  bigTree(big);
  const { lines: chunkedLines } = await captureLog(() =>
    run(big, config(), agents({ codex: () => report([]) }, [])),
  );
  const said = chunkedLines.filter((l) => l.includes('ran in 3 parts'));
  assert.equal(said.length, 1, chunkedLines.join('\n'));
  assert.ok(said[0]?.includes('over 3 file(s)'));

  const small = reviewing('done-small');
  work(small, 'small.txt', 'one line\n');
  const { lines: smallLines } = await captureLog(() =>
    run(small, config(), agents({ codex: () => report([]) }, [])),
  );
  assert.equal(
    smallLines.some((l) => l.includes('parts over')),
    false,
  );
});

test('a review under the limit is one turn with no part note of any kind', async () => {
  const state = reviewing('unchunked');
  work(state, 'small.txt', 'one line\n');
  const prompts: string[] = [];
  const calls: string[] = [];

  await orchestrate(
    state,
    config(),
    true,
    agents(
      {
        codex: (_label, options) => {
          prompts.push(options.prompt);
          return report([]);
        },
      },
      calls,
    ),
  );

  assert.deepEqual(calls, ['review-0']);
  assert.equal(prompts[0]?.includes('This is part'), false);
  assert.equal(prompts[0]?.includes('The diff below is incomplete'), false);
});

test('part 1 of a later round is not told it has already seen the other parts', async () => {
  // The slot's memory is a lifetime fact: by round 2 the reviewer thread does
  // remember round 1. It has still never seen round 2's other parts, so keying
  // the "you already saw them" wording on that memory would tell part 1 to stay
  // quiet about a diff it has not been handed.
  const state = reviewing('second-round');
  bigTree(state);
  const prompts = new Map<string, string>();

  await orchestrate(
    state,
    config(),
    true,
    agents(
      {
        codex: (label, options) => {
          prompts.set(label, options.prompt);
          return label.startsWith('review-0') ? report(BLOCKING) : report([]);
        },
      },
      [],
    ),
  );

  const NOT_SEEN = '**You have not been shown the other parts of this round**';
  const SEEN = 'shown to you earlier in this conversation';

  assert.ok(prompts.get('review-1-part1')?.includes(NOT_SEEN), 'part 1 of round 2');
  assert.equal(prompts.get('review-1-part1')?.includes(SEEN), false);
  assert.ok(prompts.get('review-1-part2')?.includes(SEEN), 'part 2 of round 2');
  assert.ok(prompts.get('review-1-part3')?.includes(SEEN), 'part 3 of round 2');
  // The round-level continuity note is a separate question and still fires: by
  // round 2 the thread really does remember round 1.
  assert.ok(prompts.get('review-1-part1')?.includes('This is review round 2'));
  assert.ok(prompts.get('review-1-part1')?.includes('you have your previous findings in context'));
});

test('with no persistent thread every part is told it has seen nothing, and so is the round', async () => {
  const state = reviewing('one-shot');
  bigTree(state);
  const prompts: string[] = [];
  const threads: (string | null)[] = [];

  await orchestrate(
    state,
    config({}, { codex: { ...DEFAULTS.codex, readRateLimits: false, persistSession: false } }),
    true,
    agents(
      {
        codex: (label, options) => {
          prompts.push(options.prompt);
          threads.push(options.sessionId ?? null);
          return label.startsWith('review-0') ? report(BLOCKING) : report([]);
        },
      },
      [],
    ),
  );

  for (const prompt of prompts) {
    assert.ok(prompt.includes('**You have not been shown the other parts of this round**'));
    assert.equal(prompt.includes('shown to you earlier in this conversation'), false);
    assert.equal(prompt.includes('quoted below'), false);
    assert.equal(prompt.includes('re-litigate'), false);
  }
  // The round-level note is honest too: a fresh conversation does not have the
  // earlier rounds' findings, and must not be told to hold its tongue about them.
  const secondRound = prompts.filter((p) => p.includes('This is review round 2'));
  assert.ok(secondRound.length > 0);
  for (const prompt of secondRound) {
    assert.ok(prompt.includes('**you do not have those findings**'));
  }
  // Nothing was resumed, which is what makes the wording above true.
  assert.deepEqual(new Set(threads), new Set([null]));
});
