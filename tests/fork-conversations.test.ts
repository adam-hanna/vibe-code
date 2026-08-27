import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { commitFork, planFork } from '@src/fork.js';
import { Escalation, orchestrate } from '@src/orchestrator.js';
import { listCheckpoints, loadRun, saveState } from '@src/run.js';
import {
  clearSlotFork,
  forkedSlotFields,
  noteSlotForkAttempt,
  slotContinuity,
  slotForkParent,
} from '@src/slots.js';
import {
  agents,
  BLOCKING,
  branchOf,
  committing,
  config,
  freshRun,
  planFixture,
  report,
  verifying,
  work,
} from './helpers/loop-harness.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import type { CodexTurnOptions } from '@src/codex.js';
import type { RunState } from '@src/types.js';

/**
 * What a forked run does on its first turn, and where it commits (#78).
 *
 * Three properties, and each has a way of being wrong that looks fine:
 *
 * - **The first turn on each conversation forks**, rather than resuming the
 *   parent's thread (two runs in one conversation) or starting fresh (the
 *   context the fork was created to inherit, silently lost).
 * - **The fork is not durably done until the turn that made it is charged.**
 *   Marking it complete in a save of its own leaves a window where the fork is
 *   done and the spend is not recorded, which #77 established cannot be
 *   reconstructed for a Codex turn.
 * - **A run commits to the branch it claims.** The forked run checks its own
 *   branch out when it is resumed and leaves HEAD there, so a resume of the
 *   PARENT afterwards has to refuse rather than commit to the child's branch.
 */

const FORK = { prefix: 'vibe-forkconv-', task: 'fork conversations' } as const;

/** A finished parent with checkpoints, commits, and both Codex threads started. */
async function parentRun(task = 'fork conversations'): Promise<RunState> {
  const state = freshRun({ ...FORK, task, planOnly: false, git: true, commit: true });
  let round = 0;
  let critiques = 0;
  await orchestrate(
    state,
    config({}, { ...committing(), ...verifying(state) }),
    false,
    agents(
      {
        claude: (label) => {
          if (label === 'plan' || label.startsWith('revise')) return planFixture();
          round += 1;
          work(state, `work-${round}.txt`);
          return `did ${label}`;
        },
        // One blocking critique, so the run records a plan revision - which is
        // the boundary the dispatch cases fork from.
        codex: (label) => {
          if (label.startsWith('review')) return report([]);
          return critiques++ === 0 ? report(BLOCKING) : report([]);
        },
        // Distinct ids per family, so "the reviewer was handed the critique's
        // thread" would be an observation rather than a coincidence.
        codexSessionId: (label) => (label.startsWith('review') ? 'review-thread' : 'judge-thread'),
      },
      [],
    ),
  );
  return state;
}

function committedPoint(state: RunState): number {
  const found = listCheckpoints(state.dir).find((c) => c.meta?.commit != null);
  assert.ok(found !== undefined);
  return found.n;
}

/**
 * The first PLANNING boundary.
 *
 * The dispatch cases fork from here rather than from the implemented boundary,
 * because that is the one place where resuming runs a Claude turn AND a Codex
 * turn: a fork taken at `implemented` resumes straight into review, whose only
 * turns are Codex, and would leave the Claude fork flag untested.
 */
function planPoint(state: RunState): number {
  const found = listCheckpoints(state.dir).find((c) => c.meta?.boundary === 'plan-round');
  assert.ok(found !== undefined, 'the parent recorded a plan revision');
  return found.n;
}

/** No branch: a planning boundary records no commit, and there is nothing to branch from. */
const NO_BRANCH = { git: { useBranch: false } };

async function forkOf(parent: RunState, n: number, overrides: object = {}): Promise<RunState> {
  const plan = await planFork(parent.targetDir, parent.id, n, overrides);
  const { state } = await commitFork(parent.targetDir, plan);
  return state;
}

const gitIn = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// ---- the first turn ---------------------------------------------------------

