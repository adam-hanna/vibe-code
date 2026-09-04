import { useState } from 'react';
import { Button, StateKicker } from '../design';
import { boundary, ending } from './format';
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
  busy: boolean;
}

export function Footer({ run, onDecide, busy }: FooterProps) {
  const [reason, setReason] = useState('');

  // A waiting gate outranks everything, including a run that has said it is
  // done. `review_approved` fires while the loop is still going - verification,
  // commits and the summary all follow it - so a footer that let `ended` win
  // could hide a gate the run is genuinely blocked on, with no way to answer it.
  if (run.gate !== null) {
    const gate = run.gate;
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

        <div className="v-footer__note">
          Nothing further has run. The session is still warm, so continuing re-sends no context.
        </div>

        <div className="v-footer__actions">
          <Button level="primary" disabled={busy} onClick={() => onDecide(gate.askId, { kind: 'continue' })}>
            ⏭ continue
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
      <div className="v-footer__note">
        {/* Not "next stop: verify gate". This slice is not given the gate matrix
            (#140), so it holds at whatever `serve.ts` reaches - and naming a
            boundary it might not stop at would be a promise the app cannot keep. */}
        Every boundary holds. Which ones is configuration this build does not have yet (#140).
      </div>
    </div>
  );
}
