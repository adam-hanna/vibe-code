import { useState } from 'react';
import { Info, Pause, Play, SkipForward, Square } from 'lucide-react';
import { LivenessDot } from '../design';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { boundary, ending, hold, nextHold } from './format';
import type { Raise } from './argv';
import { latestQuestions } from './model';
import type { Run } from './model';

/**
 * The footer from `3a`, which is where the whole slice pays off.
 *
 * A `gate_waiting` narration and an `ask` frame arrive together, and this is
 * where the run is released or stopped. Because the app links the core and runs
 * it in its own process, **releasing costs nothing**: the host never left, the
 * Claude session is still warm, and the next turn re-sends no context. The CLI
 * cannot do that - a terminal cannot answer a promise - which is the reason the
 * app exists in this shape at all.
 *
 * **The place you look for "what now" must never move.** The design puts the
 * mode control, the countdown and the primary action here, in that order, and
 * replaces them in place when the loop halts.
 */

export interface FooterProps {
  run: Run;
  /** Answer the gate. The decision goes over the wire unnarrowed - `readDecision` judges it. */
  onDecide: (askId: number, decision: { kind: 'continue' } | { kind: 'stop'; reason: string }) => void;
  /** Hold at the next boundary. Costs nothing (#210). */
  onPause: () => void;
  /** Kill the turn in flight and end the run, resumably (#209). Confirms first. */
  onStop: () => void;
  /**
   * Pick a halted run back up (`4d`, #223).
   *
   * The one choice a halt banner can genuinely offer. `4d` draws four per state
   * - `+2 rounds`, `implement anyway`, `swap the reviewer` - and every one of
   * those changes the run's configuration on the way in, which `src/host.ts`
   * says needs its own validator before it is offered. Buttons that produced no
   * frame would be the `proposed` chip shipped as behaviour.
   */
  onResume: (runId: string, dir: string, raise?: Raise) => void;
  /** Take a finished plan-only run into implementation (#223). See `implementArgv`. */
  onImplement: (runId: string, dir: string) => void;
  /** The caps in force, so a raise can be relative. Null until the config is read. */
  caps: Caps | null;
  /**
   * The gate matrix in force, or null (`3a`).
   *
   * A readout, not a control — see the mode note at the bottom of this file.
   * Null means the config has not been read, and the footer says that rather
   * than describing a matrix it does not have.
   */
  gates: Readonly<Record<string, string>> | null;
  /**
   * The boundaries in the loop's own order, from `src/gates.ts` (#223).
   *
   * Empty until the config frame arrives, and empty is what makes the *next
   * hold* line absent rather than wrong: with no order there is no "next", and
   * the row falls back to listing which boundaries hold.
   */
  order: readonly string[];
  /** Whether a pause is armed and waiting for the next boundary. */
  pausing: boolean;
  busy: boolean;
}

/**
 * Whether resuming this ending is a real thing to do.
 *
 * **Closed over exit codes, not over sentences.** Exit 0 finished and exit 6
 * never started - a resume of either would be a button that either does nothing
 * or repeats a run that is already done. Everything else stopped mid-loop with a
 * checkpoint behind it, which is the whole promise `4d` makes: *"every halt is
 * recoverable from a checkpoint, and nothing is lost must be literally true."*
 *
 * An exit code this build does not know is **not** offered a resume. Guessing
 * that an unknown ending is resumable is a claim about what happened, made by a
 * build that does not know what happened.
 */
const RESUMABLE: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 7]);

/**
 * What a halt offers beyond a plain resume (`4d`, #223).
 *
 * `4d` gives every halt state a choice, marks exactly one primary, and demotes
 * the lossy option to a link. The choices it names — `+2 rounds`, `+2M and
 * resume` — are all **caps raised on the way back in**, which is what AGENTS.md
 * already tells a human to do by hand.
 *
 * **Keyed on the exit code, never on the reason sentence.** Two of `4d`'s eight
 * states share exit 3 — a plan round cap and an oscillation stall — and the only
 * thing separating them is the prose, so a window that split them would be
 * matching English to decide which buttons to draw. They get one card, and the
 * loop's own sentence is on it.
 *
 * `4d`'s other states are not here for stated reasons rather than by omission:
 * **rate limit** is `7e` and is not a halt at all; **app restarted** would need a
 * drift diff nothing computes; **worktree dirty** and **verify can't run** both
 * arrive as exit 6, which is refused *before* anything is implemented and so has
 * no resume to offer.
 */
