import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orchestrate } from '@src/orchestrator.js';
import { artifact as writeArtifact } from '@src/run.js';
import { reviewPrompt, withFocus } from '@src/prompts.js';
import { readFinders } from '@src/roles.js';
import {
  DEFAULT_FINDER_FOCUS,
  DEFAULTS,
  defaultReviewFinders,
  loadConfig,
  storedConfig,
} from '@src/config.js';
import { agents, config, p1, report, reviewingRun, work } from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import { CRITERIA, DIFF, FILES, OUT_OF_SCOPE, PLAN_MD } from './helpers/prompt-fixture-args.js';
import type { Config, Finding, ReviewConfig, RunState } from '@src/types.js';

/**
 * A review finder seated without the implementer's report (#497, groundwork).
 *
 * `review.finders[k].report: false` is the one opt-in difference between a
 * finder and a memoryless reviewer, beyond its focus. The seat's prompt is the
 * one it would have had, minus the `## What the implementer says it did`
 * section, and with nothing in its place: not the "No report was recorded"
 * notice, which says the run lost something when nothing was lost. Everything
 * else stays, and no seat that does not set the key changes a byte.
 */

const HEADING = '## What the implementer says it did';
const NOTICE = '**No report was recorded for the most recent write turn.**';
const REPORT = 'BLIND-CASE REPORT: changed implemented.ts, verified by hand.';
const FOCUS = 'error handling';

/**
 * The prompt with its report section cut out: from the heading up to the next
 * `## ` heading. `reportSection` opens with a newline and closes with one, and
 * whatever follows it opens with `\n## `, so this is exactly the section's bytes.
 */
function withoutSection(prompt: string): string {
  const start = prompt.indexOf(`\n${HEADING}`);
  assert.ok(start >= 0, 'the prompt has no report section to remove');
  const end = prompt.indexOf('\n## ', start + 1);
  assert.ok(end > start, 'the report section is not followed by a heading');
  return prompt.slice(0, start) + prompt.slice(end);
}

function fixturePrompt(report: string | null | undefined): string {
  return reviewPrompt(DIFF, FILES, PLAN_MD, OUT_OF_SCOPE, 1, false, undefined, undefined, CRITERIA, undefined, report);
}

function withReview(review: Partial<ReviewConfig>): Config {
  return config({ p1Tolerance: 0 }, { review: { ...DEFAULTS.review, ...review } });
}

/** Run the loop, keeping every prompt by its turn's label. */
async function drive(
  state: RunState,
  cfg: Config,
  handlers: Handlers = {},
): Promise<{ calls: string[]; prompts: Map<string, string> }> {
  const calls: string[] = [];
  const prompts = new Map<string, string>();
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
  await orchestrate(state, cfg, true, agents(wrapped, calls));
  return { calls, prompts };
}

function prompt(prompts: Map<string, string>, label: string): string {
  const got = prompts.get(label);
  assert.ok(got !== undefined, `no turn labelled ${label}; saw ${[...prompts.keys()].join(', ')}`);
  return got;
}

/** A run under review whose last write turn recorded a report. */
function reportedRun(prefix: string, change = true): RunState {
  const state = reviewingRun({ prefix, change });
  writeArtifact(state, 'implementation-report.md', REPORT);
  state.lastReport = 'implementation-report.md';
  return state;
}

function project(contents: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibe-finder-blind-config-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), `${JSON.stringify(contents, null, 2)}\n`);
  return dir;
}

/** A tree whose diff needs several reviewer turns at the real 400k limit. */
function bigTree(state: RunState): void {
  const line = `${'x'.repeat(79)}\n`;
  for (const name of ['one.txt', 'two.txt', 'three.txt']) {
    work(state, name, line.repeat(Math.ceil(200_000 / line.length)));
  }
}

const blindAndOrdinary = {
  finders: [
    { provider: 'codex' as const, focus: FOCUS, report: false },
    { provider: 'codex' as const, focus: FOCUS },
  ],
};

// ---- the prompt -------------------------------------------------------------

