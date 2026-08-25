import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '@src/config.js';
import { orchestrate, ROLES, runTurn, slotForRole, slotId, slotStarted } from '@src/orchestrator.js';
import type { AgentTurns, Role, RoleTable, TurnRequest } from '@src/orchestrator.js';
import { codexConversations, ROLE_NAMES, tableFor } from '@src/roles.js';
import { loadRun } from '@src/run.js';
import { FINDINGS_SCHEMA } from '@src/schemas.js';
import { slotHasMemory, slotOccupancy } from '@src/slots.js';
import type { CodexTurnOptions } from '@src/codex.js';
import type { ClaudeTurnResult, Config, RunState, TokenUsage } from '@src/types.js';
import {
  agents,
  answersReport,
  BLOCKING,
  committing,
  config,
  freshRun,
  planFixture,
  questionFixture,
  report,
  verifying,
  work,
} from './helpers/loop-harness.js';

/**
 * Two Codex conversations, and the fact that neither can read the other.
 *
 * Before #45 the reviewer WAS the conversation that had critiqued the plan and
 * approved it: `codexDispatch` resumed one thread for every Codex turn, so the
 * agent asked whether the code was right opened the review already holding the
 * view that the plan behind it was. That is not a second opinion, and review
 * independence is most of what this tool buys.
 *
 * What is pinned here is the property by construction, not by wording: the
 * critic and the reviewer resolve to different slots, each slot owns its own
 * stored id, and a turn on one is never handed an id the other established.
 * Every case is written against the resume id a turn actually receives, because
 * that - not a prompt, and not a state field read in isolation - is what decides
 * whether a conversation continues.
 */

// ---- the two families of Codex turn ----------------------------------------

const JUDGE_THREAD = 'critique-thread';
const REVIEW_THREAD = 'review-thread';

/**
 * Which conversation a turn belongs to, by the labels `src/orchestrator.ts`
 * emits: `critique-<n>`, `answers-<n>` and `review-<n>`.
 *
 * The fake answers under a different id per family, which is what makes "the
 * reviewer was handed the critique's id" an assertion rather than a coincidence
 * of one fake id standing for every thread.
 */
function threadFor(label: string): string {
  return label.startsWith('review-') ? REVIEW_THREAD : JUDGE_THREAD;
}

/**
 * Every Codex turn, in order: its label and the id it was told to resume.
 *
 * `CodexTurnOptions.sessionId` is optional at the seam, but dispatch always
 * passes `slotResumeId`, so absent and null are the same fact here: nothing to
 * continue. Normalised on the way in rather than asserted against twice.
 */
interface CodexTurn {
  label: string;
  resumed: string | null;
}

function resumedId(options: CodexTurnOptions): string | null {
  return options.sessionId ?? null;
}

function tokens(total: number): TokenUsage {
  return { input: total, output: 0, cacheRead: 0, cacheCreation: 0, total };
}

function planningClaude(state: RunState): (label: string) => unknown {
  // A planning turn returns a plan; every other Claude turn is a writing turn,
  // and has to change the tree or the per-round commits are all no-ops.
  return (label) =>
    label === 'plan' || label.startsWith('revise-') ? planFixture() : work(state, `${label}.txt`);
}

// ---- 1. Neither conversation ever resumes the other -------------------------

