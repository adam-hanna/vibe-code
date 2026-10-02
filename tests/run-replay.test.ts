import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readRunReplay } from '@src/run.js';
import { replayRun, seatOf } from '@src/replay.js';
import type { ReplaySources } from '@src/replay.js';
import { KNOWN_MODELS, PROVIDERS } from '@src/roles.js';
import { decode } from '@src/protocol.js';
import type { RunState } from '@src/types.js';

/**
 * A finished run, said again (#223).
 *
 * **What this replaces, and why.** Opening a run repointed six panes and left
 * the loop column beside them on the live run. The first answer to that was a
 * *summary* — a different screen drawn from a different shape — and the report
 * on it was exact: *"I want the right panel to look just as it would have when I
 * click on an old run as if I had run it myself."*
 *
 * So the core reconstructs the **narration** and the window folds it through the
 * same `reduce` a live run goes through. The column is then the same components
 * rendering the same `Run`, with no second builder to disagree with the first.
 *
 * The standing objection is answered rather than ignored. A naive replay *"would
 * report finished work as running"*; this one cannot, because every turn in an
 * archive is a turn that ended — `applyCharge` records it when it is charged,
 * which is after it returned.
 */

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

function stateWith(over: Partial<RunState>): RunState {
  return {
    id: '20260101-000000-a-run',
    dir: '/runs/a',
    targetDir: '/repo',
    task: 'build the thing',
    sessionId: 's',
    createdAt: iso(0),
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
    ...over,
  } as RunState;
}

const NOTHING: ReplaySources = { checkpoints: [], censuses: [], questions: [] };

function ids(steps: readonly { narration: { id: string | null } }[]): string[] {
  return steps.map((s) => s.narration.id ?? '');
}

// ---- the label is the loop's own id, read back -------------------------------

