import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readRunRecord } from '@src/run.js';
import { KNOWN_MODELS, PROVIDERS } from '@src/roles.js';
import { decode } from '@src/protocol.js';

/**
 * A run's own record, read back after the process that made it has gone (#223).
 *
 * **What this is the fix for.** Opening a run repointed six panes and left the
 * loop column beside them showing the live run, with a strip saying so — which
 * was honest and was still the wrong answer: *"when I click on an existing run,
 * I don't see the right nav update."* The column stayed because it had nothing
 * to follow with. `reduce` builds a `Run` out of narration and a finished run's
 * narration went to a process that has exited, so replaying it would draw a live
 * card for a turn nobody is waiting on.
 *
 * `state.json` is what is still true, so the core reads it and shapes it. Every
 * case below is about that shaping being a *read* rather than a derivation.
 */

function repoWith(state: Record<string, unknown>, id = '20260101-000000-a-run'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-record-'));
  const runDir = path.join(dir, '.vibe', 'runs', id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    path.join(runDir, 'state.json'),
    JSON.stringify({
      id,
      dir: runDir,
      targetDir: dir,
      task: 'build the thing',
      sessionId: 'session-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'done',
      planRound: 0,
      reviewRound: 0,
      questionRound: 0,
      verifyRound: 0,
      verifyRounds: [],
      costUsd: 0,
      tokensUsed: 0,
      rateLimitWaits: 0,
      baseSha: null,
      branch: null,
      events: [],
      sessionStarted: false,
      planOnly: false,
      answeredQuestions: [],
      deferredQuestions: [],
      sessionRotations: 0,
      codexSessionId: null,
      handoff: null,
      contextRatio: 0,
      plan: null,
      pendingAnswers: null,
      extraContext: null,
      ...state,
    }),
    'utf8',
  );
  return dir;
}

// ---- it is a read, and the numbers are the run's own ------------------------

test('the four round counters come back as the run wrote them', () => {
  // Four counters, not one "progress". A question round is deliberately its own
  // number: `advancesRound`'s rule is that a revision answering the planner's
  // own answers is not the producer's side of a round, because nothing judged
  // anything — so folding it into the plan rounds would report a different run.
  const dir = repoWith({ planRound: 3, questionRound: 2, reviewRound: 1, verifyRound: 4 });
  const record = readRunRecord(dir, '20260101-000000-a-run');
  assert.deepEqual(record.rounds, { plan: 3, question: 2, review: 1, verify: 4 });
});

test('a run that charged nothing reports no cost, not zero dollars', () => {
  // The rule every other spend readout in this product follows: a run that has
  // charged nothing has not spent zero, it has not been measured. `$0.00` over a
  // run whose accounting never ran is the fabrication this repo refuses.
  const record = readRunRecord(repoWith({ tokensUsed: 0, costUsd: 0 }), '20260101-000000-a-run');
  assert.equal(record.spend.tokens, 0);
  assert.equal(record.spend.costUsd, null);
});

test('a run with no Codex turn reports its Codex total as absent', () => {
  // `codexTokens` is optional on `RunState` precisely because a run that never
  // took a Codex turn has not measured a Codex total.
  const none = readRunRecord(repoWith({ tokensUsed: 500 }), '20260101-000000-a-run');
  assert.equal(none.spend.codexTokens, null);
  const some = readRunRecord(
    repoWith({ tokensUsed: 500, codexTokens: 120 }),
    '20260101-000000-a-run',
  );
  assert.equal(some.spend.codexTokens, 120);
});

test('the finding lists come back as counts and an absent list is zero of them', () => {
  // Counts rather than the findings: the findings are in the round's own
  // artifact and the Code review tab already reads it. A zero here is the length
  // of a list that is genuinely empty, which is a different claim from a
  // measurement nobody took — and the four fields are always present.
  const dir = repoWith({
    carried: [{ id: 'F1', severity: 'P1', title: 't', detail: 'd', suggested_fix: 'f' }],
    declined: [],
  });
  const record = readRunRecord(dir, '20260101-000000-a-run');
  assert.equal(record.findings.carried, 1);
  assert.equal(record.findings.declined, 0);
  assert.equal(record.findings.outstanding, 0);
});

// ---- how it ended is selected by type, never read out of prose --------------