test('a full run keeps the critique and the review in separate Codex threads', async () => {
  const state = freshRun({ prefix: 'vibe-independent-', planOnly: false, git: true, commit: true });
  const seen: CodexTurn[] = [];
  const calls: string[] = [];

  await orchestrate(
    state,
    config({}, { ...committing(), ...verifying(state) }),
    false,
    agents(
      {
        claude: planningClaude(state),
        codex: (label, options) => {
          seen.push({ label, resumed: resumedId(options) });
          return report([]);
        },
        codexSessionId: threadFor,
      },
      calls,
    ),
  );

  const critiques = seen.filter((t) => !t.label.startsWith('review-'));
  const reviews = seen.filter((t) => t.label.startsWith('review-'));
  assert.ok(critiques.length > 0 && reviews.length > 0, `both families ran: ${calls.join(', ')}`);

  // The whole of #45, stated as the ids the turns were handed.
  for (const turn of reviews) {
    assert.notEqual(turn.resumed, JUDGE_THREAD, `${turn.label} was handed the critique's thread`);
  }
  for (const turn of critiques) {
    assert.notEqual(turn.resumed, REVIEW_THREAD, `${turn.label} was handed the review's thread`);
  }

  // Each conversation is stored under its own slot, and neither field moved.
  assert.equal(state.codexSessionId, JUDGE_THREAD);
  assert.equal(state.reviewSessionId, REVIEW_THREAD);
  assert.equal(slotId(state, 'judge'), JUDGE_THREAD);
  assert.equal(slotId(state, 'review'), REVIEW_THREAD);
});

// ---- 2. Each conversation keeps its own continuity --------------------------

test('a second critique and a second review each resume their own thread', async () => {
  const state = freshRun({ prefix: 'vibe-independent-', planOnly: false, git: true, commit: true });
  const seen: CodexTurn[] = [];
  const calls: string[] = [];

  // One blocking round on each side, so both families take two turns: the critic
  // sends the plan back once, and the reviewer sends the code back once. Two P1s
  // each - `BLOCKING` - because one is inside `p1Tolerance` and would be carried
  // to a final fix round instead of buying a second judging turn.
  let critiques = 0;
  let reviews = 0;

  await orchestrate(
    state,
    config({}, committing()),
    false,
    agents(
      {
        claude: planningClaude(state),
        codex: (label, options) => {
          seen.push({ label, resumed: resumedId(options) });
          if (label.startsWith('review-')) {
            reviews += 1;
            return reviews === 1 ? report(BLOCKING) : report([]);
          }
          critiques += 1;
          return critiques === 1 ? report(BLOCKING) : report([]);
        },
        codexSessionId: threadFor,
      },
      calls,
    ),
  );

  const critique = seen.filter((t) => t.label.startsWith('critique-'));
  const review = seen.filter((t) => t.label.startsWith('review-'));
  assert.ok(critique.length >= 2, `two critique rounds ran: ${calls.join(', ')}`);
  assert.ok(review.length >= 2, `two review rounds ran: ${calls.join(', ')}`);

  // A fresh conversation starts fresh and then continues on the id its OWN first
  // turn established - not on the one the other conversation established first.
  assert.equal(critique[0]?.resumed, null);
  assert.equal(critique[1]?.resumed, JUDGE_THREAD);
  assert.equal(review[0]?.resumed, null, 'the reviewer starts fresh, after critiques have run');
  assert.equal(review[1]?.resumed, REVIEW_THREAD);
});

// ---- The answerer stays with the plan-side judge ----------------------------

test('the answerer resumes the critique conversation, not the reviewer', async () => {
  const state = freshRun({ prefix: 'vibe-answerer-' });
  const seen: CodexTurn[] = [];
  const calls: string[] = [];
  let planned = 0;

  await orchestrate(
    state,
    config(),
    false,
    agents(
      {
        // The first plan asks a blocking question, which is what sends the loop
        // to the answerer; the revision that follows asks none.
        claude: () => {
          planned += 1;
          return planned === 1
            ? planFixture({ open_questions: [questionFixture()] })
            : planFixture();
        },
        codex: (label, options) => {
          seen.push({ label, resumed: resumedId(options) });
          return label.startsWith('answers-')
            ? answersReport([{ question: questionFixture().question }])
            : report([]);
        },
        codexSessionId: threadFor,
      },
      calls,
    ),
  );

  const answers = seen.find((t) => t.label.startsWith('answers-'));
  const critique = seen.find((t) => t.label.startsWith('critique-'));
  assert.ok(answers !== undefined, `the answerer ran: ${calls.join(', ')}`);
  assert.ok(critique !== undefined, `a critique followed it: ${calls.join(', ')}`);

  // Answering the planner's blocking questions is plan-side work, so the
  // conversation that argues about the plan holds it. Deliberate, not a leftover
  // of the assignment this change replaced.
  //
  // The answerer runs BEFORE the first critique - questions are answered, then
  // the plan is revised, then it is critiqued - so it opens the conversation
  // rather than resuming one, and the proof that it is the judge's is that the
  // critique after it continues the thread the answerer established.
  assert.equal(answers.resumed, null, 'the answerer is the first Codex turn of the run');
  assert.equal(critique.resumed, JUDGE_THREAD);
  assert.equal(state.codexSessionId, JUDGE_THREAD);
  assert.equal(state.reviewSessionId, undefined, 'a plan-only run opens no review conversation');
});