test('the first turn on each conversation forks, and every later one resumes', async () => {
  const parent = await parentRun('first turn');
  const child = await forkOf(parent, planPoint(parent), NO_BRANCH);

  // The fork's own state carries what each slot owes. At a planning boundary
  // the reviewer has not run yet, so there is nothing of its to fork - which is
  // itself the point: what is owed is what the parent actually had.
  assert.equal(child.forkPending?.main?.parentId, parent.sessionId);
  assert.equal(child.forkPending?.judge?.parentId, 'judge-thread');
  assert.equal(child.forkPending?.review, undefined);

  const claudeCalls: ClaudeTurnOptions[] = [];
  const codexCalls: CodexTurnOptions[] = [];
  const loaded = loadRun(child.targetDir, child.id);
  let reviews = 0;
  await orchestrate(
    loaded,
    config({}, committing()),
    true,
    agents(
      {
        claude: (label, options) => {
          claudeCalls.push(options);
          return label === 'plan' || label.startsWith('revise') ? planFixture() : `did ${label}`;
        },
        codex: (_label, options) => {
          codexCalls.push(options);
          reviews += 1;
          return report([]);
        },
      },
      [],
    ),
  );

  const firstClaude = claudeCalls[0];
  assert.ok(firstClaude !== undefined);
  assert.equal(firstClaude.forkFrom, parent.sessionId, 'the parent session is what is forked');
  assert.equal(firstClaude.resume, false, 'a fork is not a resume');
  assert.equal(firstClaude.sessionId, child.sessionId, "and it lands in vibe's own chosen id");

  for (const later of claudeCalls.slice(1)) {
    assert.equal(later.forkFrom, undefined, 'no later turn forks again');
  }

  const firstCodex = codexCalls[0];
  assert.ok(firstCodex !== undefined && reviews > 0);
  assert.equal(firstCodex.forkFrom, 'judge-thread');
  assert.equal(firstCodex.sessionId, undefined, 'fork and resume are mutually exclusive');
  for (const later of codexCalls.slice(1)) {
    assert.equal(later.forkFrom, undefined);
  }
});

test('a forked conversation is told it carries the run, not that it is fresh', async () => {
  const parent = await parentRun('continuity');
  const child = await forkOf(parent, planPoint(parent), NO_BRANCH);
  const cfg = config();

  assert.equal(slotForkParent(child, cfg, 'main'), parent.sessionId);
  assert.equal(slotContinuity(child, cfg, 'main'), true, 'a fork arrives holding the history');

  // Once the fork is done and the slot started, continuity is the ordinary
  // has-memory answer again.
  clearSlotFork(child, 'main');
  child.sessionStarted = true;
  assert.equal(slotForkParent(child, cfg, 'main'), null);
  assert.equal(slotContinuity(child, cfg, 'main'), true);
});

test('a conversation the parent never ran is not forked, and the loss is stated', () => {
  const parent = freshRun({ ...FORK, task: 'never started' });
  const cfg = config();
  const { fields, conversations } = forkedSlotFields(parent, cfg);

  assert.equal(fields.forkPending, undefined, 'nothing was owed');
  for (const conversation of conversations) {
    assert.equal(conversation.parentId, null);
    assert.equal(conversation.why, 'never-started');
  }
});

test('a one-shot Codex config forks nothing, and says which conversations that was', () => {
  const parent = freshRun({ ...FORK, task: 'one shot' });
  parent.sessionStarted = true;
  parent.codexSessionId = 'judge-thread';
  parent.codexSessionStarted = true;

  const cfg = config({}, { codex: { ...config().codex, persistSession: false } });
  const { fields, conversations } = forkedSlotFields(parent, cfg);

  assert.equal(fields.forkPending?.main?.parentId, parent.sessionId, 'main always persists');
  assert.equal(fields.forkPending?.judge, undefined);
  assert.ok(conversations.some((c) => c.slot === 'judge' && c.why === 'not-persisted'));
});

// ---- the context measurement ------------------------------------------------

