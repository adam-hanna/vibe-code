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
 * Two instances in the whole product, so this carries the only shadow in it.
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
   * Focus the scrim **once**, so Escape has somewhere to land.
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
   * Focusing the scrim at all is still right — a keydown from anything inside
   * bubbles up to it, so Escape works from a field as well as from nothing — but
   * it is a thing to do when the dialog appears, which is what a mount effect
   * means and what a callback ref does not.
   */
  useEffect(() => {
    scrim.current?.focus();
  }, []);

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
      {/* Deliberately not dismissed by clicking the scrim. Both dialogs here
          guard something expensive - ending a run, launching one - and a stray
          click outside is not an intention. Escape is. */}
      <div className="v-modal" style={{ width }} role="dialog" aria-modal="true">
        {children}
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