// ---- 3. Occupancy is per conversation, and stays attributed ------------------

/** A Codex fake answering a scripted list of turns, in order. */
function scripted(script: readonly { sessionId: string; input: number }[]): {
  turns: AgentTurns;
  codexCalls: CodexTurnOptions[];
} {
  const codexCalls: CodexTurnOptions[] = [];
  let next = 0;
  return {
    codexCalls,
    turns: {
      claude: (options): Promise<ClaudeTurnResult> =>
        Promise.resolve({
          text: 'claude said so',
          costUsd: 0.02,
          sessionId: options.sessionId,
          denials: [],
          numTurns: 1,
          usage: null,
          tokens: tokens(1000),
        }),
      codex: (options) => {
        codexCalls.push(options);
        const turn = script[Math.min(next, script.length - 1)];
        next += 1;
        return Promise.resolve({
          structured: { findings: [] },
          raw: '{"findings":[]}',
          sessionId: turn?.sessionId ?? null,
          tokens: tokens(turn?.input ?? 0),
        });
      },
    },
  };
}

function codexConfig(over: Partial<Config['codex']> = {}): Config {
  return config({}, { codex: { ...DEFAULTS.codex, readRateLimits: false, ...over } });
}

function turnRequest(role: Role, label: string): TurnRequest {
  return { role, prompt: 'do the thing', cwd: process.cwd(), label, timeoutMs: 1_000 };
}

test('each conversation carries its own occupancy, and a turn on one leaves the other', async () => {
  const state = freshRun({ prefix: 'vibe-occupancy-' });
  const cfg = codexConfig({ contextWindow: 200_000 });
  const rec = scripted([
    { sessionId: JUDGE_THREAD, input: 30_000 },
    { sessionId: REVIEW_THREAD, input: 12_000 },
  ]);

  await runTurn(state, cfg, turnRequest('critic', 'critique-0'), rec.turns);
  assert.equal(slotOccupancy(state, 'judge'), 30_000);
  assert.equal(slotOccupancy(state, 'review'), null, 'nothing ran there, which is not zero');

  await runTurn(state, cfg, turnRequest('reviewer', 'review-0'), rec.turns);
  // Neither figure is readable as the other's, and the second turn cleared
  // nothing: the two records are keyed to two different conversations.
  assert.equal(slotOccupancy(state, 'judge'), 30_000, 'the judge figure survived a review turn');
  assert.equal(slotOccupancy(state, 'review'), 12_000);
  assert.equal(state.judgeContextThread, JUDGE_THREAD);
  assert.equal(state.reviewContextThread, REVIEW_THREAD);

  // Provenance is per slot too: replacing one conversation silences its
  // measurement and says nothing about the other's.
  state.reviewSessionId = 'a-different-thread';
  assert.equal(slotOccupancy(state, 'review'), null);
  assert.equal(slotOccupancy(state, 'judge'), 30_000);
});