/**
 * The caps in force, as the config frame reported them, or null.
 *
 * **A raise has to be relative to the current value, and the current value is
 * not guessable.** `+2 rounds` written as an absolute `7` assumes the default of
 * 5 — and on a project configured to 10 that button would silently *lower* the
 * cap while claiming to raise it. So the offer only exists once the config has
 * been read, and a build that could not read it falls back to a plain resume.
 */
export interface Caps {
  maxPlanRounds: number;
  maxReviewRounds: number;
  maxTokens: number;
}

function raiseFor(exit: number, caps: Caps | null): { label: string; note: string; raise: Raise } | null {
  if (caps === null) return null;
  if (exit === 3) {
    return {
      // `+2` is the design's own figure and it is a suggestion rather than a
      // measurement, which is why the note says what the button does instead of
      // implying two is the right number.
      label: `+2 rounds and resume (${caps.maxPlanRounds} → ${caps.maxPlanRounds + 2})`,
      note: 'A finding coming back is not evidence it cannot be fixed, so more rounds is a real option — but so is deciding it yourself and stopping the argument.',
      raise: {
        'max-plan-rounds': caps.maxPlanRounds + 2,
        'max-review-rounds': caps.maxReviewRounds + 2,
      },
    };
  }
  if (exit === 4) {
    return {
      label: '+2M tokens and resume',
      note: 'Raises the ceiling that covers both agents — the only one that bounds Codex work.',
      raise: { 'max-tokens': caps.maxTokens + 2_000_000 },
    };
  }
  return null;
}

/*
 * The footer's recurring styles, named once (the UI rework). Every colour is a
 * token through `theme.css`.
 */
/** The footer itself: the column's foot, flush with its edge. */
const FOOT = 'flex flex-none flex-col gap-2 border-t border-rule-structure bg-column p-4';
/** A sentence under a banner: the rounds, a note, a cost. */
const NOTE = 'text-body-sm leading-relaxed text-tertiary';
/** The banner's own sentence beside the kicker. */
const DETAIL = 'text-body-sm leading-relaxed text-emphasis';
/**
 * A block of what the gate is asking, ruled off on the left with the accent so
 * the shared answer and the boundary-specific detail read as one block when
 * both are drawn.
 */
const ASKING = 'mb-2 flex flex-col gap-2 border-l-2 border-accent-border pl-3';
/** A row of controls under a banner. */
const ACTIONS = 'mt-2 flex items-center gap-2';
/**
 * The core's own sentence, which may be long and is not ours to trim. Scrolls
 * rather than clips: a truncated reason is a reason nobody can act on, and the
 * footer must not grow without limit either.
 */
const WHY = 'max-h-[7em] overflow-y-auto whitespace-pre-wrap text-body-sm text-secondary [overflow-wrap:anywhere]';
/** The tone a kicker takes, as a Badge variant. */
const TONE = { alarm: 'alarm', accent: 'accent', quiet: 'quiet' } as const;

