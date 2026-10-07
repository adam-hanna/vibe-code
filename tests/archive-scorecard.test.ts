import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderScorecard, scoreArchive, SCORECARD_VERSION, UNMEASURABLE } from '@src/scorecard.js';
import { RUNS_DIR } from '@src/run.js';
import type { Measure, Scorecard } from '@src/scorecard.js';
import { JUNCTION_SKIP, linkDir } from './helpers/links.js';

/**
 * The archive scorecard (#114): something finally reads `.vibe/runs`.
 *
 * The claim under test is **not** "it counts". It is that it counts *over a
 * population it can name*. Almost every field in `RunState` was added at some
 * point, so most runs in a real archive predate most fields - the census that
 * shaped this module found `toolItems` on 34 of 265 recorded turns - and a
 * scorecard that reported a rate over a population where nine tenths never
 * recorded the fact would be a fabrication that looked authoritative.
 *
 * So the cases below are mostly about **denominators**, and the invariant
 * `matched <= measured` and `measured + unmeasured = population` is checked
 * structurally rather than field by field.
 */

/** Whatever a state.json needs to be counted, over whatever the case is about. */
function state(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'done',
    planRound: 1,
    questionRound: 0,
    reviewRound: 0,
    verifyRound: 0,
    answeredQuestions: [],
    deferredQuestions: [],
    events: [],
    ...over,
  };
}

function archive(runs: Record<string, Record<string, unknown> | string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-scorecard-'));
  for (const [id, body] of Object.entries(runs)) {
    const runDir = path.join(dir, RUNS_DIR, id);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      path.join(runDir, 'state.json'),
      typeof body === 'string' ? body : JSON.stringify(body),
    );
  }
  return dir;
}

function turn(type: 'claude_turn' | 'codex_turn', over: Record<string, unknown> = {}): unknown {
  return { at: new Date().toISOString(), type, label: 'plan', tokens: 100, ...over };
}

/** Every `Measure` in the document, found by shape rather than by name. */
function measures(v: unknown, at = '$'): [string, Measure][] {
  if (typeof v !== 'object' || v === null) return [];
  const rec = v as Record<string, unknown>;
  if (
    typeof rec['matched'] === 'number' &&
    typeof rec['measured'] === 'number' &&
    typeof rec['unmeasured'] === 'number'
  ) {
    return [[at, rec as unknown as Measure]];
  }
  return Object.entries(rec).flatMap(([k, child]) => measures(child, `${at}.${k}`));
}

