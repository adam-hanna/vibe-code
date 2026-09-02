import assert from 'node:assert/strict';
import test from 'node:test';
import { downgradeInert, isInert } from '@src/evidence.js';
import { orchestrate } from '@src/orchestrator.js';
import type { Finding, FindingsReport, TurnActivity } from '@src/types.js';
import {
  active,
  agents,
  BLOCKING,
  config,
  freshRun,
  inert,
  p1,
  planFixture,
  report,
  reviewingRun,
} from './helpers/loop-harness.js';

/**
 * The second guard on a blocking finding: did the turn that produced it look?
 *
 * #48 asks whether a finding names a real place. This asks whether the reviewer
 * used its shell at all - and the two are orthogonal by construction, which is
 * why one does not subsume the other. The #44 finding cited nothing only because
 * the schema then had no `evidence` field; today's reviewer would cite a real
 * file with a real excerpt, grounding would pass it, and the false P1 would
 * still buy a fix round.
 *
 * The rule is zero tool items exactly, and it belongs to the reviewer alone.
 * Both halves are cases below.
 */

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: 'a-finding',
    severity: 'P1',
    title: 'A finding',
    detail: 'Detail.',
    suggested_fix: 'Fix it.',
    defer: false,
    ...over,
  };
}

function reportOf(findings: readonly Finding[]): FindingsReport {
  return { verdict: 'REVISE', summary: 'summary', findings: [...findings] };
}

// ---- isInert ----------------------------------------------------------------

test('a turn that emitted items and used no tool is inert, and nothing else is', () => {
  assert.equal(isInert({ items: { agent_message: 3 }, tool: 0 }), true);
  assert.equal(isInert({ items: { agent_message: 1, command_execution: 1 }, tool: 1 }), false);
});

test('an unmeasured turn is never inert', () => {
  // No heartbeat at all - `progress.enabled` off, the preflight probe, or an
  // injected agent in a test. Fail closed in the direction that costs a
  // detection rather than a finding.
  assert.equal(isInert(undefined), false);
});

test('an empty tally is nothing observed, not nothing done', () => {
  // The stream produced no items of any kind. That is the same answer as no
  // heartbeat, and deliberately not the same as "used no tools".
  assert.equal(isInert({ items: {}, tool: 0 }), false);
});

// ---- downgradeInert ---------------------------------------------------------

test('an inert turn blocking findings become P2, keeping the severity it gave them', () => {
  const { report: out, downgraded } = downgradeInert(
    reportOf([finding({ id: 'zero', severity: 'P0' }), finding({ id: 'one', severity: 'P1' })]),
    inert(3),
  );

  assert.deepEqual(out.findings.map((f) => f.severity), ['P2', 'P2']);
  assert.deepEqual(out.findings.map((f) => f.downgraded?.from), ['P0', 'P1']);
  assert.deepEqual(downgraded.map((f) => f.id), ['zero', 'one']);
});

test('the reason states what was observed rather than passing judgement', () => {
  const { report: out } = downgradeInert(reportOf([finding()]), {
    items: { agent_message: 3, reasoning: 2 },
    tool: 0,
  });

  const reason = out.findings[0]?.downgraded?.reason ?? '';
  assert.match(reason, /used no tools/);
  // The counts, so the event log and the artifact both say what the run saw.
  assert.match(reason, /5 items/);
  assert.match(reason, /agent_message x3/);
  assert.match(reason, /reasoning x2/);
});

test('a non-blocking finding from an inert turn is untouched', () => {
  const { report: out, downgraded } = downgradeInert(
    reportOf([finding({ id: 'two', severity: 'P2' }), finding({ id: 'three', severity: 'P3' })]),
    inert(),
  );

  assert.deepEqual(out.findings.map((f) => f.severity), ['P2', 'P3']);
  assert.deepEqual(out.findings.map((f) => f.downgraded), [undefined, undefined]);
  assert.deepEqual(downgraded, []);
});

test('one tool item is enough: there is no threshold', () => {
  // Zero is the only number here nobody invented. The census has no
  // near-boundary case either - every other review turn in the archive ran
  // between 5 and 154 commands.
  const one: TurnActivity = { items: { command_execution: 1, agent_message: 4 }, tool: 1 };

  const { report: out, downgraded } = downgradeInert(reportOf([finding()]), one);

  assert.equal(out.findings[0]?.severity, 'P1');
  assert.deepEqual(downgraded, []);
});

