import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DEFAULTS } from '@src/config.js';
import { applyReproducerOutcomes } from '@src/evidence.js';
import { orchestrate } from '@src/orchestrator.js';
import { fixPrompt, reviewPrompt } from '@src/prompts.js';
import {
  archiveReproducer,
  describeOutcome,
  gateFor,
  observe,
  placeReproducer,
  unplace,
} from '@src/reproducer.js';
import { REPRODUCER_RULE } from '@src/schemas.js';
import { parseFindings, readReproducer, reproducerOutcomesOf, reproductionAt } from '@src/validate.js';
import { resolveGates } from '@src/verify.js';
import type {
  Finding,
  FindingsReport,
  Reproducer,
  ReproducerOutcome,
  RunState,
} from '@src/types.js';
import type { ResolvedGate } from '@src/verify.js';
import {
  agents,
  config,
  findingFixture,
  p1,
  report,
  reproducerGate,
  reviewingRun,
} from './helpers/loop-harness.js';

/**
 * The executable witness (#113).
 *
 * The one rule every case here is ultimately about: `src/verify.ts` says
 * *"Model-authored text is never passed to a shell"*, and this feature exists in
 * the shape it does entirely to keep it. The obvious implementation - a
 * reviewer-supplied command - would break it outright, so the first section
 * asserts the thing that would be broken rather than assuming the design holds.
 */

const CONTRACT = DEFAULTS.toolchain;

function gate(over: Partial<ResolvedGate> = {}): ResolvedGate {
  return {
    name: 'verification',
    command: 'node --version',
    runs: 3,
    timeoutMs: 30_000,
    required: true,
    artifacts: [],
    ...over,
  };
}

function reproducer(over: Partial<Reproducer> = {}): Reproducer {
  return { path: 'repro/witness.mjs', contents: '// nothing\n', ...over };
}

function context(state: RunState, over: Partial<Parameters<typeof observe>[2]> = {}): Parameters<typeof observe>[2] {
  return {
    cwd: state.targetDir,
    runDir: state.dir,
    gates: [gate()],
    contract: CONTRACT,
    style: null,
    passedGates: new Set(['verification']),
    at: 'review',
    ...over,
  };
}

/** A run parked at review, with a gate that reads what a reproducer places. */
function withGate(prefix: string): { state: RunState; gates: ResolvedGate[] } {
  const state = reviewingRun({ prefix, commit: true });
  const command = reproducerGate(state);
  const gates = resolveGates({ ...DEFAULTS.verify, command, runs: 1, timeoutMs: 30_000 }, state.targetDir);
  return { state, gates };
}