test('every label the orchestrator builds is one seatOf places', () => {
  // **Source-read, for `artifacts.test.ts`'s reason.** The app and the core are
  // two packages and this is one convention written twice, so the guarantee has
  // to be that the second copy fails on the commit that respells the first. A
  // label this build cannot place is dropped from the column rather than
  // guessed into one — but a label the LOOP still produces must never be one of
  // those, which is exactly what this checks.
  // Walked up rather than hardcoded: these run from `dist/tests`, so `../src`
  // is the emitted JavaScript and the TypeScript this reads is two levels up.
  let at = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(at, 'src', 'orchestrator.ts')) && path.dirname(at) !== at) {
    at = path.dirname(at);
  }
  const source = readFileSync(path.join(at, 'src', 'orchestrator.ts'), 'utf8');
  const found = [...source.matchAll(/label: (?:`([^`]+)`|'([^']+)')/g)].map(
    (m) => m[1] ?? m[2] ?? '',
  );
  assert.ok(found.length >= 7, 'the label sites moved — this test is reading the wrong thing');
  for (const template of found) {
    // `${state.planRound}` stands for a number in the real label.
    const label = template.replace(/\$\{[^}]+\}/g, '2');
    assert.notEqual(seatOf(label), null, `no seat for ${label}`);
  }
});

test('a revision answering its own answers is not a plan round', () => {
  // `advancesRound`'s rule, and the two labels differ by one letter. A revision
  // answering FINDINGS is the producer's side of the next round; one answering
  // ANSWERS is not, because nothing judged anything — so it carries no round of
  // its own and takes the plan round it happened under.
  assert.equal(seatOf('revise-2')?.round, 2);
  assert.equal(seatOf('revise-q2')?.round, null);
  assert.equal(seatOf('revise-q2')?.kind, 'revise');
});

test('a chunked review turn is one review round, not a round per part', () => {
  assert.deepEqual(seatOf('review-3-part2'), seatOf('review-3'));
  assert.equal(seatOf('review-3')?.round, 3);
});

test('a label this build does not know is placed nowhere rather than guessed', () => {
  // The rule `phase_started` already follows for a phase it cannot place. Its
  // charge is still emitted, which the replay case below pins.
  assert.equal(seatOf('some-future-turn-7'), null);
  assert.equal(seatOf(''), null);
});

// ---- the shape of the reconstruction ----------------------------------------

test('a turn opens and is charged, and nothing is left running', () => {
  // The whole of the answer to *"a replay would report finished work as
  // running"*: every turn in an archive is a turn that ended, so every
  // `turn_started` here is followed by the charge that closes it.
  const state = stateWith({
    events: [{ at: iso(60_000), type: 'claude_turn', label: 'plan', tokens: 100 }],
  });
  const replay = replayRun(state, NOTHING);
  assert.deepEqual(ids(replay.steps), [
    'run_started',
    'phase_started',
    'turn_started',
    'claude_turn',
  ]);
});

test('a turn whose start was never written down says so', () => {
  // `state.turnStartedAt` is ONE field describing the turn in flight, so the
  // only starts an archive keeps are the ones a checkpoint froze. Inventing one
  // from the gap between two charges would be a proxy wearing another
  // measurement's clothes: that interval includes every gate the loop held at.
  const state = stateWith({
    events: [{ at: iso(60_000), type: 'claude_turn', label: 'plan', tokens: 1 }],
  });
  const started = replayRun(state, NOTHING).steps.find((s) => s.narration.id === 'turn_started');
  assert.equal(started?.narration.data?.['unmeasured'], true);
  assert.equal(started?.at, NOW + 60_000);
});

test('a checkpoint’s frozen start becomes that turn’s start', () => {
  // A checkpoint is taken during the turn it freezes, so the start it holds
  // belongs to the first turn charged at or after it.
  const state = stateWith({
    events: [{ at: iso(60_000), type: 'claude_turn', label: 'plan', tokens: 1 }],
  });
  const replay = replayRun(state, {
    ...NOTHING,
    checkpoints: [
      {
        n: 1,
        at: iso(61_000),
        boundary: 'plan-round',
        phase: 'planning',
        planRound: 1,
        reviewRound: 0,
        verifyRound: 0,
        questionRound: 0,
        commit: null,
        turnStartedAt: iso(10_000),
      },
    ],
  });
  const started = replay.steps.find((s) => s.narration.id === 'turn_started');
  assert.equal(started?.at, NOW + 10_000);
  assert.equal(started?.narration.data?.['unmeasured'], false);
});

test('one start is claimed by one turn', () => {
  // Two checkpoints inside one turn would otherwise both claim it, and the
  // second would move a duration that was already right.
  const state = stateWith({
    events: [
      { at: iso(60_000), type: 'claude_turn', label: 'plan', tokens: 1 },
      { at: iso(90_000), type: 'codex_turn', label: 'critique-0', tokens: 1 },
    ],
  });
  const checkpoint = {
    n: 1,
    at: iso(61_000),
    boundary: 'plan-round',
    phase: 'planning',
    planRound: 0,
    reviewRound: 0,
    verifyRound: 0,
    questionRound: 0,
    commit: null,
    turnStartedAt: iso(10_000),
  };
  const replay = replayRun(state, {
    ...NOTHING,
    checkpoints: [checkpoint, { ...checkpoint, n: 2, turnStartedAt: iso(11_000) }],
  });
  const starts = replay.steps
    .filter((s) => s.narration.id === 'turn_started')
    .map((s) => s.at - NOW);
  assert.deepEqual(starts, [10_000, 11_000]);
});

test('a phase opens once per round, not once per turn', () => {
  // `reduce` merges a re-entered group only when both rounds are stated, so the
  // pair is what has to change before a new group is announced. A
  // `phase_started` per turn would draw two boxes for one plan round, which is
  // the defect `reEntered` exists to prevent.
  const state = stateWith({
    events: [
      { at: iso(10_000), type: 'claude_turn', label: 'plan', tokens: 1 },
      { at: iso(20_000), type: 'codex_turn', label: 'answers-1', tokens: 1 },
      { at: iso(30_000), type: 'codex_turn', label: 'critique-0', tokens: 1 },
    ],
  });
  const phases = replayRun(state, NOTHING)
    .steps.filter((s) => s.narration.id === 'phase_started')
    .map((s) => s.narration.data?.['phase']);
  // `plan` and `answers-1` are both the plan cycle at round 0; the critique is
  // its own group, because the column draws four groups and a critique is half
  // the plan cycle's work.
  assert.deepEqual(phases, ['planning', 'critique']);
});

test('a turn this build cannot place still spends what it spent', () => {
  // Dropping the charge would make the replayed total disagree with the run's
  // own record, which is a worse failure than a missing row.
  const state = stateWith({
    events: [{ at: iso(10_000), type: 'codex_turn', label: 'some-future-turn', tokens: 5 }],
  });
  const got = ids(replayRun(state, NOTHING).steps);
  assert.deepEqual(got, ['run_started', 'codex_turn']);
});

test('a judge round reports the counts its own artifact holds', () => {
  // A census is narration with no event, so the counting was never durable —
  // the report is. The counts come from the file the judge wrote.
  const state = stateWith({
    events: [{ at: iso(10_000), type: 'codex_turn', label: 'critique-0', tokens: 1 }],
  });
  const replay = replayRun(state, {
    ...NOTHING,
    censuses: [{ phase: 'plan', round: 0, counts: { p0: 0, p1: 3, p2: 1, p3: 0 } }],
  });
  const census = replay.steps.find((s) => s.narration.id === 'findings_reported');
  assert.equal(census?.narration.data?.['phase'], 'plan');
  assert.deepEqual(census?.narration.data?.['counts'], { p0: 0, p1: 3, p2: 1, p3: 0 });
});

test('the ending is the last escalation or error, by TYPE', () => {
  // Never by picking the most alarming sentence out of the transcript, which is
  // the English-matching #133 exists to prevent and which picks the wrong line:
  // a healthy run is full of warnings that are not the ending.
  const state = stateWith({
    status: 'needs-input',
    events: [
      { at: iso(1_000), type: 'error', message: 'an earlier one' },
      { at: iso(2_000), type: 'claude_turn', label: 'plan', tokens: 1 },
      { at: iso(3_000), type: 'escalation', message: 'the planner gave up' },
    ],
  });
  const replay = replayRun(state, NOTHING);
  const ending = replay.steps.find((s) => s.narration.id === 'run_escalated');
  assert.equal(ending?.narration.message, 'the planner gave up');
  assert.equal(replay.exit, 2);
});

test('a run that simply finished has no ending invented for it', () => {
  const replay = replayRun(stateWith({}), NOTHING);
  assert.equal(
    replay.steps.find((s) => s.narration.id === 'run_failed' || s.narration.id === 'run_escalated'),
    undefined,
  );
  assert.equal(replay.exit, 0);
});

test('a status this build does not recognise reports no exit code', () => {
  // Null rather than a guessed zero: it has not told us the run succeeded, and
  // the footer draws a code it does not know as the number rather than as a
  // phrase invented for it.
  assert.equal(replayRun(stateWith({ status: 'stalled' as RunState['status'] }), NOTHING).exit, null);
});

test('a finished plan-only run says so, so it can still be offered implementation', () => {
  // `planOnly` has been durable since `createRun` and was never said, so a
  // window could not tell a plan-only run that FINISHED from any other run that
  // finished — and the two want opposite next actions.
  const state = stateWith({
    status: 'planned',
    planOnly: true,
    events: [{ at: iso(10_000), type: 'claude_turn', label: 'plan', tokens: 1 }],
  });
  const stopped = replayRun(state, NOTHING).steps.find(
    (s) => s.narration.id === 'plan_only_stopped',
  );
  assert.notEqual(stopped, undefined);
  assert.equal(stopped?.narration.data?.['carried'], 0);
});

test('the steps come back in the order they happened', () => {
  // The commits are gathered after the turns and belong among them, so the
  // sequence is sorted by the run's own clock rather than by push order.
  const state = stateWith({
    events: [
      { at: iso(10_000), type: 'claude_turn', label: 'plan', tokens: 1 },
      { at: iso(40_000), type: 'codex_turn', label: 'critique-0', tokens: 1 },
    ],
  });
  const replay = replayRun(state, {
    ...NOTHING,
    checkpoints: [
      {
        n: 1,
        at: iso(20_000),
        boundary: 'plan-round',
        phase: 'planning',
        planRound: 0,
        reviewRound: 0,
        verifyRound: 0,
        questionRound: 0,
        commit: 'abc1234',
        turnStartedAt: null,
      },
    ],
  });
  const times = replay.steps.map((s) => s.at);
  assert.deepEqual([...times].sort((a, b) => a - b), times);
  assert.ok(replay.steps.some((s) => s.narration.id === 'round_committed'));
});

// ---- the guards are `loadRun`'s, not a second set ---------------------------

function repoWith(state: Record<string, unknown>, id = '20260101-000000-a-run'): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-replay-'));
  const runDir = path.join(dir, '.vibe', 'runs', id);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    path.join(runDir, 'state.json'),
    JSON.stringify({ ...stateWith({}), dir: runDir, targetDir: dir, ...state }),
    'utf8',
  );
  return dir;
}

test('a run id that is not a single entry under .vibe/runs is refused', () => {
  assert.throws(() => readRunReplay(repoWith({}), '../elsewhere'), /run id|not a/i);
});

test('a linked run directory is refused rather than followed', (t) => {
  // #53's rule, inherited whole: following a link to READ a run is the same door
  // as following one to delete recursively.
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-replay-link-'));
  const root = path.join(dir, '.vibe', 'runs');
  mkdirSync(root, { recursive: true });
  const real = mkdtempSync(path.join(tmpdir(), 'vibe-replay-target-'));
  try {
    symlinkSync(real, path.join(root, 'linked-run'), 'junction');
  } catch {
    t.skip('this machine cannot create a link');
    return;
  }
  assert.throws(() => readRunReplay(dir, 'linked-run'), /link|junction/i);
});

test('a run whose artifacts are missing still replays its turns', () => {
  // Three reads beyond `state.json`, and a file that cannot be read is absent
  // from the reconstruction rather than fatal to it: a run whose critique
  // artifact was deleted still has its turns.
  const dir = repoWith({
    events: [{ at: iso(10_000), type: 'codex_turn', label: 'critique-0', tokens: 1 }],
  });
  const replay = readRunReplay(dir, '20260101-000000-a-run');
  assert.ok(replay.steps.some((s) => s.narration.id === 'turn_started'));
  assert.equal(
    replay.steps.find((s) => s.narration.id === 'findings_reported'),
    undefined,
  );
});

test('a replay request with no dir or no runId is refused by name', () => {
  // Both fields checked for `archive`'s reason: an empty `dir` resolves to the
  // host's cwd, which is a different repository's archive answered as though it
  // were this one — the worst way for a read to fail, because it succeeds.
  for (const frame of [
    { type: 'replay', id: 1, runId: 'r' },
    { type: 'replay', id: 1, dir: '', runId: 'r' },
    { type: 'replay', id: 1, dir: 'd' },
  ]) {
    assert.equal(decode(JSON.stringify(frame)).ok, false);
  }
  assert.equal(decode(JSON.stringify({ type: 'replay', id: 1, dir: 'd', runId: 'r' })).ok, true);
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

// ---- a turn that was stopped is still a turn that happened -------------------

test('a turn charged after FAILING is replayed, not dropped', () => {
  // **The hole this closes, and it was the expensive one.** A turn that was
  // stopped, timed out or threw is charged through `chargeFailure` under
  // `turn_failed` rather than as `claude_turn`, so a replay taking only the
  // successful ones drew a run *missing the turn it stopped on* — the opposite
  // of *"I want it to look as I just left it when I stopped the run."*
  //
  // The case is a real one: a run of 2026-09-16 whose implement turn was killed
  // 14m30s in at 14.2M tokens, having written 50 files. Its replay had no CODE
  // group at all.
  const state = stateWith({
    status: 'needs-input',
    events: [
      { at: iso(10_000), type: 'claude_turn', label: 'plan', tokens: 1 },
      {
        at: iso(90_000),
        type: 'turn_failed',
        label: 'implement',
        provider: 'claude',
        tokens: 14_247_741,
        error: 'the run was stopped: stopped from the window',
      },
    ],
  });
  const replay = replayRun(state, NOTHING);
  const phases = replay.steps
    .filter((s) => s.narration.id === 'phase_started')
    .map((s) => s.narration.data?.['phase']);
  assert.ok(phases.includes('implementing'), 'the stopped turn opens its own group');
  // Charged under the agent that ran it, so the replayed spend still adds up.
  const charge = replay.steps.find((s) => s.narration.id === 'claude_turn' && s.at === NOW + 90_000);
  assert.equal(charge?.narration.data?.['tokens'], 14_247_741);
});

test('a stopped turn is said to have stopped rather than to have been charged', () => {
  // The sentence is the only place the difference shows, since both go out under
  // the same id — which they must, because that id is what carries the spend.
  const state = stateWith({
    events: [
      { at: iso(10_000), type: 'turn_failed', label: 'implement', provider: 'claude', tokens: 5 },
    ],
  });
  const said = replayRun(state, NOTHING).steps.find((s) => s.narration.id === 'claude_turn');
  assert.match(said?.narration.message ?? '', /implement stopped/);
});

test('a failed turn whose provider this build cannot read is skipped, not misattributed', () => {
  // Fail closed: putting a Codex turn's spend on Claude's side of the ledger is
  // worse than a missing row, because a reader cannot see that it happened.
  const state = stateWith({
    events: [{ at: iso(10_000), type: 'turn_failed', label: 'implement', tokens: 5 }],
  });
  const replay = replayRun(state, NOTHING);
  assert.equal(replay.steps.find((s) => s.narration.id === 'claude_turn'), undefined);
  assert.equal(replay.steps.find((s) => s.narration.id === 'codex_turn'), undefined);
});