test('a run carrying neither thread attributes no measurement to either', async () => {
  const state = freshRun({ prefix: 'vibe-occupancy-' });
  const cfg = codexConfig({ contextWindow: 200_000, persistSession: false });
  const rec = scripted([
    { sessionId: JUDGE_THREAD, input: 30_000 },
    { sessionId: REVIEW_THREAD, input: 12_000 },
  ]);

  await runTurn(state, cfg, turnRequest('critic', 'critique-0'), rec.turns);
  await runTurn(state, cfg, turnRequest('reviewer', 'review-0'), rec.turns);

  assert.equal(rec.codexCalls[0]?.sessionId, null);
  assert.equal(rec.codexCalls[1]?.sessionId, null);
  assert.equal('judgeContextTokens' in state, false);
  assert.equal('reviewContextTokens' in state, false, 'a one-shot thread has no identity to key to');
  // Success and continuity stay different facts on the new slot, as on the old.
  assert.equal(slotStarted(state, 'review'), true);
  assert.equal(slotHasMemory(state, cfg, 'review'), false);
});

// ---- 4. A state written before this change ----------------------------------

const RUNS = path.join('.vibe', 'runs');

const FIXTURES = [
  'oldest-planning',
  'stalled-planning',
  'done-pendingfindings-null',
  'done-widest',
] as const;

/** A real state file, loaded from a copy so the fixture itself is never touched. */
function loadFixture(name: string): { state: RunState; stored: Record<string, unknown> } {
  const file = fileURLToPath(new URL(`../../tests/fixtures/state/${name}.json`, import.meta.url));
  const stored = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const id = String(stored['id']);
  const targetDir = mkdtempSync(path.join(tmpdir(), 'vibe-legacy-review-'));
  const dir = path.join(targetDir, RUNS, id);
  mkdirSync(dir, { recursive: true });
  copyFileSync(file, path.join(dir, 'state.json'));
  return { state: loadRun(targetDir, id), stored };
}

for (const name of FIXTURES) {
  test(`${name} loads with no repair, keeps its judge thread and has no review thread`, () => {
    const { state, stored } = loadFixture(name);
    const cfg = config();

    assert.deepEqual(
      state.events.filter((e) => e.type === 'state_repaired'),
      [],
      'a state written before the review slot existed needs no repair',
    );

    // The field keeps naming the conversation it has always named.
    assert.equal(slotId(state, 'judge'), stored['codexSessionId'] ?? null);

    // And nothing was invented for the conversation that has never run. Absent,
    // not false and not null - and deliberately not seeded from
    // `codexSessionId`, because that thread is the critique and handing it to
    // the reviewer is the defect.
    assert.equal('reviewSessionId' in state, false);
    assert.equal('reviewSessionStarted' in state, false);
    assert.equal(slotId(state, 'review'), null);
    assert.equal(slotStarted(state, 'review'), false);
    assert.equal(slotHasMemory(state, cfg, 'review'), false);
  });
}

test('a legacy run resumed at review starts the reviewer fresh and keeps the judge thread', async () => {
  const { state, stored } = loadFixture('done-widest');
  const judgeBefore = stored['codexSessionId'];
  assert.equal(typeof judgeBefore, 'string', 'this fixture carries a Codex thread id');

  // The ceilings are lifted, not because this case is about spending: a real
  // completed run's `tokensUsed` and `costUsd` come with it out of the fixture,
  // and `applyCharge` would stop the turn on them before the slot was consulted.
  const cfg = config(
    {},
    { budget: { ...DEFAULTS.budget, maxTokens: 0, maxCostUsd: Number.MAX_SAFE_INTEGER } },
  );
  const rec = scripted([{ sessionId: REVIEW_THREAD, input: 4_000 }]);
  await runTurn(state, cfg, turnRequest('reviewer', 'review-0'), rec.turns);

  assert.equal(rec.codexCalls[0]?.sessionId, null, 'the reviewer was handed nothing to resume');
  assert.equal(state.codexSessionId, judgeBefore, 'the judge thread is untouched');
  assert.equal(state.reviewSessionId, REVIEW_THREAD);
});