function outcomeFixture(over: Partial<ReproducerOutcome> = {}): ReproducerOutcome {
  return {
    verdict: 'did-not-reproduce',
    at: 'review',
    gate: 'verification',
    command: 'npm test',
    baseline: 'gate-passed',
    reason: null,
    archived: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Nothing model-authored reaches a shell
// ---------------------------------------------------------------------------

test('the command executed is the configured gate command, byte for byte', async () => {
  const { state, gates } = withGate('vibe-repro-shell-');
  const configured = gates[0]?.command;
  assert.equal(typeof configured, 'string');

  const outcome = await observe(
    p1('shell'),
    // Every one of these would be a catastrophe if any part of a reproducer were
    // interpolated into a command line. They are ordinary file contents and an
    // ordinary path, and that is the whole point.
    reproducer({
      path: 'repro/a && echo pwned > pwned.txt.mjs',
      contents: '; echo pwned > pwned.txt\n`touch pwned.txt`\n$(touch pwned.txt)\n',
    }),
    context(state, { gates }),
  );

  assert.equal(outcome.command, configured);
  assert.equal(existsSync(path.join(state.targetDir, 'pwned.txt')), false);
});

test('a reproducer cannot choose what runs, only which configured gate runs it', () => {
  const gates = [gate({ name: 'typecheck', command: 'tsc --noEmit' }), gate({ name: 'test' })];
  const chosen = gateFor(reproducer({ gate: 'typecheck' }), gates);

  // The identity, not an equal string: what a reproducer selects is one of the
  // objects `resolveGates` produced, and there is no path by which it could
  // supply a command of its own.
  assert.equal(chosen.gate, gates[0]);
  assert.equal(chosen.gate?.command, 'tsc --noEmit');
});

// ---------------------------------------------------------------------------
// Placement: contained, never overwriting, never through a link
// ---------------------------------------------------------------------------

test('a path that leaves the repository is refused and nothing is written', () => {
  const { state } = withGate('vibe-repro-escape-');
  for (const escape of ['../outside.mjs', '../../outside.mjs']) {
    const { placement, reason } = placeReproducer(state.targetDir, reproducer({ path: escape }), null);
    assert.equal(placement, null);
    assert.match(reason ?? '', /does not resolve inside the repository/);
  }
  assert.equal(existsSync(path.join(path.dirname(state.targetDir), 'outside.mjs')), false);
});

test('an existing file is refused rather than overwritten', () => {
  const { state } = withGate('vibe-repro-overwrite-');
  const target = path.join(state.targetDir, 'README.md');
  const before = readFileSync(target, 'utf8');

  const { placement, reason } = placeReproducer(
    state.targetDir,
    reproducer({ path: 'README.md', contents: 'clobbered\n' }),
    null,
  );

  assert.equal(placement, null);
  assert.match(reason ?? '', /already exists and was not overwritten/);
  assert.equal(readFileSync(target, 'utf8'), before);
});

test('a path through a symlinked directory is refused', () => {
  const { state } = withGate('vibe-repro-link-');
  const outside = path.join(path.dirname(state.targetDir), `escape-${path.basename(state.targetDir)}`);
  mkdirSync(outside, { recursive: true });
  // `junction` so this works on Windows without elevation; the argument is
  // ignored everywhere else. This is the case `resolveInside` cannot answer on
  // its own - the lexical check passes, because the path really is inside.
  symlinkSync(outside, path.join(state.targetDir, 'linked'), 'junction');

  const { placement, reason } = placeReproducer(
    state.targetDir,
    reproducer({ path: 'linked/witness.mjs' }),
    null,
  );

  assert.equal(placement, null);
  assert.match(reason ?? '', /passes through a symlink/);
  assert.equal(existsSync(path.join(outside, 'witness.mjs')), false);
});

test('.git and .vibe are refused whatever the containment check says', () => {
  const { state } = withGate('vibe-repro-roots-');
  for (const [where, root] of [
    ['.git/hooks/pre-commit', '.git'],
    ['.vibe/runs/anything.mjs', '.vibe'],
  ] as const) {
    const { placement, reason } = placeReproducer(state.targetDir, reproducer({ path: where }), null);
    assert.equal(placement, null);
    assert.match(reason ?? '', new RegExp(`under ${root.replace('.', '\\.')}, which is not writable`));
  }
});

test('the file and the directories it needed are gone after the run', async () => {
  const { state, gates } = withGate('vibe-repro-cleanup-');
  // A directory the project already had, left empty, which the cleanup must not
  // take with it.
  mkdirSync(path.join(state.targetDir, 'kept'), { recursive: true });

  await observe(p1('cleanup'), reproducer({ path: 'made/here/witness.mjs' }), context(state, { gates }));

  assert.equal(existsSync(path.join(state.targetDir, 'made/here/witness.mjs')), false);
  assert.equal(existsSync(path.join(state.targetDir, 'made')), false);
  assert.equal(existsSync(path.join(state.targetDir, 'kept')), true);
});

test('the file is kept in the run record even though it left the tree', async () => {
  const { state, gates } = withGate('vibe-repro-archive-');
  const outcome = await observe(
    p1('kept-in-record'),
    reproducer({ contents: 'FAIL: the witness\n' }),
    context(state, { gates }),
  );

  assert.equal(outcome.archived, 'reproducers/kept-in-record/witness.mjs');
  assert.equal(
    readFileSync(path.join(state.dir, 'reproducers/kept-in-record/witness.mjs'), 'utf8'),
    'FAIL: the witness\n',
  );
});

test('an id that is a path traversal becomes a slug, not a directory above the run', () => {
  const { state } = withGate('vibe-repro-slug-');
  const where = archiveReproducer(state.dir, '../../etc/passwd', reproducer(), 'repro/witness.mjs');
  assert.equal(where, 'reproducers/etc-passwd/witness.mjs');
  assert.equal(existsSync(path.join(state.dir, 'reproducers/etc-passwd/witness.mjs')), true);
});

test('unplace leaves a directory it did not create alone', () => {
  const { state } = withGate('vibe-repro-unplace-');
  mkdirSync(path.join(state.targetDir, 'theirs'), { recursive: true });
  writeFileSync(path.join(state.targetDir, 'theirs/ours.mjs'), 'x', 'utf8');

  unplace({
    absolute: path.join(state.targetDir, 'theirs/ours.mjs'),
    relative: 'theirs/ours.mjs',
    // The truthful record: this placement created nothing.
    created: [],
  });

  assert.equal(existsSync(path.join(state.targetDir, 'theirs/ours.mjs')), false);
  assert.equal(existsSync(path.join(state.targetDir, 'theirs')), true);
});

// ---------------------------------------------------------------------------
// Which gate
// ---------------------------------------------------------------------------

test('one gate needs no name; several need one and guess at nothing', () => {
  const sole = [gate()];
  assert.equal(gateFor(reproducer(), sole).gate, sole[0]);

  const many = [gate({ name: 'typecheck' }), gate({ name: 'test' })];
  const ambiguous = gateFor(reproducer(), many);
  assert.equal(ambiguous.gate, null);
  assert.match(ambiguous.reason ?? '', /named no gate and this run has 2 \(typecheck, test\)/);
});

test('a gate name the run does not have is reported with the names it does', () => {
  const { gate: chosen, reason } = gateFor(reproducer({ gate: 'lint' }), [gate({ name: 'test' })]);
  assert.equal(chosen, null);
  assert.match(reason ?? '', /named the gate "lint", which this run does not have \(test\)/);
});

test('a gate with no command is not a gate a reproducer can be run by', () => {
  const unavailable = gateFor(reproducer({ gate: 'qa' }), [gate({ name: 'qa', command: null })]);
  assert.equal(unavailable.gate, null);
  assert.match(unavailable.reason ?? '', /the qa gate has no command configured/);

  const none = gateFor(reproducer(), [gate({ command: null })]);
  assert.equal(none.gate, null);
  assert.match(none.reason ?? '', /no verification gate with a command/);
});

// ---------------------------------------------------------------------------
// What was observed, and what it takes to claim it
// ---------------------------------------------------------------------------

test('a test that fails on a tree the gate just passed on is a reproduction', async () => {
  const { state, gates } = withGate('vibe-repro-real-');
  const outcome = await observe(
    p1('real'),
    reproducer({ contents: 'FAIL - the defect is real\n' }),
    context(state, { gates }),
  );

  assert.equal(outcome.verdict, 'reproduced');
  assert.equal(outcome.baseline, 'gate-passed');
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.reason, null);
});

test('the same failure with no observed baseline is unproven, not a reproduction', async () => {
  const { state, gates } = withGate('vibe-repro-nobase-');
  const outcome = await observe(
    p1('unattributable'),
    reproducer({ contents: 'FAIL - but who failed?\n' }),
    // The gate was never observed passing without the file, so a failure with it
    // present could be any other test in the suite.
    context(state, { gates, passedGates: new Set<string>() }),
  );

  assert.equal(outcome.verdict, 'unproven');
  assert.equal(outcome.baseline, 'not-observed');
  assert.match(outcome.reason ?? '', /cannot be attributed to the reproducer/);
});

test('a passing test needs no baseline - it certifies itself', async () => {
  const { state, gates } = withGate('vibe-repro-pass-');
  const outcome = await observe(
    p1('did-not-happen'),
    reproducer({ contents: '// asserts nothing\n' }),
    context(state, { gates, passedGates: new Set<string>() }),
  );

  // The asymmetry, stated: the whole command exited 0 with the file in it, so
  // the file ran and passed and nothing else was broken either.
  assert.equal(outcome.verdict, 'did-not-reproduce');
  assert.equal(outcome.baseline, 'not-observed');
});

test('a gate that cannot start is unproven, and does not stop the run', async () => {
  const { state } = withGate('vibe-repro-unlaunchable-');
  const outcome = await observe(
    p1('cannot-run'),
    reproducer(),
    context(state, { gates: [gate({ command: 'vibe-definitely-not-a-command' })] }),
  );

  assert.equal(outcome.verdict, 'unproven');
  assert.match(outcome.reason ?? '', /the gate could not run/);
});

test('a reproducer that could not be placed is unproven and names why', async () => {
  const { state, gates } = withGate('vibe-repro-unplaceable-');
  const outcome = await observe(
    p1('nowhere'),
    reproducer({ path: '../escape.mjs' }),
    context(state, { gates }),
  );

  assert.equal(outcome.verdict, 'unproven');
  assert.equal(outcome.gate, 'verification');
  assert.match(outcome.reason ?? '', /does not resolve inside the repository/);
  assert.equal(outcome.archived, null);
});

// ---------------------------------------------------------------------------
// What a verdict costs the finding
// ---------------------------------------------------------------------------

function reportOf(findings: readonly Finding[]): FindingsReport {
  return { verdict: 'REVISE', summary: '', findings: [...findings] };
}

test('a blocker whose own test passed is downgraded, kept, and says why', () => {
  const before = reportOf([p1('did-not-happen')]);
  const { report: after, downgraded } = applyReproducerOutcomes(
    before,
    new Map([['did-not-happen', outcomeFixture()]]),
  );

  const [f] = after.findings;
  assert.equal(f?.severity, 'P2');
  assert.equal(f?.downgraded?.from, 'P1');
  assert.match(f?.downgraded?.reason ?? '', /its own reproducer passed against the unfixed code/);
  assert.equal(downgraded.length, 1);
  // Kept, not deleted - the same rule grounding follows.
  assert.equal(after.findings.length, 1);
});

test('a reproduction changes no severity - only a person moves one up', () => {
  const before = reportOf([p1('real')]);
  const { report: after, downgraded } = applyReproducerOutcomes(
    before,
    new Map([['real', outcomeFixture({ verdict: 'reproduced' })]]),
  );

  assert.equal(after.findings[0]?.severity, 'P1');
  assert.equal(after.findings[0]?.severityChanges, undefined);
  assert.equal(downgraded.length, 0);
  assert.equal(reproductionAt(after.findings[0] as Finding, 'review')?.verdict, 'reproduced');
});

test('an unproven observation is recorded and costs the finding nothing', () => {
  const before = reportOf([p1('cannot-tell')]);
  const { report: after, downgraded } = applyReproducerOutcomes(
    before,
    new Map([['cannot-tell', outcomeFixture({ verdict: 'unproven', reason: 'the gate could not run' })]]),
  );

  assert.equal(after.findings[0]?.severity, 'P1');
  assert.equal(after.findings[0]?.downgraded, undefined);
  assert.equal(downgraded.length, 0);
  assert.equal(reproductionAt(after.findings[0] as Finding, 'review')?.reason, 'the gate could not run');
});

test('a non-blocking finding is recorded and not rewritten', () => {
  const before = reportOf([findingFixture({ id: 'nit', severity: 'P3' })]);
  const { report: after, downgraded } = applyReproducerOutcomes(
    before,
    new Map([['nit', outcomeFixture()]]),
  );

  assert.equal(after.findings[0]?.severity, 'P3');
  assert.equal(after.findings[0]?.downgraded, undefined);
  assert.equal(downgraded.length, 0);
});

test('observations append, so the review one survives the one after the fix', () => {
  const carried: Finding = {
    ...p1('twice'),
    reproducerOutcomes: [outcomeFixture({ verdict: 'reproduced' })],
  };
  const { report: after } = applyReproducerOutcomes(
    reportOf([carried]),
    new Map([['twice', outcomeFixture({ at: 'final-fix' })]]),
  );

  const outcomes = reproducerOutcomesOf(after.findings[0] as Finding);
  assert.equal(outcomes.length, 2);
  assert.equal(outcomes[0]?.verdict, 'reproduced');
  assert.equal(outcomes[1]?.at, 'final-fix');
  // Asked per moment, never scanned as one list: a review observation must
  // never read as a statement about the fixed code.
  assert.equal(reproductionAt(after.findings[0] as Finding, 'review')?.verdict, 'reproduced');
  assert.equal(reproductionAt(after.findings[0] as Finding, 'final-fix')?.verdict, 'did-not-reproduce');
});

test('a report nothing was observed for is returned unchanged', () => {
  const before = reportOf([p1('untouched')]);
  const { report: after, downgraded } = applyReproducerOutcomes(before, new Map());
  assert.equal(after, before);
  assert.equal(downgraded.length, 0);
});

// ---------------------------------------------------------------------------
// Reading what a model, or a hand-edited state, said
// ---------------------------------------------------------------------------

test('a reproducer needs both a path and contents, or it is not one', () => {
  assert.equal(readReproducer({ path: 'a.mjs', contents: '' }), null);
  assert.equal(readReproducer({ path: '   ', contents: 'x' }), null);
  assert.equal(readReproducer({ contents: 'x' }), null);
  assert.equal(readReproducer(null), null);
  assert.deepEqual(readReproducer({ path: ' a.mjs ', contents: 'x', gate: ' test ' }), {
    path: 'a.mjs',
    contents: 'x',
    gate: 'test',
  });
  // The schema's null, which is what a finding with no reproducer sends.
  assert.equal(readReproducer({ path: null, contents: null, gate: null }), null);
});

test('parseFindings carries a reproducer through and omits an unusable one', () => {
  const parsed = parseFindings({
    verdict: 'REVISE',
    summary: '',
    findings: [
      {
        id: 'with',
        severity: 'P1',
        title: 't',
        detail: 'd',
        suggested_fix: 'f',
        defer: false,
        evidence: [],
        reproducer: { path: 'tests/x.test.ts', contents: 'assert(false)', gate: null },
      },
      {
        id: 'without',
        severity: 'P1',
        title: 't',
        detail: 'd',
        suggested_fix: 'f',
        defer: false,
        evidence: [],
        reproducer: { path: 'tests/y.test.ts', contents: null, gate: null },
      },
    ],
  });

  assert.equal(parsed.findings[0]?.reproducer?.path, 'tests/x.test.ts');
  assert.equal(parsed.findings[0]?.reproducer?.gate, undefined);
  // The finding survives; only the unusable witness is dropped.
  assert.equal(parsed.findings[1]?.reproducer, undefined);
  assert.equal(parsed.findings[1]?.id, 'without');
});

test('a stored outcome list drops what it cannot read and keeps the rest', () => {
  const f = {
    ...p1('stored'),
    reproducerOutcomes: [
      { verdict: 'made-up', at: 'review' },
      { verdict: 'reproduced', at: 'never' },
      null,
      { verdict: 'reproduced', at: 'review', gate: 'test', command: 'npm test', reason: null },
    ],
  } as unknown as Finding;

  const outcomes = reproducerOutcomesOf(f);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.verdict, 'reproduced');
  // Fail closed: an entry that did not say it had a baseline does not get one,
  // because `gate-passed` is the claim that licenses `reproduced`.
  assert.equal(outcomes[0]?.baseline, 'not-observed');
});

