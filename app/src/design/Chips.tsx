/**
 * The severity chip. The state kicker and the meta chip beside it went with the
 * gallery, which was the last thing drawing them (#237).
 *
 * `Severity` is declared here rather than imported from `@src/types.js`
 * deliberately: this layer binds to no core code, so it can be built while the
 * narration and host seams are still landing. It must stay identical to the
 * union in `src/types.ts`, and the app proper is where the two are joined.
 */
export type Severity = 'P0' | 'P1' | 'P2' | 'P3';

/**
 * Weight ascends with severity. No chip carries a fill but P2's tint - a fill
 * would mean pressable. P0 takes the highest luminance AND a doubled rule,
 * because on a dark ground the ramp is rebuilt rather than flipped. Zero is
 * dashed, with its digit at the text floor: nothing to report is an absence,
 * and absence has a treatment.
 *
 * Utilities since #237, each the token the old `.v-sev` rule named - the
 * spacing tokens are off Tailwind's scale, so they are referenced, not rounded.
 */
const CHIP =
  'inline-flex items-baseline gap-(--space-1) whitespace-nowrap rounded-[4px] px-(--space-2) py-[2px] uppercase tracking-(--track-chip) [font:var(--type-chip)]';

const VARIANT = {
  P0: 'border-(length:--severity-p0-width) border-solid border-severity-p0-rule text-severity-p0-text',
  P1: 'border border-severity-p1-rule text-severity-p1-text',
  P2: 'border border-severity-p2-rule bg-severity-p2-fill text-accent-on-tint',
  P3: 'border border-severity-p3-rule text-primary',
  zero: 'border border-dashed border-severity-zero-rule text-tertiary',
} as const;

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
  return (
    <span className={`${CHIP} ${VARIANT[severity ?? 'zero']}`}>
      <span>{label ?? severity ?? 'none'}</span>
      {count !== undefined && <span>{count}</span>}
    </span>
  );
}
