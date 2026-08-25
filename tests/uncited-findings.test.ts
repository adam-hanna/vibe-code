import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { orchestrate, writeFollowUps } from '@src/orchestrator.js';
import { toAgentPath } from '@src/pathstyle.js';
import { loadRun, saveState } from '@src/run.js';
import { hasFindingShape } from '@src/stored.js';
import type { EnvironmentFacts } from '@src/runtime.js';
import type { Finding, RunEvent, RunState } from '@src/types.js';
import {
  agents,
  config,
  p1,
  planFixture,
  report,
  reviewingRun,
  work,
} from './helpers/loop-harness.js';

/**
 * The #44 failure, driven through the real loop: a reviewer that ran no
 * commands raised P1s it could not point at, and the loop bought a fix round
 * for each of them.
 *
 * Grounding sits inside `runCritique`/`runReview`, so the only honest way to
 * test it is through `orchestrate` - the assertion that matters is not "the
 * severity changed" (that is `evidence-grounding.test.ts`) but "no fix round
 * happened", and nothing below the seam can see that.
 *
 * Findings here are built inline rather than from `p1()`: the harness fixture
 * carries an `external` citation precisely so that every *other* case keeps
 * blocking, which is the opposite of what these cases need.
 */

const RUN = { prefix: 'vibe-uncited-', task: 'uncited findings' } as const;

/** A blocking finding that cites whatever it is given, or nothing at all. */
function blocker(over: Partial<Finding> = {}): Finding {
  return {
    id: 'floating-claim',
    severity: 'P1',
    title: 'A claim about code nobody read',
    detail: 'Detail.',
    suggested_fix: 'Fix it.',
    defer: false,
    ...over,
  };
}

function eventsOf(state: RunState, type: string): RunEvent[] {
  return state.events.filter((e) => e.type === type);
}

function reviewArtifact(state: RunState, round = 0): { findings: Finding[] } {
  const raw: unknown = JSON.parse(
    readFileSync(path.join(state.dir, `code-review-${round}.json`), 'utf8'),
  );
  assert.ok(raw !== null && typeof raw === 'object' && 'findings' in raw);
  return raw as { findings: Finding[] };
}

/** Environment facts naming one agent's shell convention, as preflight records them. */
function environmentOf(provider: 'claude' | 'codex', pathStyle: 'msys' | 'win32'): EnvironmentFacts {
  return {
    agents: [{ provider, shell: 'bash', pathStyle, repaired: false, tools: [] }],
    verifyCommand: null,
    verifyRuns: 1,
  };
}

// ---- the failure this prevents ---------------------------------------------

test('a review round whose only P1 is uncited buys no fix round', async () => {
  const state = reviewingRun(RUN);
  const calls: string[] = [];

  await orchestrate(
    state,
    config(),
    true,
    agents(
      {
        claude: () => assert.fail('an uncited P1 must not buy a fix round'),
        codex: () => report([blocker()]),
      },
      calls,
    ),
  );

  // One review, and nothing after it. Before #48 this was review, fix, review,
  // fix, up to `maxReviewRounds` - all of it spent on a claim nobody could
  // point at.
  assert.deepEqual(calls, ['review-0']);
  assert.equal(state.phase, 'complete');
  assert.equal(state.pendingFindings, null);
});

test('the downgraded finding is in the round artifact, at P2, saying why', () => {
  // Same case as above; asserted separately so a failure names which half broke.
  return (async () => {
    const state = reviewingRun(RUN);
    await orchestrate(
      state,
      config(),
      true,
      agents({ codex: () => report([blocker({ evidence: [{ kind: 'code', path: 'nope.ts' }] })]) }, []),
    );

    const found = reviewArtifact(state).findings[0];
    // Downgraded, not deleted: the reviewer may well be right, and a run that
    // dropped the finding would be hiding that it was ever raised.
    assert.equal(found?.id, 'floating-claim');
    assert.equal(found?.severity, 'P2');
    assert.equal(found?.downgraded?.from, 'P1');
    assert.match(found?.downgraded?.reason ?? '', /nope\.ts/);
  })();
});

test('the event log names the id, the original severity and the kinds offered', async () => {
  const state = reviewingRun(RUN);

  await orchestrate(
    state,
    config(),
    true,
    agents(
      {
        codex: () =>
          report([
            blocker({
              evidence: [
                { kind: 'code', path: 'nope.ts' },
                { kind: 'artifact', path: 'MISSING.md' },
              ],
            }),
          ]),
      },
      [],
    ),
  );

  const [event] = eventsOf(state, 'finding_downgraded');
  assert.ok(event !== undefined, 'the downgrade must be recorded');
  assert.equal(event['id'], 'floating-claim');
  assert.equal(event['from'], 'P1');
  assert.match(String(event['reason']), /nope\.ts/);
  // The kinds it *offered* is the fact worth reading: a blocker that rested
  // only on `external` is visible for what it was.
  assert.deepEqual(event['kinds'], ['code', 'artifact']);
});

test('a finding that offered nothing records an empty kind list, and does not throw', async () => {
  const state = reviewingRun(RUN);

  await orchestrate(state, config(), true, agents({ codex: () => report([blocker()]) }, []));

  const [event] = eventsOf(state, 'finding_downgraded');
  assert.equal(event?.['from'], 'P1');
  assert.deepEqual(event?.['kinds'], []);
  assert.match(String(event?.['reason']), /cited no evidence/);
});

// ---- what still blocks ------------------------------------------------------

