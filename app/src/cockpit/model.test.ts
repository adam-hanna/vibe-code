import { describe, expect, test } from 'vitest';
import { emptyRun, nextRun, reduce, runningRow, OUTPUT_KEEP } from './model';
import type { Run } from './model';
import type { Frame } from '../host';

/**
 * The reducer, on the frames a real pass actually emits (#159).
 *
 * The sequence below is the one `tests/narration-identity.test.ts` pins in the
 * core, so this file and that one describe the same run from opposite ends. If
 * the loop's ids change, that test fails first and this one second - which is
 * the right order, because the core is where the contract lives.
 *
 * **Nothing here asserts on English.** Every case drives ids and data, which is
 * the property that makes the cockpit survive somebody improving a sentence.
 */

/** A narration frame, as the wire delivers it. */
function say(id: string | null, data: Record<string, unknown> | null, message = 'x'): Frame {
  return { type: 'narration', level: 'info', message, id, data };
}

const beat = (elapsedMs: number, over: Record<string, unknown> = {}): Frame =>
  say('heartbeat', {
    label: 'plan',
    elapsedMs,
    activities: 47,
    unit: 'tool use',
    tokens: 120_000,
    promptTokens: 90_000,
    ...over,
  });

/** Fold a list of frames, one millisecond apart, from `t0`. */
function fold(frames: readonly Frame[], t0 = 1_000_000): Run {
  return frames.reduce((run, frame, i) => reduce(run, frame, t0 + i), emptyRun());
}

/** The nine-id clean pass the core pins, in order. */
const CLEAN: readonly Frame[] = [
  // `round` on `planning` since #223: it was the one phase in the plan cycle
  // that carried none, which the fixture faithfully reproduced.
  say('phase_started', { phase: 'planning', round: 0 }),
  say('turn_started', { role: 'planner', kind: 'plan' }),
  say('phase_started', { phase: 'critique', round: 0 }),
  say('turn_started', { role: 'critic', kind: 'critique', round: 0 }),
  say('phase_started', { phase: 'implementing' }),
  say('verify_started', { gate: 'verification' }),
  say('phase_started', { phase: 'review', round: 0 }),
  say('turn_started', { role: 'reviewer', kind: 'review', round: 0 }),
  say('review_approved', { findings: 0 }),
];

describe('the loop column is built from ids and never from sentences', () => {
  // Found by kind rather than by position, so a change to the order these
  // groups first appear in does not fail four tests about something else.
  const group = (run: Run, kind: string) => run.cycles.find((c) => c.kind === kind);

  test('a clean pass fills four groups in the order the phases arrived', () => {
    const run = fold(CLEAN);
    expect(run.cycles.map((c) => c.kind)).toEqual(['plan', 'critique', 'code', 'review']);
    // **The judge has a group of its own.** A round is still the pair - the
    // planner produces a version and the critic judges it - and `rounds()` is
    // where that survives, because hi-fi 5's card draws the pair. What the
    // column draws is four peer headings, so the critique has a name on screen
    // instead of being a row inside cycle 1 that nobody could find.
    expect(group(run, 'plan')?.phases.map((p) => p.phase)).toEqual(['planning']);
    expect(group(run, 'critique')?.phases.map((p) => p.phase)).toEqual(['critique']);
    expect(group(run, 'code')?.phases.map((p) => p.phase)).toEqual(['implementing']);
    expect(group(run, 'review')?.phases.map((p) => p.phase)).toEqual(['review']);
  });

  test('a turn lands in the phase that was open when it started', () => {
    const run = fold(CLEAN);
    const turns = run.cycles.flatMap((c) => c.phases.map((p) => p.turns.map((t) => t.role)));
    expect(turns).toEqual([['planner'], ['critic'], [], ['reviewer']]);
    // The implementing phase is the empty one, and deliberately: it has never
    // had a `log.step`, so `phase_started` IS its turn's announcement. #152
    // pinned that in the core as a decision rather than a gap.
    expect(group(run, 'code')?.phases[0]?.turns).toEqual([]);
  });

  test('the round a phase carries is the archive number, not the display one', () => {
    // The heading says "round 1" because humans count from one; the artifact is
    // `plan-critique-0.json`. The column has to carry the one that names a file.
    expect(group(fold(CLEAN), 'critique')?.phases[0]?.round).toBe(0);
  });

  test('the producer half carries the round too, so the two groups pair by eye', () => {
    // `planning` carried no round at all until #223, which was invisible while
    // it sat in the same group as its critique and is not once they are peers:
    // the chip is the only thing saying which critique judged which draft.
    expect(group(fold(CLEAN), 'plan')?.phases[0]?.round).toBe(0);
  });

  test('a verify gate attaches to the phase that opened it', () => {
    expect(group(fold(CLEAN), 'code')?.phases[0]?.gates).toEqual(['verification']);
  });

  test('an id from a newer core reaches the output pane and moves nothing', () => {
    // The property that makes adding a narration id to the loop a safe change
    // for an app that has already shipped.
    const run = fold([...CLEAN, say('something_new', { what: 1 })]);
    const clean = fold(CLEAN);
    expect(run.cycles).toEqual(clean.cycles);
    expect(run.output.length).toBe(clean.output.length + 1);
  });

  test('a phase this version cannot place is left out of the column, not guessed in', () => {
    const run = fold([say('phase_started', { phase: 'teleporting' })]);
    expect(run.cycles).toEqual([]);
    expect(run.output.length).toBe(1);
  });
});

