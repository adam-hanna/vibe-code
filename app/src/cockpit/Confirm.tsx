import { Button, Modal, StateKicker } from '../design';
import type { ReactNode } from 'react';

/**
 * The confirmation in front of anything that cannot be undone (#223).
 *
 * Asked for in one line — *"There needs to be a confirmation window that shows
 * up so i dont accidentally delete something"* — and written as one component
 * because there are two of them already and they must not drift: forgetting a
 * project and deleting a run are opposite acts that look identical in a sidebar,
 * and the only thing that can tell them apart is what the dialog says.
 *
 * ## It inherits `StopConfirm`'s three rules rather than restating them
 *
 * - **The primary is the safe action.** A confirmation whose primary is the
 *   destructive one is a speed bump somebody learns to click through. `Cancel`
 *   is filled; the destructive action is a secondary with no fill and no red,
 *   and the label carries the weight.
 * - **Cancel is never disabled.** It sends nothing — it closes a dialog nobody
 *   has acted on — and a scrim covering the window with every button dead is a
 *   window with no way out of it (#211).
 * - **Say the cost in checkable terms.** *"This cannot be undone"* is the
 *   sentence people learn to ignore. A path, a run id and a sentence naming what
 *   survives are things a person can read and disagree with.
 *
 * ## The facts are what make the two dialogs different
 *
 * Forgetting a project touches no disk at all, and deleting a run leaves its
 * branch and every commit on it in git. Both are stated as rows rather than
 * buried in prose, because the thing a person is checking before they press is
 * exactly *what is about to be gone* and *what is not*.
 */

/** One line of what is about to happen, or of what deliberately is not. */
export interface Fact {
  label: string;
  /** Monospace when it is a path or an id — those are strings to recognise. */
  value: ReactNode;
  mono?: boolean;
}

export function Confirm({
  tone = 'alarm',
  kicker,
  title,
  lead,
  facts,
  confirm,
  onConfirm,
  onCancel,
  busy = false,
  problem = null,
}: {
  tone?: 'alarm' | 'quiet';
  /** What kind of act this is, in two or three words. */
  kicker: string;
  title: string;
  lead: string;
  facts: readonly Fact[];
  /** The destructive button's label. Names the act, never just *OK*. */
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  /**
   * Why the last attempt did not happen, or null.
   *
   * **Shown here rather than closing the dialog**, because a refusal is the one
   * answer a person has to read: the core refuses to delete a run whose lock is
   * live, and a dialog that vanished on that would look exactly like one that
   * succeeded. It is the core's own sentence, not a paraphrase of it.
   */
  problem?: string | null;
}) {
  return (
    <Modal width={560} onDismiss={onCancel}>
      <div className="v-confirm__head">
        <StateKicker tone={tone}>{kicker}</StateKicker>
        <span className="v-confirm__title">{title}</span>
      </div>

      <p className="v-confirm__lead">{lead}</p>

      {facts.map((fact) => (
        <div className="v-confirm__fact" key={fact.label}>
          <span className="v-confirm__label">{fact.label}</span>
          <span className={`v-confirm__value${fact.mono === true ? ' v-confirm__value--mono' : ''}`}>
            {fact.value}
          </span>
        </div>
      ))}

      {problem !== null && (
        <p className="v-confirm__problem" role="alert">
          <StateKicker tone="alarm">refused</StateKicker> {problem}
        </p>
      )}

      <div className="v-confirm__actions">
        {/* Leftmost, secondary, no fill and no red. See the header. */}
        <Button level="secondary" disabled={busy} onClick={onConfirm}>
          {confirm}
        </Button>
        {/* Never disabled. It closes a dialog and sends nothing. */}
        <Button level="primary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