test('a fork of a full conversation does not rotate its brand-new one', async () => {
  const parent = await parentRun('measurement');
  // A parent whose Claude conversation is nearly full. Left in place, the
  // child's first turn marks the slot started while reporting no usage, and the
  // rotation would fire on a conversation created moments ago.
  parent.contextRatio = 0.95;
  parent.contextModel = config().claude.model;
  parent.contextWindow = 200_000;
  parent.handoff = 'the parent said this';
  saveState(parent);
  const n = committedPoint(parent);
  // Re-checkpoint so the snapshot carries the measurement.
  const file = path.join(parent.dir, `checkpoint-${n}.json`);
  const snapshot = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  writeFileSync(
    file,
    JSON.stringify({
      ...snapshot,
      contextRatio: 0.95,
      contextModel: config().claude.model,
      contextWindow: 200_000,
      handoff: 'the parent said this',
    }),
    'utf8',
  );

  const child = await forkOf(parent, n);
  assert.equal(child.contextRatio, 0, 'nothing has been measured on the new conversation');
  assert.equal(child.contextModel, undefined);
  assert.equal(child.contextWindow, undefined);
  assert.equal(child.handoff, null, "and the parent's briefing does not describe it");
});

test('a parent that rotated without running again owes no fork, and keeps its handoff', () => {
  const parent = freshRun({ ...FORK, task: 'rotated' });
  // Exactly what `resetSlot` leaves behind: a fresh session id, no successful
  // turn on it, and the handoff the next turn is meant to receive.
  parent.sessionStarted = false;
  parent.handoff = 'what the abandoned session had worked out';
  parent.contextRatio = 0.9;

  const { fields } = forkedSlotFields(parent, config());
  assert.equal(fields.forkPending?.main, undefined, 'there is no conversation to fork');
  assert.equal(fields.handoff, undefined, 'so the handoff is left exactly as it was');
  assert.equal(fields.contextRatio, undefined);
});

// ---- once, and durably ------------------------------------------------------

test('the fork is completed by the write that charges the turn, and by no other', async () => {
  const parent = await parentRun('atomic');
  const child = await forkOf(parent, planPoint(parent), NO_BRANCH);
  const loaded = loadRun(child.targetDir, child.id);
  const tokensBefore = loaded.tokensUsed;

  // A ceiling that admits one turn and refuses the next: above what the fork
  // starts with, below what it will hold once a 1000-token turn is charged. It
  // fires INSIDE `applyCharge`, after that write - so the first forking turn is
  // the whole observation, with nothing after it to tidy up behind the dispatch.
  const ceiling = { budget: { ...config().budget, maxTokens: tokensBefore + 500 } };
  await assert.rejects(() =>
    orchestrate(loaded, config({}, ceiling), true, agents({ claude: () => planFixture() }, [])),
  );

  // Five facts, one write: the fork is done, the slot is started, the totals
  // moved, the turn is in the event log, and nothing is left in flight. A
  // separate save for any of them would let a kill land between two of these.
  const persisted = loadRun(child.targetDir, child.id);
  assert.equal(persisted.forkPending?.main, undefined, 'the fork is marked done');
  assert.equal(persisted.sessionStarted, true, 'beside the started marker');
  assert.ok(persisted.tokensUsed > tokensBefore, 'and the spend it paid for');
  assert.ok(persisted.events.some((e) => e.type === 'claude_turn'), 'and the turn event');
  assert.equal(persisted.inFlight, undefined, 'with nothing left in flight');
});