describe('the step before the first phase', () => {
  test('preflight says what it will probe, then which one it is probing', () => {
    const started = fold([say('preflight_started', { agents: ['claude', 'codex'] })], 1_000_000);
    expect(started.preflight).toEqual({
      agents: ['claude', 'codex'],
      probing: null,
      passed: false,
      // When it started, so the card can carry an elapsed instead of a spinner
      // (hi-fi 16). `fold` steps one millisecond per frame from `t0`.
      at: 1_000_000,
    });

    const probing = fold(
      [
        say('preflight_started', { agents: ['claude', 'codex'] }),
        say('probe_started', { agent: 'codex' }),
      ],
      1_000_000,
    );
    expect(probing.preflight).toEqual({
      agents: ['claude', 'codex'],
      probing: 'codex',
      passed: false,
      at: 1_000_000,
    });
  });

  test('the elapsed clock measures preflight, not the probe it is on', () => {
    // `at` is kept from the announcement rather than reset by each probe, so a
    // card that has been up for forty seconds does not drop back to two the
    // moment the second agent starts.
    const run = fold(
      [
        say('preflight_started', { agents: ['claude', 'codex'] }),
        say('probe_started', { agent: 'claude' }),
        say('probe_started', { agent: 'codex' }),
      ],
      1_000_000,
    );
    expect(run.preflight?.at).toBe(1_000_000);
  });

  test('passing clears the agent in flight, so the row does not stay mid-probe', () => {
    const run = fold(
      [
        say('preflight_started', { agents: ['claude', 'codex'] }),
        say('probe_started', { agent: 'codex' }),
        say('preflight_passed', null),
      ],
      1_000_000,
    );
    expect(run.preflight).toEqual({
      agents: ['claude', 'codex'],
      probing: null,
      passed: true,
      at: 1_000_000,
    });
  });

  test('a probe from a core that never announced the list leaves the list empty', () => {
    // Never counted from the agent in hand. A window that filled in `['codex']`
    // would be deciding how many probes a run has, and would then draw
    // `1 of 1` on a run that probes two. The clock starts here instead, which is
    // the only honest reading available on a core that said nothing earlier.
    const run = fold([say('probe_started', { agent: 'codex' })], 1_000_000);
    expect(run.preflight).toEqual({
      agents: [],
      probing: 'codex',
      passed: false,
      at: 1_000_000,
    });
  });

  test('a list that is not wholly readable is no list rather than a partial one', () => {
    for (const agents of [['claude', 7], 'claude', [''], null]) {
      expect(fold([say('preflight_started', { agents })]).preflight?.agents).toEqual([]);
    }
  });

  test('a skipped or older preflight leaves the row absent, not empty', () => {
    // `--skip-probe` narrates none of these, and neither does a core that
    // predates them. Absent is what is true, and the column draws nothing.
    expect(fold(CLEAN).preflight).toBeNull();
  });
});

