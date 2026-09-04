import { LivenessDot } from '../design';
import { counted, elapsed, tokens } from './format';
import { runningRow } from './model';
import type { Turn } from './model';

/**
 * `6a` — the element on screen longer than anything else in the app.
 *
 * The design says *"build this exactly"* and lists six measurements with no
 * derived quantity. Four are on the wire today; two name the issue that would
 * supply them and are drawn as absences rather than as blanks.
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
 */
export function RunningRow({ turn, now }: { turn: Turn; now: number }) {
  const row = runningRow(turn, now);

  return (
    <div className="v-running">
      <div className="v-running__head">
        <LivenessDot state="live" />
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

        {/* Absent with the reason, which is the design's own rule for a missing
            quantity. Naming the issue means the row completes without being
            redesigned when the data arrives. */}
        <li className="v-running__line v-running__line--absent">{row.diffstat}</li>

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
