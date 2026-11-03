import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Cancelled } from '@src/cancel.js';
import { DEFAULTS, loadConfig } from '@src/config.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { orchestrate, writeFollowUps } from '@src/orchestrator.js';
import { confirmPrompt } from '@src/prompts.js';
import { confirmSeat, rolesFor, ROLES, seatTable, slotForRole, tableFor } from '@src/roles.js';
import { listCheckpoints, loadRun, saveState } from '@src/run.js';
import { CONFIRM_SCHEMA } from '@src/schemas.js';
import { slotId } from '@src/slots.js';
import { parseConfirm } from '@src/validate.js';
import { countConfirmation, failedConfirmation } from '@src/vote.js';
import type {
  Config,
  FinalFixConfirmation,
  FinalFixConfirmations,
  Finding,
  Reproducer,
  RunState,
} from '@src/types.js';
import type { RoleProviders } from '@src/roles.js';
import {
  agents,
  CITED,
  codexRaw,
  committing,
  config,
  p1,
  report,
  reproducerGate,
  reviewingRun,
  verifying,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';

/**
 * The confirmation after the final fix (#489): one fresh, read-only turn per
 * carried or guard-downgraded P1 once the gates pass, whose verdict is recorded
 * and rendered and buys nothing.
 *
 * Driven through the loop harness, as `final-fix-round.test.ts` is: the turns
 * are injected, git, the gate and `state.json` are real. On the default table
 * the confirmation runs on the provider the implementer is not on, as a turn
 * labelled `confirm-<round>-<n>`, answered by that provider's handler.
 */

const RUN = { prefix: 'vibe-confirm-', task: 'confirm the final fix', commit: true } as const;

interface Driven {
  calls: string[];
  seen: Narration[];
  prompts: Map<string, string>;
  options: Map<string, Record<string, unknown>>;
}

/** Run the loop, capturing every label, prompt, option set and narration line. */
async function drive(state: RunState, cfg: Config, handlers: Handlers): Promise<Driven> {
  const calls: string[] = [];
  const seen: Narration[] = [];
  const prompts = new Map<string, string>();
  const options = new Map<string, Record<string, unknown>>();
  const wrapped: Handlers = {
    ...handlers,
    claude: (label, o) => {
      prompts.set(label, o.prompt);
      options.set(label, o as unknown as Record<string, unknown>);
      return handlers.claude?.(label, o);
    },
    codex: (label, o) => {
      prompts.set(label, o.prompt);
      options.set(label, o as unknown as Record<string, unknown>);
      return handlers.codex?.(label, o) ?? report([]);
    },
  };
  const realLog = console.log;
  const realError = console.error;
  log.setSink((n) => void seen.push(n));
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(state, cfg, true, agents(wrapped, calls));
  } finally {
    log.setSink(null);
    console.log = realLog;
    console.error = realError;
  }
  return { calls, seen, prompts, options };
}

/** `drive`, for a run that is expected to stop. */
async function driveRejecting(state: RunState, cfg: Config, handlers: Handlers): Promise<string[]> {
  const calls: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await assert.rejects(() => orchestrate(state, cfg, true, agents(handlers, calls)));
  } finally {
    console.log = realLog;
    console.error = realError;
  }
  return calls;
}

const cfgFor = (state: RunState, loop: Partial<Config['loop']> = {}, over: Partial<Config> = {}): Config =>
  config(loop, { ...committing(), ...verifying(state), ...over });

const answer = (verdict: string, evidence: unknown[] = [...CITED], reason = 'looked at it'): object => ({
  verdict,
  reason,
  evidence,
});

/** One review raising `findings`, then confirmations answered by `confirm`. */
function reviewer(findings: readonly Finding[], confirm: (label: string) => unknown): NonNullable<Handlers['codex']> {
  return (label) => {
    if (label === 'review-0') return report([...findings]);
    if (label.startsWith('confirm-')) return confirm(label);
    return assert.fail(`${label}: nothing after the final fix may be reviewed`);
  };
}

/** A fixer that changes the tree, and says what it did with each finding when told. */
function fixer(
  state: RunState,
  dispositions?: { id: string; disposition: string; reason: string }[],
): NonNullable<Handlers['claude']> {
  return (label) => {
    work(state, `${label}.txt`);
    return dispositions === undefined ? 'fixed it' : { report: '## Changed\nfixed', dispositions };
  };
}

/** A P1 that cites nothing: grounding moves it to P2, from P1 (#48). */
function uncited(id: string): Finding {
  return { id, severity: 'P1', title: `Claim ${id}`, detail: `Detail of ${id}.`, suggested_fix: 'Repair it.' };
}

const record = (state: RunState): FinalFixConfirmations => {
  const r = state.finalFixConfirmations;
  assert.ok(r !== undefined, 'a confirmation record was kept');
  return r;
};

const verdictOf = (state: RunState, id: string): FinalFixConfirmation => {
  const found = record(state).findings.find((c) => c.id === id);
  assert.ok(found !== undefined, `a verdict for ${id}`);
  return found;
};

const outstandingText = (state: RunState): string => readFileSync(path.join(state.dir, 'OUTSTANDING.md'), 'utf8');
const followUpsPath = (state: RunState): string => path.join(state.dir, 'FOLLOW-UPS.md');

