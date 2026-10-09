import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/** The modal and the table. The card and the banner went with the gallery, their last caller (#237). */

/**
 * Three instances in the whole product, so this carries the only shadow in it.
 *
 * **Escape always leaves, and that is a safety property rather than a
 * convenience** (#211). A scrim is `position: fixed; inset: 0` over the entire
 * window, so a dialog whose every control is unreachable is not a stuck dialog —
 * it is a stuck *application*, with the conversation, the tabs and the run all
 * visible behind it and none of them clickable. That was reachable here: both
 * callers disable their actions while a request is in flight, and one of them
 * disabled its cancel too.
 *
 * `onDismiss` is required rather than optional, so a future third modal has to
 * answer the question instead of inheriting the trap. A dialog with genuinely no
 * safe cancel would pass the least destructive of its own actions.
 *
 * **A dialog cannot outgrow the viewport**, which is the other half of the same
 * safety property and was missing until a confirmation put a whole brief in its
 * title. The dialog is height-bounded and its body scrolls inside it (the
 * `max-h-[…]` and `min-h-0 overflow-y-auto` below), so a dialog's own actions stay reachable however long its content is - the size
 * of what a caller passes in is not something this component can be asked to
 * trust.
 */
/** Whether a key event's target keeps the browser's own select-all: a field. */
function editable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
}

export function Modal({
  children,
  width = 520,
  onDismiss,
  label,
}: {
  children: ReactNode;
  width?: number;
  /** A concise name for assistive technology, independent of the content. */
  label?: string;
  /** What Escape does. Must be the option that acts on nothing. */
  onDismiss: () => void;
}) {
  const scrim = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  /**
   * Focus the scrim **once**, so a keystroke has somewhere to land.
   *
   * This was `ref={(el) => el?.focus()}`, and an inline callback ref is not a
   * one-off: React detaches and re-attaches it on **every render**, because the
   * arrow function is a new identity each time. So every render called `focus()`
   * on the scrim — and the cockpit re-renders once a second off its own clock,
   * and again on every keystroke, because a controlled field's `onChange` is a
   * `setState` in the component above this one.
   *
   * The symptom was exact and was reported as such: *"I can't type in the 'What
   * are we doing' window, it keeps going out of focus when I try typing in it."*
   * One character landed, the state changed, the parent re-rendered, and this
   * ref took focus straight back off the textarea.
   *
   * Focusing on mount is a thing to do when the dialog appears, which is what an
   * effect means and what a callback ref does not.
   */
  useEffect(() => {
    scrim.current?.focus();
  }, []);

  /**
   * Escape, on the window, so it does not depend on where focus is.
   *
   * The scrim's own `onKeyDown` stays and covers the ordinary case — a keydown
   * from a field inside bubbles up to it — but it only fires while focus is
   * *within* the dialog, and this is the one control in the product that must
   * work when everything else has failed. A modal is `position: fixed; inset: 0`
   * over the whole window, so a dialog with no reachable way out is not a stuck
   * dialog, it is a stuck **application** (#211): the conversation, the tabs and
   * the run are all visible behind it and none of them is clickable.
   *
   * That state was reached — *"This screen pops up and I cant click out of it"* —
   * by a confirmation whose title was a whole brief, which grew the dialog past
   * the bottom of the screen and took its own Cancel button with it. The height
   * bound on the dialog below is what stops that happening again; this is what
   * makes the way out independent of it, and of focus, and of layout.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss();
      // Select-all inside a dialog selects the dialog (#253). The pilot's log is
      // selectable text, so the browser's own select-all painted the whole
      // conversation blue behind the scrim. A field keeps its own select-all.
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !editable(event.target)) {
        event.preventDefault();
        const box = dialog.current;
        const selection = window.getSelection();
        if (box !== null && selection !== null) {
          const range = document.createRange();
          range.selectNodeContents(box);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  /**
   * A selection made behind the dialog does not stay painted under it (#253).
   * The scrim is translucent, so a selection in the log read as part of the
   * dialog. Cleared once, when it opens.
   */
  useEffect(() => {
    window.getSelection()?.removeAllRanges();
  }, []);

  // Styled with utilities (the UI rework), and every rule the stylesheet carried
  // is here: the scrim is fixed over the whole window at z-50, above the palette;
  // the dialog is bounded by the viewport (`max-h`) and the body is the flex item
  // that shrinks and scrolls (`min-h-0`), so a dialog's own actions stay
  // reachable however long its content is. `audit:contrast` §10 reads these two
  // classes off this file.
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-page/60"
      // On the scrim rather than the dialog so a keystroke lands whatever has
      // focus inside it, and `autoFocus`-free: taking focus on mount would move
      // it away from whatever the user was typing in behind the modal.
      tabIndex={-1}
      ref={scrim}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onDismiss();
      }}
    >
      {/* Deliberately not dismissed by clicking the scrim. Every dialog here
          guards something expensive - ending a run, launching one, deleting one -
          and a stray click outside is not an intention. Escape is. */}
      <div
        className="relative flex max-h-[calc(100vh-44px)] max-w-[calc(100vw-32px)] flex-col rounded-lg border border-rule-strong bg-card p-6 shadow-overlay"
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        ref={dialog}
      >
        {/* The scrolling half, a wrapper rather than `overflow` on the dialog
            itself, so the dialog keeps its border and shadow while a long body
            scrolls inside it. */}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

/**
 * 30px header, 34px rows, no zebra, no vertical rules, sized to content and
 * never full-bleed - a table stretched to the pane makes the eye travel across
 * whitespace to reach a value.
 */
/** Cell styles, on the cell, from the old `.v-table th` / `td` rules. */
const TH =
  'h-(--dim-table-header) whitespace-nowrap border-b border-rule-structure bg-column px-(--space-4) py-0 text-left uppercase tracking-(--track-label) text-tertiary [font:var(--type-label)]';
const TD = 'h-(--dim-table-row) whitespace-nowrap border-b border-rule-inner px-(--space-4) py-0 text-primary';

export function Table({
  columns,
  rows,
  selected,
}: {
  columns: readonly string[];
  rows: readonly { key: string; cells: readonly ReactNode[] }[];
  selected?: string | undefined;
}) {
  return (
    <table className="w-auto border-collapse">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c} className={TH}>
              {c}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          // A selected row: the active wash on every cell, and the 2px accent
          // rule drawn as an inset on the first, so it does not move the text.
          // The row itself also carried the global `.is-selected` rule.
          const on = r.key === selected;
          return (
            <tr key={r.key} className={on ? 'border-l-2 border-accent bg-active' : ''}>
              {r.cells.map((cell, i) => (
                <td
                  // eslint-disable-next-line react/no-array-index-key
                  key={i}
                  className={on ? `${TD} bg-active${i === 0 ? ' shadow-[inset_2px_0_0_var(--accent-solid)]' : ''}` : TD}
                >
                  {cell}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