test('a turn that never returns leaves the fork owed, so the next pass re-forks', async () => {
  const parent = await parentRun('retry');
  const child = await forkOf(parent, planPoint(parent), NO_BRANCH);
  const loaded = loadRun(child.targetDir, child.id);

  await assert.rejects(() =>
    orchestrate(
      loaded,
      config(),
      true,
      agents({ claude: () => { throw new Error('the process died here'); } }, []),
    ),
  );

  const persisted = loadRun(child.targetDir, child.id);
  assert.equal(persisted.sessionStarted, false, 'no turn succeeded');
  assert.equal(persisted.forkPending?.main?.parentId, parent.sessionId, 'so the fork is still owed');
  assert.equal(persisted.forkPending?.main?.attempts, 1, 'and the attempt is recorded');

  // The next pass forks again - from the same parent, into a NEW child id.
  //
  // This case used to assert the same child id, on the grounds that re-issuing
  // the identical command was idempotent. #74 measured that it is not: the id is
  // spent by the ATTEMPT, so the second `--session-id <child>` fails instantly
  // with "Session ID ... is already in use", forever. An observed failure now
  // discards the spent id, which is what makes this retry make progress. The
  // orphan session that leaves behind is what `attempts` and `fork_retried`
  // disclose - see the case below.
  assert.notEqual(persisted.sessionId, child.sessionId, 'the spent id was discarded');
  assert.equal(persisted.sessionRegistered, undefined, 'and the fresh one is unspent');

  const seen: ClaudeTurnOptions[] = [];
  await orchestrate(
    persisted,
    config(),
    true,
    agents({ claude: (_l, options) => { seen.push(options); return planFixture(); } }, []),
  );
  assert.equal(seen[0]?.forkFrom, parent.sessionId, 'the parent is forked again');
  assert.notEqual(seen[0]?.sessionId, child.sessionId, 'into an id the CLI has not refused');
  assert.equal(seen[0]?.sessionId, persisted.sessionId, 'the one the failure minted');
});

test('the retry counter and its event are persisted by one write', async () => {
  const parent = await parentRun('retry record');
  const child = await forkOf(parent, planPoint(parent), NO_BRANCH);
  const loaded = loadRun(child.targetDir, child.id);

  // Two failed attempts: the second is the one that must disclose itself.
  for (const _attempt of [1, 2]) {
    const state = loadRun(child.targetDir, child.id);
    await assert.rejects(() =>
      orchestrate(state, config(), true, agents({ claude: () => { throw new Error('died'); } }, [])),
    );
  }

  const persisted = loadRun(child.targetDir, child.id);
  assert.equal(persisted.forkPending?.main?.attempts, 2);
  const retried = persisted.events.filter((e) => e.type === 'fork_retried');
  assert.equal(retried.length, 1, 'one event for the one retry');
  assert.equal(retried[0]?.['attempt'], 2, 'never the counter without the event, or the reverse');
  assert.equal(retried[0]?.['slot'], 'main');
  assert.ok(loaded !== undefined);
});

test('noteSlotForkAttempt counts nothing for a slot that owes no fork', () => {
  const state = freshRun({ ...FORK, task: 'no fork owed' });
  assert.equal(noteSlotForkAttempt(state, 'main'), 0);
  assert.equal(state.forkPending, undefined);
});

// ---- the branch -------------------------------------------------------------

test('resuming a fork checks its branch out, once', async () => {
  const parent = await parentRun('branch checkout');
  const child = await forkOf(parent, committedPoint(parent));
  assert.equal(child.branchPending, true);
  assert.ok(child.branch !== null);
  const headBefore = gitIn(parent.targetDir, 'rev-parse', '--abbrev-ref', 'HEAD');
  assert.notEqual(headBefore, child.branch, 'the fork did not check anything out');

  const loaded = loadRun(child.targetDir, child.id);
  await orchestrate(
    loaded,
    config({}, committing()),
    true,
    agents({ claude: () => planFixture() }, []),
  );

  assert.equal(branchOf(loaded), child.branch, 'the run is on the branch it claims');
  assert.equal(loaded.branchPending, undefined, 'and the flag is spent');

  // A second resume checks nothing out - it is already there, and there is no
  // flag left to act on.
  const again = loadRun(child.targetDir, child.id);
  assert.equal(again.branchPending, undefined);
  await orchestrate(again, config(), true, agents({ claude: () => planFixture() }, []));
  assert.equal(branchOf(again), child.branch);
});

