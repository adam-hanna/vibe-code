import { StateKicker } from '../design';
import { clock, elapsed } from './format';
import type { Staleness } from './model';

/**
 * How old what is on screen is, and whether it is still live (`7c`, #223).
 *
 * The design is explicit that for an app whose entire job is reflecting a
 * long-running external process, **this is a first-class concern rather than a
 * polish item** — and that the three states need three different weights,
 * because *"nothing happened"* and *"I stopped being able to tell"* are
 * different facts with different responses.
 *
 * - **live** — nothing drawn. The liveness dot in the titlebar already says it,
 *   and a second element saying the same thing is the noise that trains people
 *   to stop reading both.
 * - **thinking** — one quiet line, **stated as a fact and not as a worry**. A
 *   turn emitting nothing for twelve minutes is a healthy turn; the retired
 *   6-minute indicator is on the canvas with exactly that reason beside it.
 * - **not-live** — a strip across the window. Everything on screen is however
 *   old it is and vibe cannot confirm the phase is still running. **This one
 *   must not look normal**, which is why it is the only state that gets width.
 *
 * `unknown` is drawn too, and it is not a fourth degree of staleness: it is the
 * pane saying it has no threshold to judge against. That happens on a core that
 * does not report its heartbeat cadence, and picking a number here instead would
 * be the invented denominator this repo refuses everywhere.
 */
export function StalenessStrip({ state }: { state: Staleness }) {
  if (state.state === 'live') return null;

  if (state.state === 'unknown') {
    // Only worth saying when it is a limitation rather than an ordinary gap.
    // "No turn is running" is the cockpit's normal resting state and needs no
    // announcement; not knowing the cadence is a real thing to report.
    if (state.why === null || state.lastBeatAt === null) return null;
    return (
      <div className="v-stale v-stale--quiet">
        <StateKicker tone="quiet">cannot tell</StateKicker>
        <span>
          {state.why}. Last beat {clock(state.lastBeatAt)}.
        </span>
      </div>
    );
  }

  if (state.state === 'thinking') {
    return (
      <div className="v-stale v-stale--quiet">
        <StateKicker tone="quiet">thinking</StateKicker>
        <span>
          {/* Both clocks on one line, because the point is the comparison: the
              child has been silent this long, and vibe heard from itself this
              recently. Either number alone is the one that misleads. */}
          no output for {state.outputMs === null ? 'the whole turn' : elapsed(state.outputMs)}
          {state.activityMs !== null && <> · activity {elapsed(state.activityMs)} ago</>}
        </span>
      </div>
    );
  }

  return (
    <div className="v-stale v-stale--alarm">
      <StateKicker tone="alarm">not live</StateKicker>
      <span>
        {/* An instant, not a relative time. This strip is on screen precisely
            because nothing is updating, and a relative time on a still surface
            ages into a lie — which is the whole of hi-fi 17. */}
        Nothing since {state.lastBeatAt === null ? 'an unrecorded time' : clock(state.lastBeatAt)}.
        Everything below is at least that old, and vibe cannot confirm the phase is still
        running.
      </span>
    </div>
  );
}
