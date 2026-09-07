import { LivenessDot } from '../design';
import { counted, elapsed, tokens, work } from './format';
import { runningRow } from './model';
import type { Turn } from './model';

/**
 * `6a` — the element on screen longer than anything else in the app.
 *
 * The design says *"build this exactly"* and lists six measurements with no
 * derived quantity. Five are on the wire today; the last names the issue that
 * would supply it and is drawn as an absence rather than as a blank.
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
 * A gate holds after a turn has ended, and that is the one moment somebody wants
 * to see what the turn *did* before deciding whether to continue - so the card
 * stays, with its measurements, rather than collapsing to a duration (#202).
 *
 * What it gives up is the live treatment: the accent border, the active ground
 * and the pulsing dot. **One live card is a rule the column already obeys**, and
 * while a gate is held there is no live card at all, so nothing may wear it. The
 * clocks are stopped in `runningRow` rather than here, because a stopped clock
 * is a fact about the turn and not about how it is drawn.
 */
export function RunningRow({ turn, now, live = true }: { turn: Turn; now: number; live?: boolean }) {
  const row = runningRow(turn, now);

  return (
    <div className={`v-running${live ? '' : ' v-running--settled'}`}>
      <div className="v-running__head">
        <LivenessDot state={live ? 'live' : 'quiet'} />
        <span className="v-running__who">
          {turn.role} · {turn.kind}
          {turn.round === null ? '' : ` · round ${turn.round}`}
        </span>
      </div>

      <ol className="v-running__lines">
        <li className="v-running__line">{elapsed(row.elapsedMs)}</li>

        {row.activities !== null && (
          <li className="v-running__line">{counted(row.activities.count, row.activities.unit)}</li>
        )}

        {row.lastActivity !== null && (
          <li className="v-running__line v-running__line--activity">{row.lastActivity}</li>
        )}

        {/* The measurement where there is one, and the reason where there is
            not - never a blank and never a zero standing in for either. This
            line was an absence naming #136 until that landed and #198 connected
            it; the other absence below is still waiting on its own. */}
        {row.work !== null ? (
          <li className="v-running__line">{work(row.work)}</li>
        ) : (
          <li className="v-running__line v-running__line--absent">{row.noWork}</li>
        )}

        {row.quietMs !== null && (
          <li className="v-running__line">last activity {elapsed(row.quietMs)} ago</li>
        )}

        <li className="v-running__line v-running__line--absent">{row.comparable}</li>
      </ol>

      {row.tokens !== null && (
        <div className="v-running__spend">
          {tokens(row.tokens)} tok
          {row.context === null ? (
            // Codex reports no context figure at all, and a Claude turn has none
            // until one has measured a window. Drawn as a stated absence, never
            // as a bar at zero - those two look identical and mean opposite things.
            <span className="v-running__unmeasured"> · context not measured for this turn</span>
          ) : (
            <span className="v-running__ctx">
              {' · ctx '}
              {Math.round((row.context.used / row.context.window) * 100)}%
              <span
                className="v-running__ctxtrack"
                role="img"
                aria-label={`context ${row.context.used} of ${row.context.window}`}
              >
                <span
                  className="v-running__ctxfill"
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
