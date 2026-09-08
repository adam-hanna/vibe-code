import { useState } from 'react';
import { Button, StateKicker } from '../design';
import { boundary, ending } from './format';
import type { Raise } from './argv';
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

export function Footer({
  run,
  onDecide,
  onPause,
  onStop,
  onResume,
  caps,
  gates,
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
    return (
      <div className="v-footer v-footer--holding">
        <div className="v-footer__banner">
          <StateKicker tone="accent">holding</StateKicker>
          <span className="v-footer__detail">at {boundary(gate.boundary)}</span>
        </div>

        {/* The rounds travel with the boundary because a boundary alone does not
            say where in the run it is: `review-round` is reached up to
            `maxReviewRounds` times and they are not the same decision. */}
        <div className="v-footer__rounds">
          plan {gate.planRound} · verify {gate.verifyRound} · review {gate.reviewRound}
        </div>

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
        */}
        {gate.boundary === 'verify-round' && (
          <div className="v-footer__verify">
            {failing !== undefined && (
              <div className="v-footer__note">
                <strong>{failing.name}</strong> failed{' '}
                {failing.failed === null
                  ? ''
                  : `${failing.failed} of ${failing.runs} run${failing.runs === 1 ? '' : 's'}`}
                {failing.verdict === 'flaky' && ' — and it is not deterministic'}.
              </div>
            )}
            <div className="v-footer__note">
              Continuing sends this round to FIX, which is a full implement turn. Doing nothing
              is <strong>fix it yourself</strong>: the loop is already waiting and will keep
              waiting — edit the worktree, then continue.
            </div>
            {run.identity !== null && (
              <div className="v-footer__path">
                <code>{run.identity.dir}</code>
                <button
                  className="v-footer__copy"
                  onClick={() => void navigator.clipboard.writeText(run.identity?.dir ?? '')}
                >
                  copy
                </button>
              </div>
            )}
            {/* Named rather than drawn. A manual re-run would have to re-enter
                the gate out of band and no frame does that - and the design is
                explicit that a rerun spends a round, so a button that silently
                did not would be worse than none. */}
            <div className="v-footer__note">
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
          <div className="v-footer__verify">
            {run.questions === null ? (
              // A real state, not an error: `questions_opened` is what fills
              // this, and a build that held here without seeing one says so
              // rather than drawing an empty inbox as "no questions".
              <div className="v-footer__note">
                The loop is holding at a question round, and this window never saw the questions
                open. They are in <code>.vibe/runs/{'<'}run-id{'>'}/answers-N.json</code>.
              </div>
            ) : (
              <>
                <div className="v-footer__note">
                  The planner raised {run.questions.total} question
                  {run.questions.total === 1 ? '' : 's'} it could not settle from the brief
                  {run.questions.blocking > 0 && (
                    <>
                      , <strong>{run.questions.blocking} blocking</strong>
                    </>
                  )}
                  . The answerer has already taken its turn — this is you checking what it said.
                </div>
                {/* Blocking first, then declines, then the rest: the order is
                    what a person should read rather than the order they were
                    asked in. A decline on a blocking question is the one that
                    ends runs. */}
                {[...run.questions.open]
                  .sort(
                    (a, b) =>
                      Number(b.blocking) - Number(a.blocking) ||
                      Number(b.declined) - Number(a.declined),
                  )
                  .map((q) => (
                    <div className="v-footer__q" key={q.question}>
                      <div className="v-footer__q-head">
                        {q.blocking ? (
                          <StateKicker tone="accent">blocking</StateKicker>
                        ) : (
                          <StateKicker tone="quiet">advisory</StateKicker>
                        )}
                        <span className="v-footer__q-ask">{q.question}</span>
                      </div>
                      {q.declined ? (
                        <div className="v-footer__q-answer v-footer__q-answer--declined">
                          declined — {q.rationale ?? 'no reason given'}
                        </div>
                      ) : q.answer === null ? (
                        <div className="v-footer__q-answer">no answer came back for this one</div>
                      ) : (
                        <div className="v-footer__q-answer">
                          <em>{q.confidence ?? 'confidence not stated'}</em> — {q.answer}
                        </div>
                      )}
                    </div>
                  ))}
                {run.questions.open.length < run.questions.total && (
                  <div className="v-footer__note">
                    The count is the loop&apos;s; this build could not read every question behind
                    it. The rest are in the run&apos;s <code>answers-N.json</code>.
                  </div>
                )}
              </>
            )}
            {/* The two options, in what they cost rather than in what they are
                called. This is the sentence whose absence made `continue` the
                only thing anybody pressed. */}
            <div className="v-footer__note">
              <strong>Continue</strong> accepts those answers and spends a planner turn revising
              the plan with them. <strong>Stop</strong> ends the run resumably and writes them
              into <code>NEEDS-INPUT.md</code> with a blank under each — answer them there in your
              own words and <code>vibe resume</code>, and yours are what the planner gets.
            </div>
          </div>
        )}

        <div className="v-footer__note">
          Nothing further has run. The session is still warm, so continuing re-sends no context.
        </div>

        <div className="v-footer__actions">
          <Button level="primary" disabled={busy} onClick={() => onDecide(gate.askId, { kind: 'continue' })}>
            {/* The label says what pressing it does, at the two boundaries
                where "continue" is not self-explanatory. Both spend a turn, and
                naming which one is the difference between a decision and a
                reflex. */}
            {gate.boundary === 'verify-round'
              ? '⏭ let FIX run'
              : gate.boundary === 'question-round'
                ? '⏭ accept these answers'
                : '⏭ continue'}
          </Button>
          <input
            className="v-footer__reason"
            placeholder="why you are stopping (optional)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <Button
            level="secondary"
            disabled={busy}
            onClick={() => {
              onDecide(gate.askId, { kind: 'stop', reason });
              setReason('');
            }}
          >
            ⏹ stop
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
      <div className={`v-footer v-footer--ended${how?.tone === 'alarm' ? ' v-footer--alarm' : ''}`}>
        <div className="v-footer__banner">
          <StateKicker tone={how?.tone ?? 'quiet'}>{how?.kicker ?? `exit ${exit}`}</StateKicker>
          <span className="v-footer__detail">
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
          <div className="v-footer__note">
            The loop {run.ended.how === 'approved' ? 'approved the review' : 'was stopped'}:{' '}
            {run.ended.detail}
          </div>
        )}

        {run.reason !== null && <div className="v-footer__why">{run.reason.message}</div>}

        {how !== null && how.next !== null && <div className="v-footer__note">{how.next}</div>}

        {/*
          `4d`'s rule made real: **every halt names a next action, and exactly
          one is primary.** Somebody reading a halt banner is already frustrated,
          and four equal-weight buttons make them read all four every time.

          The action is offered only when the run said which run it is (#207) and
          only for an ending a resume can actually pick up - so an unknown exit
          code gets the sentence and no button, rather than a control that might
          do nothing.
        */}
        {RESUMABLE.has(exit) && run.identity !== null && (
          <>
            <div className="v-footer__actions">
              <Button
                level="primary"
                disabled={busy}
                onClick={() => {
                  if (run.identity !== null) onResume(run.identity.runId, run.identity.dir);
                }}
              >
                ▶ resume this run
              </Button>
              <span className="v-footer__note">
                It picks up from the last checkpoint on the same agent sessions. Nothing before
                the halt is redone.
              </span>
            </div>

            {/* `4d`'s second choice, and never a peer of the first: exactly one
                primary, because somebody reading a halt banner is already
                frustrated and four equal-weight buttons make them read all four
                every time. */}
            {raise !== null && (
              <div className="v-footer__actions">
                <button
                  className="v-footer__demoted"
                  disabled={busy}
                  onClick={() => {
                    if (run.identity !== null) {
                      onResume(run.identity.runId, run.identity.dir, raise.raise);
                    }
                  }}
                >
                  {raise.label}
                </button>
                <span className="v-footer__note">{raise.note}</span>
              </div>
            )}
            {raise === null && (exit === 3 || exit === 4) && (
              <div className="v-footer__note">
                Raising the cap on the way back in is the usual answer here, and this build has
                not read the project&apos;s current one — so it is not offered rather than
                offered against a number it guessed. Settings has the caps.
              </div>
            )}
          </>
        )}
        {RESUMABLE.has(exit) && run.identity === null && (
          <div className="v-footer__note">
            This run is resumable, but the loop never said which run it is — so there is nothing to
            point a resume at from here. `vibe list` has the id.
          </div>
        )}
      </div>
    );
  }

  if (run.ended !== null) {
    return (
      <div className="v-footer">
        <div className="v-footer__banner">
          <StateKicker tone={run.ended.how === 'approved' ? 'accent' : 'alarm'}>
            {run.ended.how === 'approved' ? 'review clear' : 'stopped'}
          </StateKicker>
          <span className="v-footer__detail">{run.ended.detail}</span>
        </div>
        {run.ended.how === 'stopped' && (
          <div className="v-footer__note">
            The run is resumable — the reason is in NEEDS-INPUT.md and `vibe resume` picks it up.
          </div>
        )}
        {/* Said plainly rather than left to look like a hung app: the loop is
            finished and the command is not - artifacts, commits and the summary
            all happen after the last thing the loop narrates. */}
        <div className="v-footer__note">The command has not returned yet.</div>
      </div>
    );
  }

  // The window between the core saying why it is giving up and the process
  // returning. Short, and it covers the summary and the artifact writes - so
  // saying "running" through it would be the same lie in a smaller size.
  if (run.reason !== null) {
    return (
      <div className="v-footer v-footer--ended v-footer--alarm">
        <div className="v-footer__banner">
          <StateKicker tone="alarm">ending</StateKicker>
          <span className="v-footer__detail">the run is stopping.</span>
        </div>
        <div className="v-footer__why">{run.reason.message}</div>
        <div className="v-footer__note">
          The command has not returned yet, so what it exits with is not known.
        </div>
      </div>
    );
  }

  return (
    <div className="v-footer">
      <div className="v-footer__banner">
        <StateKicker tone="quiet">{run.running === null ? 'idle' : 'running'}</StateKicker>
        <span className="v-footer__detail">
          {run.running === null
            ? 'no turn is open'
            : `${run.running.role} · ${run.running.kind}`}
        </span>
      </div>
      {/*
        `3a`'s mode control, and it is a **readout rather than a control**.

        The design asks for the mode to be readable at a glance and says why:
        *"mode is a mode, not an action."* Editing it belongs in one place, and
        that place is the gate matrix in Settings — a segmented control here
        would be a second form over one file, which is how two answers to "where
        does this run hold" come to exist.

        It lists **which boundaries hold** rather than naming a next stop. The
        matrix is a fact the loop stated; *which one comes next* would need a
        phase-to-boundary ordering written here, and a wrong one is a promise the
        app cannot keep — the same reason this line used to say nothing at all.
      */}
      <div className="v-footer__note">
        {gates === null ? (
          <>Where this run hands control back is in `vibe.config.json`; this build has not read it.</>
        ) : holding.length === 0 ? (
          <>
            No boundary holds — every row is <code>auto</code>, so the loop runs to the end
            without asking.
          </>
        ) : (
          <>
            Holds at {holding.map((b) => boundary(b)).join(', ')}.{' '}
            {stopping.length > 0 && (
              <>
                {/* The difference that costs something. A `step` row is an
                    await and free; a `stop` row ENDS the run, resumably. */}
                {stopping.map((b) => boundary(b)).join(', ')}{' '}
                {stopping.length === 1 ? 'ends' : 'end'} the run there rather than asking.
              </>
            )}
          </>
        )}
      </div>

      {/*
        Hi-fi 18. Two controls, one above the other, **neither a primary**, and
        the visual difference is deliberately small: two controls that look
        wildly different stop reading as alternatives, and these are alternatives.
        **The labels carry the distinction, not the colour** - they differ in
        when it happens and what it acts on, and each carries its cost on a
        second line.
      */}
      <div className="v-footer__controls">
        <button className="v-control" disabled={busy || pausing} onClick={onPause}>
          <span className="v-control__label">⏸ Pause at the next gate</span>
          <span className="v-control__cost">
            {pausing
              ? 'armed — the loop holds at the next boundary it reaches'
              : 'lets the turn finish, then holds. Costs nothing.'}
          </span>
        </button>
        <button className="v-control v-control--grave" disabled={busy} onClick={onStop}>
          <span className="v-control__label">
            ⏹ Stop this turn now
            <StateKicker tone="alarm">ends the run</StateKicker>
          </span>
          <span className="v-control__cost">kills the agent mid-turn. Confirms first.</span>
        </button>
      </div>
    </div>
  );
}