export function Footer({
  run,
  onDecide,
  onPause,
  onStop,
  onResume,
  onImplement,
  caps,
  gates,
  order,
  pausing,
  busy,
}: FooterProps) {
  const [reason, setReason] = useState('');
  // The two holding modes, kept apart because the difference is what a hold
  // costs: `step` is an await and free, `stop` ends the run resumably.
  const holding = Object.entries(gates ?? {})
    .filter(([, mode]) => mode !== 'auto')
    .map(([b]) => b);
  const stopping = Object.entries(gates ?? {})
    .filter(([, mode]) => mode === 'stop')
    .map(([b]) => b);
  // The earliest boundary ahead that holds. Null with no matrix and no order,
  // which is the state before the config frame arrives - and the row says which
  // boundaries hold rather than nothing at all.
  const next = gates === null ? null : nextHold(order, gates, run.lastGate);

  // A waiting gate outranks everything, including a run that has said it is
  // done. `review_approved` fires while the loop is still going - verification,
  // commits and the summary all follow it - so a footer that let `ended` win
  // could hide a gate the run is genuinely blocked on, with no way to answer it.
  if (run.gate !== null) {
    const gate = run.gate;
    // The gate that failed, from the most recent pass, so `5d`'s card can name
    // it. Told rather than inferred: the verdict is the loop's word, and a
    // window recomputing it from the fraction would disagree about flaky.
    const failing = run.verify[run.verify.length - 1]?.gates.find((g) => g.status === 'failed');
    // The questions this hold is about: the round the loop is on, through the
    // same expression the tab badge and the pane use (#223). `Run.questions` is
    // a list now, so "the latest" is a decision and it is made in one place.
    const asked = latestQuestions(run);
    // What this boundary is asking, or null if this build has no description of
    // it - in which case nothing is drawn rather than something generic.
    const held = hold(gate.boundary);
    return (
      // The halt replaces the footer IN PLACE, so the place you look never moves.
      <div className={cn(FOOT, 'border-t-2 border-accent-border bg-active')}>
        <div className="flex items-center gap-2">
          <Badge variant="accent">holding</Badge>
          <span className={DETAIL}>at {boundary(gate.boundary)}</span>
        </div>

        {/* The rounds travel with the boundary because a boundary alone does not
            say where in the run it is: `review-round` is reached up to
            `maxReviewRounds` times and they are not the same decision.

            Against the cap where one is known, because "plan 1" is a position
            and "plan 1 of 5" is a position in something — which is what makes it
            a fact somebody can act on. Absent rather than guessed when the
            config has not been read, for `raiseFor`'s reason. */}
        <div className={NOTE}>
          plan {gate.planRound}
          {caps !== null && ` of ${caps.maxPlanRounds}`} · verify {gate.verifyRound} · review{' '}
          {gate.reviewRound}
          {caps !== null && ` of ${caps.maxReviewRounds}`}
        </div>

        {/*
          What this gate is actually asking, which `boundary()` alone never said
          (#211). Three sentences: what has just finished, what to look at, and
          what continuing spends. Absent for a boundary this build has no
          description of, rather than filled in with something generic — the rule
          `ending()` follows for an exit code it does not know.
        */}
        {held !== null && (
          <div className={ASKING}>
            <div className={NOTE}>{held.what}</div>
            <div className={NOTE}>
              <strong>To look at it:</strong> {held.inspect}
            </div>
            {/* The run's own directory, which is where PLAN.md, every critique
                and every report already are. Carried on `run_started` rather
                than assembled here, and copied rather than opened: the window
                has no filesystem and #207 keeps reading an artifact a separate
                decision with #129's link refusal attached. */}
            {run.identity !== null && (
              <div className="flex items-center gap-2">
                <code className="font-mono text-mono-sm text-secondary [overflow-wrap:anywhere]">{run.identity.dir}</code>
                <Button
                  variant="quiet"
                  size="sm"
                  onClick={() => void navigator.clipboard.writeText(run.identity?.dir ?? '')}
                >
                  copy
                </Button>
              </div>
            )}
            <div className={NOTE}>
              <strong>Continuing:</strong> {held.cost}
            </div>
          </div>
        )}

        {/*
          `5d`'s gate card, and it is only reachable because `verify-round` is a
          real `GateableBoundary` - the loop genuinely stops here when the matrix
          says `step`. What changes is the wording, because at this one boundary
          "continue" means something specific and unobvious: it sends the round
          to FIX, which costs an implementation-sized turn.

          **"Fix myself" is real**, as the design insists, and it turns out to
          need no mechanism at all: the loop is already waiting, so fixing it
          yourself is what happens if you simply do not answer. What the app adds
          is saying so, and giving you the path.

          Capped and scrolled so the two buttons below never leave the screen — a
          decision you have to scroll past to reach is one people stop reading.
        */}
        {gate.boundary === 'verify-round' && (
          <div className={cn(ASKING, 'max-h-72 overflow-y-auto')}>
            {failing !== undefined && (
              <div className={NOTE}>
                <strong>{failing.name}</strong> failed{' '}
                {failing.failed === null
                  ? ''
                  : `${failing.failed} of ${failing.runs} run${failing.runs === 1 ? '' : 's'}`}
                {failing.verdict === 'flaky' && ' — and it is not deterministic'}.
              </div>
            )}
            {/* The cost of continuing is on the shared card above. What is here
                is the option that has no button, because it needs none: the
                loop is already waiting. */}
            <div className={NOTE}>
              Doing nothing is <strong>fix it yourself</strong>: the loop will keep waiting — edit
              the worktree, then continue. That path spends no round.
            </div>
            {/* Named rather than drawn. A manual re-run would have to re-enter
                the gate out of band and no frame does that - and the design is
                explicit that a rerun spends a round, so a button that silently
                did not would be worse than none. */}
            <div className={NOTE}>
              There is no <em>rerun</em> button: nothing on this wire can re-enter the gate, and
              a rerun costs one of the verify rounds, which is the scarce thing here.
            </div>
          </div>
        )}

        {/*
          `1f`'s inbox, at the boundary that is about it.

          The questions have been on the wire since #223 and there is a whole
          pane for them — but the footer said `holding at question round ·
          waiting on you` and nothing else, so the only way to find out what was
          being asked was to know the Questions tab existed. Reported from a
          manual pass, and the sentence is the whole finding: *"I can't see any
          questions to help with. I don't know why it's waiting on me. I just
          always hit continue."*

          Continuing here is not neutral — it accepts the answerer's answers and
          buys a planner turn to revise the plan with them — so a person pressing
          it without having read them is agreeing to something they were never
          shown.
        */}
        {gate.boundary === 'question-round' && (
          <div className={cn(ASKING, 'max-h-72 overflow-y-auto')}>
            {asked === null ? (
              // A real state, not an error: `questions_opened` is what fills
              // this, and a build that held here without seeing one says so
              // rather than drawing an empty inbox as "no questions".
              <div className={NOTE}>
                The loop is holding at a question round, and this window never saw the questions
                open. They are in <code>.vibe/runs/{'<'}run-id{'>'}/answers-N.json</code>.
              </div>
            ) : (
              <>
                <div className={NOTE}>
                  {asked.total} question{asked.total === 1 ? '' : 's'}
                  {asked.blocking > 0 && (
                    <>
                      , <strong>{asked.blocking} blocking</strong>
                    </>
                  )}
                  :
                </div>
                {/* Blocking first, then declines, then the rest: the order is
                    what a person should read rather than the order they were
                    asked in. A decline on a blocking question is the one that
                    ends runs. */}
                {[...asked.open]
                  .sort(
                    (a, b) =>
                      Number(b.blocking) - Number(a.blocking) ||
                      Number(b.declined) - Number(a.declined),
                  )
                  .map((q) => (
                    <div className="flex flex-col gap-1 border-t border-rule-inner py-2" key={q.question}>
                      <div className="flex flex-wrap items-baseline gap-2">
                        {q.blocking ? <Badge variant="accent">blocking</Badge> : <Badge>advisory</Badge>}
                        <span className="text-body-sm text-primary">{q.question}</span>
                      </div>
                      {q.declined ? (
                        <div className="pl-3 text-body-sm text-emphasis">
                          declined — {q.rationale ?? 'no reason given'}
                        </div>
                      ) : q.answer === null ? (
                        <div className="pl-3 text-body-sm text-secondary">no answer came back for this one</div>
                      ) : (
                        <div className="pl-3 text-body-sm text-secondary">
                          <em>{q.confidence ?? 'confidence not stated'}</em> — {q.answer}
                        </div>
                      )}
                    </div>
                  ))}
                {asked.open.length < asked.total && (
                  <div className={NOTE}>
                    The count is the loop&apos;s; this build could not read every question behind
                    it. The rest are in the run&apos;s <code>answers-N.json</code>.
                  </div>
                )}
              </>
            )}
            {/* The option the shared card does not cover, because it is specific
                to this boundary: stopping here is how you answer them yourself,
                and until the questions rode along on the stop it produced a
                document with nothing in it to answer. */}
            <div className={NOTE}>
              <strong>Stop</strong> ends the run resumably and writes these into{' '}
              <code>NEEDS-INPUT.md</code> with a blank under each. Answer them on the{' '}
              <strong>Questions</strong> tab — the window fills in that same file and resumes —
              and yours are what the planner gets instead of its own defaults.
            </div>
          </div>
        )}

        <div className={NOTE}>
          Nothing further has run. The session is still warm, so continuing re-sends no context.
        </div>

        <div className={ACTIONS}>
          <Button variant="primary" disabled={busy} onClick={() => onDecide(gate.askId, { kind: 'continue' })}>
            <SkipForward size={14} aria-hidden="true" />
            {/* The label says what pressing it does, at the two boundaries
                where "continue" is not self-explanatory. Both spend a turn, and
                naming which one is the difference between a decision and a
                reflex. */}
            {gate.boundary === 'verify-round'
              ? 'let FIX run'
              : gate.boundary === 'question-round'
                ? 'accept these answers'
                : 'continue'}
          </Button>
          <input
            className="h-7 min-w-0 flex-1 rounded-sm border border-rule-control bg-card px-2 font-sans text-body-sm text-primary outline-none placeholder:text-tertiary focus-visible:ring-1 focus-visible:ring-accent-border"
            placeholder="why you are stopping (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              onDecide(gate.askId, { kind: 'stop', reason });
              setReason('');
            }}
          >
            <Square size={12} aria-hidden="true" /> stop
          </Button>
        </div>
      </div>
    );
  }

  // The command returned, and that outranks whatever the loop last said about
  // itself (#162). Before this existed, `ended` was set by exactly two
  // narrations - `review_approved` and `gate_stopped` - so a run killed by a
  // turn timeout, stopped by a ceiling, or refused at preflight fell straight
  // through to the idle banner and looked like a run that had not started.
  if (run.completed !== null) {
    const exit = run.completed.exit;
    const how = ending(exit);
    const raise = raiseFor(exit, caps);
    return (
      // An ending is a halt too, and gets the same weight in the same place
      // (#162). `--text-emphasis` is reserved for alarm across the whole
      // product, and an ending that went wrong is one; an ending that did not -
      // exit 0, 2 or 7 - must not wear it.
      <div className={cn(FOOT, 'border-t-2 bg-active', how?.tone === 'alarm' ? 'border-emphasis' : 'border-rule-strong')}>
        <div className="flex items-center gap-2">
          <Badge variant={TONE[how?.tone ?? 'quiet']}>{how?.kicker ?? `exit ${exit}`}</Badge>
          <span className={DETAIL}>
            {/* An unknown code says it is unknown. Inventing a phrase for it
                would be a claim about what happened, made by a build that does
                not know - which is the failure `boundary()` avoids the same way. */}
            {how?.detail ?? 'this build has no phrase for that exit code.'}
          </span>
        </div>

        {/* The loop's own verdict, kept beside the ending rather than replaced by
            it. A run can be approved and then fail on the way out, and those are
            two facts - showing only the second would lose the work it did. */}
        {run.ended !== null && (
          <div className={NOTE}>
            The loop {run.ended.how === 'approved' ? 'approved the review' : 'was stopped'}:{' '}
            {run.ended.detail}
          </div>
        )}

        {run.reason !== null && <div className={WHY}>{run.reason.message}</div>}
        {/* **A finished plan-only run is the one ending with work left to do**,
            and until #223 it was the only ending offering nothing. `plan_only_stopped`
            is what makes it distinguishable: every other exit-0 run built what it
            planned, and this one has an approved plan and nothing built from it.

            Reported as a dead end in as many words — *"after it stopped, I SHOULD
            have been able to continue… When I asked the pilot, it kicked off
            another run from scratch"* — and a new run is the wrong answer rather
            than a slow one: it re-derives a plan that exists, and it carries none
            of what the plan phase settled.

            Offered here, beside the ending, rather than as a `RESUMABLE` exit
            code. Exit 0 is not a halt and must not start reading as one; this is
            a separate labelled act on a run that finished exactly as asked. */}
        {run.plannedOnly !== null && run.identity !== null && (
          <div className={ACTIONS}>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                if (run.identity !== null) onImplement(run.identity.runId, run.identity.dir);
              }}
            >
              <Play size={14} aria-hidden="true" /> implement this plan
            </Button>
            <span className={NOTE}>
              It continues this run rather than starting one: the approved plan, the acceptance
              bar the critic passed, the{' '}
              {run.plannedOnly.carried > 0
                ? `${run.plannedOnly.carried} P1(s) it carried`
                : 'findings it carried'}{' '}
              and the ones it declined all travel with it, and nothing is re-planned.
            </span>
          </div>
        )}
        {/* Said whether or not the button is pressed, because it changes what
            the plan means. The tolerance let these through — the plan was
            accepted DESPITE them — and a reader who thinks the plan is clean is
            reading the wrong thing. Absent, not zero, when none were carried. */}
        {run.plannedOnly !== null && run.plannedOnly.carried > 0 && (
          <div className={WHY}>
            This plan was accepted carrying {run.plannedOnly.carried} P1(s) on tolerance — not
            without them. They are stated in the implementation prompt, so whatever implements
            this plan is told about them; the Plan critique tab has each in full.
          </div>
        )}

        {how !== null && how.next !== null && <div className={NOTE}>{how.next}</div>}

        {/*
          `4d`'s rule made real: **every halt names a next action, and exactly
          one is primary.** Somebody reading a halt banner is already frustrated,
          and four equal-weight buttons make them read all four every time.

          The action is offered only when the run said which run it is (#207) and
          where it is (#223), and only for an ending a resume can actually pick
          up - so an unknown exit code gets the sentence and no button, rather
          than a control that might do nothing.

          **`repo`, never `dir`, and that distinction cost a resume.** The two
          are both on `run_started` and they are not interchangeable:
          `identity.dir` is the run's OWN directory - `<repo>/.vibe/runs/<id>` -
          and `identity.repo` is the repository. This passed `dir`, so the resume
          ran with `-C <run dir>` and the core looked for the run *inside
          itself*, answering `No run "..." under .vibe\runs` about a run that was
          sitting there intact. `repo` was added to the frame for exactly this
          reason and this call site was never moved onto it.
        */}
        {RESUMABLE.has(exit) && run.identity?.repo != null && (
          <>
            <div className={ACTIONS}>
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  const at = run.identity;
                  if (at?.repo != null) onResume(at.runId, at.repo);
                }}
              >
                <Play size={14} aria-hidden="true" /> resume this run
              </Button>
              <span className={NOTE}>
                It picks up from the last checkpoint on the same agent sessions. Nothing before
                the halt is redone.
              </span>
            </div>

            {/* `4d`'s second choice, and never a peer of the first: exactly one
                primary, because somebody reading a halt banner is already
                frustrated and four equal-weight buttons make them read all four
                every time. A text link rather than a button. */}
            {raise !== null && (
              <div className={ACTIONS}>
                <button
                  type="button"
                  className="cursor-pointer border-0 border-b border-accent-border bg-transparent p-0 py-1 text-label font-medium uppercase tracking-label text-accent-on-tint disabled:cursor-default disabled:opacity-70"
                  disabled={busy}
                  onClick={() => {
                    // The repository, for the reason above: `dir` is the run's
                    // own directory, and resuming into it looks for the run
                    // inside itself.
                    const at = run.identity;
                    if (at?.repo != null) onResume(at.runId, at.repo, raise.raise);
                  }}
                >
                  {raise.label}
                </button>
                <span className={NOTE}>{raise.note}</span>
              </div>
            )}
            {raise === null && (exit === 3 || exit === 4) && (
              <div className={NOTE}>
                Raising the cap on the way back in is the usual answer here, and this build has
                not read the project&apos;s current one — so it is not offered rather than
                offered against a number it guessed. Settings has the caps.
              </div>
            )}
          </>
        )}
        {RESUMABLE.has(exit) && run.identity?.repo == null && (
          <div className={NOTE}>
            This run is resumable, but the loop never said which run it is or which repository it
            is in — so there is nothing to point a resume at from here. `vibe list` has the id.
          </div>
        )}
      </div>
    );
  }

  if (run.ended !== null) {
    return (
      <div className={FOOT}>
        <div className="flex items-center gap-2">
          <Badge variant={run.ended.how === 'approved' ? 'accent' : 'alarm'}>
            {run.ended.how === 'approved' ? 'review clear' : 'stopped'}
          </Badge>
          <span className={DETAIL}>{run.ended.detail}</span>
        </div>
        {run.ended.how === 'stopped' && (
          <div className={NOTE}>
            The run is resumable — the reason is in NEEDS-INPUT.md and `vibe resume` picks it up.
          </div>
        )}
        {/* Said plainly rather than left to look like a hung app: the loop is
            finished and the command is not - artifacts, commits and the summary
            all happen after the last thing the loop narrates. */}
        <div className={NOTE}>The command has not returned yet.</div>
      </div>
    );
  }

  // The window between the core saying why it is giving up and the process
  // returning. Short, and it covers the summary and the artifact writes - so
  // saying "running" through it would be the same lie in a smaller size.
  if (run.reason !== null) {
    return (
      <div className={cn(FOOT, 'border-t-2 border-emphasis bg-active')}>
        <div className="flex items-center gap-2">
          <Badge variant="alarm">ending</Badge>
          <span className={DETAIL}>the run is stopping.</span>
        </div>
        <div className={WHY}>{run.reason.message}</div>
        <div className={NOTE}>
          The command has not returned yet, so what it exits with is not known.
        </div>
      </div>
    );
  }

  // No run means no process to pause or stop. The old footer offered both on
  // the welcome screen, turning a harmless empty workspace into a control desk.
  if (run.identity === null && run.preflight === null && run.running === null) {
    return (
      <div className={cn(FOOT, 'gap-1.5 px-6 py-5')}>
        <span className="text-body-sm font-medium text-accent-muted">Ready when you are</span>
        <p className="m-0 text-body-sm leading-relaxed text-secondary">
          The pilot prepares the brief. You decide when the run begins.
        </p>
      </div>
    );
  }

  const canControl = run.preflight !== null || run.running !== null;
  const boundaryTitle = gates === null
    ? 'Gate settings have not been read yet.'
    : holding.length === 0
      ? 'No boundary holds. The loop will run to the end without asking.'
      : `${next === null ? '' : `Next possible hold: ${boundary(next)}. `}Holds at ${holding.map((b) => boundary(b)).join(', ')}.${stopping.length > 0 ? ` ${stopping.map((b) => boundary(b)).join(', ')} ends the run there.` : ''}`;

  /*
   * Hi-fi 18. Two controls side by side, **neither a primary**, and the visual
   * difference between them deliberately small: two controls that look wildly
   * different stop reading as alternatives, and these are alternatives. The
   * labels carry the distinction, not the colour - what separates them is the
   * emphasis on the stop glyph and the cost in each title, never a red button,
   * which would say *dangerous* where the honest word is *different*.
   */
  return (
    <div className={cn(FOOT, 'gap-0 px-3 py-2.5')}>
      <div className="flex items-center justify-between gap-2">
        <div className={cn('inline-flex min-w-0 items-center gap-1.5 text-body-sm', canControl ? 'text-secondary' : 'text-tertiary')}>
          <LivenessDot state={run.running === null ? 'waiting' : 'live'} />
          <span>{run.running === null ? 'Preparing' : 'Live run'}</span>
          <Button variant="quiet" size="icon-sm" title={boundaryTitle} aria-label={boundaryTitle}>
            <Info size={14} aria-hidden="true" />
          </Button>
        </div>
        {canControl && (
          <div className="flex gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || pausing}
              onClick={onPause}
              title={pausing ? 'The loop will hold at the next boundary.' : 'Let the current turn finish, then hold at the next boundary.'}
              aria-label="Pause at the next gate"
            >
              <Pause size={14} aria-hidden="true" />
              <span>{pausing ? 'Pause armed' : 'Pause at gate'}</span>
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={onStop}
              title="Stop the active turn now. The run will be resumable from its last checkpoint."
              aria-label="Stop this turn now — ends the run"
            >
              <Square size={12} className="text-emphasis" aria-hidden="true" />
              <span>Stop run</span>
            </Button>
          </div>
        )}
      </div>
      {!canControl && <span className={NOTE}>No turn is open.</span>}
    </div>
  );
}