describe('which run this is', () => {
  test('the identity is what the loop said, and nothing until it says', () => {
    expect(emptyRun().identity).toBeNull();
    const run = fold(
      [
        say('run_started', {
          runId: '20260907-031221-a-task',
          dir: '/repo/.vibe/runs/20260907-031221-a-task',
          resumed: false,
        }),
      ],
      1_000_000,
    );
    expect(run.identity).toEqual({
      runId: '20260907-031221-a-task',
      dir: '/repo/.vibe/runs/20260907-031221-a-task',
      // The frame above is what a core older than #223 sends, and both of the
      // header's other two lines come back null rather than being filled in
      // from what is here - the repository is NOT `dir` with `.vibe/runs/<id>`
      // trimmed off, and the task is not the run id with its stamp removed.
      repo: null,
      task: null,
      resumed: false,
      // When the CORE said this, which is the honest answer to "when did the
      // task reach the core". The window's own send time would be when it
      // asked, not when anything happened (hi-fi 16).
      at: 1_000_000,
    });
  });

  test('the repository and the task are carried when the core sends them (#223)', () => {
    // Hi-fi 1's identity header: workstream, branch, repository. Two of the
    // three ride here; the third is `run_branch`.
    const run = fold([
      say('run_started', {
        runId: 'r',
        dir: '/repo/.vibe/runs/r',
        repo: '/repo',
        task: 'build a todo app',
        resumed: false,
      }),
    ]);
    expect(run.identity?.repo).toBe('/repo');
    expect(run.identity?.task).toBe('build a todo app');
  });

  test('the branch is told, and a run with none says which kind of none', () => {
    // Null for the whole field is "nothing has said" - an older core. A named
    // branch of null with a reason is a run that HAS no branch, which is a
    // different fact and the header words it differently.
    expect(emptyRun().branch).toBeNull();
    expect(fold([say('run_branch', { branch: 'vibe/r', why: null })]).branch).toEqual({
      name: 'vibe/r',
      why: null,
    });
    expect(
      fold([say('run_branch', { branch: null, why: 'branch isolation is off' })]).branch,
    ).toEqual({ name: null, why: 'branch isolation is off' });
  });

  test('a commit carries both ends of its range, and neither is derived (#223)', () => {
    // The Code tab shows one round's diff, which needs `from` and `to`.
    // `round_committed` reads HEAD before it commits, so both are measured - the
    // alternative is pairing consecutive commits here, which is correct until a
    // run is resumed and the earlier commits were narrated to a process that has
    // exited, at which point round 3 silently shows a cumulative diff.
    const run = fold([
      say('round_committed', { sha: 'aaa', since: 'bbb', message: 'vibe: implement' }),
      say('round_committed', { sha: 'ccc', since: 'aaa', message: 'vibe: fix round 1' }),
    ]);
    expect(run.commits.map((c) => [c.since, c.sha])).toEqual([
      ['bbb', 'aaa'],
      ['aaa', 'ccc'],
    ]);
    expect(run.commits[1]?.message).toBe('vibe: fix round 1');
  });

  test('a first commit in an empty repository has no parent, and says so', () => {
    // `markBase` answers null in a repository with no commits yet. Null is a
    // real answer - "everything up to here" - and not a missing field.
    expect(fold([say('round_committed', { sha: 'aaa' })]).commits[0]?.since).toBeNull();
  });

  test('a commit with no sha is dropped: it is not a commit anybody can diff', () => {
    expect(fold([say('round_committed', { since: 'bbb' })]).commits).toEqual([]);
  });

  test('a resume is the same id, saying so', () => {
    const run = fold([say('run_started', { runId: 'r', dir: '/d', resumed: true })]);
    expect(run.identity?.resumed).toBe(true);
  });

  test('a half-carried identity is no identity, not a run id with a blank home', () => {
    // Both fields or neither. The emitting site has both in hand, so one
    // arriving alone means something is wrong with the frame rather than with
    // the run - and a window that showed the id beside an empty path would be
    // presenting that as a fact about the run.
    for (const data of [{ runId: 'r' }, { dir: '/d' }, {}, { runId: 7, dir: '/d' }]) {
      expect(fold([say('run_started', data)]).identity).toBeNull();
    }
  });

  test('a second run does not inherit the first one\'s identity', () => {
    // `nextRun` carries the protocol and the sequence because both are facts
    // about the process. An identity is a fact about the run, and showing the
    // last one beside a fresh launch would point a person at the wrong
    // directory on disk.
    const run = fold([say('run_started', { runId: 'first', dir: '/d', resumed: false })]);
    expect(nextRun(run).identity).toBeNull();
    expect(nextRun(run).protocol).toBe(run.protocol);
  });

  test('an older core that never says it leaves the window unable to name the run', () => {
    // Absent, not guessed. There is nothing else on the wire a run id could be
    // derived from, and the honest state is that the window does not know.
    expect(fold(CLEAN).identity).toBeNull();
  });
});

describe('a turn ends because the next thing starts', () => {
  test('a new turn closes the one before it', () => {
    const run = fold(CLEAN);
    const all = run.cycles.flatMap((c) => c.phases.flatMap((p) => p.turns));
    const open = all.filter((t) => t.endedAt === null);
    expect(open.map((t) => t.role)).toEqual(['reviewer']);
  });

  test('a result closes whatever was still running', () => {
    const run = fold([...CLEAN, { type: 'result', id: 1, exit: 0 }]);
    expect(run.running).toBeNull();
    const all = run.cycles.flatMap((c) => c.phases.flatMap((p) => p.turns));
    expect(all.every((t) => t.endedAt !== null)).toBe(true);
  });

  test('the loop saying it is done and the command returning are two facts', () => {
    // `ended` arrives while the command is still writing artifacts and printing
    // a summary. Only `completed` means another run may be started, and
    // `serve.ts` refuses one before then.
    const approved = fold(CLEAN);
    expect(approved.ended).not.toBeNull();
    expect(approved.completed).toBeNull();

    const done = fold([...CLEAN, { type: 'result', id: 1, exit: 0 }]);
    expect(done.completed).toEqual({ exit: 0 });
  });
});