test('an undefined report is the reported prompt with the section cut, and no notice', () => {
  const blind = fixturePrompt(undefined);
  assert.equal(withoutSection(fixturePrompt(REPORT)), blind);
  assert.equal(withoutSection(fixturePrompt(null)), blind, 'the notice is cut the same way');
  assert.equal(blind.includes(HEADING), false);
  assert.equal(blind.includes(NOTICE), false);
  assert.equal(blind.includes('No report was recorded'), false);
});

// ---- the loop ---------------------------------------------------------------

test('a round with a report: only the blinded finder loses the section', async () => {
  const state = reportedRun('vibe-finder-blind-report-');
  const { prompts } = await drive(state, withReview(blindAndOrdinary));
  const reviewer = prompt(prompts, 'review-0');
  const blind = prompt(prompts, 'review-0-f1');
  const ordinary = prompt(prompts, 'review-0-f2');

  for (const seen of [reviewer, ordinary]) {
    assert.ok(seen.includes(HEADING));
    assert.ok(seen.includes(REPORT));
  }
  assert.equal(blind.includes(HEADING), false);
  assert.equal(blind.includes(REPORT), false);
  assert.equal(blind.includes(NOTICE), false);
  assert.equal(blind, withoutSection(ordinary), 'the same seat, minus the section and nothing else');
  assert.equal(ordinary, withFocus(reviewer, FOCUS), 'the ordinary finder is unchanged');
  assert.ok(blind.endsWith(`## Focus for this review\n\n${FOCUS}`), 'the focus still comes last');
});

test('a round whose report is missing: the others get the notice, the blinded seat nothing', async () => {
  const state = reviewingRun({ prefix: 'vibe-finder-blind-missing-' });
  const { prompts } = await drive(state, withReview(blindAndOrdinary));
  const blind = prompt(prompts, 'review-0-f1');
  const ordinary = prompt(prompts, 'review-0-f2');

  assert.ok(prompt(prompts, 'review-0').includes(NOTICE));
  assert.ok(ordinary.includes(NOTICE));
  assert.equal(blind.includes(HEADING), false);
  assert.equal(blind.includes(NOTICE), false);
  assert.equal(blind, withoutSection(ordinary));
});

test('a chunked round drops the section from every part of the blinded finder', async () => {
  const state = reportedRun('vibe-finder-blind-chunked-', false);
  bigTree(state);
  const { calls, prompts } = await drive(state, withReview(blindAndOrdinary));
  const review = calls.filter((l) => l.startsWith('review-0'));
  const parts = review.filter((l) => /^review-0-part\d+$/.test(l)).length;
  assert.ok(parts > 1, `the diff was not chunked: ${review.join(', ')}`);
  assert.deepEqual(review, [
    ...Array.from({ length: parts }, (_, i) => `review-0-part${i + 1}`),
    ...Array.from({ length: parts }, (_, i) => `review-0-f1-part${i + 1}`),
    ...Array.from({ length: parts }, (_, i) => `review-0-f2-part${i + 1}`),
  ]);
  for (let i = 1; i <= parts; i++) {
    const blind = prompt(prompts, `review-0-f1-part${i}`);
    const ordinary = prompt(prompts, `review-0-f2-part${i}`);
    assert.ok(prompt(prompts, `review-0-part${i}`).includes(REPORT), `reviewer part ${i}`);
    assert.ok(ordinary.includes(REPORT), `ordinary finder part ${i}`);
    assert.equal(blind.includes(HEADING), false, `blinded finder part ${i}`);
    assert.equal(blind, withoutSection(ordinary), `blinded finder part ${i}`);
  }
});

test('report: true renders exactly as no report key', async () => {
  const state = reportedRun('vibe-finder-blind-true-');
  const { prompts } = await drive(
    state,
    withReview({
      finders: [
        { provider: 'codex', focus: FOCUS, report: true },
        { provider: 'codex', focus: FOCUS },
      ],
    }),
  );
  const explicit = prompt(prompts, 'review-0-f1');
  assert.ok(explicit.includes(REPORT));
  assert.equal(explicit, prompt(prompts, 'review-0-f2'));
});

