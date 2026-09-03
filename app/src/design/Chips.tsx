import type { ReactNode } from 'react';

/**
 * Severity, the kicker, and the meta chip.
 *
 * `Severity` is declared here rather than imported from `@src/types.js`
 * deliberately: this layer binds to no core code, so it can be built while the
 * narration and host seams are still landing. It must stay identical to the
 * union in `src/types.ts`, and the app proper is where the two are joined.
 */
export type Severity = 'P0' | 'P1' | 'P2' | 'P3';

export function SeverityChip({
  severity,
  count,
  label,
}: {
  /** Null draws the `zero` variant - dashed, digit at the text floor. */
  severity: Severity | null;
  count?: number | undefined;
  label?: string | undefined;
}) {
  const variant = severity === null ? 'zero' : severity.toLowerCase();
  return (
    <span className={`v-sev v-sev--${variant}`}>
      <span>{label ?? severity ?? 'none'}</span>
      {count !== undefined && <span>{count}</span>}
    </span>
  );
}

/**
 * The headline of a banner, and the one place a solid fill does not mean
 * interactive. One per region.
 *
 * `alarm` is the pale emphasis reserved for alarm across the whole product;
 * `accent` is for a state that wants you but is not wrong; `quiet` is outlined
 * and is what a verdict wears.
 */
export function StateKicker({
  tone = 'alarm',
  children,
}: {
  tone?: 'alarm' | 'accent' | 'quiet';
  children: ReactNode;
}) {
  return <span className={`v-kicker v-kicker--${tone}`}>{children}</span>;
}

/**
 * `proposed · #NNN`, `app`, `unknown`, `likely the same`, and the evidence
 * kinds.
 *
 * Dashed by default, because a dashed border says "nothing verified this".
 * `checkable` is the exception: a citation that resolved on disk is drawn as a
 * fact. `proposed` is a promise the UI is making that the code has not kept -
 * any of these surviving into a shipped build is a screen running ahead of its
 * behaviour.
 */
export function MetaChip({
  kind = 'default',
  children,
}: {
  kind?: 'default' | 'checkable' | 'proposed';
  children: ReactNode;
}) {
  const mod = kind === 'default' ? '' : ` v-meta--${kind}`;
  return <span className={`v-meta${mod}`}>{children}</span>;
}
