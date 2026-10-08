import { SeverityChip } from '../design';
import { Badge } from '@/ui/badge';
import { cn } from '@/lib/utils';
import { SEVERITIES } from './model';
import type { Severity } from '../design';

/**
 * The four severity counts against the tolerance, as one control.
 *
 * `1e` and hi-fi 2 both put this row on a round — *"severity carries the
 * screen"* — and the point is the peripheral scan: a run in trouble should look
 * different from across the room, before any text is read.
 *
 * **It navigates, because a count is what a reader reaches for.** The row was
 * drawn identically in the loop column and on the pilot's round card and neither
 * was clickable; the reported complaint was that clicking a `P0` did nothing.
 * The chips are the largest, most legible thing on either surface, so they are
 * the control and the wording is unchanged.
 *
 * **Zeros are drawn.** A gate decision is being made here and an absence is
 * information: `no P0s` is frequently the most important thing on the row. A
 * severity this build has no weight for renders unweighted rather than being
 * dropped, which is the same rule `boundary()` and `ending()` follow.
 *
 * `onOpen` is optional and its absence is a real state — a row with nowhere to
 * send anybody, and a button that goes nowhere is worse than a row that does not
 * claim to be one.
 *
 * As a button it keeps exactly the same geometry. The click target is the row,
 * and the only thing that changes on hover is the cursor and a hairline — a
 * count that grew a background on hover would flicker during the peripheral
 * scan the row exists for.
 */

/** A severity this build knows how to weight, or null for the zero variant. */
function weight(severity: string): Severity | null {
  return (SEVERITIES as readonly string[]).includes(severity) ? (severity as Severity) : null;
}

const ROW = 'my-1 flex flex-wrap items-center gap-1';

export function Counts({
  counts,
  tolerance,
  onOpen,
  compact = false,
  className,
}: {
  counts: Readonly<Record<string, number>>;
  /** `p1Tolerance`, or null where the row is drawn without a gate decision. */
  tolerance?: number | null;
  /** Where clicking sends the reader. Undefined draws a plain row. */
  onOpen?: (() => void) | undefined;
  /** The 364px column drops the tolerance chip; the pilot's wider card keeps it. */
  compact?: boolean;
  /** Where the row sits in its parent; never what it looks like. */
  className?: string | undefined;
}) {
  const chips = (
    <>
      {SEVERITIES.map((s) => {
        const n = counts[s] ?? 0;
        return <SeverityChip key={s} severity={n === 0 ? null : weight(s)} label={s} count={n} />;
      })}
      {!compact && tolerance !== null && tolerance !== undefined && (
        <Badge className="normal-case tracking-normal">tolerance P1≤{tolerance}</Badge>
      )}
    </>
  );

  if (onOpen === undefined) return <div className={cn(ROW, className)}>{chips}</div>;
  return (
    <button
      type="button"
      className={cn(
        ROW,
        'cursor-pointer border-0 border-b border-transparent bg-transparent p-0 text-left text-inherit hover:border-rule-control',
        className,
      )}
      onClick={onOpen}
      // Not "open the findings" any more: there is no Findings tab, and where
      // this row sends you depends on which judge produced the census. The
      // caller knows that and this does not, so the label says the thing that is
      // true from here.
      title="Open this round"
    >
      {chips}
    </button>
  );
}