/** The `Left by the final fix round` section of FOLLOW-UPS.md, or '' when there is none. */
function leftSection(state: RunState): string {
  if (!existsSync(followUpsPath(state))) return '';
  const text = readFileSync(followUpsPath(state), 'utf8');
  const at = text.indexOf('## Left by the final fix round');
  return at === -1 ? '' : text.slice(at);
}

// ---- the verdict, recorded and rendered, buying nothing ----------------------

test('a tolerated P1 confirmed fixed: recorded, rendered, counted, and the run ends after one final round', async () => {
  const state = reviewingRun(RUN);
  const d = await drive(state, cfgFor(state), {
    codex: reviewer([p1('tolerated-one')], () => answer('fixed', [...CITED], 'the guard is in place')),
    claude: fixer(state),
  });

  assert.deepEqual(d.calls, ['review-0', 'final-fix-1', 'confirm-1-1']);
  assert.equal(state.phase, 'complete');
  const v = verdictOf(state, 'tolerated-one');
  assert.equal(v.verdict, 'fixed');
  assert.equal(v.counted, 'fixed');
  assert.equal(v.source, 'seat');
  assert.equal(v.countedReason, undefined);

  const text = outstandingText(state);
  assert.match(text, /\*After the final fix:\* confirmed fixed - a fresh read-only codex turn \(default\): the guard is in place/);
  assert.equal(text.includes('nobody has confirmed they are gone'), false);
  assert.match(text, /checked it: 1 confirmed fixed/);
  assert.match(text, /shown only the claim and the fix's diff/);

  const artifact = JSON.parse(readFileSync(path.join(state.dir, 'final-fix-confirm-1.json'), 'utf8')) as {
    round: number;
    scope: string;
    findings: FinalFixConfirmation[];
  };
  assert.equal(artifact.round, 1);
  assert.equal(artifact.scope, 'since-last-review');
  assert.deepEqual(artifact.findings, record(state).findings);

  assert.equal(state.events.filter((e) => e.type === 'final_fix_confirmed').length, 1);
  assert.ok(
    d.seen.some((n) => n.message === 'Carried findings addressed and verification still passes - checked after the gates: 1 confirmed fixed.'),
  );
});

test('still-present is recorded and rendered, buys no further turn, and ends the run as fixed does', async () => {
  const runWith = async (verdict: string): Promise<{ state: RunState; d: Driven }> => {
    const state = reviewingRun(RUN);
    const d = await drive(state, cfgFor(state), {
      codex: reviewer([p1('tolerated-one')], () => answer(verdict, [], 'the check is still missing')),
      claude: fixer(state),
    });
    return { state, d };
  };
  const present = await runWith('still-present');
  const fixed = await runWith('fixed');

  // One final round, never two: nothing after the confirmation, of any kind.
  assert.deepEqual(present.d.calls, ['review-0', 'final-fix-1', 'confirm-1-1']);
  assert.equal(verdictOf(present.state, 'tolerated-one').counted, 'still-present');
  assert.match(outstandingText(present.state), /\*After the final fix:\* still present - .*the check is still missing/);
  assert.equal(present.state.phase, fixed.state.phase);
  assert.equal(present.state.status, fixed.state.status);
  assert.equal(present.state.reviewRound, 1);
  assert.equal(present.state.pendingFindings, null);
  // The severity is the reviewer's, untouched by the verdict.
  assert.equal(present.state.outstanding?.[0]?.severity, 'P1');
});

test('a fixed whose evidence resolves to nothing counts as cannot-tell, and both are kept', async () => {
  const state = reviewingRun(RUN);
  await drive(state, cfgFor(state), {
    codex: reviewer([p1('tolerated-one')], () => answer('fixed', [{ kind: 'code', path: 'no/such/file.ts' }])),
    claude: fixer(state),
  });

  const v = verdictOf(state, 'tolerated-one');
  assert.equal(v.verdict, 'fixed');
  assert.equal(v.counted, 'cannot-tell');
  assert.match(v.countedReason ?? '', /resolved to nothing/);
  assert.match(outstandingText(state), /could not be confirmed - .*\(it answered fixed, counted as cannot-tell/);
});

test('a failed confirmation turn is cannot-tell with the failure as its reason, and the run finishes', async () => {
  const state = reviewingRun(RUN);
  const d = await drive(state, cfgFor(state), {
    codex: reviewer([p1('tolerated-one')], () => {
      throw new Error('boom');
    }),
    claude: fixer(state),
  });

  assert.deepEqual(d.calls, ['review-0', 'final-fix-1', 'confirm-1-1']);
  assert.equal(state.phase, 'complete');
  const v = verdictOf(state, 'tolerated-one');
  assert.equal(v.counted, 'cannot-tell');
  assert.match(v.reason, /the turn failed: boom/);
});

test('an answer that is not a confirmation is a failed turn, never a fixed', async () => {
  const state = reviewingRun(RUN);
  await drive(state, cfgFor(state), {
    codex: reviewer([p1('tolerated-one')], () => report([])),
    claude: fixer(state),
  });
  assert.equal(verdictOf(state, 'tolerated-one').counted, 'cannot-tell');
});

// ---- which findings --------------------------------------------------------

test('a guard-downgraded P1 the fixer marked fixed is confirmed, and FOLLOW-UPS.md lists it only if not confirmed gone', async () => {
  for (const verdict of ['still-present', 'fixed'] as const) {
    const state = reviewingRun(RUN);
    const d = await drive(state, cfgFor(state), {
      codex: reviewer([uncited('guarded-one')], () => answer(verdict, verdict === 'fixed' ? [...CITED] : [])),
      claude: fixer(state, [{ id: 'guarded-one', disposition: 'fixed', reason: 'done' }]),
    });

    assert.deepEqual(d.calls, ['review-0', 'final-fix-1', 'confirm-1-1'], verdict);
    assert.deepEqual(state.finalFixNonBlocking, ['guarded-one']);
    assert.equal(record(state).claims[0]?.downgraded?.from, 'P1');
    assert.equal(verdictOf(state, 'guarded-one').counted, verdict);
    // No P1 was tolerated, so there is still no OUTSTANDING.md.
    assert.equal(existsSync(path.join(state.dir, 'OUTSTANDING.md')), false);
    const section = leftSection(state);
    if (verdict === 'still-present') {
      assert.match(section, /`guarded-one`/);
      assert.match(section, /\*Raised as:\* P1 - /);
      assert.match(section, /\*Fixer's disposition:\* fixed/);
      assert.match(section, /\*After the final fix:\* still present/);
    } else {
      assert.equal(section, '', 'confirmed gone, so no entry');
    }
  }
});

test('a guard-downgraded P1 the fixer left carries its verdict in its FOLLOW-UPS.md entry', async () => {
  const state = reviewingRun(RUN);
  await drive(state, cfgFor(state), {
    codex: reviewer([uncited('guarded-one')], () => answer('cannot-tell', [])),
    claude: fixer(state, [{ id: 'guarded-one', disposition: 'rebutted', reason: 'not real' }]),
  });

  const section = leftSection(state);
  assert.match(section, /\*Fixer's disposition:\* rebutted - not real\n\n\*After the final fix:\* could not be confirmed/);
  assert.doesNotMatch(section, /Raised as/);
});

test('a P1 a review-time reproducer moved down is confirmed too', async () => {
  const state = reviewingRun(RUN);
  const withRepro: Finding = {
    ...p1('repro-moved'),
    reproducer: { path: 'repro/witness.txt', contents: '// asserts nothing\n' } satisfies Reproducer,
  };
  const d = await drive(
    state,
    config(
      {},
      {
        ...committing(),
        verify: { ...DEFAULTS.verify, enabled: true, command: reproducerGate(state), runs: 1, timeoutMs: 30_000 },
      },
    ),
    {
      codex: reviewer([withRepro], () => answer('fixed')),
      claude: fixer(state, [{ id: 'repro-moved', disposition: 'fixed', reason: 'done' }]),
    },
  );

  assert.equal(state.finalFixNonBlocking?.includes('repro-moved'), true);
  assert.deepEqual(d.calls, ['review-0', 'final-fix-1', 'confirm-1-1']);
  assert.equal(verdictOf(state, 'repro-moved').source, 'seat');
});

test('a plain P2 left to address is not confirmed', async () => {
  const state = reviewingRun(RUN);
  const p2: Finding = { ...p1('plain-p2'), severity: 'P2' };
  const d = await drive(state, cfgFor(state), {
    codex: reviewer([p2], () => answer('fixed')),
    claude: fixer(state, [{ id: 'plain-p2', disposition: 'fixed', reason: 'done' }]),
  });
  assert.deepEqual(d.calls, ['review-0', 'final-fix-1']);
  assert.equal(state.finalFixConfirmations, undefined);
  assert.equal(existsSync(path.join(state.dir, 'final-fix-confirm-1.json')), false);
});

test('a carried P1 closed by its own reproducer is recorded fixed from it, with no turn', async () => {
  const state = reviewingRun(RUN);
  const proven: Finding = {
    ...p1('proven-one'),
    reproducer: { path: 'repro/witness.txt', contents: 'FAIL - carried\n' },
  };
  const d = await drive(
    state,
    config(
      { maxReviewRounds: 3 },
      {
        ...committing(),
        verify: {
          ...DEFAULTS.verify,
          enabled: true,
          command: reproducerGate(state, { fixedBy: 'fixed.txt' }),
          runs: 1,
          timeoutMs: 30_000,
        },
      },
    ),
    {
      codex: reviewer([proven], () => answer('still-present')),
      claude: (label) => {
        if (label.startsWith('final-fix-')) writeFileSync(path.join(state.targetDir, 'fixed.txt'), 'done\n', 'utf8');
        return 'fixed';
      },
    },
  );

  assert.equal(d.calls.some((c) => c.startsWith('confirm-')), false);
  const v = verdictOf(state, 'proven-one');
  assert.equal(v.source, 'reproducer');
  assert.equal(v.counted, 'fixed');
  assert.equal(v.seat, undefined);
  assert.match(outstandingText(state), /confirmed fixed, by its reproducer passing after the fix/);
});

// ---- the seat ----------------------------------------------------------------

test('the seat is the vendor the implementer is not on, fresh and read-only, never main', () => {
  const byDefault = confirmSeat(DEFAULTS, ROLES);
  assert.deepEqual(byDefault, { setting: { provider: 'codex' }, sharesImplementerVendor: false });
  assert.equal(slotForRole('reviewer', seatTable(ROLES, byDefault.setting, CONFIRM_SCHEMA)), 'fresh-codex');

  const codexWrites: RoleProviders = { ...DEFAULTS.roles, implementer: 'codex' } as RoleProviders;
  const swapped = tableFor(codexWrites);
  const onClaude = confirmSeat({ ...DEFAULTS, roles: codexWrites }, swapped);
  assert.equal(onClaude.setting.provider, 'claude');
  assert.equal(onClaude.sharesImplementerVendor, false);
  assert.equal(slotForRole('reviewer', seatTable(swapped, onClaude.setting, CONFIRM_SCHEMA)), 'fresh-claude');

  const allClaude = {
    planner: 'claude',
    implementer: 'claude',
    critic: 'claude',
    answerer: 'claude',
    reviewer: { provider: 'claude', model: 'claude-reviewer-model', effort: 'high' },
  } as RoleProviders;
  const single = confirmSeat({ ...DEFAULTS, roles: allClaude }, tableFor(allClaude));
  assert.deepEqual(single, {
    setting: { provider: 'claude', model: 'claude-reviewer-model', effort: 'high' },
    sharesImplementerVendor: true,
  });
  assert.equal(slotForRole('reviewer', seatTable(tableFor(allClaude), single.setting, CONFIRM_SCHEMA)), 'fresh-claude');
});

test('implementer on Claude, reviewer on Codex: the confirmation is a fresh Codex turn on the reviewer model', async () => {
  const state = reviewingRun(RUN);
  const roles = { ...DEFAULTS.roles, reviewer: { provider: 'codex', model: 'review-model-x' } } as RoleProviders;
  const d = await drive(state, cfgFor(state, {}, { roles }), {
    codex: reviewer([p1('tolerated-one')], () => answer('fixed')),
    claude: fixer(state),
  });

  const o = d.options.get('confirm-1-1');
  assert.ok(o !== undefined, 'the confirmation reached Codex');
  assert.equal(o['model'], 'review-model-x');
  assert.equal(o['sessionId'] ?? null, null, 'a fresh thread, never a resumed one');
  assert.equal(o['sandbox'], DEFAULTS.codex.sandbox);
  assert.deepEqual(verdictOf(state, 'tolerated-one').seat, {
    provider: 'codex',
    model: 'review-model-x',
    sharesImplementerVendor: false,
  });
});

test('implementer on Codex: the confirmation is a fresh Claude turn, not main', async () => {
  const state = reviewingRun(RUN);
  const roles = { ...DEFAULTS.roles, implementer: 'codex' } as RoleProviders;
  const d = await drive(state, cfgFor(state, {}, { roles }), {
    codex: (label) => {
      if (label === 'review-0') return report([p1('tolerated-one')]);
      work(state, `${label}.txt`);
      return codexRaw('fixed it');
    },
    claude: (label) => (label.startsWith('confirm-') ? answer('fixed') : assert.fail(`${label} on Claude`)),
  });

  assert.deepEqual(d.calls, ['review-0', 'final-fix-1', 'confirm-1-1']);
  const o = d.options.get('confirm-1-1');
  assert.ok(o !== undefined, 'the confirmation reached Claude');
  assert.equal(o['resume'], false);
  assert.equal(o['permissionMode'], 'plan');
  assert.notEqual(o['sessionId'], slotId(state, 'main'));
  assert.equal(verdictOf(state, 'tolerated-one').seat?.provider, 'claude');
});

test('a single-vendor table confirms on a fresh Claude turn and says it shares the implementer vendor', async () => {
  const state = reviewingRun(RUN);
  const roles = {
    planner: 'claude',
    implementer: 'claude',
    critic: 'claude',
    answerer: 'claude',
    reviewer: 'claude',
  } as RoleProviders;
  const cfg = cfgFor(state, {}, { roles });
  assert.deepEqual(rolesFor(cfg).reviewer.provider, 'claude');
  const d = await drive(state, cfg, {
    codex: () => assert.fail('no Codex turn on a Claude-only run'),
    claude: (label) => {
      if (label === 'review-0') return report([p1('tolerated-one')]);
      if (label.startsWith('confirm-')) return answer('fixed');
      work(state, `${label}.txt`);
      return 'fixed it';
    },
  });

  assert.deepEqual(d.calls, ['review-0', 'final-fix-1', 'confirm-1-1']);
  const o = d.options.get('confirm-1-1');
  assert.ok(o !== undefined);
  assert.equal(o['resume'], false);
  assert.notEqual(o['sessionId'], slotId(state, 'main'));
  const v = verdictOf(state, 'tolerated-one');
  assert.equal(v.seat?.provider, 'claude');
  assert.equal(v.seat?.sharesImplementerVendor, true);
  assert.match(outstandingText(state), /on the implementer's own vendor, as this run uses no other/);
});

// ---- what it is shown ----------------------------------------------------------

test('the prompt carries the claim and the fix diff, and nothing about the finding beyond the claim', async () => {
  const state = reviewingRun(RUN);
  const claim: Finding = {
    id: 'secret-id-xyz',
    severity: 'P1',
    title: 'Title of the claim',
    detail: 'Detail of the claim.',
    suggested_fix: 'Suggested repair of the claim.',
    evidence: [...CITED],
  };
  const reviewerSummary = 'REVIEWER_SUMMARY_TEXT';
  const fixerReport = 'FIXER_REPORT_TEXT';
  const d = await drive(state, cfgFor(state), {
    codex: (label) => {
      if (label === 'review-0') return { ...report([claim]), summary: reviewerSummary };
      return answer('fixed');
    },
    claude: () => {
      work(state, 'fix-marker.txt', 'FIX_DIFF_LINE\n');
      return { report: fixerReport, dispositions: [{ id: 'secret-id-xyz', disposition: 'fixed', reason: 'rebutted nothing' }] };
    },
  });

  const prompt = d.prompts.get('confirm-1-1') ?? '';
  assert.notEqual(prompt, '');
  for (const present of [claim.title, claim.detail, claim.suggested_fix, 'FIX_DIFF_LINE', 'fix-marker.txt']) {
    assert.ok(prompt.includes(present), `the prompt shows ${present}`);
  }
  // Each absence is of a value the run really had, so it cannot pass because
  // the value never existed.
  assert.notEqual(readFileSync(path.join(state.dir, 'fix-report-1.md'), 'utf8').indexOf(fixerReport), -1);
  assert.notEqual(JSON.stringify(state.events).indexOf('secret-id-xyz'), -1);
  for (const absent of ['secret-id-xyz', 'P1', fixerReport, reviewerSummary, 'rebutted', 'disposition']) {
    assert.equal(prompt.indexOf(absent), -1, `the prompt must not show ${absent}`);
  }
});

test('a whole-run diff says it is the whole run, not the fix', () => {
  const claim = { title: 't', detail: 'd', suggested_fix: 's' };
  const since = confirmPrompt(claim, ['a.ts'], 'diff', 'since-last-review', 'plan', []);
  const whole = confirmPrompt(claim, ['a.ts'], 'diff', 'whole-run', 'plan', []);
  assert.match(since, /## Diff since the review/);
  assert.doesNotMatch(since, /whole run/);
  assert.match(whole, /## Diff of the whole run/);
  assert.match(whole, /could not be separated from the rest of the run/);
});

test('without per-round commits the check reads the whole run, and OUTSTANDING.md says so', async () => {
  const state = reviewingRun(RUN);
  const d = await drive(state, config({}, verifying(state)), {
    codex: reviewer([p1('tolerated-one')], () => answer('fixed')),
    claude: fixer(state),
  });

  assert.deepEqual(d.calls, ['review-0', 'final-fix-1', 'confirm-1-1']);
  assert.equal(record(state).since, null);
  assert.match(d.prompts.get('confirm-1-1') ?? '', /## Diff of the whole run/);
  const artifact = JSON.parse(readFileSync(path.join(state.dir, 'final-fix-confirm-1.json'), 'utf8')) as { scope: string };
  assert.equal(artifact.scope, 'whole-run');
  const text = outstandingText(state);
  assert.match(text, /shown only the claim and the run's whole diff/);
  assert.doesNotMatch(text, /the fix's diff/);
});

test('an intent-to-add the index refuses is a diff that could not be read: no turn, not confirmed', async () => {
  // Without per-round commits, so the final fix's new file is untracked and
  // only `add -N` (or `add -A` with no base) can show it. The gate after the
  // fix leaves an index lock, which refuses both.
  for (const withBase of [false, true]) {
    const state = reviewingRun(RUN);
    if (withBase) {
      state.baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: state.targetDir, encoding: 'utf8' }).trim();
    }
    writeFileSync(
      path.join(state.targetDir, 'vibe-lock.mjs'),
      "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';\n" +
        "appendFileSync('vibe-lock-runs.txt', 'ran\\n');\n" +
        "const runs = readFileSync('vibe-lock-runs.txt', 'utf8').split('\\n').filter(Boolean).length;\n" +
        "if (runs >= 2) writeFileSync('.git/index.lock', '');\n",
      'utf8',
    );
    const d = await drive(
      state,
      config({}, { verify: { ...DEFAULTS.verify, enabled: true, command: 'node vibe-lock.mjs', runs: 1, timeoutMs: 30_000 } }),
      {
        codex: reviewer([p1('tolerated-one')], () => assert.fail('no turn on a diff that could not be read')),
        claude: (label) => {
          work(state, `brand-new-${label}.ts`, 'export const added = 1;\n');
          return 'fixed it';
        },
      },
    );

    assert.deepEqual(d.calls, ['review-0', 'final-fix-1'], `base: ${withBase}`);
    const v = verdictOf(state, 'tolerated-one');
    assert.equal(v.counted, 'cannot-tell');
    assert.match(v.reason, /^the diff could not be read: /);
    // Not a check: no turn ran, so no seat is named and nothing reads as one.
    assert.equal(v.source, 'unread-diff');
    assert.equal(v.seat, undefined);
    const text = outstandingText(state);
    assert.match(text, /\*After the final fix:\* could not be confirmed - no check ran, because the diff could not be read: /);
    assert.doesNotMatch(text, /fresh read-only/);
    // With no turn having checked anything, the summary keeps its sentence.
    assert.match(text, /So these were worked on, and nobody has confirmed they are gone\./);
    assert.equal(state.phase, 'complete');
  }
});

test('a verdict whose citations include one the reader cannot use survives a reload with no repair', async () => {
  const state = reviewingRun(RUN);
  await drive(state, cfgFor(state), {
    codex: reviewer([p1('tolerated-one')], () => answer('fixed', [...CITED, { path: 'x' }])),
    claude: fixer(state),
  });
  assert.equal(verdictOf(state, 'tolerated-one').counted, 'fixed');

  const reloaded = loadRun(state.targetDir, state.id);
  assert.equal(
    reloaded.events.some((e) => e.type === 'state_repaired' && e['field'] === 'finalFixConfirmations'),
    false,
  );
  const v = reloaded.finalFixConfirmations?.findings.find((c) => c.id === 'tolerated-one');
  assert.equal(v?.counted, 'fixed');
  assert.deepEqual(v?.evidence, [...CITED]);
});

test('the diff runs to the working tree, so a verify fix whose commit failed is in it', async () => {
  const state = reviewingRun(RUN);
  const d = await drive(
    state,
    config({ maxVerifyRounds: 2 }, { ...committing(), ...verifying(state, { failRuns: [2], baseline: false }) }),
    {
      codex: reviewer([p1('tolerated-one')], () => answer('fixed')),
      claude: (label) => {
        if (label.startsWith('final-fix-')) work(state, 'fix.txt', 'the fix\n');
        if (label.startsWith('verify-fix-')) {
          work(state, 'repair.txt', 'the repair\n');
          const hooks = path.join(state.targetDir, '.git', 'hooks');
          mkdirSync(hooks, { recursive: true });
          writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', 'utf8');
          chmodSync(path.join(hooks, 'pre-commit'), 0o755);
        }
        return 'fixed it';
      },
    },
  );

  assert.deepEqual(d.calls, ['review-0', 'final-fix-1', 'verify-fix-1', 'confirm-1-1']);
  const verifyRound = listCheckpoints(state.dir).find((c) => c.meta?.boundary === 'verify-round');
  assert.equal(verifyRound?.meta?.commitNote, 'commit-failed');
  const prompt = d.prompts.get('confirm-1-1') ?? '';
  assert.match(prompt, /fix\.txt/);
  assert.match(prompt, /repair\.txt/);
  assert.match(prompt, /## Diff since the review/);
});

// ---- resume ------------------------------------------------------------------

test('a stop after the first of two confirmations resumes buying only the second', async () => {
  const state = reviewingRun(RUN);
  const cfg = cfgFor(state);
  const first = await driveRejecting(state, cfg, {
    codex: reviewer([p1('carried-one'), uncited('guarded-one')], (label) => {
      if (label === 'confirm-1-2') throw new Cancelled('stopped from the test');
      return answer('fixed');
    }),
    claude: fixer(state, [
      { id: 'carried-one', disposition: 'fixed', reason: 'done' },
      { id: 'guarded-one', disposition: 'fixed', reason: 'done' },
    ]),
  });
  assert.deepEqual(first, ['review-0', 'final-fix-1', 'confirm-1-1', 'confirm-1-2']);
  const persisted = loadRun(state.targetDir, state.id).finalFixConfirmations;
  assert.deepEqual(persisted?.findings.map((c) => c.id), ['carried-one']);

  const resumed = loadRun(state.targetDir, state.id);
  const d = await drive(resumed, cfg, {
    codex: (label) => {
      if (label === 'confirm-1-2') return answer('still-present', []);
      return assert.fail(`${label}: bought again`);
    },
    claude: () => assert.fail('no fix after the final fix'),
  });
  assert.deepEqual(d.calls, ['confirm-1-2']);
  assert.deepEqual(
    resumed.finalFixConfirmations?.findings.map((c) => [c.id, c.counted]),
    [
      ['carried-one', 'fixed'],
      ['guarded-one', 'still-present'],
    ],
  );
  assert.equal(resumed.phase, 'complete');
});

/** A run already past its final fix and its gates, with every verdict recorded. */
function pastConfirmation(prefix: string): RunState {
  const state = reviewingRun({ ...RUN, prefix });
  state.reviewRound = 1;
  state.finalFixDone = true;
  state.outstanding = [p1('the-one')];
  state.pendingFindings = null;
  state.finalFixConfirmations = {
    round: 1,
    since: null,
    claims: [],
    findings: [
      {
        id: 'the-one',
        verdict: 'fixed',
        counted: 'fixed',
        source: 'seat',
        seat: { provider: 'codex', model: 'default', sharesImplementerVendor: false },
        reason: 'gone',
        evidence: [],
      },
    ],
  };
  return state;
}

test('a resume with every verdict recorded rewrites a missing or stale artifact and buys no turn', async () => {
  for (const stale of [false, true]) {
    const state = pastConfirmation('vibe-confirm-artifact-');
    const file = path.join(state.dir, 'final-fix-confirm-1.json');
    if (stale) writeFileSync(file, JSON.stringify({ round: 1, findings: [] }), 'utf8');
    else rmSync(file, { force: true });
    const d = await drive(state, config(), {
      codex: () => assert.fail('nothing to buy'),
      claude: () => assert.fail('nothing to buy'),
    });

    assert.deepEqual(d.calls, []);
    const written = JSON.parse(readFileSync(file, 'utf8')) as { findings: unknown };
    assert.deepEqual(written.findings, state.finalFixConfirmations?.findings);
    assert.match(outstandingText(state), /confirmed fixed - a fresh read-only codex turn \(default\): gone/);
  }
});

test('repaired follow-up inputs keep FOLLOW-UPS.md as it was, and say where the verdicts went', async () => {
  const state = reviewingRun({ ...RUN, prefix: 'vibe-confirm-guard-' });
  const guarded: Finding = {
    ...uncited('guarded-one'),
    severity: 'P2',
    downgraded: { from: 'P1', reason: 'it cited no evidence' },
  };
  const rebutted: Finding = { ...p1('rebutted-p2'), severity: 'P2' };
  state.reviewRound = 1;
  state.finalFixDone = true;
  state.outstanding = [];
  state.pendingFindings = null;
  state.finalFixNonBlocking = ['guarded-one', 'rebutted-p2'];
  state.unaddressed = [{ finding: rebutted, outcome: 'rebutted', reason: 'not real' }];
  state.finalFixConfirmations = { round: 1, since: null, claims: [guarded], findings: [] };
  assert.ok(state.plan !== null && state.plan !== undefined);
  writeFollowUps(state, state.plan);
  saveState(state);
  const before = readFileSync(followUpsPath(state), 'utf8');
  assert.match(before, /rebutted-p2/);

  // Damage the leftover, so the loader repairs it away.
  const file = path.join(state.dir, 'state.json');
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...raw, unaddressed: [{ finding: { id: 'rebutted-p2' } }] }), 'utf8');
  const resumed = loadRun(state.targetDir, state.id);
  assert.ok(resumed.events.some((e) => e.type === 'state_repaired' && e['field'] === 'unaddressed'));

  const d = await drive(resumed, config(), {
    codex: (label) => (label === 'confirm-1-1' ? answer('still-present', []) : assert.fail(label)),
    claude: () => assert.fail('no fix'),
  });
  assert.deepEqual(d.calls, ['confirm-1-1']);
  assert.equal(readFileSync(followUpsPath(state), 'utf8'), before);
  assert.ok(d.seen.some((n) => n.level === 'warn' && n.message.includes('final-fix-confirm-1.json')));
  assert.equal(resumed.finalFixConfirmations?.findings[0]?.counted, 'still-present');
});

// ---- off ---------------------------------------------------------------------

test('loop.confirmFinalFix: false buys no turn, keeps no record, and writes what it always wrote', async () => {
  const state = reviewingRun(RUN);
  const d = await drive(state, cfgFor(state, { confirmFinalFix: false }), {
    codex: reviewer([p1('tolerated-one')], () => assert.fail('no confirmation')),
    claude: fixer(state),
  });

  assert.deepEqual(d.calls, ['review-0', 'final-fix-1']);
  assert.equal(state.finalFixConfirmations, undefined);
  assert.equal(existsSync(path.join(state.dir, 'final-fix-confirm-1.json')), false);
  assert.equal(state.events.some((e) => e.type === 'final_fix_confirmed'), false);
  // OUTSTANDING.md exactly as `renderOutstanding` wrote it before #489.
  assert.equal(
    outstandingText(state),
    '# Carried findings\n\n<!-- vibe:outstanding -->\n\n' +
      `**Run:** \`${state.id}\`\n**Task:** ${state.task}\n\n` +
      'The last review raised 1 P1 finding(s), within `loop.p1Tolerance`. A final fix round addressed ' +
      'them and verification still passed, but that round was deliberately **not reviewed again** - ' +
      're-reviewing would reopen the loop the tolerance exists to close. So these were worked on, and ' +
      'nobody has confirmed they are gone.\n\n' +
      'Worth a human eye. Set `loop.p1Tolerance` to 0 to require a spotless review instead, at the ' +
      'cost of runs that cannot converge.\n\n' +
      '## Finding tolerated-one `tolerated-one`\n\nDetail.\n\n*Suggested fix:* Fix it.\n',
  );
  assert.ok(d.seen.some((n) => n.message === 'Carried findings addressed and verification still passes.'));
});

test('off, a guard-downgraded P1 the fixer left reads in FOLLOW-UPS.md as it did before', async () => {
  const state = reviewingRun(RUN);
  await drive(state, cfgFor(state, { confirmFinalFix: false }), {
    codex: reviewer([uncited('guarded-one')], () => assert.fail('no confirmation')),
    claude: fixer(state, [{ id: 'guarded-one', disposition: 'rebutted', reason: 'not real' }]),
  });
  const section = leftSection(state);
  assert.match(section, /\*Fixer's disposition:\* rebutted - not real\n\nDetail of guarded-one\./);
  assert.doesNotMatch(section, /After the final fix/);
});

// ---- part 3: reproducers after an ordinary fix round ---------------------------

function reproduced(id: string, file: string): Finding {
  return { ...p1(id), reproducer: { path: `repro/${file}`, contents: 'FAIL - it happens\n' } };
}

async function fixRound(
  options: { dispositions?: { id: string; disposition: string; reason: string }[]; fixMarker?: boolean } = {},
): Promise<{ state: RunState; d: Driven }> {
  const state = reviewingRun({ ...RUN, prefix: 'vibe-confirm-part3-' });
  const marker = path.join('.vibe', 'fixed-marker');
  const d = await drive(
    state,
    config(
      { p1Tolerance: 0, maxReviewRounds: 3 },
      {
        ...committing(),
        verify: {
          ...DEFAULTS.verify,
          enabled: true,
          command: reproducerGate(state, { fixedBy: marker }),
          runs: 1,
          timeoutMs: 30_000,
        },
      },
    ),
    {
      codex: (label) =>
        label === 'review-0' ? report([reproduced('fixed-one', 'a.txt'), reproduced('rebutted-one', 'b.txt')]) : report([]),
      claude: (label) => {
        work(state, `${label}.txt`);
        if (options.fixMarker === true) writeFileSync(path.join(state.targetDir, marker), 'x', 'utf8');
        return options.dispositions === undefined ? 'fixed it' : { report: '## Changed\nfixed', dispositions: options.dispositions };
      },
    },
  );
  return { state, d };
}

const MIXED = [
  { id: 'fixed-one', disposition: 'fixed', reason: 'done' },
  { id: 'rebutted-one', disposition: 'rebutted', reason: 'not real' },
];

test('after an ordinary fix round, only the fixed reproduced finding is re-run, once, and recorded', async () => {
  const { state, d } = await fixRound({ dispositions: MIXED });

  assert.deepEqual(d.calls, ['review-0', 'fix-1', 'review-1']);
  const afterFix = state.events.filter((e) => e.type === 'reproducer_observed' && e['at'] === 'fix');
  assert.equal(afterFix.length, 1);
  assert.equal(afterFix[0]?.['id'], 'fixed-one');
  assert.equal(afterFix[0]?.['round'], 1);
  assert.equal(state.fixReproductions?.round, 1);
  assert.deepEqual(state.fixReproductions?.outcomes.map((o) => [o.id, o.outcome.at]), [['fixed-one', 'fix']]);
  // The failure has no baseline on the changed tree, so it is unproven, as
  // `confirmFixed`'s is.
  assert.equal(state.fixReproductions?.outcomes[0]?.outcome.verdict, 'unproven');
});

test('unreadable dispositions re-run nothing after the fix round', async () => {
  const { state } = await fixRound();
  assert.equal(state.events.some((e) => e.type === 'reproducer_observed' && e['at'] === 'fix'), false);
  assert.equal(state.fixReproductions, undefined);
});

test('every prompt is the same whichever way the re-run after the fix round went', async () => {
  const a = await fixRound({ dispositions: MIXED, fixMarker: true });
  const b = await fixRound({ dispositions: MIXED });
  assert.equal(a.state.fixReproductions?.outcomes[0]?.outcome.verdict, 'did-not-reproduce');
  assert.equal(b.state.fixReproductions?.outcomes[0]?.outcome.verdict, 'unproven');

  const normal = (state: RunState, text: string): string =>
    text.split(state.dir).join('<dir>').split(state.targetDir).join('<target>').split(state.id).join('<id>');
  const labels = [...a.d.prompts.keys()];
  assert.deepEqual(labels, [...b.d.prompts.keys()]);
  assert.ok(labels.includes('review-1'));
  for (const label of labels) {
    assert.equal(
      normal(a.state, a.d.prompts.get(label) ?? ''),
      normal(b.state, b.d.prompts.get(label) ?? ''),
      `${label} is byte-identical`,
    );
  }
});

// ---- the pure pieces -----------------------------------------------------------

test('counting fails closed: only a fixed whose evidence resolved counts as fixed', () => {
  assert.deepEqual(countConfirmation('fixed', null), { counted: 'fixed' });
  assert.deepEqual(countConfirmation('fixed', 'nope.ts does not exist'), {
    counted: 'cannot-tell',
    countedReason: 'its evidence resolved to nothing: nope.ts does not exist',
  });
  assert.deepEqual(countConfirmation('still-present', 'anything'), { counted: 'still-present' });
  assert.deepEqual(countConfirmation('cannot-tell', 'anything'), { counted: 'cannot-tell' });

  const seat = { provider: 'codex', model: 'default', sharesImplementerVendor: false } as const;
  const failed = failedConfirmation('x', seat, new Error('first line\nsecond line'));
  assert.equal(failed.counted, 'cannot-tell');
  assert.equal(failed.reason, 'the turn failed: first line');
  assert.deepEqual(failed.evidence, []);
});

test('an answer that is not a confirmation is refused', () => {
  assert.deepEqual(parseConfirm({ verdict: 'fixed', reason: 'r', evidence: [] }), {
    verdict: 'fixed',
    reason: 'r',
    evidence: [],
  });
  assert.throws(() => parseConfirm({ verdict: 'real', reason: 'r', evidence: [] }));
  assert.throws(() => parseConfirm({ verdict: 'fixed' }));
  assert.throws(() => parseConfirm(null));
});

test('loop.confirmFinalFix must be a boolean', () => {
  assert.equal(DEFAULTS.loop.confirmFinalFix, true);
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-confirm-config-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ loop: { confirmFinalFix: false } }));
  assert.equal(loadConfig(dir).loop.confirmFinalFix, false);
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ loop: { confirmFinalFix: 'false' } }));
  assert.throws(() => loadConfig(dir), /loop\.confirmFinalFix must be true or false/);
});