// ---------------------------------------------------------------------------
// The prompts
// ---------------------------------------------------------------------------

test('a run that does not run reproducers renders no reproducer section', () => {
  const without = reviewPrompt('diff', ['a.ts'], 'plan', [], 1, false);
  assert.equal(without.includes('## Reproducer'), false);
  assert.equal(without.includes(REPRODUCER_RULE), false);

  // An empty gate list is the same answer: a choice between nothing is not a
  // field worth offering.
  const empty = reviewPrompt('diff', ['a.ts'], 'plan', [], 1, false, null, undefined, undefined, undefined, null, []);
  assert.equal(empty.includes('## Reproducer'), false);
});

test('the reviewer is told which gates it may name, and when it need not', () => {
  const one = reviewPrompt('d', [], 'p', [], 1, false, null, undefined, undefined, undefined, null, [
    'verification',
  ]);
  assert.match(one, /## Reproducer/);
  assert.match(one, /one verification gate, `verification`, so leave `gate` null/);

  const several = reviewPrompt('d', [], 'p', [], 1, false, null, undefined, undefined, undefined, null, [
    'typecheck',
    'test',
  ]);
  assert.match(several, /`typecheck`, `test`/);
  assert.match(several, /`gate` is not optional here/);
});

test('the fixer is told a finding is proven, and told when nothing settled it', () => {
  const proven: Finding = {
    ...p1('proven'),
    reproducerOutcomes: [outcomeFixture({ verdict: 'reproduced' })],
  };
  const unproven: Finding = {
    ...p1('unproven'),
    reproducerOutcomes: [
      outcomeFixture({ verdict: 'unproven', reason: 'the gate could not run' }),
    ],
  };

  const prompt = fixPrompt([proven, unproven], 1);
  assert.match(prompt, /fails against the code as it stands/);
  assert.match(prompt, /says nothing either way about the finding/);
  // Byte-identical for a run where nobody wrote one, as `raisedNote` and
  // `movedNote` are.
  assert.equal(fixPrompt([p1('plain')], 1).includes('*Reproducer:*'), false);
});

test('describeOutcome says something different after the fix than before it', () => {
  const before = describeOutcome(outcomeFixture({ verdict: 'did-not-reproduce', at: 'review' }));
  const after = describeOutcome(outcomeFixture({ verdict: 'did-not-reproduce', at: 'final-fix' }));

  assert.match(before, /passed\*\* against the unfixed code/);
  assert.match(after, /failed before the fix and passes after it/);
  assert.match(after, /closed by evidence/);
});

// ---------------------------------------------------------------------------
// Through the loop
// ---------------------------------------------------------------------------

/** The reviewer's finding, with a reproducer whose contents decide the gate. */
function reviewWith(contents: string, over: Partial<Reproducer> = {}): object {
  return report([
    {
      ...p1('the-claim'),
      reproducer: { path: 'repro/witness.txt', contents, ...over },
    },
  ]);
}

test('a P1 whose own test passes stops blocking, and the run finishes clean', async () => {
  const state = reviewingRun({ prefix: 'vibe-repro-loop-false-', commit: true });
  const calls: string[] = [];
  const turns = agents(
    {
      // Round two is never reached: the P1 is downgraded before the gate reads
      // it, `decision.tolerated` is empty, and the loop ends.
      codex: (label) => (label === 'review-0' ? reviewWith('// this asserts nothing\n') : report([])),
    },
    calls,
  );

  await orchestrate(
    state,
    config(
      {},
      {
        verify: {
          ...DEFAULTS.verify,
          enabled: true,
          command: reproducerGate(state),
          runs: 1,
          timeoutMs: 30_000,
        },
      },
    ),
    true,
    turns,
  );

  // The #44 case, mechanically: a finding that cited real things, was believed,
  // and did not survive being run.
  assert.equal(calls.filter((c) => c.startsWith('fix-')).length, 0);
  const events = state.events.filter((e) => e.type === 'reproducer_observed');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.['verdict'], 'did-not-reproduce');
  assert.equal(state.events.some((e) => e.type === 'finding_downgraded'), true);

  const round = JSON.parse(readFileSync(path.join(state.dir, 'code-review-0.json'), 'utf8')) as {
    findings: Finding[];
  };
  // Written once, holding what the reviewer said and what vibe observed about
  // it - the same file that already holds `downgraded` from grounding.
  assert.equal(round.findings[0]?.severity, 'P2');
  assert.equal(round.findings[0]?.reproducerOutcomes?.[0]?.verdict, 'did-not-reproduce');
});