test('the default finder carries no report key, and its prompt is the reviewer\'s plus its focus', async () => {
  const finders = defaultReviewFinders(DEFAULTS.roles);
  assert.equal(finders.length, 1);
  assert.equal(finders.some((f) => Object.hasOwn(f, 'report')), false);

  const state = reportedRun('vibe-finder-blind-default-');
  const { prompts } = await drive(state, withReview({ finders }), {
    claude: (label) => (label.startsWith('review-') ? report([]) : undefined),
  });
  const finder = prompt(prompts, 'review-0-f1');
  assert.ok(finder.includes(REPORT));
  assert.equal(finder, withFocus(prompt(prompts, 'review-0'), DEFAULT_FINDER_FOCUS));

  // As a run stores it: the resolved default, with no key added.
  const loaded = loadConfig(project({}));
  assert.equal(loaded.findersDefaulted, true);
  const stored = storedConfig(loaded).review.finders;
  assert.deepEqual(stored, finders);
  assert.equal(JSON.stringify(stored).includes('report'), false);
});

test('a blinded and an ordinary finder: both seats\' findings are kept and attributed as today', async () => {
  const blindFinding: Finding = { ...p1('only-blind'), title: 'The cache is never invalidated on write' };
  const ordinaryFinding: Finding = { ...p1('only-ordinary'), title: 'An empty input crashes the parser' };
  const handlers: Handlers = {
    codex: (label) => {
      if (label === 'review-0-f1') return report([blindFinding]);
      if (label === 'review-0-f2') return report([ordinaryFinding]);
      return report([]);
    },
  };
  const blinded = reportedRun('vibe-finder-blind-foundby-');
  await drive(blinded, withReview(blindAndOrdinary), handlers);
  const control = reportedRun('vibe-finder-blind-control-');
  await drive(control, withReview({ finders: [blindAndOrdinary.finders[1]!, blindAndOrdinary.finders[1]!] }), handlers);

  const findings = (state: RunState): Finding[] =>
    (JSON.parse(readFileSync(path.join(state.dir, 'code-review-0.json'), 'utf8')) as { findings: Finding[] })
      .findings;
  const byId = (state: RunState, id: string): Finding | undefined => findings(state).find((f) => f.id === id);

  assert.deepEqual(byId(blinded, 'only-blind')?.foundBy, [
    { seat: 'review.finders[0]', provider: 'codex', model: 'default', id: 'only-blind' },
  ]);
  assert.deepEqual(byId(blinded, 'only-ordinary')?.foundBy, [
    { seat: 'review.finders[1]', provider: 'codex', model: 'default', id: 'only-ordinary' },
  ]);
  assert.deepEqual(findings(blinded), findings(control), 'the round records what an unblinded one does');
  assert.deepEqual(Object.keys(blinded).sort(), Object.keys(control).sort(), 'no new state field');
});

// ---- the setting ------------------------------------------------------------

test('review.finders[k].report is kept in the stored config as written', () => {
  const loaded = loadConfig(project({ review: blindAndOrdinary }));
  const stored = JSON.parse(JSON.stringify(storedConfig(loaded))) as Config;
  assert.deepEqual(stored.review.finders, blindAndOrdinary.finders);
});

test('a report that is not a boolean is refused by its path', () => {
  for (const [value, shown] of [
    ['no', '"no"'],
    [0, '0'],
    [null, 'null'],
  ] as const) {
    assert.throws(() => loadConfig(project({ review: { finders: [{ provider: 'codex', report: value }] } })), {
      message: `review.finders[0].report is ${shown}; must be true or false, or absent for the implementer's report`,
    });
  }
});

test('report in critique.finders is refused, saying a plan critique has no implementer report', () => {
  for (const value of [false, true, 'no']) {
    assert.throws(() => loadConfig(project({ critique: { finders: [{ provider: 'codex', report: value }] } })), {
      message:
        'critique.finders[0].report is not a setting for a plan critique; a plan critique has no ' +
        'implementer report to withhold',
    });
  }
});

test('report true and false are accepted, and only false reaches the seat', () => {
  const finders = [{ provider: 'codex', report: false }, { provider: 'codex', report: true }, 'codex'];
  const loaded = loadConfig(project({ review: { finders } }));
  assert.deepEqual(readFinders(loaded), [
    { k: 1, path: 'review.finders[0]', setting: { provider: 'codex' }, report: false },
    { k: 2, path: 'review.finders[1]', setting: { provider: 'codex' } },
    { k: 3, path: 'review.finders[2]', setting: { provider: 'codex' } },
  ]);
});