test('the parent refuses to resume while the fork is checked out, and says how to fix it', async () => {
  const parent = await parentRun('wrong branch');
  const child = await forkOf(parent, committedPoint(parent));

  // Resume the child, which leaves HEAD on the child's branch.
  const loadedChild = loadRun(child.targetDir, child.id);
  await orchestrate(loadedChild, config(), true, agents({ claude: () => planFixture() }, []));
  assert.equal(branchOf(loadedChild), child.branch);

  // Now the parent. Its commits would land on the child's branch.
  const loadedParent = loadRun(parent.targetDir, parent.id);
  loadedParent.phase = 'reviewing';
  loadedParent.status = 'reviewing';
  const err = await orchestrate(loadedParent, config(), true, agents({}, [])).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof Escalation, 'it stops before any turn is dispatched');
  assert.match(err.message, /records branch/);
  assert.match(err.message, new RegExp(`git checkout ${parent.branch ?? ''}`));
  assert.match(err.message, /--no-branch/);
  // Nothing ran, and HEAD did not move.
  assert.equal(branchOf(loadedParent), child.branch);

  // With the branch checked out, it proceeds and commits where it says.
  execFileSync('git', ['checkout', parent.branch ?? ''], { cwd: parent.targetDir, stdio: 'ignore' });
  const again = loadRun(parent.targetDir, parent.id);
  await orchestrate(again, config(), true, agents({}, []));
  assert.equal(branchOf(again), parent.branch);
});

test('--no-branch resumes without the branch check', async () => {
  const parent = await parentRun('no branch resume');
  const child = await forkOf(parent, committedPoint(parent));
  const loadedChild = loadRun(child.targetDir, child.id);
  await orchestrate(loadedChild, config(), true, agents({ claude: () => planFixture() }, []));

  const loadedParent = loadRun(parent.targetDir, parent.id);
  const cfg = config({}, { git: { ...config().git, useBranch: false } });
  await orchestrate(loadedParent, cfg, true, agents({}, []));
  assert.equal(branchOf(loadedParent), child.branch, 'it ran where it was, as asked');
});

test('a stored branch that no longer exists warns rather than refusing', async () => {
  const parent = await parentRun('branch deleted');
  const branch = parent.branch ?? '';
  // Move off it, then delete it: nothing to check out, and recreating it at
  // HEAD would fabricate a base the run never had.
  execFileSync('git', ['checkout', 'main'], { cwd: parent.targetDir, stdio: 'ignore' });
  execFileSync('git', ['branch', '-D', branch], { cwd: parent.targetDir, stdio: 'ignore' });

  const loaded = loadRun(parent.targetDir, parent.id);
  await orchestrate(loaded, config(), true, agents({}, []));
  assert.equal(branchOf(loaded), 'main', 'it continued on HEAD');
});

test("a fork whose branch was deleted before it ran refuses rather than running on HEAD", async () => {
  const parent = await parentRun('fork branch deleted');
  const child = await forkOf(parent, committedPoint(parent));
  execFileSync('git', ['branch', '-D', child.branch ?? ''], {
    cwd: parent.targetDir,
    stdio: 'ignore',
  });

  const loaded = loadRun(child.targetDir, child.id);
  const err = await orchestrate(loaded, config(), true, agents({}, [])).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof Escalation);
  assert.match(err.message, /no longer exists/);
});

test('a fresh run still creates and checks out its branch exactly as before', async () => {
  const state = freshRun({ ...FORK, task: 'fresh branch', git: true, commit: true });
  await orchestrate(state, config(), false, agents({ claude: () => planFixture() }, []));
  assert.equal(state.branch, `vibe/${state.id}`);
  assert.equal(branchOf(state), state.branch);
});

// ---- what a resume must NOT do to the branch --------------------------------

