import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Severity } from './Chips';

/** Card, banner, modal, table. */

export function Card({
  state = 'settled',
  severity,
  children,
}: {
  /**
   * `spent` is opacity 0.72 and means acted-on, not disabled - a declined
   * finding or a settled round, still readable and no longer live.
   */
  state?: 'settled' | 'live' | 'spent';
  severity?: Severity | undefined;
  children: ReactNode;
}) {
  const cls = [
    'v-card',
    state === 'live' ? 'v-card--live' : '',
    state === 'spent' ? 'is-spent' : '',
    severity !== undefined ? `v-card--${severity.toLowerCase()}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  return <div className={cls}>{children}</div>;
}

/**
 * Replaces the footer in place and never appears above it. A halt is not a
 * notification; it is the state of the thing already being looked at.
 */
export function Banner({
  kicker,
  headline,
  evidence,
  actions,
}: {
  kicker: ReactNode;
  headline: ReactNode;
  evidence?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="v-banner">
      {kicker}
      <div>
        <div className="v-banner__headline">{headline}</div>
        {evidence !== undefined && <div className="v-banner__evidence">{evidence}</div>}
      </div>
      {actions !== undefined && <div className="v-banner__actions">{actions}</div>}
    </div>
  );
}

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
 * title. `.v-modal` is height-bounded and `.v-modal__body` scrolls inside it, so
 * a dialog's own actions stay reachable however long its content is - the size
 * of what a caller passes in is not something this component can be asked to
 * trust.
 */
export function Modal({
  children,
  width = 520,
  onDismiss,
}: {
  children: ReactNode;
  width?: number;
  /** What Escape does. Must be the option that acts on nothing. */
  onDismiss: () => void;
}) {
  const scrim = useRef<HTMLDivElement>(null);

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
   * bound in `components.css` is what stops that happening again; this is what
   * makes the way out independent of it, and of focus, and of layout.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  return (
    <div
      className="v-scrim"
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
      <div className="v-modal" style={{ width }} role="dialog" aria-modal="true">
        {/* The scrolling half, and the reason it is a wrapper rather than
            `overflow` on `.v-modal` itself: the corner marks are absolutely
            positioned against the dialog, and a scrolling dialog would scroll
            two of the four out of view — the marks and the one shadow are what
            carry elevation in this palette, so losing them on a long dialog
            loses the elevation exactly when there is most to look at. */}
        <div className="v-modal__body">{children}</div>
      </div>
    </div>
  );
}

/**
 * 30px header, 34px rows, no zebra, no vertical rules, sized to content and
 * never full-bleed - a table stretched to the pane makes the eye travel across
 * whitespace to reach a value.
 */
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
    <table className="v-table">
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className={r.key === selected ? 'is-selected' : ''}>
            {r.cells.map((cell, i) => (
              // eslint-disable-next-line react/no-array-index-key
              <td key={i}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
