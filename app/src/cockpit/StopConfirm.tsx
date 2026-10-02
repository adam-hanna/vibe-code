import { Button, MetaChip, Modal, StateKicker } from '../design';
import { counted, tokens } from './format';
import type { Turn } from './model';

/**
 * Hi-fi 18's confirmation, on `7d`'s cost table.
 *
 * **The cost is not a re-send.** A killed run resumes its conversation by
 * session id, so there is no context to re-send and saying so would be the
 * wrong warning. What a stop destroys is the **turn in flight**: its spend is
 * charged anyway and the turn is redone from the top. So the rows are the
 * tool calls that are discarded and the tokens that are not refunded — both
 * measured, both from the heartbeat, neither invented.
 *
 * *"Unsaved work may be lost"* is the sentence people learn to click through. A
 * token figure is checkable.
 *
 * **The primary is `Keep running`.** A confirmation whose primary action is the
 * destructive one is a speed bump. `Stop the turn` is the leftmost secondary,
 * with no solid fill and no red — the label carries the weight, not the colour.
 *
 * Pause is offered here rather than left to be remembered, because it is the
 * honest middle: it holds at the next boundary and costs nothing.
 */

/** One row of the cost table, or the reason there is no figure for it. */
function Cost({ label, value, note }: { label: string; value: string | null; note: string }) {
  return (
    <div className="v-stop__cost">
      <span className="v-stop__label">{label}</span>
      {value === null ? (
        <span className="v-stop__absent">{note}</span>
      ) : (
        <>
          <span className="v-stop__value">{value}</span>
          <span className="v-stop__note">{note}</span>
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
    <Modal width={560} onDismiss={onKeep}>
      <div className="v-stop__head">
        <StateKicker tone="alarm">ends the run</StateKicker>
        <span className="v-stop__title">
          {turn === null
            ? 'Stop the run'
            : `Stop ${turn.role} · ${turn.kind} now`}
        </span>
      </div>

      <p className="v-stop__lead">
        {turn === null
          ? 'Nothing is running, so no work is discarded. The run ends here and resumes from its last checkpoint.'
          : 'The agent is killed mid-turn. That turn is redone from the top when you resume — the conversation is picked up by session id, so nothing is re-sent.'}
      </p>

      <Cost
        label="work in flight"
        value={beat === null ? null : counted(beat.activities, beat.unit)}
        note={
          beat === null
            ? 'nothing has reported yet, so there is nothing measured to discard'
            : 'discarded'
        }
      />
      <Cost
        label="already spent"
        value={beat === null || beat.tokens <= 0 ? null : `${tokens(beat.tokens)} tok`}
        note={
          beat === null
            ? 'no turn has reported'
            : beat.tokens <= 0
              ? // Not zero, and the reason is the standing one: Codex reports
                // usage only when a turn completes, so a Codex turn killed
                // mid-flight has no figure at all. `0 tok` would be a claim that
                // it spent nothing.
                'not reported for this turn — a turn killed before it completes may report no usage at all'
              : 'not refunded — the tokens were used'
        }
      />
      <Cost
        label="resumes from"
        value={null}
        note="its last checkpoint — no frame carries which one, so it is not named here"
      />

      <div className="v-stop__middle">
        <MetaChip>the honest middle</MetaChip>
        <span className="v-stop__note">
          Pausing holds at the next boundary instead and costs nothing: the turn finishes, both
          sessions stay warm, and continuing re-sends no context.
        </span>
      </div>

      <div className="v-stop__actions">
        {/* Leftmost, secondary, no fill and no red. The label carries it. */}
        <Button level="secondary" disabled={busy} onClick={onStop}>
          ⏹ Stop the turn
        </Button>
        <Button level="secondary" disabled={busy} onClick={onPause}>
          ⏸ Pause instead
        </Button>
        {/* **Never disabled, and that is the fix rather than an inconsistency.**
            The other two send a frame, so they wait their turn behind one that
            is already in flight. This one sends nothing at all — it closes a
            dialog nobody has acted on. Gating it on `busy` meant that while a
            request was outstanding the modal had three dead buttons and a scrim
            over the whole window, which is a window with no way out of it. A
            confirmation's cancel must never depend on anything being reachable
            (#211). */}
        <Button level="primary" onClick={onKeep}>
          Keep running
        </Button>
      </div>
    </Modal>
  );
}
