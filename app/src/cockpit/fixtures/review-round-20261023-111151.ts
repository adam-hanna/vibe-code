/**
 * The review round of run `20261023-111151-brief-when-the-plan-loop-stops-convergin`
 * (#394 part 2), whose round card said `tolerance P1≤0` and *"The gate blocked
 * this round."* over a review the loop called clean (#437).
 *
 * Copied, not read: a test never opens `.vibe/`.
 *
 * `REPLAYED` is what `readRunReplay` (`src/replay.ts`) produced for that run's
 * review round, verbatim - the steps from `phase_started` through the census.
 * That census is rebuilt from `code-review-0.json`, which holds the report and
 * not the gate's decision, so it carries `phase` and `counts` and nothing else.
 *
 * `LIVE` is the same round as the running loop said it. Narration is not kept
 * in `state.json`, so its `findings_reported` is the frame `sayFindings`
 * builds, filled from the run's own record: the transcript's
 * `Review: 0 P0 · 0 P1 · 2 P2 · 0 P3 (tolerance 1 P1)` and
 * `Review clean - 2 non-blocking finding(s)` (so `pass: true`, `reason: null`,
 * `tolerated: []`, as `gate()` returns for no P1s), and the two findings in
 * `code-review-0.json`.
 */

type Step = {
  at: number;
  narration: {
    level: 'detail' | 'info';
    message: string;
    id: string;
    data: Record<string, unknown>;
  };
};

const OPENED: readonly Step[] = [
  {
    at: 1792781846467,
    narration: { level: 'detail', message: 'review 0', id: 'phase_started', data: { phase: 'review', round: 0 } },
  },
  {
    at: 1792781846467,
    narration: {
      level: 'detail',
      message: 'reviewer · review',
      id: 'turn_started',
      data: { role: 'reviewer', kind: 'review', round: 0, unmeasured: false },
    },
  },
  {
    at: 1792782137570,
    narration: {
      level: 'detail',
      message: 'review-0 charged',
      id: 'codex_turn',
      data: {
        label: 'review-0',
        tokens: 5351884,
        contextTokens: 5317602,
        items: { agent_message: 2, command_execution: 33 },
        toolItems: 33,
        runTokens: 48007710,
        runCostUsd: 14.2038,
        codexTokens: 28580604,
      },
    },
  },
];

export const REPLAYED: readonly Step[] = [
  ...OPENED,
  {
    at: 1792782137570,
    narration: {
      level: 'detail',
      message: 'review round 1',
      id: 'findings_reported',
      data: { phase: 'review', counts: { P0: 0, P1: 0, P2: 2, P3: 0 } },
    },
  },
];

const finding = (id: string, title: string) => ({
  id,
  severity: 'P2',
  title,
  raisedBy: 'reviewer',
  evidence: 2,
  downgraded: null,
  severityChanges: null,
  reproducer: null,
  deferred: false,
});

export const LIVE: readonly Step[] = [
  ...OPENED,
  {
    at: 1792782137570,
    narration: {
      level: 'info',
      message: 'Review: 0 P0 · 0 P1 · 2 P2 · 0 P3 (tolerance 1 P1)',
      id: 'findings_reported',
      data: {
        phase: 'review',
        counts: { P0: 0, P1: 0, P2: 2, P3: 0 },
        tolerance: 1,
        pass: true,
        reason: null,
        tolerated: [],
        findings: [
          finding(
            'answer-demotion-notice-only-on-gate-pass',
            'Answer-plus-demotion explanation is skipped when the gate still fails',
          ),
          finding('stored-reader-test-file-missing', 'The required stored-reader test file was not added'),
        ],
      },
    },
  },
];
