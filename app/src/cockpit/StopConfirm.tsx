import { Pause, Square } from 'lucide-react';
import { Modal } from '../design';
import { Button } from '@/ui/button';
import { counted, tokens, turnSentence } from './format';
import type { Turn } from './model';

/**
 * Hi-fi 18's confirmation, on `7d`'s cost table.
 *
 * **The cost is not a re-send.** A stopped run resumes its conversation, so
 * there is no context to re-send and saying so would be the wrong warning. What
 * a stop destroys is the **turn in flight**: its spend is charged anyway and the
 * turn is redone from the top. So the rows are the work that is discarded and
 * the tokens that are not refunded - both measured, both from the heartbeat,
 * neither invented.
 *
 * *"Unsaved work may be lost"* is the sentence people learn to click through. A
 * token figure is checkable.
 *
 * **Said in plain words** (#253). The first version spoke the design's and the
 * protocol's language at the person deciding - a title of `Stop implementer ·
 * verify-fix now`, *"picked up by session id"*, a row explaining that *"no frame
 * carries which one"*, a badge reading `the honest middle` - and its red `ends
 * the run` badge contradicted its own next sentence, because a stop is
 * resumable. The badge is gone; the sentence says what happens.
 *
 * **The primary is `Keep running`.** A confirmation whose primary action is the
 * destructive one is a speed bump. `Stop run` is the leftmost secondary, with no
 * solid fill and no red - the label carries the weight, not the colour. The row
 * wraps, because three buttons on one line ran off the dialog's edge and hid the
 * safe one.
 *
 * Pause is offered here rather than left to be remembered: it holds before the
 * next step and costs nothing.
 */

/** One row of the cost table, or the reason there is no figure for it. */
function Cost({ label, value, note }: { label: string; value: string | null; note: string }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 border-t border-rule-inner py-2">
      <span className="text-label uppercase tracking-label text-tertiary">{label}</span>
      {value === null ? (
        // A figure this build cannot produce, named with its reason. Never a
        // zero: a turn killed before it completes may report no usage at all,
        // and `0 tok` would be a claim that it spent nothing.
        <span className="text-body-sm text-tertiary">{note}</span>
      ) : (
        <>
          <span className="font-mono text-mono text-primary">{value}</span>
          <span className="col-start-2 text-body-sm text-secondary">{note}</span>
        </>
      )}
    </div>
  );
}

export interface StopConfirmProps {
  /** The turn that would be killed, or null if the loop is between turns. */
  turn: Turn | null;
  busy: boolean;
  onStop: () => void;
  onPause: () => void;
  onKeep: () => void;
}

export function StopConfirm({ turn, busy, onStop, onPause, onKeep }: StopConfirmProps) {
  const beat = turn?.beat ?? null;

  return (
    <Modal width={560} onDismiss={onKeep} label="Stop the run?">
      <h2 className="m-0 text-title font-semibold tracking-tight text-display">Stop the run?</h2>
      <p className="mt-1 mb-4 text-body-sm text-secondary">
        {turn === null ? 'No agent turn is running right now.' : turnSentence(turn)}
      </p>

      <p className="mt-0 mb-4 text-body text-primary">
        {turn === null
          ? 'The run stops before its next step. Nothing in progress is lost, and you can resume it later.'
          : 'This turn is cancelled and the run stops. You can resume it later, and this turn will start over.'}
      </p>

      {turn !== null && (
        <>
          <Cost
            label="work lost"
            value={beat === null ? null : counted(beat.activities, beat.unit)}
            note={
              beat === null
                ? 'this turn has not reported any work yet'
                : 'done so far in this turn, and redone when it starts over'
            }
          />
          <Cost
            label="already spent"
            value={beat === null || beat.tokens <= 0 ? null : `${tokens(beat.tokens)} tok`}
            note={
              beat === null
                ? 'this turn has not reported any usage yet'
                : beat.tokens <= 0
                  ? // Not zero, and the reason is the standing one: Codex reports
                    // usage only when a turn completes, so a Codex turn killed
                    // mid-flight has no figure at all. `0 tok` would be a claim
                    // that it spent nothing.
                    'not reported yet: some agents report usage only when a turn finishes'
                  : 'these tokens were used and still count'
            }
          />
        </>
      )}

      <p className="mt-4 mb-0 border-t border-rule-inner pt-3 text-body-sm text-secondary">
        <span className="font-medium text-primary">Pause instead</span> to let this step finish and
        then wait before the next one. Nothing is lost, and you continue from the footer.
      </p>

      {/* The primary sits last, so the destructive action is not what the eye or
          the pointer lands on first. */}
      <div className="mt-5 flex flex-wrap gap-3">
        {/* Leftmost, secondary, no fill and no red. The label carries it. */}
        <Button variant="secondary" disabled={busy} onClick={onStop}>
          <Square size={12} aria-hidden="true" /> Stop run
        </Button>
        <Button variant="secondary" disabled={busy} onClick={onPause}>
          <Pause size={14} aria-hidden="true" /> Pause instead
        </Button>
        {/* **Never disabled, and that is the fix rather than an inconsistency.**
            The other two send a frame, so they wait their turn behind one that
            is already in flight. This one sends nothing at all — it closes a
            dialog nobody has acted on. Gating it on `busy` meant that while a
            request was outstanding the modal had three dead buttons and a scrim
            over the whole window, which is a window with no way out of it. A
            confirmation's cancel must never depend on anything being reachable
            (#211). */}
        <Button variant="primary" className="ml-auto" onClick={onKeep}>
          Keep running
        </Button>
      </div>
    </Modal>
  );
}
