import { useState } from 'react';
import { Activity, ArrowRight, Check, ChevronRight, Clock, Pause } from 'lucide-react';
import { LivenessDot } from '../design';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { Counts } from './Counts';
import { Caret } from './Disclosure';
import { boundary, clock, elapsed } from './format';
import { censusByPhase, questionsByPhase, title, unplacedQuestions } from './rounds';
import type { BottomTab, Tab } from './where';
import { RunningRow } from './RunningRow';
import type { KeyboardEvent } from 'react';
import { CYCLE_OF, runningRow } from './model';
import type { Census, CycleKind, PhaseGroup, Preflight, QuestionRound, ResumedFrom, Run, Turn } from './model';

/**
 * Where a count or a box sends the reader (#223).
 *
 * The tab, and the **round** within it. A round number rather than a filename:
 * both ends of that link already hold the round - the card carries it and the
 * pane's sections are keyed by it - and a filename would put the loop's naming
 * convention in a third place, in the one process that cannot be kept in step
 * with it.
 */
/**
 * Open a pane, at a round when it has one. A pane by name, never a string: a
 * name that is not one used to become the current tab and blank the window
 * (#260).
 */
export type OpenAt = (tab: Tab | BottomTab, round?: number | null) => void;

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
 *
 * Styled with utilities (the UI rework): every colour is a token through
 * `theme.css`, and what recurs is named once below rather than in a stylesheet
 * nobody can see from here.
 */

/** A small uppercase label: a group title, a section head, an eyebrow. */
const LABEL = 'text-label uppercase tracking-label';
/** A measured figure beside a row: monospace and tabular so a column of them lines up. */
const FIGURE = 'font-mono text-mono-sm tabular-nums text-tertiary';
/** A disclosure head that is the whole row, reset from the button it is. */
const HEAD =
  'flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent text-left text-inherit outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent';

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
  plan: 'Plan',
  critique: 'Plan critique',
  code: 'Code',
  review: 'Code review',
};

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

