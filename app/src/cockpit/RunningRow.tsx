import { LivenessDot } from '../design';
import { Badge } from '@/ui/badge';
import { cn } from '@/lib/utils';
import { clock, counted, elapsed, tokens, work } from './format';
import { runningRow } from './model';
import type { ArchiveView, Turn } from './model';

/**
 * `6a` — the element on screen longer than anything else in the app.
 *
 * The design says *"build this exactly"* and lists six measurements with no
 * derived quantity. All six are on the wire now: the last, comparable turns, is
 * read from the archive's scorecard (#114) - **by tokens, never by time**,
 * because the archive records no turn durations - and is drawn as an absence
 * only while that scorecard has not been read.
 *
 * The diffstat joined them in #198, and the way it was missed is worth keeping:
 * it named #136, #136 landed, and nobody connected the two - so the row went on
 * printing *"the loop reports no file counts"* while the loop narrated them
 * every thirty seconds. Naming an issue makes a gap legible; it does not close
 * it.
 *
 * **Each earlier attempt at this element failed the same way: inventing a
 * denominator to make waiting feel measured.** There is no bar here. The only
 * bar in the app is Claude's context, because `promptTokens / contextWindow` is
 * a real number over a known denominator - and even that is drawn only when the
 * heartbeat carried the window, because it omits the field rather than sending
 * a zero.
 *
 * The pulsing dot is the only moving element. It carries "alive" so nothing else
 * has to imply it.
 *
 * ## `live={false}` is the same row with nothing claiming to be happening
 *
 * Hi-fi 17. A gate holds after a turn has ended, and that is the one moment
 * somebody wants to see what the turn *did* before deciding whether to continue
 * - so the card stays, **fully measured**, rather than collapsing to a duration
 * (#202). Settled is not the same as unimportant: a transcript's settled cards
 * can recede, and a card a decision is pending on cannot.
 *
 * What it gives up is everything that says *live*: the accent border, the active
 * ground, the accent on the version label, and **the liveness dot entirely**. A
 * quiet dot would still be a dot, and the rule the column obeys is that exactly
 * one element on screen pulses - while a gate is held, nothing should. What does
 * NOT recede is the measurements: the tool count, the last activity, the spend
 * and the summary stay at primary weight, because those are what the pending
 * decision rests on.
 *
 * ## Every relative time becomes absolute, and that is the actual fix
 *
 * Stopping the clocks was half of it. `last activity 6s ago` is a claim that has
 * to keep being true, and on a card that has stopped moving it ages into a lie -
 * which is how a run held overnight came to read `5h39m ago` about a turn that
 * had taken a minute. `last activity 14:52` is true forever.
 *
 * The elapsed line takes the past tense with it: `ran 4m12s · ended 14:52`.
 */

/** One measured line of the row. */
const LINE = 'font-mono text-mono-sm text-primary';
/**
 * A measurement with no source. Dashed left rule and the text floor - it says
 * "nothing has filled this in", which is a different statement from a zero and
 * has to look like one.
 */
const ABSENT = 'border-l border-dashed border-rule-strong pl-1.5 text-tertiary';

export function RunningRow({
  turn,
  now,
  live = true,
  archive = null,
}: {
  turn: Turn;
  now: number;
  live?: boolean;
  /** The archive's per-kind token distributions, or null while unread. */
  archive?: ArchiveView;
}) {
  const row = runningRow(turn, now, archive);

  return (
    <div
      className={cn(
        'my-2 rounded-sm border p-3',
        live ? 'border-accent-border bg-active' : 'border-rule-card bg-card',
      )}
    >
      <div className={cn('mb-2 flex items-center gap-2 border-b border-rule-inner pb-2', !live && 'justify-between')}>
        {live && <LivenessDot state="live" />}
        <span className={cn('text-body-sm', live ? 'text-emphasis' : 'text-tertiary')}>
          {turn.role} · {turn.kind}
          {turn.round === null ? '' : ` · round ${turn.round}`}
        </span>
        {/* Names why nothing is moving, so a completely still card does not read
            as a failed one. */}
        {!live && <Badge>held</Badge>}
      </div>

      <ol className="m-0 flex list-none flex-col gap-1 p-0">
        <li className={LINE}>
          {live || row.endedAt === null
            ? elapsed(row.elapsedMs)
            : `ran ${elapsed(row.elapsedMs)} · ended ${clock(row.endedAt)}`}
        </li>

        {row.activities !== null && (
          <li className={LINE}>{counted(row.activities.count, row.activities.unit)}</li>
        )}

        {row.lastActivity !== null && (
          <li className={cn(LINE, 'text-emphasis [overflow-wrap:anywhere]')}>{row.lastActivity}</li>
        )}

        {/* The measurement where there is one, and the reason where there is
            not - never a blank and never a zero standing in for either. This
            line was an absence naming #136 until that landed and #198 connected
            it; the other absence below is still waiting on its own. */}
        {row.work !== null ? (
          <li className={LINE}>{work(row.work)}</li>
        ) : (
          <li className={cn(LINE, ABSENT)}>{row.noWork}</li>
        )}

        {/* The line the six-hour hang was really made of. Relative while the
            card is live, absolute once it is not — see the header. */}
        {live
          ? row.quietMs !== null && (
              <li className={LINE}>last activity {elapsed(row.quietMs)} ago</li>
            )
          : row.lastBeatAt !== null && (
              <li className={LINE}>last activity {clock(row.lastBeatAt)}</li>
            )}

        <li className={row.comparable.measured ? LINE : cn(LINE, ABSENT)}>{row.comparable.text}</li>
      </ol>

      {row.tokens !== null && (
        <div className={cn(LINE, 'mt-2 border-t border-rule-inner pt-2')}>
          {tokens(row.tokens)} tok
          {row.context === null ? (
            // Codex reports no context figure at all, and a Claude turn has none
            // until one has measured a window. Drawn as a stated absence, never
            // as a bar at zero - those two look identical and mean opposite things.
            <span className="text-tertiary"> · context not measured for this turn</span>
          ) : (
            <span className="text-secondary">
              {' · ctx '}
              {Math.round((row.context.used / row.context.window) * 100)}%
              {/* The ONE bar in the app, and only because promptTokens over
                  contextWindow is a real number divided by a known denominator.
                  If you cannot name the denominator, it is not a bar. */}
              <span
                className="ml-1.5 inline-block h-1 w-16 border border-rule-inner bg-page align-middle"
                role="img"
                aria-label={`context ${row.context.used} of ${row.context.window}`}
              >
                <span
                  className="block h-full bg-accent-base"
                  style={{
                    width: `${Math.min(100, (row.context.used / row.context.window) * 100)}%`,
                  }}
                />
              </span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
