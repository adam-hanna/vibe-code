import { useState } from 'react';
import { LivenessDot, MetaChip, StateKicker } from '../design';
import { Counts } from './Counts';
import { clock, elapsed } from './format';
import { censusByPhase, questionsPhase, title } from './rounds';
import { RunningRow } from './RunningRow';
import type { Census, CycleKind, PhaseGroup, Preflight, ResumedFrom, Run, Turn } from './model';

/**
 * The centre column from `3a`, at the width the design fixes it at.
 *
 * Three cycle groups, because the loop is **not linear**: it is three nested
 * convergence cycles, each iterating over versions of an artifact until the
 * adversary stops objecting. A cycle header must never read *closed* - cycle 2
 * re-opens on every review fix, and saying otherwise would be describing a
 * pipeline the code does not have.
 *
 * Round lists grow unboundedly, which is why the column collapses by cycle.
 *
 * **A round, not a phase, is the unit inside a cycle.** The column used to draw
 * one row per phase group, which made a plan round arrive as two rows, made the
 * cycle header count two plan rounds as three, and filed the planner's next
 * revision under the critique that caused it. `rounds()` is the grouping and it
 * is shared with the pilot's log, so the two surfaces cannot disagree about what
 * one round was.
 */

/**
 * The four groups, in the order the loop reaches them.
 *
 * **The judge has a heading of its own**, which is the whole of the change: the
 * column read `PLAN · CODE · REVIEW`, and the critique — half the plan cycle's
 * work, and every one of its Codex turns — had no heading anywhere on screen.
 *
 * `GROUP`, not `CYCLE`, in the labels. Four peer groups read as four stages and
 * the loop is not a pipeline: cycle 2 re-opens on every review fix, and cycle 1
 * alternates between its two groups for as many rounds as the critic objects.
 * The word is the cheapest place to stop the numbering claiming a sequence, and
 * `status()` says `re-runs on every fix` under the two that re-open.
 */
const TITLE: Readonly<Record<CycleKind, string>> = {
  plan: 'GROUP 1 · PLAN',
  critique: 'GROUP 2 · PLAN CRITIQUE',
  code: 'GROUP 3 · CODE',
  review: 'GROUP 4 · CODE REVIEW',
};

/**
 * What a cycle header says about itself.
 *
 * Counted from what arrived, never from a cap: the caps are configurable and
 * this slice is not given them, so `2 rounds` is a fact and `2/5` would be two
 * thirds of one.
 */
/**
 * What a group header says about itself.
 *
 * Counted from what arrived, never from a cap: the caps are configurable and
 * this column is not given them, so `2 rounds` is a fact and `2/5` would be two
 * thirds of one.
 *
 * `re-runs on every fix` is on the two groups that genuinely re-open, and it is
 * carrying more weight since the groups became four: a numbered row of peers
 * reads as a pipeline, and this line is what says the run comes back here.
 */
function status(kind: CycleKind, count: number): string {
  const noun = count === 1 ? 'round' : 'rounds';
  if (kind === 'code' || kind === 'critique') return `${count} ${noun} · re-runs on every fix`;
  return `${count} ${noun}`;
}

/**
 * How much of a turn to draw.
 *
 * `settled` is the turn a held gate is showing the result of (#202): the full
 * row, with its final numbers, and none of the live treatment. It exists because
 * the moment before somebody presses continue is exactly when they want to see
 * what the turn did - and because a card still counting while the loop waits for
 * a human reads as a hang.
 */
type Draw = 'live' | 'settled' | 'done';

const drawOf = (turn: Turn, runningId: number | null, settledId: number | null): Draw =>
  turn.id === runningId ? 'live' : turn.id === settledId ? 'settled' : 'done';

/**
 * The disclosure control every collapsible thing in this column uses.
 *
 * One shape for a group and for a round, because they are the same gesture at two
 * levels and two spellings of it would drift. The caret is `aria-hidden` and the
 * button carries `aria-expanded`, so the state is announced once rather than
 * twice.
 */
