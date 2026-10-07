import { Modal } from '../design';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
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
  /**
   * Whether this value is long enough to need a box of its own (#223).
   *
   * **The one row that is a document rather than a sentence.** A run's name is
   * its brief until somebody renames it, so the row naming *what this run was
   * asked to do* is a wall of text — and putting it in the dialog unbounded is
   * what pushed the Cancel button off the bottom of the screen. The heading
   * shows a preview and this shows the whole of it, in a box that scrolls, which
   * is what *"it should just be a preview and it needs to be scrollable just in
   * case"* asked for. Nothing is hidden and nothing is elided.
   */
  scroll?: boolean;
}

/** A fact row's label: small caps over the value. */
const LABEL = 'text-label uppercase tracking-label text-tertiary';

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
      <div className="mb-4 flex items-center gap-3">
        <Badge variant={tone}>{kicker}</Badge>
        {/* Bounded as well as previewed, and the two are not redundant.
            `preview()` cuts the text and this cuts the layout: a 72-character
            preview is still three lines at the title size in a narrow window,
            and the clamp is what makes the heading a heading at every width. */}
        <span className="line-clamp-2 text-title font-semibold tracking-tight text-display [overflow-wrap:anywhere]">{title}</span>
      </div>

      <p className="mt-0 mb-4 text-body text-primary">{lead}</p>

      {/* One fact per row: what goes, where from, and what survives. A path and
          an id are strings to recognise rather than read, which is the mono. */}
      {facts.map((fact) => (
        <div className="grid grid-cols-[9rem_1fr] gap-3 border-t border-rule-inner py-2" key={fact.label}>
          <span className={LABEL}>{fact.label}</span>
          <span
            className={cn(
              'text-body-sm text-secondary',
              fact.mono === true && 'font-mono text-mono-sm text-primary [overflow-wrap:anywhere]',
              // The whole of a long value, in a box of its own. `pre-wrap`
              // because a brief has its own line breaks; a cap because the row
              // is the only one whose content is a document, and a document in a
              // fact row is what took the Cancel button off the screen.
              fact.scroll === true && 'max-h-44 overflow-y-auto whitespace-pre-wrap rounded-sm border border-rule-inner px-3 py-2',
            )}
            data-scroll={fact.scroll === true ? '' : undefined}
          >
            {fact.value}
          </span>
        </div>
      ))}

      {/* The core's own refusal, on the dialog rather than instead of it: a
          window that closed on "it is still running" would look exactly like
          one that succeeded. */}
      {problem !== null && (
        <p className="mt-4 mb-0 rounded-sm bg-alarm p-3 text-body-sm text-primary" role="alert">
          <Badge variant="alarm">refused</Badge> {problem}
        </p>
      )}

      {/* The primary sits last, so the destructive action is not what the eye or
          the pointer lands on first. */}
      <div className="mt-5 flex gap-3">
        {/* Leftmost, secondary, no fill and no red. See the header. */}
        <Button variant="secondary" disabled={busy} onClick={onConfirm}>
          {confirm}
        </Button>
        {/* Never disabled. It closes a dialog and sends nothing. */}
        <Button variant="primary" className="ml-auto" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