test('the ending is the last escalation or error, by TYPE', () => {
  // Never by picking the most alarming sentence out of the log, which is the
  // English-matching #133 exists to prevent and which picks the wrong line: an
  // escalation narrates at `warn`, and a healthy run is full of warnings that
  // are not the ending.
  const dir = repoWith({
    events: [
      { at: '2026-01-01T00:01:00.000Z', type: 'error', message: 'an earlier one' },
      { at: '2026-01-01T00:02:00.000Z', type: 'claude_turn', tokens: 10 },
      { at: '2026-01-01T00:03:00.000Z', type: 'escalation', message: 'the planner gave up' },
      { at: '2026-01-01T00:04:00.000Z', type: 'codex_turn', tokens: 10 },
    ],
  });
  assert.deepEqual(readRunRecord(dir, '20260101-000000-a-run').ended, {
    type: 'escalation',
    message: 'the planner gave up',
  });
});

test('a run that simply finished has no ending phrase invented for it', () => {
  // The status already says it completed. A sentence composed here would make
  // every ending read as a failure, which is the mistake the footer's exit-code
  // map exists to avoid: exit 7 and exit 2 must never say "failed".
  assert.equal(readRunRecord(repoWith({}), '20260101-000000-a-run').ended, null);
});

test('an ending whose message is not a string reports the type alone', () => {
  // Fail closed rather than stringify: the type is the fact and the sentence is
  // the elaboration, so a missing sentence loses the elaboration and nothing
  // else. `[object Object]` where a reason goes is worse than no reason.
  const dir = repoWith({
    events: [{ at: '2026-01-01T00:01:00.000Z', type: 'error', message: { nested: true } }],
  });
  assert.deepEqual(readRunRecord(dir, '20260101-000000-a-run').ended, {
    type: 'error',
    message: '',
  });
});

// ---- the guards are `loadRun`'s, not a second set ---------------------------

test('a run id that is not a single entry under .vibe/runs is refused', () => {
  // Through `loadRun`, so there is one definition of a legal run and one set of
  // guards. A record that answered where a load would refuse would be a second
  // road into a run's directory.
  const dir = repoWith({});
  assert.throws(() => readRunRecord(dir, '../elsewhere'), /run id|not a/i);
});

test('a linked run directory is refused rather than followed', (t) => {
  // #53's rule, inherited whole: following a link to *read* a run is the same
  // door as following one to delete recursively.
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-record-link-'));
  const root = path.join(dir, '.vibe', 'runs');
  mkdirSync(root, { recursive: true });
  const real = mkdtempSync(path.join(tmpdir(), 'vibe-record-target-'));
  try {
    symlinkSync(real, path.join(root, 'linked-run'), 'junction');
  } catch {
    // Creating a link can need a privilege this machine does not grant. The
    // refusal is what is being tested, not the filesystem's permission model.
    t.skip('this machine cannot create a link');
    return;
  }
  assert.throws(() => readRunRecord(dir, 'linked-run'), /link|junction/i);
});

// ---- the frame that carries it ----------------------------------------------

test('a record request with no dir or no runId is refused by name', () => {
  // Both fields checked for `archive`'s reason: an empty `dir` resolves to the
  // host's cwd, which is a *different repository's* archive answered as though
  // it were this one — the worst way for a read to fail, because it succeeds.
  for (const frame of [
    { type: 'record', id: 1, runId: 'r' },
    { type: 'record', id: 1, dir: '', runId: 'r' },
    { type: 'record', id: 1, dir: 'd' },
  ]) {
    const got = decode(JSON.stringify(frame));
    assert.equal(got.ok, false);
  }
  const good = decode(JSON.stringify({ type: 'record', id: 1, dir: 'd', runId: 'r' }));
  assert.equal(good.ok, true);
});

// ---- the model list is offered, never enforced ------------------------------

test('every agent has a model list and every name on it is non-empty', () => {
  // A list a window may OFFER. It is not an allowlist and `validateRoleSetting`
  // is unchanged — *"guessing whether a model exists is the never-invent-a-number
  // rule applied to a name"* still holds, which is why a value not on this list
  // is still typed, still saved and still shown.
  for (const provider of PROVIDERS) {
    const models = KNOWN_MODELS[provider];
    assert.ok(models.length > 0, `${provider} has no models to offer`);
    for (const model of models) assert.notEqual(model.trim(), '');
  }
});

test('the list has an entry for every agent and no agent this build cannot seat', () => {
  // One list, keyed by the same names `PROVIDERS` holds. A second vocabulary is
  // one that can disagree, and the disagreement is a row whose select is empty.
  assert.deepEqual(Object.keys(KNOWN_MODELS).sort(), [...PROVIDERS].sort());
});