function Caret({ open }: { open: boolean }) {
  return (
    <span className="v-disclose" aria-hidden="true">
      {open ? '▾' : '▸'}
    </span>
  );
}

function Version({ turn, draw, now }: { turn: Turn; draw: Draw; now: number }) {
  if (draw !== 'done') return <RunningRow turn={turn} now={now} live={draw === 'live'} />;
  return (
    <div className="v-version">
      <span className="v-version__who">
        {turn.role} · {turn.kind}
      </span>
      {turn.round !== null && <MetaChip>round {turn.round}</MetaChip>}
      {turn.endedAt !== null && (
        <span className="v-version__took">{elapsed(turn.endedAt - turn.startedAt)}</span>
      )}
    </div>
  );
}

/**
 * The answerer's turns, which belong in the nested question group rather than
 * beside the planner's.
 *
 * `7a`: the question loop is drawn nested inside cycle 1, *"nesting rather than
 * a fourth peer group, because that is what it is - iterating a plan before
 * anyone critiques it."* The frames arrive flat, so the split happens here.
 */
const isAnswerer = (turn: Turn): boolean => turn.role === 'answerer';

/**
 * One round of one group: its turns, and what the gate made of them.
 *
 * **One row per phase, because the groups are peers now.** `planning` and
 * `critique` are separate headings, so a plan round is a row under each — the
 * planner's version under `PLAN` and the critique of it under `PLAN CRITIQUE`,
 * both carrying the same round number, which is what lets a reader pair them by
 * eye.
 *
 * The round chip is what does that pairing and it is not decoration: without it
 * two peer groups are two lists with no stated relationship. It is also why the
 * core now puts a round on `planning` — that phase carried none, so the producer
 * side of the pairing had nothing to match on.
 *
 * The pair still exists as one object in `rounds()`, which is what the pilot's
 * log draws, because hi-fi 5's round card is the pair in as many words.
 */