test('an unmeasured or unobserved turn downgrades nothing', () => {
  for (const activity of [undefined, { items: {}, tool: 0 }]) {
    const { report: out, downgraded } = downgradeInert(reportOf([finding()]), activity);
    assert.equal(out.findings[0]?.severity, 'P1');
    assert.deepEqual(downgraded, []);
  }
});

test('the input report is not mutated: the artifact is written from these objects', () => {
  const original = finding();
  const input = reportOf([original]);

  downgradeInert(input, inert());

  assert.equal(original.severity, 'P1');
  assert.equal(input.findings[0]?.severity, 'P1');
});

// ---- through the loop -------------------------------------------------------

const RUN = { prefix: 'vibe-inert-', task: 'inert review' } as const;

/** A run parked at the plan phase, so the critic is the next turn taken. */
function planningRun(): ReturnType<typeof freshRun> {
  return freshRun({ ...RUN, planOnly: true, git: true, commit: true });
}

test('the critic is not held to the rule, even when its turn ran nothing', () => {
  // Decision 3 of #66, and the census is why it is a decision rather than an
  // oversight: 2 of 65 critique turns ran zero commands, and nothing in the
  // archive says either was wrong. The critic attacks a *plan*, before any code
  // exists; reading the plan is its prompt, and a plan critique that runs no
  // shell has not failed to gather evidence.
  const state = planningRun();
  const calls: string[] = [];

  return orchestrate(
    state,
    config(),
    false,
    agents(
      {
        claude: () => planFixture(),
        codex: (() => {
          let asked = 0;
          return (): unknown => {
            asked += 1;
            // Two P1s, because one is inside the default `p1Tolerance` and
            // would not force a revision even from an active turn. Clean the
            // second time, so the loop ends rather than grinding to its cap.
            return asked === 1 ? report(BLOCKING) : report([]);
          };
        })(),
        // Every turn of the run ran nothing at all.
        activity: () => inert(),
      },
      calls,
    ),
  ).then(() => {
    assert.ok(
      calls.filter((c) => c.startsWith('critique-')).length > 1,
      `the critic's P1 should still have bought a revision round: ${calls.join(', ')}`,
    );
    const downgrades = state.events.filter((e) => e.type === 'finding_downgraded');
    assert.deepEqual(downgrades, [], 'nothing the critic said should have been downgraded');
  });
});

test('grounding wins the race: a P1 that cited nothing AND ran nothing is downgraded once', async () => {
  // Order is the point, and only the real seam can show it: `groundAndRecord`
  // grounds first and applies inertness to the survivors, so a finding that
  // fails both is downgraded once - `downgraded.from` still names the severity
  // the model gave, and the recorded reason is the more specific of the two.
  const state = reviewingRun(RUN);

  await orchestrate(
    state,
    config(),
    true,
    agents(
      {
        claude: () => assert.fail('neither guard should have left a blocking finding'),
        codex: () =>
          report([
            {
              id: 'floating-claim',
              severity: 'P1',
              title: 'A claim about code nobody read',
              detail: 'Detail.',
              suggested_fix: 'Fix it.',
              defer: false,
            },
          ]),
        activity: () => inert(),
      },
      [],
    ),
  );

  const downgrades = state.events.filter((e) => e.type === 'finding_downgraded');
  assert.equal(downgrades.length, 1, 'downgraded once, not twice');
  assert.equal(downgrades[0]?.['from'], 'P1');
  assert.equal(downgrades[0]?.['reason'], 'it cited no evidence');
});

test('an inert reviewer downgrades a well-cited P1 that grounding passes', async () => {
  // The #44 shape as it would arrive today: the finding cites something that
  // resolves, so #48 lets it through untouched. This is the whole reason the
  // second guard exists.
  const state = reviewingRun(RUN);

  await orchestrate(
    state,
    config(),
    true,
    agents({ codex: () => report([p1('well-cited-but-unlooked-at')]), activity: () => inert() }, []),
  );

  const downgrades = state.events.filter((e) => e.type === 'finding_downgraded');
  assert.equal(downgrades.length, 1);
  assert.equal(downgrades[0]?.['id'], 'well-cited-but-unlooked-at');
  assert.match(String(downgrades[0]?.['reason']), /used no tools/);
});

test('a control: an active turn leaves the same report alone', () => {
  const { report: out, downgraded } = downgradeInert(reportOf([finding()]), active(30));

  assert.equal(out.findings[0]?.severity, 'P1');
  assert.deepEqual(downgraded, []);
});