// ---- 5. Exactly one role changed conversation -------------------------------

test('the default table moves the reviewer and nothing else', () => {
  const expected: Record<Role, string> = {
    planner: 'main',
    implementer: 'main',
    critic: 'judge',
    answerer: 'judge',
    reviewer: 'review',
  };
  for (const role of ROLE_NAMES) {
    assert.equal(slotForRole(role), expected[role], `${role} talks through the wrong conversation`);
  }
});

test('a reviewer seated on Claude talks through main, like any Claude role', () => {
  const onClaude = tableFor({
    planner: 'claude',
    implementer: 'claude',
    critic: 'codex',
    answerer: 'codex',
    reviewer: 'claude',
  });
  assert.equal(slotForRole('reviewer', onClaude), 'main');
  assert.equal(slotForRole('critic', onClaude), 'judge');
});

test('a table that names no slot gives the reviewer its own conversation too', () => {
  const unnamed: RoleTable = {
    planner: { provider: 'claude', access: 'read-only' },
    implementer: { provider: 'claude', access: 'write' },
    critic: { provider: 'codex', access: 'read-only', schema: FINDINGS_SCHEMA },
    answerer: { provider: 'codex', access: 'read-only', schema: FINDINGS_SCHEMA },
    reviewer: { provider: 'codex', access: 'read-only', schema: FINDINGS_SCHEMA },
  };
  assert.equal(slotForRole('reviewer', unnamed), 'review');
  assert.equal(slotForRole('answerer', unnamed), 'judge');
});

test('every non-reviewer Codex turn resumes exactly what it resumes today', async () => {
  const state = freshRun({ prefix: 'vibe-blast-' });
  const cfg = config();
  const rec = scripted([{ sessionId: JUDGE_THREAD, input: 1_000 }]);

  await runTurn(state, cfg, turnRequest('critic', 'critique-0'), rec.turns);
  await runTurn(state, cfg, turnRequest('answerer', 'answers-0'), rec.turns);
  await runTurn(state, cfg, turnRequest('critic', 'critique-1'), rec.turns);

  assert.equal(rec.codexCalls[0]?.sessionId, null, 'the first turn opens the conversation');
  assert.equal(rec.codexCalls[1]?.sessionId, JUDGE_THREAD);
  assert.equal(rec.codexCalls[2]?.sessionId, JUDGE_THREAD);
  assert.equal('reviewSessionId' in state, false, 'no reviewer turn, no review conversation');
});

// ---- 6. The pairing is still checked ----------------------------------------

test('a role seated on a provider its slot does not match is still refused', () => {
  const misSeated: RoleTable = {
    ...ROLES,
    reviewer: { provider: 'claude', access: 'read-only', schema: FINDINGS_SCHEMA, slot: 'review' },
  };
  assert.throws(
    () => slotForRole('reviewer', misSeated),
    /but slot "review" is a codex conversation/,
  );

  const onMain: RoleTable = {
    ...ROLES,
    reviewer: { provider: 'codex', access: 'read-only', schema: FINDINGS_SCHEMA, slot: 'main' },
  };
  assert.throws(() => slotForRole('reviewer', onMain), /but slot "main" is a claude conversation/);
});

// ---- What the run tells the user --------------------------------------------

test('the run summary counts the Codex conversations the table actually holds', () => {
  // Two under the default assignment: the plan-side judge, and the reviewer.
  assert.equal(codexConversations(config()), 2);

  // One when the reviewer is seated elsewhere, and none when Codex holds
  // nothing - a count derived from the table cannot claim a thread no turn opens.
  assert.equal(codexConversations(config({}, { roles: { ...DEFAULTS.roles, reviewer: 'claude' } })), 1);
  assert.equal(
    codexConversations(
      config(
        {},
        {
          roles: {
            planner: 'claude',
            implementer: 'claude',
            critic: 'claude',
            answerer: 'claude',
            reviewer: 'claude',
          },
        },
      ),
    ),
    0,
  );
});