test('a P1 citing a real file still blocks, and still buys its fix round', async () => {
  const state = reviewingRun(RUN);
  work(state, 'real.ts', 'the cited line\n');
  const calls: string[] = [];

  await orchestrate(
    state,
    config(),
    true,
    agents(
      {
        claude: (label) => work(state, `${label}.txt`),
        codex: () =>
          report([
            blocker({ evidence: [{ kind: 'code', path: 'real.ts', excerpt: 'the cited line' }] }),
          ]),
      },
      calls,
    ),
  );

  // One P1 is inside the default tolerance, so it is carried into the final fix
  // round - which is the behaviour the uncited case above must not reach.
  assert.deepEqual(calls, ['review-0', 'final-fix-1']);
  assert.equal(reviewArtifact(state).findings[0]?.severity, 'P1');
  assert.equal(eventsOf(state, 'finding_downgraded').length, 0);
});

test('a citation in the reviewing agent path convention resolves', async () => {
  const state = reviewingRun(RUN);
  const real = work(state, 'real.ts', 'the cited line\n');
  // With the default table the reviewer is Codex, and its shell decides the
  // convention a path comes back in - `/c/...` here, which `path.resolve`
  // alone would place nowhere near the repo.
  state.environment = environmentOf('codex', 'msys');
  const cited = toAgentPath(real, 'msys');
  const calls: string[] = [];

  await orchestrate(
    state,
    config(),
    true,
    agents(
      {
        claude: (label) => work(state, `${label}.txt`),
        codex: () => report([blocker({ evidence: [{ kind: 'code', path: cited }] })]),
      },
      calls,
    ),
  );

  assert.deepEqual(calls, ['review-0', 'final-fix-1']);
  assert.equal(eventsOf(state, 'finding_downgraded').length, 0);
  // Rewritten to the form the *fixer* can open: the reviewer's shell is not the
  // implementer's, and the finding is read by the implementer next.
  assert.equal(reviewArtifact(state).findings[0]?.evidence?.[0]?.path, 'real.ts');
});

test('an artifact citation resolves against the run directory', async () => {
  const state = reviewingRun(RUN);
  writeFileSync(path.join(state.dir, 'PLAN.md'), '# plan\n', 'utf8');
  const calls: string[] = [];

  await orchestrate(
    state,
    config(),
    true,
    agents(
      {
        claude: (label) => work(state, `${label}.txt`),
        codex: () => report([blocker({ evidence: [{ kind: 'artifact', path: 'PLAN.md' }] })]),
      },
      calls,
    ),
  );

  assert.deepEqual(calls, ['review-0', 'final-fix-1']);
  assert.equal(eventsOf(state, 'finding_downgraded').length, 0);
});

// ---- the artifacts a human reads -------------------------------------------

test('a deferred P2 with a broken citation still reaches FOLLOW-UPS.md', async () => {
  const state = reviewingRun(RUN);

  await orchestrate(
    state,
    config(),
    true,
    agents(
      {
        codex: () =>
          report([
            {
              id: 'separate-work',
              severity: 'P2',
              title: 'Worth doing elsewhere',
              detail: 'Detail.',
              suggested_fix: 'Do it later.',
              defer: true,
              evidence: [{ kind: 'code', path: 'nope.ts' }],
            },
          ]),
      },
      [],
    ),
  );

  // A bad citation must not delete a finding from a human-facing document. The
  // downgrade only ever touches severity, and a P2 has none to lose.
  const followUps = readFileSync(path.join(state.dir, 'FOLLOW-UPS.md'), 'utf8');
  assert.match(followUps, /separate-work/);
  assert.doesNotMatch(followUps, /undefined/);
  assert.equal(eventsOf(state, 'finding_downgraded').length, 0);
});

test('a stored finding with no evidence survives the readers and renders cleanly', () => {
  const state = reviewingRun(RUN);
  // Exactly what a report recorded before #48 looks like: no `evidence`, no
  // `downgraded`. `hasFindingShape` must not have learned to reject it.
  const legacy: unknown = {
    id: 'legacy-finding',
    severity: 'P2',
    title: 'Recorded before evidence existed',
    detail: 'Detail.',
    suggested_fix: 'Fix it.',
    defer: true,
  };
  assert.equal(hasFindingShape(legacy), true);
  assert.equal(Object.hasOwn(legacy as object, 'evidence'), false);

  state.deferred = [legacy as Finding];
  const file = writeFollowUps(state, planFixture());
  assert.ok(file !== null);

  const body = readFileSync(file, 'utf8');
  assert.match(body, /legacy-finding/);
  // The failure this guards against is a renderer that reaches for a field the
  // stored finding never had and prints the word `undefined` at a human.
  assert.doesNotMatch(body, /undefined/);
});

test('a run written before evidence existed still reloads with no repairs', () => {
  const state = reviewingRun(RUN);
  state.deferred = [
    {
      id: 'legacy-finding',
      severity: 'P3',
      title: 'Recorded before evidence existed',
      detail: 'Detail.',
      suggested_fix: 'Fix it.',
      defer: true,
    },
  ];
  state.outstanding = [p1('carried-one')];
  saveState(state);

  const reloaded = loadRun(state.targetDir, state.id);
  assert.equal(reloaded.events.filter((e) => e.type === 'state_repaired').length, 0);
  assert.deepEqual((reloaded.deferred ?? []).map((f) => (f as Finding).id), ['legacy-finding']);
  // The extra field rides along untouched: `readFinding` returns the entry as
  // it found it, so a stored citation is not something any reader has to learn.
  assert.deepEqual((reloaded.outstanding ?? [])[0]?.evidence, [
    { kind: 'external', ref: 'harness fixture' },
  ]);
});
