import { useState } from 'react';
import { Button, StateKicker } from '../design';
import { boundary } from './format';
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
        {run.completed === null && (
          // Said plainly rather than left to look like a hung app: the loop is
          // finished and the command is not - artifacts, commits and the summary
          // all happen after the last thing the loop narrates.
          <div className="v-footer__note">The command has not returned yet.</div>
        )}
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