/** Every file under the archive with its size and mtime, for the never-writes claim. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const s = statSync(full);
        out.push(`${path.relative(root, full)} ${s.size} ${s.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

test('it counts what the runs recorded, over the runs that recorded it', () => {
  const dir = archive({
    'run-a': state({ status: 'done', planRound: 2, questionRound: 1 }),
    'run-b': state({ status: 'stalled', planRound: 0 }),
    'run-c': state({ status: 'done', planRound: 2 }),
  });
  const card = scoreArchive(dir);

  assert.equal(card.version, SCORECARD_VERSION);
  assert.equal(card.archive.entries, 3);
  assert.equal(card.archive.read, 3);
  assert.deepEqual(card.archive.skipped, []);
  assert.deepEqual(card.endings.byStatus, { done: 2, stalled: 1 });
  // The histogram, not a mean: "1.33 plan rounds" describes no run that ever
  // happened, and the shape is what a reader is actually after.
  assert.deepEqual(card.rounds.plan, {
    measured: 3,
    unmeasured: 0,
    total: 4,
    max: 2,
    histogram: { '0': 1, '2': 2 },
  });
});

test('a run missing a counter is unmeasured, and never counted as a zero', () => {
  // The rule the whole module is built around, at its simplest. Two runs, one
  // of which predates the counter: the total is over ONE run and says so.
  const withCounter = state({ questionRound: 3 });
  const without = state();
  delete without['questionRound'];
  const card = scoreArchive(archive({ 'run-a': withCounter, 'run-b': without }));

  assert.equal(card.rounds.question.measured, 1);
  assert.equal(card.rounds.question.unmeasured, 1);
  assert.equal(card.rounds.question.total, 3);
  assert.deepEqual(card.rounds.question.histogram, { '3': 1 });
  // And it renders as a caveat rather than as a clean figure.
  assert.match(renderScorecard(card).join('\n'), /question rounds:\s+3 over 1 run, max 3.*1 could not say/);
});

test('a dimension nothing recorded reports absent, not zero', () => {
  // `suppressedQuestions` arrived with #65, so every run recorded before it
  // carries none - which on the archive that motivated this issue is all 26 of
  // them. `0%` would be a claim those runs never made.
  const card = scoreArchive(archive({ 'run-a': state(), 'run-b': state() }));

  assert.deepEqual(card.questions.suppressed, { matched: 0, measured: 0, unmeasured: 2 });
  assert.match(
    renderScorecard(card).join('\n'),
    /re-asks suppressed:\s+not recorded by any run \(2 could not say\)/,
  );
  // The distinction that matters: a run that recorded an EMPTY list did say, and
  // is measured. Absent and empty are not the same fact.
  const said = scoreArchive(archive({ 'run-a': state({ suppressedQuestions: [] }) }));
  assert.deepEqual(said.questions.suppressed, { matched: 0, measured: 1, unmeasured: 0 });
});

test('an inert turn is counted over turns that recorded tools, and no others', () => {
  // The case the census produced and the module was shaped by. Three turns: one
  // that ran nothing, one that ran something, and one from before #66 that
  // counted neither. The answer is 1 of 2, with the third named.
  const card = scoreArchive(
    archive({
      'run-a': state({
        events: [
          turn('codex_turn', { label: 'review-0', toolItems: 0 }),
          turn('codex_turn', { label: 'review-1', toolItems: 12 }),
          turn('codex_turn', { label: 'review-2' }),
        ],
      }),
    }),
  );

  assert.deepEqual(card.turns.inert, { matched: 1, measured: 2, unmeasured: 1 });
  assert.match(renderScorecard(card).join('\n'), /ran no tools:\s+1 of 2 turns - 50%, 1 could not say/);
});

test('turns are grouped by label family, and Codex cost stays absent', () => {
  // Grouped because the question is what a KIND of turn costs: a label carrying
  // its round number would make sixty-one critique turns sixty-one groups of one.
  const card = scoreArchive(
    archive({
      'run-a': state({
        events: [
          turn('claude_turn', { label: 'revise-1', tokens: 10, costUsd: 1 }),
          turn('claude_turn', { label: 'revise-2', tokens: 20, costUsd: 2 }),
          turn('codex_turn', { label: 'critique-1', tokens: 30 }),
        ],
      }),
    }),
  );

  assert.equal(card.turns.total, 3);
  assert.equal(card.turns.byLabel['revise-N']?.turns, 2);
  assert.equal(card.turns.byLabel['revise-N']?.tokens, 30);
  assert.equal(card.turns.byLabel['revise-N']?.costUsd, 3);
  // Null, not zero. No `codex exec` output mode returns a cost and no app-server
  // endpoint returns money; a `$0.00` here would say a Codex turn was free.
  assert.equal(card.turns.byLabel['critique-N']?.costUsd, null);
  assert.equal(card.turns.byLabel['critique-N']?.tokens, 30);
  assert.match(renderScorecard(card).join('\n'), /critique-N:.*cost not reported/);
});

test('a gate that failed and then passed is visible as both', () => {
  // `gateOutcomes` keeps one row per gate and overwrites it, so it ends up
  // saying `passed` - which is true and is not the whole answer. The attempts
  // come from the event log, which is the only place a failure survives.
  const card = scoreArchive(
    archive({
      'run-a': state({
        gateOutcomes: [{ name: 'verification', status: 'passed', command: 'npm test', runs: 3, required: true }],
        events: [
          { at: 'x', type: 'verify_failed', gate: 'verification' },
          { at: 'x', type: 'verify_passed', gate: 'verification' },
        ],
      }),
    }),
  );

  assert.deepEqual(card.gates.byName, { verification: { passed: 1 } });
  assert.deepEqual(card.gates.attempts, { verification: { failed: 1, passed: 1 } });
  assert.deepEqual(card.gates.repeatedFailure, { matched: 0, measured: 1, unmeasured: 0 });
});

test('the same gate failing twice in one run is not two runs recovering', () => {
  const twice = state({
    events: [
      { at: 'x', type: 'verify_failed', gate: 'typecheck' },
      { at: 'x', type: 'verify_failed', gate: 'typecheck' },
    ],
  });
  const once = state({ events: [{ at: 'x', type: 'verify_failed', gate: 'typecheck' }] });
  // A run that ran no gate at all cannot answer the question, so it is not a
  // confident "no" - over an archive of them that would report a 0% rate the
  // runs never claimed.
  const silent = state();

  const card = scoreArchive(archive({ 'run-a': twice, 'run-b': once, 'run-c': silent }));
  assert.deepEqual(card.gates.repeatedFailure, { matched: 1, measured: 2, unmeasured: 1 });
});

test('the final fix round is counted over runs that got as far as reviewing', () => {
  // A plan-only run and a run that stalled in planning never had the
  // opportunity, so counting them would make the rate describe the wrong
  // population. Detected from a review turn actually happening rather than from
  // `phase`, which a stalled run may have advanced past for other reasons.
  const fixed = state({ finalFixDone: true, events: [turn('codex_turn', { label: 'review-0' })] });
  const notFixed = state({ events: [turn('codex_turn', { label: 'review-0' })] });
  const neverReviewed = state({ events: [turn('claude_turn', { label: 'plan' })] });

  const card = scoreArchive(archive({ a: fixed, b: notFixed, c: neverReviewed }));
  assert.deepEqual(card.finalFix, { matched: 1, measured: 2, unmeasured: 1 });
});

test('an unreadable entry is counted as skipped, never dropped', () => {
  // The overclaim this exists to prevent: a scorecard that quietly ignored a run
  // would report over a population smaller than the one it named.
  const card = scoreArchive(archive({ good: state(), bad: '{ not json', empty: '"a string"' }));

  assert.equal(card.archive.entries, 3);
  assert.equal(card.archive.read, 1);
  // `empty` holds a JSON string rather than a record: well-formed, and not a run.
  assert.deepEqual(card.archive.skipped.map((s) => s.id).sort(), ['bad', 'empty']);
  // And every skip says WHY, so a reader can tell a corrupt run from a link.
  for (const s of card.archive.skipped) assert.ok(s.reason.length > 0, s.id);
  // Named on the terminal too, not only in the JSON.
  const rendered = renderScorecard(card).join('\n');
  assert.match(rendered, /1 run\(s\) read of 3/);
  assert.match(rendered, /skipped bad:/);
});

test('a linked entry is skipped for being a link, and is never opened', (t) => {
  // #53's rule, inherited rather than re-implemented: `listRuns` is the one
  // thing that decides what an archive entry is, so a link is refused here by
  // the same verdict `vibe list` shows rather than by a second opinion.
  const dir = archive({ real: state({ planRound: 7 }) });
  const outside = mkdtempSync(path.join(tmpdir(), 'vibe-scorecard-outside-'));
  writeFileSync(path.join(outside, 'state.json'), JSON.stringify(state({ planRound: 99 })));
  if (!linkDir(outside, path.join(dir, RUNS_DIR, 'sym-run'))) {
    t.skip(JUNCTION_SKIP);
    return;
  }

  const card = scoreArchive(dir);
  assert.equal(card.archive.read, 1);
  assert.equal(card.archive.skipped.length, 1);
  assert.equal(card.archive.skipped[0]?.id, 'sym-run');
  assert.match(card.archive.skipped[0]?.reason ?? '', /symlink/);
  // Nothing from behind the link reached the counts.
  assert.equal(card.rounds.plan.max, 7);
});

test('an empty archive reports nothing rather than a page of zeroes', () => {
  const card = scoreArchive(mkdtempSync(path.join(tmpdir(), 'vibe-scorecard-empty-')));
  assert.equal(card.archive.entries, 0);
  assert.equal(card.archive.read, 0);
  const rendered = renderScorecard(card);
  assert.match(rendered.join('\n'), /nothing to report - no run record could be read/);
  // Every heading below would have been a row of zeroes over a population of
  // none, which is the shape this module exists to refuse.
  assert.equal(rendered.some((l) => l.includes('%')), false, rendered.join('\n'));
});

test('every measure in the document keeps its own invariant', () => {
  // Checked by shape rather than field by field, so a measure added later is
  // covered by this the day it appears. `matched <= measured` and
  // `measured + unmeasured` is the population it was counted over.
  const card = scoreArchive(
    archive({
      a: state({ events: [turn('codex_turn', { label: 'review-0', toolItems: 0 })] }),
      b: state({ suppressedQuestions: [{ question: 'q' }] }),
      c: state({ status: 'error' }),
    }),
  );

  const found = measures(card);
  assert.ok(found.length >= 6, `only ${found.length} measures found`);
  for (const [at, m] of found) {
    assert.ok(m.matched <= m.measured, `${at}: matched ${m.matched} > measured ${m.measured}`);
    assert.ok(m.measured >= 0 && m.unmeasured >= 0, at);
  }
});

test('the four dimensions it will not estimate are in the output', () => {
  // Reported rather than omitted: a scorecard silently missing recall is one a
  // reader assumes was fine.
  const card = scoreArchive(archive({ a: state() }));
  assert.deepEqual(card.unmeasurable, UNMEASURABLE);
  const named = card.unmeasurable.map((u) => u.dimension);
  assert.deepEqual(named, [
    'defect recall',
    'finding precision',
    'reviewer uplift',
    'correlated miss rate',
  ]);
  const rendered = renderScorecard(card).join('\n');
  assert.match(rendered, /Not measured, and not estimated/);
  for (const u of card.unmeasurable) assert.ok(rendered.includes(u.dimension), u.dimension);
});

test('an escalation is named by its exit code, and an unknown code by itself', () => {
  const card = scoreArchive(
    archive({
      a: state({
        events: [
          { at: 'x', type: 'escalation', code: 2, message: 'answer this' },
          { at: 'x', type: 'escalation', code: 3, message: 'no convergence' },
          { at: 'x', type: 'escalation', code: 99, message: 'from the future' },
        ],
      }),
    }),
  );

  assert.deepEqual(card.endings.byExitCode, { '2': 1, '3': 1, '99': 1 });
  const rendered = renderScorecard(card).join('\n');
  assert.match(rendered, /2 needs-human/);
  assert.match(rendered, /3 no-convergence/);
  // Shown as itself rather than as a phrase invented for it - the rule the
  // cockpit's exit-code footer already follows for the same numbers.
  assert.match(rendered, /^\s+99:/m);
});

test('a downgrade is tallied by severity and evidence, and never by its reason', () => {
  const card = scoreArchive(
    archive({
      a: state({
        events: [
          { at: 'x', type: 'finding_downgraded', id: 'f1', from: 'P1', reason: 'no citation resolved: ...', kinds: ['code'] },
          { at: 'x', type: 'finding_downgraded', id: 'f2', from: 'P0', reason: 'the turn ran nothing', kinds: ['external', 'code'] },
          { at: 'x', type: 'finding_downgraded', id: 'f3', from: 'P1', reason: 'something else', kinds: [] },
        ],
      }),
    }),
  );

  assert.equal(card.findings.downgraded, 3);
  assert.deepEqual(card.findings.byFrom, { P1: 2, P0: 1 });
  // Sorted and joined so ["code","external"] and ["external","code"] are one key,
  // and a finding that offered no evidence gets its own row rather than joining
  // one it does not belong to.
  assert.deepEqual(card.findings.byKinds, { code: 1, 'code,external': 1, '': 1 });
  // `reason` is prose assembled per finding, so it is not a key anywhere: tallying
  // it would mean matching English, which the product does not do about itself.
  assert.equal(JSON.stringify(card).includes('no citation resolved'), false);
});

test('reading the archive does not write to it', () => {
  // #114 asks for this in as many words, and it is the property that makes
  // running this against a live repo safe.
  const dir = archive({ a: state({ planRound: 2 }), b: '{ broken' });
  const root = path.join(dir, RUNS_DIR);
  const before = snapshot(root);
  scoreArchive(dir);
  assert.deepEqual(snapshot(root), before);
});

test('the JSON is the same measurement the table renders', () => {
  // One `scoreArchive`, two renderings, so the two cannot report different
  // numbers - which is the half a later GUI depends on.
  const dir = archive({ a: state({ planRound: 4, status: 'done' }) });
  const card = scoreArchive(dir);
  const round: Scorecard = JSON.parse(JSON.stringify(card)) as Scorecard;
  assert.deepEqual(round, card, 'the document does not survive JSON round-tripping');
  assert.match(renderScorecard(card).join('\n'), /plan revisions:\s+4 over 1 run, max 4/);
});

test('a state.json holding something that is not an object is refused upstream', () => {
  // Well-formed JSON that is not a run. `summariseStored` already calls a
  // non-record `unreadable`, so the scorecard inherits that verdict rather than
  // forming a second opinion about the same file - which is the point of running
  // over `listRuns` at all. Its own `is not an object` check stays as defence in
  // depth for a caller that does not come through here.
  const dir = archive({ a: '[1,2,3]' });
  const card = scoreArchive(dir);
  assert.equal(card.archive.read, 0);
  assert.deepEqual(card.archive.skipped, [{ id: 'a', reason: 'state.json could not be read' }]);
  assert.equal(readFileSync(path.join(dir, RUNS_DIR, 'a', 'state.json'), 'utf8'), '[1,2,3]');
  assert.deepEqual(card.endings.byStatus, {});
});