function Round({
  phase,
  census,
  questions,
  open,
  onToggle,
  onOpen,
  runningId,
  settledId,
  now,
}: {
  phase: PhaseGroup;
  /** What the gate made of this phase, or null. Hi-fi 2 puts it on the row. */
  census: Census | null;
  /** The question round that opened during this phase, or null. See `Questions`. */
  questions: Run['questions'];
  /** Whether the body is showing. The head is always drawn. */
  open: boolean;
  onToggle: () => void;
  /** Where a count sends the reader. Undefined leaves every count inert. */
  onOpen?: ((tab: string) => void) | undefined;
  runningId: number | null;
  settledId: number | null;
  now: number;
}) {
  const turns = phase.turns.filter((t) => !isAnswerer(t));
  const answerers = phase.turns.filter(isAnswerer);
  return (
    <div className={`v-phase${open ? '' : ' v-phase--closed'}`}>
      {/* The whole head is the control, not a separate affordance beside it: a
          round row is two lines tall and a hit target smaller than the thing it
          opens is the reason nobody finds it. */}
      <button type="button" className="v-phase__head" onClick={onToggle} aria-expanded={open}>
        <Caret open={open} />
        <span className="v-phase__name">{title(phase.phase)}</span>
        {/* The archive's round, which is the number that names the artifact
            behind it. The heading in the terminal says "round 1"; the file is
            `plan-critique-0.json`, and a row has to agree with the file — and
            since the groups became peers it is also what pairs this row with
            its other half one group up or down. */}
        {phase.round !== null && <MetaChip kind="checkable">round {phase.round}</MetaChip>}
      </button>

      {open && (
        <>
          {/*
            Hi-fi 2 draws the four counts on the round card in the loop column,
            not only in the findings pane — *"severity carries the screen"*, and
            the point is the peripheral scan: a run in trouble should look
            different from across the room, before any text is read.

            `compact`, because the tolerance chip is a fifth item in a 364px
            column and the pane and the pilot's round card both state it.
          */}
          {census !== null && (
            <Counts
              counts={census.counts}
              compact
              onOpen={onOpen === undefined ? undefined : () => { onOpen('findings'); }}
            />
          )}
          {phase.gates.map((gate, i) => (
            <div className="v-phase__gate" key={`${gate}-${String(i)}`}>
              verify · {gate}
            </div>
          ))}
          {turns.map((turn) => (
            <Version
              key={turn.id}
              turn={turn}
              draw={drawOf(turn, runningId, settledId)}
              now={now}
            />
          ))}
          {turns.length === 0 && phase.gates.length === 0 && questions === null && (
            // The implementing phase is the one that reaches this: it has never
            // had a `log.step` of its own, so `phase_started` IS its
            // announcement (#152).
            <div className="v-phase__silent">
              announced by the phase, with no turn line of its own
            </div>
          )}
          {questions !== null && (
            <Questions
              questions={questions}
              turns={answerers}
              onOpen={onOpen}
              runningId={runningId}
              settledId={settledId}
              now={now}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The question loop, nested inside the round that opened it.
 *
 * `7a` draws it **nested inside cycle 1**, indented with a left rule, because that
 * is what it is: iterating a plan before anyone critiques it. A peer group would
 * say it was something else.
 *
 * **Under the round it belongs to, and that took a timestamp to get right.** It
 * used to sit at the foot of the whole `PLAN` group, so the moment a second plan
 * round opened, round 1's questions were drawn beneath round 2's row — reported
 * exactly that way. `questionsPhase()` places it by arrival, through the same
 * `during()` a census goes through.
 *
 * **A count, not a list.** The questions themselves were drawn inline here and
 * that is the Questions pane's job: this column is 364px wide, the question text
 * is a paragraph, and a list of them pushed every subsequent round off the screen.
 * So the row says how many and how many block, and clicking it opens the pane
 * that has the wording, the answerer's draft and the composer.
 */
function Questions({
  questions,
  turns,
  onOpen,
  runningId,
  settledId,
  now,
}: {
  questions: NonNullable<Run['questions']>;
  /** The answerer's turns from this phase, which belong here rather than above. */
  turns: readonly Turn[];
  onOpen?: ((tab: string) => void) | undefined;
  runningId: number | null;
  settledId: number | null;
  now: number;
}) {
  const outstanding = questions.open.filter((q) => q.answer === null && !q.declined).length;
  return (
    <div className="v-questions">
      <div className="v-questions__head">
        QUESTIONS · answerer
        {/* Hi-fi 14's own counter, nested inside the plan round's. Against the
            cap where one arrived, because `round 3/3` is the state the
            escalation is about and `round 3` is a number. Absent rather than
            guessed on a core that sent neither. */}
        {questions.round !== null && (
          <MetaChip kind="checkable">
            round {questions.round}
            {questions.cap !== null && ` of ${questions.cap}`}
          </MetaChip>
        )}
      </div>
      {/* The count is the control, for the same reason the severity row is: it
          is the thing a reader reaches for, and the pane behind it is where the
          wording lives. */}
      <QuestionCount
        total={questions.total}
        blocking={questions.blocking}
        outstanding={outstanding}
        onOpen={onOpen === undefined ? undefined : () => { onOpen('questions'); }}
      />

      {turns.map((turn) => (
        <Version key={turn.id} turn={turn} draw={drawOf(turn, runningId, settledId)} now={now} />
      ))}

      {/* Hi-fi 14: *"waiting on you is not stalled, and the column says so."* The
          failure mode it names is exact — a user seeing a motionless column and
          assuming the run died. Drawn only while something is genuinely
          outstanding, so it cannot become a permanent reassurance nobody reads. */}
      {outstanding > 0 && (
        <div className="v-questions__waiting">
          <StateKicker tone="quiet">waiting on an answer</StateKicker>
          <span>Answers already given are in the draft and are not lost.</span>
        </div>
      )}
      {/* The explicit panel `7a` asks for. Two full turns of legitimate work run
          and the outer counter correctly does not move, which without saying so
          is indistinguishable from a stall. */}
      <div className="v-questions__note">
        A question round produces no critique, so it cannot advance the plan round. This is where
        that time is accounted for.
      </div>
    </div>
  );
}

function QuestionCount({
  total,
  blocking,
  outstanding,
  onOpen,
}: {
  total: number;
  blocking: number;
  outstanding: number;
  onOpen?: (() => void) | undefined;
}) {
  const body = (
    <>
      <span className="v-questions__n">{total} raised</span>
      <span className="v-questions__sub">{blocking} blocking</span>
      {/* Counted from the rows themselves rather than from a field, because the
          answers arrive on a second frame and nothing on the wire restates the
          total. A round with every answer in says so instead of showing a zero. */}
      <span className="v-questions__sub">
        {outstanding === 0 ? 'all answered' : `${outstanding} unanswered`}
      </span>
    </>
  );
  if (onOpen === undefined) return <div className="v-questions__body">{body}</div>;
  return (
    <button
      type="button"
      className="v-questions__body v-questions__body--link"
      onClick={onOpen}
      title="Open the questions"
    >
      {body}
    </button>
  );
}

/**
 * The three things that have to happen before a phase can start (hi-fi 16).
 *
 * **This is what replaces a progress bar**, and the substitution is the whole
 * design: there is no denominator between pressing launch and the first phase -
 * no phase has started, no turn exists, and there is no total to be a fraction
 * of - so the honest drawing is a checklist of facts, two settled and one in
 * flight. Each carries the evidence for itself: a timestamp, a pid, an elapsed.
 *
 * `done` is not `pending` drawn differently. A step nothing has reported yet
 * says so; it never shows a zero or an empty value standing in for a fact.
 */
function Step({
  label,
  done,
  detail,
}: {
  label: string;
  done: boolean;
  detail: string;
}) {
  return (
    <li className={`v-starting__step${done ? ' v-starting__step--done' : ''}`}>
      <span className="v-starting__mark" aria-hidden="true">
        {done ? '✓' : '·'}
      </span>
      <span className="v-starting__what">{label}</span>
      <span className="v-starting__detail">{detail}</span>
    </li>
  );
}

/**
 * What this run did before this window was watching (#211).
 *
 * **The column below draws narration, and narration starts when the window
 * connects.** So a run resumed at review round 3 drew an empty column and a
 * `starting` checklist, exactly as though it were beginning - which is what
 * *"when I resume a past run, the pilot et al should be brought back to
 * wherever we're resuming from"* is about.
 *
 * It sits above the cycles rather than among them, and it is a **summary**
 * rather than reconstructed cards: the core reads it off `state.json`, and
 * re-emitting phases and turns for work that already finished would fill the
 * column at the price of drawing completed work as though it were running.
 *
 * Every figure is drawn only when it arrived. A round the frame did not carry
 * is left out rather than shown as 0, which on a resumed run would say the
 * opposite of what this row exists to say.
 */
function ResumedRow({ from }: { from: ResumedFrom }) {
  const rounds: string[] = [];
  if (from.planRound !== null) rounds.push(`plan ${String(from.planRound)}`);
  if (from.questionRound !== null && from.questionRound > 0) {
    rounds.push(`question ${String(from.questionRound)}`);
  }
  if (from.verifyRound !== null && from.verifyRound > 0) {
    rounds.push(`verify ${String(from.verifyRound)}`);
  }
  if (from.reviewRound !== null) rounds.push(`review ${String(from.reviewRound)}`);

  const open: string[] = [];
  if (from.pendingFindings !== null && from.pendingFindings > 0) {
    open.push(
      `${String(from.pendingFindings)} finding(s) outstanding` +
        (from.pendingFrom === null ? '' : ` from ${from.pendingFrom}`),
    );
  }
  if (from.carried !== null && from.carried > 0) {
    open.push(`${String(from.carried)} carried into implementation`);
  }

  return (
    <div className="v-resumed">
      <div className="v-resumed__head">
        <StateKicker tone="quiet">picked up</StateKicker>
        <span className="v-resumed__where">
          {from.phase === null ? 'from an earlier session' : `in ${from.phase}`}
          {from.status === null ? '' : `, which ended ${from.status}`}
        </span>
      </div>
      {rounds.length > 0 && <div className="v-resumed__line">{rounds.join(' · ')}</div>}
      {open.length > 0 && <div className="v-resumed__line">{open.join(' · ')}</div>}
      {/* Said out loud, because it is the thing most likely to be misread: the
          cards below are this session only, and the totals in the footer start
          from zero again. */}
      <div className="v-resumed__note">
        Everything below is this session. Earlier sessions spent{' '}
        {from.tokensUsed === null ? 'an unrecorded number of' : from.tokensUsed.toLocaleString()}{' '}
        tokens
        {from.codexTokens === null
          ? ''
          : ` (${from.codexTokens.toLocaleString()} of them Codex)`}
        , and are not counted again here.
      </div>
    </div>
  );
}

/**
 * What preflight is doing, before there is a phase to draw (#205, hi-fi 16).
 *
 * The seconds between pressing launch and the first phase used to have nothing
 * true to say in them: preflight spawns a probe turn against each agent and
 * narrated nothing while it did. This is the fix's visible half, and every part
 * of it is a fact the loop sent.
 *
 * **Preflight takes the live card while it runs** - accent border, pulsing dot,
 * elapsed - because it *is* a real turn against a real CLI. That is what makes
 * this "the cockpit with one card in it" rather than a launching screen with its
 * own vocabulary, and it is why there is no spinner: a spinner would say the
 * same thing while measuring nothing.
 *
 * **No bar, no percentage, no ETA.** `2 of 2` is a position in a list the loop
 * named, not a fraction of the run - and it is omitted entirely when the list
 * did not arrive, rather than being counted from the agent in hand.
 */
function PreflightRow({ preflight, now }: { preflight: Preflight; now: number }) {
  const at = preflight.probing === null ? -1 : preflight.agents.indexOf(preflight.probing);
  const position = at < 0 ? '' : ` · ${String(at + 1)} of ${String(preflight.agents.length)}`;

  const state = preflight.passed
    ? 'toolchain contract satisfied'
    : preflight.probing !== null
      ? `probing ${preflight.probing}${position}`
      : 'checking that both agents can run what this run needs';

  return (
    <div className={`v-preflight${preflight.passed ? ' v-preflight--done' : ' v-preflight--live'}`}>
      {!preflight.passed && <LivenessDot state="live" />}
      <span className="v-preflight__label">PREFLIGHT</span>
      <span className="v-preflight__state">{state}</span>
      {/* The elapsed a spinner would have replaced. Measured from the frame that
          announced preflight, so it is this step's duration and not the run's. */}
      {!preflight.passed && (
        <span className="v-preflight__elapsed">{elapsed(Math.max(0, now - preflight.at))}</span>
      )}
    </div>
  );
}

/**
 * The launching state: three checkboxes, and what nothing has reported yet.
 *
 * Hi-fi 16, and the table it is built from is a list of substitutions - a
 * progress bar becomes three checkboxes, an ETA becomes a claim about the past,
 * a spinner becomes the liveness dot plus an elapsed, a skeleton becomes dashed
 * cycle rows, and a zero becomes a named absence.
 *
 * **The ETA is the one that is not built, and its absence is the point.** The
 * design's wording is *"preflight usually clears in under a minute"*, which is a
 * claim about past runs; nothing in this app has read a past run, because that
 * is #114. Shipping the sentence anyway would make it the same kind of invention
 * as `claude 38%` and `step 9/14` - the two the design itself struck. So the row
 * says what it cannot say and names the issue that would supply it, exactly as
 * `6a`'s comparable-turns line already does.
 */
function Starting({
  run,
  hostPid,
  now,
}: {
  run: Run;
  hostPid: number | null;
  now: number;
}) {
  return (
    <div className="v-starting">
      <ol className="v-starting__steps">
        <Step
          label="task reached the core"
          done={run.identity !== null}
          detail={
            run.identity === null
              ? 'sent — the core has not answered yet'
              : clock(run.identity.at)
          }
        />
        <Step
          label="host alive"
          done={hostPid !== null}
          detail={hostPid === null ? 'no host is running' : `pid ${hostPid}`}
        />
        <Step
          label="preflight probing"
          done={run.preflight?.passed === true}
          detail={
            run.preflight === null
              ? 'not started'
              : run.preflight.passed
                ? 'both agents can run what this run needs'
                : elapsed(Math.max(0, now - run.preflight.at))
          }
        />
      </ol>

      {/* Named and attributed rather than left blank. Without this the next
          reader assumes four numbers were forgotten. */}
      <p className="v-starting__unknown">
        phase, round, elapsed total and spend — the first turn has not reported
      </p>
      {/* The issue number this line used to carry has gone from the copy and
          stayed in the source. An end user cannot act on `#114`; the sentence
          they can act on is the one that says the figure does not exist. */}
      <p className="v-starting__unknown">
        how long this usually takes — no frame carries a past run&apos;s timings
      </p>
    </div>
  );
}

/**
 * Who this column is about (hi-fi 1, §1.5 of `design/AUDIT.md`).
 *
 * Three lines above the cycles: the workstream, the branch, the repository. The
 * column started at the cycles, so once the titlebar had scrolled past there was
 * nothing on screen naming which repository you were looking at — and a window
 * that can be pointed at any checkout on the machine has to say.
 *
 * **Every line is one the core stated.** The task and the repository ride on
 * `run_started` and the branch on `run_branch`; none of the three is derived
 * from the run id, which would mean re-deriving `vibe/<run-id>` from a prefix
 * `git.branchPrefix` can change and `--no-branch` can remove.
 *
 * A field a frame did not carry is drawn as absent with its reason rather than
 * omitted, because a header with a line missing reads as a header that forgot
 * one — and the two cases here are genuinely different: *nothing said* is an
 * older core, and *no branch* is a run that has one for a stated reason.
 */
function Identity({ run }: { run: Run }) {
  const identity = run.identity;
  if (identity === null) return null;
  const branch = run.branch;
  return (
    <header className="v-ident">
      {/* Clamped, and the whole of it on the title.
          `task` joined this frame with the identity header and a brief is not a
          name: a run launched from a file - which is what AGENTS.md tells you to
          do - put its entire prompt across the top of the column, which was
          reported as the prompt being printed. Two lines and an ellipsis; the
          full text is one hover away and is also in the run's own artifacts. */}
      <div className="v-ident__name" title={identity.task ?? identity.runId}>
        {identity.task ?? identity.runId}
      </div>
      <div className="v-ident__line">
        {branch === null ? (
          <span className="v-ident__absent">branch — nothing has said</span>
        ) : branch.name === null ? (
          <span className="v-ident__absent">no branch — {branch.why ?? 'no reason given'}</span>
        ) : (
          branch.name
        )}
      </div>
      <div className="v-ident__line">
        {identity.repo === null ? (
          <span className="v-ident__absent">repository — this core did not say which</span>
        ) : (
          identity.repo
        )}
      </div>
    </header>
  );
}

export function LoopColumn({
  run,
  now,
  hostPid = null,
  onOpen,
}: {
  run: Run;
  now: number;
  /** A fact about this window's process, not about the run. Hi-fi 16 draws it. */
  hostPid?: number | null;
  /**
   * Where a count sends the reader, or undefined where there is nowhere to send
   * them. The Gallery draws this column with no tabs behind it.
   */
  onOpen?: ((tab: string) => void) | undefined;
}) {
  /**
   * Which groups and rounds are folded shut.
   *
   * **Closed is the exception, so the set holds what is closed.** Everything is
   * open on arrival: a run in progress is what this column is for, and a column
   * that remembered a fold across a reload would hide the round somebody is
   * waiting on. Keyed by group kind and by phase id, both of which `reduce`
   * guarantees are stable and never reused, so a fold cannot follow a re-render
   * onto a different row.
   */
  const [shut, setShut] = useState<ReadonlySet<string>>(() => new Set<string>());
  const toggle = (key: string) => {
    setShut((cur) => {
      const next = new Set(cur);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  };

  const runningId = run.running?.id ?? null;
  // Told, not worked out. `reduce` names the turn a gate opened after, so the
  // column does not have to decide that "the last one" is the right turn (#202).
  const settledId = run.gate?.turnId ?? null;
  // Which census belongs to which phase, through `rounds.ts` rather than a
  // second matching rule here: that module is where "by arrival" is decided and
  // tested, and a second answer is how this column and the pilot's log come to
  // disagree about one round.
  const censusOf = censusByPhase(run);
  // Which round the question loop opened during, through the same module for the
  // same reason: a second answer here is how this column and the pilot's log come
  // to disagree about one round.
  const questionsAt = questionsPhase(run);

  return (
    <section className="v-loop" aria-label="loop">
      <Identity run={run} />
      {run.from !== null && <ResumedRow from={run.from} />}
      {run.preflight !== null && <PreflightRow preflight={run.preflight} now={now} />}

      {/* Everything before the first phase. The checklist goes once a run has
          been asked for - which the identity or a live preflight both prove -
          and disappears the moment there is a real phase to look at instead. */}
      {run.cycles.length === 0 && (run.identity !== null || run.preflight !== null) && (
        <Starting run={run} hostPid={hostPid} now={now} />
      )}

      {/* Only when there is genuinely nothing to say. A run that has been asked
          for IS something happening, and two lines claiming the opposite of each
          other is the disagreement #202 was about. */}
      {run.cycles.length === 0 && run.preflight === null && run.identity === null && (
        <div className="v-loop__empty">nothing has run yet</div>
      )}

      {run.cycles.map((cycle) => {
        const open = !shut.has(cycle.kind);
        return (
          <div className={`v-cycle${open ? '' : ' v-cycle--closed'}`} key={cycle.kind}>
            <button
              type="button"
              className="v-cycle__head"
              onClick={() => { toggle(cycle.kind); }}
              aria-expanded={open}
            >
              <Caret open={open} />
              <span className="v-cycle__title">{TITLE[cycle.kind]}</span>
              {/* One phase per round now that the groups are peers, so counting
                  this group's phases counts its rounds - which is what the old
                  three-cycle header got wrong, calling two plan rounds three.
                  Drawn folded as well as open: the count is the reason to open
                  a group, so hiding it behind the fold would hide the answer. */}
              <span className="v-cycle__status">{status(cycle.kind, cycle.phases.length)}</span>
            </button>
            {open &&
              cycle.phases.map((phase) => (
                <Round
                  key={phase.id}
                  phase={phase}
                  census={censusOf.get(phase.id) ?? null}
                  // `7a`'s nested question loop, on the round it opened during
                  // rather than at the foot of the group.
                  questions={questionsAt === phase.id ? run.questions : null}
                  open={!shut.has(`p${String(phase.id)}`)}
                  onToggle={() => { toggle(`p${String(phase.id)}`); }}
                  onOpen={onOpen}
                  runningId={runningId}
                  settledId={settledId}
                  now={now}
                />
              ))}
          </div>
        );
      })}

      {/* A question round that opened before any phase of this session did. Real
          on a resume, where the frames start mid-run: it is drawn here rather
          than filed under this session's first round, which would credit an
          earlier session's questions to work that has not happened yet. */}
      {run.questions !== null && questionsAt === null && (
        <Questions
          questions={run.questions}
          turns={[]}
          onOpen={onOpen}
          runningId={runningId}
          settledId={settledId}
          now={now}
        />
      )}

      {/* Four groups are always the shape of a run, so the ones that have not
          started are named rather than absent - at reduced weight, because a
          missing group reads as a loop with fewer parts than it has. */}
      {(['plan', 'critique', 'code', 'review'] as const)
        .filter((kind) => !run.cycles.some((c) => c.kind === kind))
        .map((kind) => (
          <div className="v-cycle v-cycle--idle" key={kind}>
            <div className="v-cycle__head">
              <span className="v-cycle__title">{TITLE[kind]}</span>
              <span className="v-cycle__status">not started</span>
            </div>
          </div>
        ))}
    </section>
  );
}
