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

/** Two instances in the whole product, so this carries the only shadow in it. */
export function Modal({ children, width = 520 }: { children: ReactNode; width?: number }) {
  return (
    <div className="v-scrim">
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