function Version({ turn, draw, now }: { turn: Turn; draw: Draw; now: number }) {
  if (draw !== 'done') return <RunningRow turn={turn} now={now} live={draw === 'live'} />;
  return (
    <div className="flex items-center gap-2 py-1 text-body-sm text-secondary">
      <span className="text-primary">
        {turn.role} · {turn.kind}
      </span>
      {turn.round !== null && <Badge>round {turn.round}</Badge>}
      {turn.endedAt !== null && (
        <span className={cn(FIGURE, 'ml-auto')}>{elapsed(turn.endedAt - turn.startedAt)}</span>
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
  questions: QuestionRound | null;
  /** Whether the body is showing. The head is always drawn. */
  open: boolean;
  onToggle: () => void;
  /** Where a count sends the reader. Undefined leaves every count inert. */
  onOpen?: OpenAt | undefined;
  runningId: number | null;
  settledId: number | null;
  now: number;
}) {
  const turns = phase.turns.filter((t) => !isAnswerer(t));
  const answerers = phase.turns.filter(isAnswerer);
  return (
    <div className="border-b border-rule-inner px-4 py-3 last:border-b-0">
      {/* The whole head is the control, not a separate affordance beside it: a
          round row is two lines tall and a hit target smaller than the thing it
          opens is the reason nobody finds it. A closed round keeps its head and
          gives up the space its body had, so a long run folds down to a
          readable list of round headings. */}
      <button
        type="button"
        className={cn(HEAD, 'group p-0', open && 'mb-2')}
        onClick={onToggle}
        aria-expanded={open}
      >
        <Caret open={open} />
        <span className="text-body-sm text-primary group-hover:text-emphasis">{title(phase.phase)}</span>
        {/* The archive's round, which is the number that names the artifact
            behind it. The heading in the terminal says "round 1"; the file is
            `plan-critique-0.json`, and a row has to agree with the file — and
            since the groups became peers it is also what pairs this row with
            its other half one group up or down. */}
        {phase.round !== null && <Badge className="font-mono normal-case tracking-normal">round {phase.round}</Badge>}
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
          {/* The counts open the round they belong to, in the pane that has the
              judge's own words for it. `census.phase` is the loop's label for
              which judge produced it - `plan` from the critic, `review` from the
              reviewer - so the tab is told rather than worked out from where the
              row happens to be drawn. */}
          {census !== null && (
            <Counts
              counts={census.counts}
              compact
              onOpen={
                onOpen === undefined
                  ? undefined
                  : () => { onOpen(census.phase === 'plan' ? 'critique' : 'review', phase.round); }
              }
            />
          )}
          {phase.gates.map((gate, i) => (
            <div className="py-1 font-mono text-mono-sm text-secondary" key={`${gate}-${String(i)}`}>
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
          {/* **An answerer turn is drawn whether or not its round has a
              questions block** (#223). They used to be rendered *only* inside
              that block, and `Run.questions` held one round at a time — so the
              moment a second question round opened, the first round's answerer
              turn stopped being drawn anywhere at all. Reported as *"only plan
              round 2 has full details... they all should"*: a run with three
              question rounds showed one answerer turn and silently dropped two.

              **The field is a list now and that removed the cause**, so this is
              no longer holding a loss up. It stays because the two halves are
              still independent: an answerer turn is a *turn* — something that
              ran and was paid for — and nothing about whether a questions block
              happens to be on screen beside it may decide whether it appears. */}
          {questions === null &&
            answerers.map((turn) => (
              <Version
                key={turn.id}
                turn={turn}
                draw={drawOf(turn, runningId, settledId)}
                now={now}
              />
            ))}
          {turns.length === 0 &&
            answerers.length === 0 &&
            phase.gates.length === 0 &&
            questions === null && (
              // A phase that announced itself and ran nothing under it. The
              // implementing phase used to be the one that reached this, because
              // it had no `turn_started` of its own until #223 gave it one.
              // A sentence, not a label - so the prose tier, not the floor (#190).
              <div className="text-body-sm text-secondary">
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
 *
 * **The whole box is the control, not the count inside it.** Only the count
 * navigated, reported exactly that way — *"clicking anywhere on the Questions box
 * should lead to the questions tab, not just the N raised text"* — and it is the
 * same finding as the severity chips one level up: the largest thing on the
 * surface was inert while a smaller thing beside it did the navigating.
 *
 * It is a `role="button"` on the container rather than a `<button>` around it,
 * because the box holds the answerer's turn rows and a button inside a button is
 * a control a keyboard cannot reach. The keyboard path is handled here instead —
 * Enter and Space, which is what the role promises — and the focus ring the role
 * does not bring with it is drawn here too.
 */
function Questions({
  questions,
  turns,
  onOpen,
  runningId,
  settledId,
  now,
}: {
  questions: QuestionRound;
  /** The answerer's turns from this phase, which belong here rather than above. */
  turns: readonly Turn[];
  onOpen?: OpenAt | undefined;
  runningId: number | null;
  settledId: number | null;
  now: number;
}) {
  const outstanding = questions.open.filter((q) => q.answer === null && !q.declined).length;
  const go = onOpen === undefined ? null : () => { onOpen('questions', questions.round); };
  return (
    <div
      className={cn(
        'group my-2 ml-3 border-l-2 border-accent-border-dim px-3 py-2',
        go !== null && 'cursor-pointer outline-none hover:bg-active-hdr focus-visible:ring-1 focus-visible:ring-accent',
      )}
      {...(go === null
        ? {}
        : {
            role: 'button',
            tabIndex: 0,
            title: 'Open the questions',
            onClick: go,
            onKeyDown: (e: KeyboardEvent) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              go();
            },
          })}
    >
      <div className={cn(LABEL, 'flex flex-wrap items-center gap-2 text-tertiary')}>
        QUESTIONS · answerer
        {/* Hi-fi 14's own counter, nested inside the plan round's. Against the
            cap where one arrived, because `round 3/3` is the state the
            escalation is about and `round 3` is a number. Absent rather than
            guessed on a core that sent neither. */}
        {questions.round !== null && (
          <Badge className="font-mono normal-case tracking-normal">
            round {questions.round}
            {questions.cap !== null && ` of ${questions.cap}`}
          </Badge>
        )}
      </div>
      {/* Not a control of its own any more: the box is the control, and a nested
          button would be the thing that made only this part clickable. */}
      <QuestionCount
        total={questions.total}
        blocking={questions.blocking}
        outstanding={outstanding}
        linked={go !== null}
      />

      {turns.map((turn) => (
        <Version key={turn.id} turn={turn} draw={drawOf(turn, runningId, settledId)} now={now} />
      ))}

      {/* Hi-fi 14: *"waiting on you is not stalled, and the column says so."* The
          failure mode it names is exact — a user seeing a motionless column and
          assuming the run died. Drawn only while something is genuinely
          outstanding, so it cannot become a permanent reassurance nobody reads. */}
      {outstanding > 0 && (
        <div className="mt-1 flex flex-wrap items-baseline gap-2 text-body-sm text-secondary">
          <Badge>waiting on an answer</Badge>
          <span>Answers already given are in the draft and are not lost.</span>
        </div>
      )}
      {/* The explicit panel `7a` asks for. Two full turns of legitimate work run
          and the outer counter correctly does not move, which without saying so
          is indistinguishable from a stall. */}
      <div className="mt-1 text-body-sm text-tertiary">
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
  linked,
}: {
  total: number;
  blocking: number;
  outstanding: number;
  /** Whether the box around this is a control, so the count can show it on hover. */
  linked: boolean;
}) {
  return (
    <div className="flex w-full flex-wrap items-baseline gap-2 py-1 text-body-sm text-primary">
      <span className={cn(linked && 'group-hover:text-accent group-hover:underline')}>{total} raised</span>
      <span className="text-tertiary">{blocking} blocking</span>
      {/* Counted from the rows themselves rather than from a field, because the
          answers arrive on a second frame and nothing on the wire restates the
          total. A round with every answer in says so instead of showing a zero. */}
      <span className="text-tertiary">
        {outstanding === 0 ? 'all answered' : `${outstanding} unanswered`}
      </span>
    </div>
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
    <li className="flex items-baseline gap-2 py-1 text-body-sm text-secondary">
      <span className={cn('w-[1em]', done ? 'text-accent' : 'text-tertiary')} aria-hidden="true">
        {done ? '✓' : '·'}
      </span>
      <span className="text-primary">{label}</span>
      <span className="ml-auto font-mono text-mono-sm text-secondary">{detail}</span>
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
    <div className="flex flex-col gap-1 rounded-md border border-rule-inner bg-panel px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <Badge>picked up</Badge>
        <span className="text-body-sm text-primary">
          {from.phase === null ? 'from an earlier session' : `in ${from.phase}`}
          {from.status === null ? '' : `, which ended ${from.status}`}
        </span>
      </div>
      {rounds.length > 0 && <div className="text-body-sm text-secondary">{rounds.join(' · ')}</div>}
      {open.length > 0 && <div className="text-body-sm text-secondary">{open.join(' · ')}</div>}
      {/* Said out loud, because it is the thing most likely to be misread: the
          cards below are this session only, and the totals in the footer start
          from zero again. */}
      <div className="text-body-sm text-secondary">
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
    <div
      className={cn(
        'flex items-baseline gap-3 rounded-md border px-4 py-3',
        preflight.passed ? 'border-rule-card bg-card opacity-70' : 'border-accent-border bg-active',
      )}
    >
      {!preflight.passed && <LivenessDot state="live" />}
      <span className={cn(LABEL, 'text-emphasis')}>PREFLIGHT</span>
      <span className="text-body-sm text-secondary">{state}</span>
      {/* The elapsed a spinner would have replaced. Measured from the frame that
          announced preflight, so it is this step's duration and not the run's. */}
      {!preflight.passed && (
        <span className={cn(FIGURE, 'ml-auto text-secondary')}>{elapsed(Math.max(0, now - preflight.at))}</span>
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
    <div className="rounded-md border border-dashed border-rule-control-dim px-4 py-3">
      <ol className="m-0 list-none p-0">
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
          reader assumes four numbers were forgotten. Dashed and never dimmed,
          which is the design's rule for absence: dimming reads as "disabled for
          you", dashed reads as "nothing has filled this in". */}
      <p className="mt-2 mb-0 border-t border-dashed border-rule-control-dim pt-2 text-body-sm text-tertiary">
        phase, round, elapsed total and spend — the first turn has not reported
      </p>
      {/* The issue number this line used to carry has gone from the copy and
          stayed in the source. An end user cannot act on `#114`; the sentence
          they can act on is the one that says the figure does not exist. */}
      <p className="mt-2 mb-0 border-t border-dashed border-rule-control-dim pt-2 text-body-sm text-tertiary">
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
 * older core, and *no branch* is a run that has one for a stated reason. Dashed
 * for the same reason an unavailable tab is: dimming reads as "disabled for
 * you", dashed reads as "nothing has filled this in".
 */
const ABSENT = 'border-b border-dashed border-rule-control-dim text-tertiary';

function Identity({ run }: { run: Run }) {
  const identity = run.identity;
  if (identity === null) return null;
  const branch = run.branch;
  return (
    <header className="flex flex-none flex-col gap-1 rounded-md border border-rule-card bg-card p-4">
      {/* Clamped, and the whole of it on the title.
          `task` joined this frame with the identity header and a brief is not a
          name: a run launched from a file - which is what AGENTS.md tells you to
          do - put its entire prompt across the top of the column, which was
          reported as the prompt being printed. Two lines and an ellipsis; the
          full text is one hover away and is also in the run's own artifacts. */}
      <div
        className="line-clamp-2 text-section font-semibold tracking-tight text-display [overflow-wrap:anywhere]"
        title={identity.task ?? identity.runId}
      >
        {identity.task ?? identity.runId}
      </div>
      <div className="mt-1 font-mono text-mono-sm text-tertiary [overflow-wrap:anywhere]">
        {branch === null ? (
          <span className={ABSENT}>branch — nothing has said</span>
        ) : branch.name === null ? (
          <span className={ABSENT}>no branch — {branch.why ?? 'no reason given'}</span>
        ) : (
          branch.name
        )}
      </div>
      <div className="font-mono text-mono-sm text-tertiary [overflow-wrap:anywhere]">
        {identity.repo === null ? (
          <span className={ABSENT}>repository — this core did not say which</span>
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
  compact = false,
}: {
  run: Run;
  now: number;
  /** A fact about this window's process, not about the run. Hi-fi 16 draws it. */
  hostPid?: number | null;
  /**
   * Where a count sends the reader, or undefined where there is nowhere to send
   * them. The Gallery draws this column with no tabs behind it.
   */
  onOpen?: OpenAt | undefined;
  /** Use the glanceable run-status rail in the desktop cockpit. */
  compact?: boolean;
}) {
  if (compact) return <RunRail run={run} now={now} onOpen={onOpen} />;

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
  // Which question round each phase raised, through the same module for the same
  // reason: a second answer here is how this column and the pilot's log come to
  // disagree about one round. A **map**, because every round that asked has one
  // (#223) - a single answer meant at most one round in the run could draw its
  // counts, which is what "only plan round 2 has full details" was.
  const questionsOf = questionsByPhase(run);

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pt-1 pb-5" aria-label="loop">
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
        <div className="py-2 text-body-sm text-tertiary">Your run will take shape here.</div>
      )}

      {run.cycles.map((cycle) => {
        const open = !shut.has(cycle.kind);
        return (
          <div className="flex-none overflow-clip rounded-md border border-rule-card bg-card" key={cycle.kind}>
            <button
              type="button"
              className={cn(HEAD, 'flex-wrap items-baseline px-3 py-3.5 hover:bg-active-hdr', open && 'border-b border-rule-inner')}
              onClick={() => { toggle(cycle.kind); }}
              aria-expanded={open}
            >
              <Caret open={open} />
              {/* `auto` margin rather than `space-between` on the parent: the row
                  is three children, and spreading them would push the caret away
                  from the title it opens. */}
              <span className="mr-auto text-body-sm font-medium text-emphasis">{TITLE[cycle.kind]}</span>
              {/* One phase per round now that the groups are peers, so counting
                  this group's phases counts its rounds - which is what the old
                  three-cycle header got wrong, calling two plan rounds three.
                  Drawn folded as well as open: the count is the reason to open
                  a group, so hiding it behind the fold would hide the answer. */}
              <span className="text-chip text-tertiary">{status(cycle.kind, cycle.phases.length)}</span>
            </button>
            {open &&
              cycle.phases.map((phase) => (
                <Round
                  key={phase.id}
                  phase={phase}
                  census={censusOf.get(phase.id) ?? null}
                  // `7a`'s nested question loop, on the round it opened during
                  // rather than at the foot of the group.
                  questions={questionsOf.get(phase.id) ?? null}
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

      {/* Question rounds that opened before any phase of this session did. Real
          on a resume, where the frames start mid-run: they are drawn here rather
          than filed under this session's first round, which would credit an
          earlier session's questions to work that has not happened yet. */}
      {unplacedQuestions(run).map((round) => (
        <Questions
          key={round.at}
          questions={round}
          turns={[]}
          onOpen={onOpen}
          runningId={runningId}
          settledId={settledId}
          now={now}
        />
      ))}

      {/* Four groups are always the shape of a run, so the ones that have not
          started are named rather than absent - at reduced weight, because a
          missing group reads as a loop with fewer parts than it has. Dashed
          (hi-fi 16): "these stages exist and none has begun". It is what
          replaces a skeleton - a skeleton implies content is arriving into that
          exact shape, and none of these has a shape yet. */}
      {(['plan', 'critique', 'code', 'review'] as const)
        .filter((kind) => !run.cycles.some((c) => c.kind === kind))
        .map((kind) => (
          <div className="flex-none rounded-md border border-dashed border-rule-control-dim" key={kind}>
            <div className="flex flex-wrap items-baseline gap-2 px-3 py-3.5">
              <span className="mr-auto inline-flex items-center gap-2 text-body-sm font-medium text-secondary">
                <span className="size-1.75 rounded-full border border-rule-strong" aria-hidden="true" />
                {TITLE[kind]}
              </span>
              <span className="text-chip text-tertiary">not started</span>
            </div>
          </div>
        ))}
    </section>
  );
}

/**
 * The cockpit's glanceable version of the loop column.
 *
 * The full column still exists for the Gallery and for round-level inspection,
 * but the live desktop rail has a different job: explain what is happening now,
 * then make the shape of the run easy to scan. Details stay behind one disclosure
 * per stage and the Activity tab remains the home for the raw transcript.
 */
const RAIL_KINDS: readonly CycleKind[] = ['plan', 'critique', 'code', 'review'];

const RAIL_TITLE: Readonly<Record<CycleKind, string>> = {
  plan: 'Plan',
  critique: 'Plan critique',
  code: 'Code',
  review: 'Code review',
};

const TURN_GROUP: Readonly<Record<string, CycleKind>> = {
  plan: 'plan',
  critique: 'critique',
  implement: 'code',
  review: 'review',
};

type RailState = 'upcoming' | 'complete' | 'running' | 'waiting';

/**
 * The one place a state becomes a colour. Four states, four tokens: the accent
 * for what is running, the live green for what finished, the muted accent for
 * what is waiting on a person, and the floor for what has not begun.
 */
const STATE_TEXT: Readonly<Record<RailState, string>> = {
  running: 'text-accent',
  complete: 'text-live',
  waiting: 'text-accent-muted',
  upcoming: 'text-tertiary',
};

const STATE_BAR: Readonly<Record<RailState, string>> = {
  running: 'before:bg-accent',
  complete: 'before:bg-live',
  waiting: 'before:bg-accent-muted',
  upcoming: 'before:bg-transparent',
};

/** A card in the rail: the `now` card, the activity card and the path. */
const CARD = 'rounded-md border border-rule-card bg-card';

function railKindForTurn(kind: string): CycleKind | null {
  return TURN_GROUP[kind] ?? CYCLE_OF[kind] ?? null;
}

function findTurn(run: Run, id: number | null): Turn | null {
  if (id === null) return null;
  for (const cycle of run.cycles) {
    for (const phase of cycle.phases) {
      const turn = phase.turns.find((candidate) => candidate.id === id);
      if (turn !== undefined) return turn;
    }
  }
  return null;
}

function roleName(role: string): string {
  return role.length === 0 ? 'Agent' : `${role.slice(0, 1).toUpperCase()}${role.slice(1)}`;
}

function RailStateIcon({ state }: { state: RailState }) {
  if (state === 'running') {
    return <LivenessDot state="live" />;
  }
  if (state === 'waiting') {
    return <Pause size={13} aria-hidden="true" />;
  }
  if (state === 'complete') {
    return <Check size={14} aria-hidden="true" />;
  }
  return <span className="size-1.75 rounded-full border border-current" aria-hidden="true" />;
}

function RailStage({
  kind,
  cycle,
  state,
  open,
  onToggle,
  censusOf,
  onOpen,
}: {
  kind: CycleKind;
  cycle: Run['cycles'][number] | undefined;
  state: RailState;
  open: boolean;
  onToggle: () => void;
  censusOf: ReadonlyMap<number, Census>;
  onOpen?: OpenAt | undefined;
}) {
  const count = cycle?.phases.length ?? 0;
  const meta = cycle === undefined
    ? 'not started'
    : `${count} ${count === 1 ? 'round' : 'rounds'}`;
  const stateLabel = state === 'running'
    ? 'running'
    : state === 'waiting'
      ? 'waiting for your decision'
      : state === 'complete'
        ? 'complete'
        : 'not started';
  const reruns = kind === 'critique' || kind === 'code';
  const canExpand = cycle !== undefined;

  return (
    <section className="border-t border-rule-inner" data-state={state}>
      <button
        type="button"
        className={cn(
          HEAD,
          'gap-2.5 px-3.5 py-2.5 hover:bg-active-hdr disabled:cursor-default disabled:hover:bg-transparent',
        )}
        onClick={canExpand ? onToggle : undefined}
        aria-expanded={canExpand ? open : undefined}
        disabled={!canExpand}
        title={canExpand
          ? reruns ? `${RAIL_TITLE[kind]} can run again after a fix` : `Show ${RAIL_TITLE[kind]} details`
          : `${RAIL_TITLE[kind]} has not started yet`}
      >
        <span className={cn('inline-flex size-4 flex-none items-center justify-center', STATE_TEXT[state])} title={stateLabel}>
          <RailStateIcon state={state} />
        </span>
        <span className={cn('text-body-sm font-medium', state === 'upcoming' ? 'text-secondary' : 'text-primary')}>
          {RAIL_TITLE[kind]}
        </span>
        <span className="ml-auto text-body-sm text-tertiary">{meta}</span>
        {canExpand
          ? <ChevronRight size={14} className={cn('flex-none text-tertiary transition-transform', open && 'rotate-90')} aria-hidden="true" />
          : <span className="w-3.5 flex-none" aria-hidden="true" />}
      </button>

      {open && cycle !== undefined && (
        <div className="divide-y divide-dashed divide-rule-inner bg-active py-px pr-3.5 pb-2.75 pl-10">
          {cycle.phases.map((phase) => {
            const census = censusOf.get(phase.id);
            const round = phase.round === null ? 'unnumbered pass' : `round ${phase.round}`;
            const turnCount = phase.turns.length;
            return (
              <div
                className="flex flex-wrap items-center gap-2 py-1.5 text-body-sm"
                key={phase.id}
                title={`${phase.phase} · ${round}${turnCount === 0 ? ' · no turns reported' : ` · ${turnCount} ${turnCount === 1 ? 'turn' : 'turns'}`}`}
              >
                <span className="inline-flex text-tertiary" aria-hidden="true"><ArrowRight size={12} /></span>
                <span className="text-primary">{round}</span>
                <span className={cn(FIGURE, 'ml-auto')}>{turnCount} {turnCount === 1 ? 'turn' : 'turns'}</span>
                {census !== undefined && (
                  <Counts
                    counts={census.counts}
                    compact
                    className="w-full py-0.5"
                    onOpen={onOpen === undefined
                      ? undefined
                      : () => { onOpen(census.phase === 'plan' ? 'critique' : 'review', phase.round); }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function RailPreflight({ preflight, now }: { preflight: Preflight; now: number }) {
  const state: RailState = preflight.passed ? 'complete' : preflight.probing === null ? 'waiting' : 'running';
  const label = preflight.passed
    ? 'toolchain satisfied'
    : preflight.probing === null
      ? 'preparing checks'
      : `checking ${preflight.probing}`;
  return (
    <div className="mb-0.75 border-b border-rule-inner" data-state={state}>
      <div className="flex w-full items-center gap-2.5 px-3.5 py-2.5 text-left">
        <span className={cn('inline-flex size-4 flex-none items-center justify-center', STATE_TEXT[state])} title={preflight.passed ? 'Complete' : label}>
          <RailStateIcon state={state} />
        </span>
        <span className="text-body-sm font-medium text-primary">Preflight</span>
        <span className="ml-auto min-w-0 truncate text-body-sm text-tertiary" title={label}>{label}</span>
        <span className={FIGURE}>{elapsed(Math.max(0, now - preflight.at))}</span>
      </div>
    </div>
  );
}

function RunRail({ run, now, onOpen }: { run: Run; now: number; onOpen?: OpenAt | undefined }) {
  const currentTurn = run.running ?? findTurn(run, run.gate?.turnId ?? null);
  const currentKind = currentTurn === null ? null : railKindForTurn(currentTurn.kind);
  const [open, setOpen] = useState<ReadonlySet<CycleKind>>(() => new Set());
  const toggle = (kind: CycleKind) => {
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(kind)) next.add(kind);
      return next;
    });
  };
  const censusOf = censusByPhase(run);
  const activity = currentTurn === null ? null : runningRow(currentTurn, now);
  const isEmpty = run.identity === null && run.preflight === null && run.cycles.length === 0;
  const status = run.gate !== null
    ? { title: 'Needs your decision', detail: `Waiting at ${boundary(run.gate.boundary)}`, tone: 'waiting' }
    : run.running !== null && currentKind !== null
      ? { title: RAIL_TITLE[currentKind], detail: `${roleName(run.running.role)} is working`, tone: 'running' }
      : run.preflight !== null && !run.preflight.passed
        ? { title: 'Preflight', detail: run.preflight.probing === null ? 'Preparing checks' : `Checking ${run.preflight.probing}`, tone: 'running' }
        : run.reason !== null
          ? { title: 'Run ending', detail: run.reason.message, tone: 'waiting' }
          : run.ended?.how === 'stopped'
            ? { title: 'Run stopped', detail: run.ended.detail, tone: 'waiting' }
            : run.completed?.exit === 0 || run.ended?.how === 'approved'
            ? { title: 'Run complete', detail: 'Review the results in the workspace', tone: 'complete' }
            : run.completed !== null
              ? { title: 'Process finished', detail: `Exit ${run.completed.exit}`, tone: 'complete' }
            : isEmpty
              ? { title: 'Waiting for a brief', detail: 'Review the brief to begin', tone: 'upcoming' }
              : { title: 'Ready for the next turn', detail: 'The run is between turns', tone: 'waiting' };
  const statusState = status.tone as RailState;
  const statusTime = activity === null
    ? run.preflight === null ? null : elapsed(Math.max(0, now - run.preflight.at))
    : elapsed(activity.elapsedMs);

  // `flex-none`: the rail is sized by its groups and the cockpit's wrapper is
  // what scrolls, so a summary placed after it shares the scroll rather than
  // squeezing it (AGENTS.md's rule that a scrolling column's children must not
  // be allowed to shrink, applied to this one).
  return (
    <section className="flex min-w-0 flex-none flex-col gap-2.5 bg-column px-3 pb-3.5" aria-label="run status">
      {/* The `now` card: what is happening, in one sentence, with a state bar
          down its left edge in the state's colour. */}
      <div
        className={cn(
          CARD,
          'relative overflow-hidden p-3.5 pl-4 before:absolute before:inset-y-0 before:left-0 before:w-0.75',
          STATE_BAR[statusState],
        )}
      >
        <div className={cn(LABEL, 'flex items-center justify-between text-tertiary')}>
          <span>Now</span>
          <span className={cn('inline-flex items-center gap-1.5', STATE_TEXT[statusState])} title={status.detail}>
            <RailStateIcon state={statusState} />
            {statusState === 'running' ? 'live' : statusState === 'waiting' ? 'waiting' : statusState === 'complete' ? 'done' : 'idle'}
          </span>
        </div>
        <h2 className="mt-1.5 mb-0 text-section font-semibold text-display">{status.title}</h2>
        <p className="mt-1 mb-0 text-body-sm text-secondary" title={status.detail}>{status.detail}</p>
        {statusTime !== null && (
          <span className={cn(FIGURE, 'mt-2 inline-flex items-center gap-1')} title="Elapsed time for the current turn or preflight">
            <Clock size={13} aria-hidden="true" /> {statusTime}
          </span>
        )}
      </div>

      {activity !== null && (
        <div className={cn(CARD, 'p-3.5')}>
          <div className={cn(LABEL, 'flex items-center justify-between text-secondary')}>
            <span>Current activity</span>
            {onOpen !== undefined && (
              <Button variant="quiet" size="icon-sm" onClick={() => onOpen('output')} title="Open full activity" aria-label="Open full activity">
                <Activity size={14} aria-hidden="true" />
              </Button>
            )}
          </div>
          <div className="mt-2.5 flex items-start gap-2 text-body-sm text-primary" title={activity.lastActivity ?? 'No tool activity has been reported yet'}>
            <Activity size={14} className="mt-0.5 flex-none text-accent" aria-hidden="true" />
            <span className="min-w-0 truncate">{activity.lastActivity ?? 'Waiting for the first update'}</span>
          </div>
          <div className={cn(FIGURE, 'mt-2')}>
            {activity.activities === null
              ? 'No activity count reported yet'
              : `${activity.activities.count} ${activity.activities.unit}`}
          </div>
        </div>
      )}

      <div className={cn(CARD, 'pt-3.5 pb-1')}>
        <div className={cn(LABEL, 'mb-2.5 flex items-center justify-between px-3.5 text-secondary')}>
          <span>Run path</span>
          <span className={cn(FIGURE, 'normal-case tracking-normal')} title="Stages with narration received">
            {RAIL_KINDS.filter((kind) => run.cycles.some((cycle) => cycle.kind === kind)).length}/{RAIL_KINDS.length}
          </span>
        </div>
        {run.preflight !== null && <RailPreflight preflight={run.preflight} now={now} />}
        {RAIL_KINDS.map((kind) => {
          const cycle = run.cycles.find((candidate) => candidate.kind === kind);
          const state: RailState = currentKind === kind
            ? run.gate !== null ? 'waiting' : 'running'
            : cycle === undefined ? 'upcoming' : 'complete';
          return (
            <RailStage
              key={kind}
              kind={kind}
              cycle={cycle}
              state={state}
              open={open.has(kind)}
              onToggle={() => { toggle(kind); }}
              censusOf={censusOf}
              onOpen={onOpen}
            />
          );
        })}
      </div>
    </section>
  );
}