describe('the two clocks are different measurements and the loop wins', () => {
  test('a heartbeat re-anchors the turn to the loop own elapsed figure', () => {
    // Our clock ticks between beats; the loop's clock is authoritative whenever
    // it speaks. Anchoring is what stops the two drifting apart over an hour.
    const t0 = 5_000_000;
    const run = fold(
      [say('phase_started', { phase: 'planning' }), say('turn_started', { role: 'planner', kind: 'plan' }), beat(600_000)],
      t0,
    );
    // The beat arrived at t0+2 saying "this turn has run ten minutes".
    expect(run.running?.startedAt).toBe(t0 + 2 - 600_000);
    expect(runningRow(run.running!, t0 + 2).elapsedMs).toBe(600_000);
  });

  test('a heartbeat with no turn open is dropped rather than attributed', () => {
    // A measurement that cannot be attributed is not recorded.
    const run = fold([beat(1000)]);
    expect(run.running).toBeNull();
    expect(run.cycles).toEqual([]);
  });
});

describe('the running row reports absence as absence', () => {
  const started = fold([
    say('phase_started', { phase: 'planning' }),
    say('turn_started', { role: 'planner', kind: 'plan' }),
  ]);

  test('before the first beat there is elapsed time and nothing else', () => {
    const row = runningRow(started.running!, started.running!.startedAt + 4321);
    expect(row.elapsedMs).toBe(4321);
    expect(row.activities).toBeNull();
    expect(row.lastActivity).toBeNull();
    expect(row.quietMs).toBeNull();
    expect(row.tokens).toBeNull();
  });

  test('an unmeasured context window is null, never a bar at zero', () => {
    // `heartbeatData` omits the field rather than sending a zero, and the
    // omission IS the fact. The one bar in the app needs a real denominator.
    const run = fold([
      say('phase_started', { phase: 'planning' }),
      say('turn_started', { role: 'planner', kind: 'plan' }),
      beat(1000),
    ]);
    expect(runningRow(run.running!, 0).context).toBeNull();
  });

  test('a known window with no prompt size yet is still not a bar', () => {
    // The same condition `formatHeartbeat` puts on printing `ctx N%`. A bar at
    // 0% and a bar that cannot be measured look identical and mean opposite
    // things - which is why this is the only bar in the app.
    const run = fold([
      say('phase_started', { phase: 'planning' }),
      say('turn_started', { role: 'planner', kind: 'plan' }),
      beat(1000, { contextWindow: 200_000, promptTokens: 0 }),
    ]);
    expect(runningRow(run.running!, 0).context).toBeNull();
  });

  test('a measured context window gives the bar both of its numbers', () => {
    const run = fold([
      say('phase_started', { phase: 'planning' }),
      say('turn_started', { role: 'planner', kind: 'plan' }),
      beat(1000, { contextWindow: 200_000 }),
    ]);
    expect(runningRow(run.running!, 0).context).toEqual({ used: 90_000, window: 200_000 });
  });

  test('lastActivity absent means nothing observed, which is not nothing happened', () => {
    const run = fold([
      say('phase_started', { phase: 'planning' }),
      say('turn_started', { role: 'planner', kind: 'plan' }),
      beat(1000, { lastActivity: '' }),
    ]);
    expect(runningRow(run.running!, 0).lastActivity).toBeNull();
  });

  test('a Codex turn reporting zero tokens shows no figure, not a zero', () => {
    // Found on a real run: the answerer's heartbeat carries `tokens: 0` for the
    // whole turn, because Codex reports no usage until `turn.completed`. The
    // terminal already drops the segment below one - `formatHeartbeat` gates it
    // on `> 0` - and drawing `0 tok` would be an absence rendered as a
    // measurement, on a turn that is spending the entire time.
    const run = fold([
      say('phase_started', { phase: 'planning' }),
      say('turn_started', { role: 'answerer', kind: 'answer' }),
      beat(30_000, { unit: 'event', tokens: 0, promptTokens: 0 }),
    ]);
    const row = runningRow(run.running!, 0);
    expect(row.tokens).toBeNull();
    // The activity count is still a counted zero and still a fact: it says the
    // stream was read and nothing was seen, which is not the same absence.
    expect(row.activities).toEqual({ count: 47, unit: 'event' });
  });

  test('the line with no source says what is missing, in words a user can act on', () => {
    // Drawn as absent with a reason rather than as a blank or a zero. `6a` has
    // failed three times by inventing a denominator; this says why it is missing
    // instead.
    //
    // **This case used to assert the same of the diffstat line, and that half is
    // gone because the contract moved, not because it was inconvenient (#198).**
    // #136 landed and the loop began narrating file counts, so an assertion that
    // the row still says it does not would have been pinning the defect. The
    // part that still holds - a missing measurement is absent WITH A REASON - is
    // kept here and asserted of the diffstat's own absence below.
    //
    // **It used to assert the issue number was in the sentence, and that is the
    // part that moved.** An end user cannot act on `#114`; the actionable half
    // is the statement that no frame carries the figure. The number stays in the
    // source comment, where the next reader of this module is.
    const row = runningRow(started.running!, 0);
    expect(row.comparable).toMatch(/no frame carries it/);
    expect(row.comparable).not.toMatch(/#\d/);
  });

  test('a turn with no reading says which turns get one, rather than looking late', () => {
    // Only write turns are sampled - `withWorkProgress` wraps those and nothing
    // else - so a planning turn has no reading and never will. Saying "not yet"
    // about it would be a promise the loop is not going to keep.
    const row = runningRow(started.running!, 0);
    expect(row.work).toBeNull();
    expect(row.noWork).toMatch(/write turns/);
  });
});

describe('the tree the loop measured reaches the row', () => {
  const writing = (...readings: readonly Frame[]): Run =>
    fold([
      say('phase_started', { phase: 'implementing' }),
      say('turn_started', { role: 'implementer', kind: 'implement' }),
      ...readings,
    ]);

  const reading = (id: string, over: Record<string, unknown> = {}): Frame =>
    say(id, { label: 'implement', files: 9, added: 2, uncounted: 0, ...over });

  test('both work ids land, because the loop emits two and they are not one fact', () => {
    // `work_progress` is a sample during the turn and `work_measured` is the
    // final reading. Reading only the second would leave this line blank for the
    // entire ninety minutes it exists for.
    for (const id of ['work_progress', 'work_measured']) {
      expect(runningRow(writing(reading(id)).running!, 0).work?.files).toBe(9);
    }
  });

  test('the most recent reading wins', () => {
    const run = writing(reading('work_progress', { files: 3 }), reading('work_measured', { files: 9 }));
    expect(runningRow(run.running!, 0).work?.files).toBe(9);
  });

  test('a reading with no turn open is dropped rather than attributed', () => {
    // The rule the heartbeat already follows, for the same reason.
    const run = fold([reading('work_progress')]);
    expect(run.running).toBeNull();
  });

  test('a record with no file count is not a reading this version understands', () => {
    // Fails closed. `files` is the one field `workData` always sends, so a
    // record without it came from something this build cannot read - and a zero
    // filled in for it would claim the turn had changed nothing.
    const run = writing(say('work_progress', { label: 'implement', insertions: 40 }));
    expect(runningRow(run.running!, 0).work).toBeNull();
  });

  test('lines git could not count are absent, and are not zero', () => {
    // The distinction `workData` sends and the row has to keep: `insertions`
    // omitted means git could not be asked, which is not `+0`.
    const run = writing(reading('work_measured'));
    const work = runningRow(run.running!, 0).work;
    expect(work?.insertions).toBeNull();
    expect(work?.deletions).toBeNull();
  });

  test('a turn that changed nothing is a measurement, not an absence', () => {
    // `files: 0` is a real reading and the most interesting one this ever
    // produces: the run has just paid for a turn that produced no change.
    const run = writing(reading('work_measured', { files: 0 }));
    const row = runningRow(run.running!, 0);
    expect(row.work).toEqual({
      files: 0,
      insertions: null,
      deletions: null,
      uncounted: 0,
      plan: null,
      at: expect.any(Number) as unknown as number,
    });
    expect(row.noWork).toBeNull();
  });

  test('the plan proxy needs both halves or it is not a figure', () => {
    // One without the other is not a coverage figure, and choosing a value for
    // the missing half would invent the number the proxy exists to avoid.
    const half = writing(reading('work_measured', { planNamed: 14 }));
    expect(runningRow(half.running!, 0).work?.plan).toBeNull();

    const whole = writing(reading('work_measured', { planNamed: 14, planTouched: 9 }));
    expect(runningRow(whole.running!, 0).work?.plan).toEqual({ named: 14, touched: 9 });
  });
});

describe('the gate is the payoff', () => {
  const held: Frame = {
    type: 'ask',
    id: 7,
    context: {
      boundary: 'plan-approved',
      phase: 'planning',
      planRound: 0,
      questionRound: 0,
      reviewRound: 0,
      verifyRound: 0,
    },
  };

  test('an ask carries the id to answer, where in the run it is, and after what', () => {
    const run = fold([...CLEAN, held]);
    // The turn the person is deciding about (#202), named by the reducer so the
    // column does not have to work out that "the last one" is the right one.
    // Read off the run rather than written as a literal: the identities come
    // from `seq`, and pinning one here would make this fail on any change to
    // how many a clean pass hands out.
    const turns = run.cycles.flatMap((c) => c.phases.flatMap((p) => p.turns));
    expect(run.gate).toEqual({
      askId: 7,
      boundary: 'plan-approved',
      planRound: 0,
      reviewRound: 0,
      verifyRound: 0,
      turnId: turns[turns.length - 1]?.id,
    });
  });

  test('a held gate has no live turn, and the one before it has ended', () => {
    // The whole of #202. A run held at `question-round` overnight drew
    // `5h40m / last activity 5h39m ago` on a turn that had taken a minute -
    // two inches above a footer correctly saying the loop was waiting for a
    // human. The card said kill it; the footer said press continue.
    const run = fold([...CLEAN, held]);
    expect(run.running).toBeNull();
    const turns = run.cycles.flatMap((c) => c.phases.flatMap((p) => p.turns));
    expect(turns.every((t) => t.endedAt !== null)).toBe(true);
  });

  test('the settled turn keeps its measurements and stops both clocks', () => {
    // Not deleted, because the moment before somebody presses continue is
    // exactly when they want to see what the turn did. `runningRow` measures to
    // `endedAt`, so an hour of waiting is not reported as an hour of work.
    const run = fold([...CLEAN, held], 1_000_000);
    const turns = run.cycles.flatMap((c) => c.phases.flatMap((p) => p.turns));
    const settled = turns.find((t) => t.id === run.gate?.turnId);
    if (settled === undefined) throw new Error('the gate named no turn');

    const atOnce = runningRow(settled, settled.endedAt ?? 0);
    const anHourLater = runningRow(settled, (settled.endedAt ?? 0) + 3_600_000);
    expect(anHourLater.elapsedMs).toBe(atOnce.elapsedMs);
    expect(anHourLater.quietMs).toBe(atOnce.quietMs);
  });

  test('a settled turn carries the instants a card needs to stop aging', () => {
    // Hi-fi 17. Stopping the clocks was half the fix; the other half is that a
    // *relative* time on a card that has stopped moving keeps aging into a lie.
    // `quietMs` stays for the live card and these two are what the settled one
    // reads, so both are on the row rather than the component choosing between
    // a number and a date it computed itself.
    const t0 = 1_000_000;
    const run = fold([...CLEAN.slice(0, 2), beat(60_000), held], t0);
    const turns = run.cycles.flatMap((c) => c.phases.flatMap((p) => p.turns));
    const settled = turns.find((t) => t.id === run.gate?.turnId);
    if (settled === undefined) throw new Error('the gate named no turn');

    const row = runningRow(settled, t0 + 9_999_999);
    expect(row.endedAt).toBe(settled.endedAt);
    expect(row.lastBeatAt).toBe(settled.beat?.at);
    // And they do not move, however long the gate is held.
    expect(runningRow(settled, t0 + 99_999_999).lastBeatAt).toBe(row.lastBeatAt);
  });

  test('a running turn has no ended instant to report', () => {
    const run = fold(CLEAN);
    expect(run.running).not.toBeNull();
    expect(runningRow(run.running!, 2_000_000).endedAt).toBeNull();
  });

  test('a gate reached before any turn names none, rather than naming a wrong one', () => {
    const run = fold([held]);
    expect(run.gate?.turnId).toBeNull();
  });

  test('releasing clears the gate and the run carries on', () => {
    // Mid-run, not after it: `CLEAN` ends with `review_approved`, so appending
    // to the whole sequence would be asserting about a run that has finished.
    const mid = CLEAN.slice(0, 2);
    const run = fold([...mid, held, say('gate_released', { boundary: 'plan-approved' })]);
    expect(run.gate).toBeNull();
    expect(run.ended).toBeNull();
    // Nothing is running, and that is the change #202 made. This used to assert
    // the planner was still live, which was only true because the `ask` failed
    // to close it - the loop is between turns here and the next `turn_started`
    // is what starts one.
    expect(run.running).toBeNull();
    expect(run.cycles[0]?.phases[0]?.turns[0]?.role).toBe('planner');
  });

  test('stopping ends the run and keeps the reason the host gave', () => {
    const run = fold([
      ...CLEAN,
      held,
      say('gate_stopped', { boundary: 'plan-approved', reason: 'you said so' }),
    ]);
    expect(run.gate).toBeNull();
    expect(run.ended).toEqual({ how: 'stopped', detail: 'you said so' });
    expect(run.running).toBeNull();
  });

  test('a stop with no reason falls back to the sentence rather than inventing one', () => {
    const run = fold([held, say('gate_stopped', { boundary: 'plan-approved' }, 'Stopped at plan-approved')]);
    expect(run.ended?.detail).toBe('Stopped at plan-approved');
  });
});

describe('the output pane', () => {
  test('keeps a tail rather than a whole run', () => {
    const many = Array.from({ length: OUTPUT_KEEP + 50 }, (_, i) => say(null, null, `line ${i}`));
    const run = fold(many);
    expect(run.output.length).toBe(OUTPUT_KEEP);
    expect(run.output[run.output.length - 1]?.message).toBe(`line ${OUTPUT_KEEP + 49}`);
  });

  test('every narration reaches it, id or no id', () => {
    const run = fold([say(null, null, 'just prose'), ...CLEAN]);
    expect(run.output.length).toBe(1 + CLEAN.length);
  });
});

describe('a run that ends badly says so, and says why (#162)', () => {
  test('a turn timeout is an ending, not an idle cockpit', () => {
    // The run that produced the issue: a Codex critique stalled and was killed
    // at its 45-minute ceiling. Every one of these frames arrived; nothing read
    // the last two, so the footer said `idle`.
    const run = fold([
      say('phase_started', { phase: 'critique', round: 0 }),
      say('turn_started', { role: 'critic', kind: 'critique', round: 0 }),
      say(
        'run_failed',
        { code: 1, reason: 'the critic turn exceeded criticTimeoutMs' },
        'Error: the critic turn exceeded criticTimeoutMs\n    at claudeTurn (...)',
      ),
      { type: 'result', id: 1, exit: 1 },
    ]);

    expect(run.reason).toEqual({ code: 1, message: 'the critic turn exceeded criticTimeoutMs' });
    expect(run.completed).toEqual({ exit: 1 });
    // `ended` stays null and that is correct: the LOOP never said anything about
    // itself here. The two are different facts and neither stands in for the
    // other - which is the whole reason a third field exists.
    expect(run.ended).toBeNull();
  });

  test('the sentence is preferred over the stack, and the stack is the fallback', () => {
    // `run_escalated` carries no `reason` because its message already IS the
    // sentence; `run_failed` prints a stack and carries one. One field, read the
    // same way `gate_stopped` reads its own.
    const withReason = fold([say('run_failed', { code: 1, reason: 'the short one' }, 'the stack')]);
    expect(withReason.reason?.message).toBe('the short one');

    const without = fold([say('run_escalated', { code: 2 }, 'Three questions are unanswered.')]);
    expect(without.reason).toEqual({ code: 2, message: 'Three questions are unanswered.' });
  });

  test('a code that did not arrive stays null rather than becoming zero', () => {
    // Zero is `EXIT.OK`. A frame from a build that sent no code must never fold
    // into the one value that means the run was fine.
    const run = fold([say('run_failed', { reason: 'something went wrong' })]);
    expect(run.reason?.code).toBeNull();
  });

  test('the ending does not close the open turn - the result frame does', () => {
    const upTo = fold([
      say('phase_started', { phase: 'planning' }),
      say('turn_started', { role: 'planner', kind: 'plan' }),
      say('run_failed', { code: 1, reason: 'boom' }),
    ]);
    // The command is still writing artifacts and a summary. Ending the turn here
    // would stamp an endedAt nobody measured.
    expect(upTo.running).not.toBeNull();

    const done = reduce(upTo, { type: 'result', id: 1, exit: 1 }, 2_000_000);
    expect(done.running).toBeNull();
  });

  test('a clean pass carries no reason at all', () => {
    expect(fold(CLEAN).reason).toBeNull();
  });
});

describe('a second run is a second column', () => {
  test('starting again clears the run and keeps what belongs to the host', () => {
    const first = reduce(fold(CLEAN), { type: 'ready', protocol: 1, pid: 9 }, 1);
    const second = nextRun(first);
    expect(second.cycles).toEqual([]);
    expect(second.output).toEqual([]);
    expect(second.ended).toBeNull();
    expect(second.reason).toBeNull();
    expect(second.completed).toBeNull();
    // The protocol version described the process, not the work.
    expect(second.protocol).toBe(1);
  });

  test('identity does not restart, so nothing from the old run can collide', () => {
    const first = fold(CLEAN);
    expect(nextRun(first).seq).toBe(first.seq);
  });
});

describe('reduce is pure', () => {
  test('the same frames from the same start give the same run', () => {
    // The property a module-level counter would have broken: identity comes out
    // of the run, so folding twice in one process gives two identical results.
    expect(fold(CLEAN)).toEqual(fold(CLEAN));
  });

  test('folding does not mutate what it was given', () => {
    const before = emptyRun();
    const snapshot = JSON.stringify(before);
    reduce(before, CLEAN[0]!, 1);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('a round that re-enters its phase is one group, not two (#223)', () => {
  // The report: *"There are now TWO boxes for Plan Round 1. It looks like
  // questions were answered, but rather than continuing with the existing box,
  // it created a new box after answering the questions."* The loop announces
  // `planning` again when it revises against its own answers, which is correct -
  // a phase did start - and drawing it as a second round is not.
  const questionRound: readonly Frame[] = [
    say('phase_started', { phase: 'planning', round: 1 }),
    say('turn_started', { role: 'planner', kind: 'revise' }),
    say('questions_opened', { total: 3, blocking: 2, round: 1, cap: 3 }),
    say('turn_started', { role: 'answerer', kind: 'answers' }),
    // The revision against the answers. Same phase, same round: this is the
    // frame that used to open a second group.
    say('phase_started', { phase: 'planning', round: 1 }),
    say('turn_started', { role: 'planner', kind: 'revise' }),
  ];

  test('one group, and every turn of the round is in it', () => {
    const run = fold(questionRound);
    const plan = run.cycles.find((c) => c.kind === 'plan');
    expect(plan?.phases).toHaveLength(1);
    // All three turns - the draft, the answerer and the revision - which is the
    // shape the loop actually has and the reason the merge is right rather than
    // merely tidier.
    expect(plan?.phases[0]?.turns.map((t) => t.role)).toEqual([
      'planner',
      'answerer',
      'planner',
    ]);
  });

  test('the group keeps the time the round began', () => {
    // A card is dated from when the round started, not from its second turn. Had
    // the merge taken the later `startedAt`, a plan round that spent ten minutes
    // on questions would report the two minutes after them.
    const run = fold(questionRound, 500_000);
    expect(run.cycles[0]?.phases[0]?.startedAt).toBe(500_000);
  });

  test('a different round is a new group, and so is a re-entry with a gap', () => {
    const advanced = fold([
      say('phase_started', { phase: 'planning', round: 0 }),
      say('phase_started', { phase: 'planning', round: 1 }),
    ]);
    expect(advanced.cycles[0]?.phases).toHaveLength(2);

    // The fix round: `implementing` re-opens at the same review round, and the
    // review that asked for it is in between. Merging here would fold a fix into
    // the round it was fixing, so the rule is the *most recently opened* group
    // and never any group with a matching number.
    const fix = fold([
      say('phase_started', { phase: 'implementing', round: 0 }),
      say('phase_started', { phase: 'review', round: 0 }),
      say('phase_started', { phase: 'implementing', round: 0 }),
    ]);
    expect(fix.cycles.find((c) => c.kind === 'code')?.phases).toHaveLength(2);
  });

  test('two unnumbered phases stay two, because nothing said they were one round', () => {
    // A null round is the loop declining to number the phase, not evidence that
    // two groups are one. Requiring the number is what leaves a core older than
    // `round`-on-`planning` drawing exactly what it drew before.
    const run = fold([
      say('phase_started', { phase: 'planning', round: null }),
      say('phase_started', { phase: 'planning', round: null }),
    ]);
    expect(run.cycles[0]?.phases).toHaveLength(2);
  });
});

describe('an artifact the run wrote is what makes a pane live (#223)', () => {
  test('every write is appended, rewrites of one name included', () => {
    // Appended rather than de-duplicated: a plan round that answers its own
    // questions replaces `plan-1.json` under the name it already had, and that
    // second write is exactly the event a pane holding the first needs.
    const run = fold([
      say('artifact_written', { name: 'plan-1.json' }),
      say('artifact_written', { name: 'answers-1.json' }),
      say('artifact_written', { name: 'plan-1.json' }),
    ]);
    expect(run.artifacts).toEqual(['plan-1.json', 'answers-1.json', 'plan-1.json']);
  });

  test('a frame with no name is dropped, and an old core simply has none', () => {
    expect(fold([say('artifact_written', {})]).artifacts).toEqual([]);
    expect(fold(CLEAN).artifacts).toEqual([]);
  });
});