test('a resumed run with no branch does not gain one', async () => {
  // Started with --no-branch, resumed with branch isolation back on. Creating a
  // branch here would move HEAD on a run that has already done work somewhere
  // else - a bigger change than the wrong-branch refusal, and one nothing asked
  // for. Branch creation stays a fresh-run act.
  const state = freshRun({ ...FORK, task: 'branchless', git: true, commit: true });
  const before = branchOf(state);
  await orchestrate(
    state,
    config({}, { git: { ...config().git, useBranch: false } }),
    false,
    agents({ claude: () => planFixture() }, []),
  );
  assert.equal(state.branch, null);
  assert.equal(branchOf(state), before, 'the fresh run made no branch either');

  const resumed = loadRun(state.targetDir, state.id);
  resumed.phase = 'reviewing';
  resumed.status = 'reviewing';
  await orchestrate(resumed, config(), true, agents({}, []));

  assert.equal(resumed.branch, null, 'and the resume did not invent one');
  assert.equal(branchOf(resumed), before, 'HEAD did not move');
});

test('a legacy run resumed in a repo it was never branched in keeps HEAD where it is', async () => {
  // The same shape one step further out: a state written before branches, or by
  // a run started outside a repository, resumed inside one.
  const state = freshRun({ ...FORK, task: 'legacy branchless', git: true, commit: true });
  state.branch = null;
  state.phase = 'reviewing';
  state.status = 'reviewing';
  state.plan = planFixture();
  saveState(state);
  const before = branchOf(state);

  await orchestrate(state, config(), true, agents({}, []));
  assert.equal(branchOf(state), before);
  assert.equal(state.branch, null);
});

test('a pending fork outside a git repository refuses rather than running on HEAD', async () => {
  const parent = await parentRun('fork moved out of the repo');
  const child = await forkOf(parent, committedPoint(parent));
  assert.equal(child.branchPending, true);

  // The repository is gone from under the fork - moved, or the run copied
  // elsewhere. `prepareGit`'s not-a-repo path returns early for an ordinary run,
  // and that early return must not let a fork owing a branch dispatch a turn.
  const loaded = loadRun(child.targetDir, child.id);
  rmSync(path.join(parent.targetDir, '.git'), { recursive: true, force: true });

  const err = await orchestrate(loaded, config(), true, agents({}, [])).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof Escalation, 'it stops before any turn is dispatched');
  assert.match(err.message, /not a git repository/);
  assert.match(err.message, /--no-branch/);
  assert.equal(
    loadRun(child.targetDir, child.id).branchPending,
    true,
    'and the fork still owes its branch',
  );
});

// ---- what a forked conversation is told -------------------------------------

test('a forked Codex conversation is not told it is starting fresh', async () => {
  const parent = await parentRun('codex continuity');
  const child = await forkOf(parent, planPoint(parent), NO_BRANCH);
  const cfg = config();

  // The distinction the prompts turn on: the slot is not `started`, so it has no
  // memory to resume - but the conversation the fork creates does hold the
  // parent's history, and telling the critic otherwise makes it re-derive
  // findings it already made under new ids.
  assert.equal(slotForkParent(child, cfg, 'judge'), 'judge-thread');
  assert.equal(child.codexSessionStarted, undefined, 'no turn has succeeded here yet');
  assert.equal(slotContinuity(child, cfg, 'judge'), true);

  // And it reaches the prompt: a second planning round on a forked judge is told
  // it has seen this run before.
  const prompts = new Map<string, string>();
  const loaded = loadRun(child.targetDir, child.id);
  await orchestrate(
    loaded,
    config({ maxPlanRounds: 3 }),
    true,
    agents(
      {
        claude: () => planFixture(),
        codex: (label, options) => {
          prompts.set(label, options.prompt);
          return report([]);
        },
      },
      [],
    ),
  );
  const critique = [...prompts.entries()].find(([label]) => label.startsWith('critique'))?.[1];
  assert.ok(critique !== undefined, 'the critic ran');
  // The round-2 continuity note, which is the whole of the difference: told it
  // has memory, the critic is asked to re-raise unresolved findings under their
  // EXISTING ids; told it has none, it is asked to judge afresh - and every
  // still-live objection comes back under a new id, which reads as churn.
  assert.ok(
    critique.includes('continues the same conversation'),
    'a forked conversation is not told it is seeing this run for the first time',
  );
  assert.ok(critique.includes('exact same `id` you used before'));
});