test('a P1 whose own test fails is proven, blocks, and the fixer is told so', async () => {
  const state = reviewingRun({ prefix: 'vibe-repro-loop-true-', commit: true });
  const calls: string[] = [];
  let fixPromptSeen = '';
  const turns = agents(
    {
      codex: (label) => (label === 'review-0' ? reviewWith('FAIL - it really happens\n') : report([])),
      claude: (label, options) => {
        if (label.startsWith('fix-')) fixPromptSeen = options.prompt;
        return 'fixed';
      },
    },
    calls,
  );

  await orchestrate(
    state,
    // Tolerance 0, so this is an ordinary blocking fix round rather than the
    // carried-P1 final one. The two take different prompts and different labels,
    // and this case is about what the *fixer* is told.
    config(
      { maxReviewRounds: 3, p1Tolerance: 0 },
      {
        verify: {
          ...DEFAULTS.verify,
          enabled: true,
          command: reproducerGate(state),
          runs: 1,
          timeoutMs: 30_000,
        },
      },
    ),
    true,
    turns,
  );

  assert.equal(calls.filter((c) => c.startsWith('fix-')).length, 1);
  assert.match(fixPromptSeen, /\*Reproducer:\* The reviewer's own test for this fails/);
  const observed = state.events.filter((e) => e.type === 'reproducer_observed');
  assert.equal(observed[0]?.['verdict'], 'reproduced');
  assert.equal(observed[0]?.['baseline'], 'gate-passed');
  // Placed, run, and taken back out - the tree the next round verifies is the
  // tree the fixer left.
  assert.equal(existsSync(path.join(state.targetDir, 'repro/witness.txt')), false);
});

test('a run whose reviewer writes no reproducer behaves exactly as it did', async () => {
  const state = reviewingRun({ prefix: 'vibe-repro-loop-none-', commit: true });
  const calls: string[] = [];
  const turns = agents({ codex: () => report([]) }, calls);

  await orchestrate(
    state,
    config(
      {},
      {
        verify: {
          ...DEFAULTS.verify,
          enabled: true,
          command: reproducerGate(state),
          runs: 1,
          timeoutMs: 30_000,
        },
      },
    ),
    true,
    turns,
  );

  assert.equal(state.events.some((e) => e.type === 'reproducer_observed'), false);
  assert.equal(existsSync(path.join(state.dir, 'reproducers')), false);
});

test('verify.reproducers: false places nothing and tells the reviewer nothing', async () => {
  const state = reviewingRun({ prefix: 'vibe-repro-loop-off-', commit: true });
  const calls: string[] = [];
  let reviewPromptSeen = '';
  const turns = agents(
    {
      codex: (label, options) => {
        if (label === 'review-0') {
          reviewPromptSeen = options.prompt;
          return reviewWith('FAIL - it really happens\n');
        }
        return report([]);
      },
    },
    calls,
  );

  await orchestrate(
    state,
    config(
      { maxReviewRounds: 3, p1Tolerance: 0 },
      {
        verify: {
          ...DEFAULTS.verify,
          enabled: true,
          reproducers: false,
          command: reproducerGate(state),
          runs: 1,
          timeoutMs: 30_000,
        },
      },
    ),
    true,
    turns,
  );

  assert.equal(reviewPromptSeen.includes('## Reproducer'), false);
  assert.equal(state.events.some((e) => e.type === 'reproducer_observed'), false);
  // The finding is untouched: still P1, still blocking, judged as findings were
  // judged before this existed.
  assert.equal(calls.filter((c) => c.startsWith('fix-')).length, 1);
});

test('a carried P1 whose test passes after the fix is closed by evidence in OUTSTANDING.md', async () => {
  const state = reviewingRun({ prefix: 'vibe-repro-outstanding-', commit: true });
  const calls: string[] = [];
  // The reproducer fails at review and passes after the fix, because the fix
  // turn is what rewrites it. That is the whole sequence OUTSTANDING.md has
  // never been able to describe.
  const turns = agents(
    {
      codex: (label) => (label === 'review-0' ? reviewWith('FAIL - carried\n') : report([])),
      claude: (label) => {
        // The fix. The reproducer is the one file the fixer cannot edit, so the
        // repair has to be in the code under test - which is exactly the real
        // shape: the same test, unchanged, run against a changed tree.
        if (label.startsWith('final-fix-')) {
          writeFileSync(path.join(state.targetDir, 'fixed.txt'), 'done\n', 'utf8');
        }
        return 'fixed';
      },
    },
    calls,
  );

  await orchestrate(
    state,
    config(
      { p1Tolerance: 1, maxReviewRounds: 3 },
      {
        verify: {
          ...DEFAULTS.verify,
          enabled: true,
          command: reproducerGate(state, { fixedBy: 'fixed.txt' }),
          runs: 1,
          timeoutMs: 30_000,
        },
      },
    ),
    true,
    turns,
  );

  const settled = state.outstanding?.[0] as Finding | undefined;
  assert.equal(reproductionAt(settled ?? p1('missing'), 'review')?.verdict, 'reproduced');
  assert.equal(reproductionAt(settled ?? p1('missing'), 'final-fix')?.verdict, 'did-not-reproduce');

  const outstanding = readFileSync(path.join(state.dir, 'OUTSTANDING.md'), 'utf8');
  assert.match(outstanding, /failed before the fix and passes after it/);
  // The sentence this document has always ended on, and the one thing that can
  // retire it.
  assert.equal(outstanding.includes('nobody has confirmed they are gone'), false);
  assert.match(outstanding, /every one of those tests passes now/);
});
