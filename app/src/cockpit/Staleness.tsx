import { Badge } from '@/ui/badge';
import { cn } from '@/lib/utils';
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
 *   6-minute indicator is on the canvas with exactly that reason beside it. It
 *   gets the chrome ground and no weight.
 * - **not-live** — a strip across the window. Everything on screen is however
 *   old it is and vibe cannot confirm the phase is still running. **This one
 *   must not look normal**, which is why it is the only state that gets width
 *   and the alarm ground.
 *
 * `unknown` is drawn too, and it is not a fourth degree of staleness: it is the
 * pane saying it has no threshold to judge against. That happens on a core that
 * does not report its heartbeat cadence, and picking a number here instead would
 * be the invented denominator this repo refuses everywhere.
 */

const STRIP = 'flex items-baseline gap-3 border-b px-5 py-2 text-body-sm';
const QUIET = 'border-rule-inner bg-chrome text-secondary';

/**
 * Both clocks, side by side (hi-fi 13).
 *
 * *"Two mono figures side by side are the cheapest possible explanation of why
 * the app reached a different conclusion in each case, and they are the same two
 * numbers the code branches on."* The `thinking` strip already showed them; the
 * `not-live` one did not, which is the state where a reader most wants to check
 * the app's arithmetic — and the design draws them on **both**. Mono and
 * tabular because a reader is checking the app's arithmetic against them.
 *
 * `pid · alive` beside them is the third figure the frame carries, and it is
 * three-valued rather than two: `alive` is a fact and *cannot tell* is the state
 * the design calls the worst the app can report. This window is told the host's
 * pid and is not told anything about the agent child, so what it can honestly
 * show is the host's — labelled as the host's, because a pid presented without
 * saying whose is a number a reader will attribute to the turn.
 */
function Clocks({ state, hostPid }: { state: Staleness; hostPid: number | null }) {
  return (
    <span className="flex gap-3 font-mono text-mono-sm tabular-nums text-tertiary">
      <span>output {state.outputMs === null ? 'never' : elapsed(state.outputMs)}</span>
      <span>activity {state.activityMs === null ? 'never' : elapsed(state.activityMs)}</span>
      {hostPid !== null && <span>host pid {hostPid}</span>}
    </span>
  );
}

export function StalenessStrip({
  state,
  hostPid = null,
}: {
  state: Staleness;
  /** This window's own host process, not the agent's. Null before it connects. */
  hostPid?: number | null;
}) {
  if (state.state === 'live') return null;

  if (state.state === 'unknown') {
    // Only worth saying when it is a limitation rather than an ordinary gap.
    // "No turn is running" is the cockpit's normal resting state and needs no
    // announcement; not knowing the cadence is a real thing to report.
    if (state.why === null || state.lastBeatAt === null) return null;
    return (
      <div className={cn(STRIP, QUIET)}>
        <Badge>cannot tell</Badge>
        <span>
          {state.why}. Last beat {clock(state.lastBeatAt)}.
        </span>
      </div>
    );
  }

  if (state.state === 'thinking') {
    return (
      <div className={cn(STRIP, QUIET)}>
        <Badge>thinking</Badge>
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
    <div className={cn(STRIP, 'border-rule-strong bg-alarm text-primary')}>
      <Badge variant="alarm">not live</Badge>
      <span>
        {/* An instant, not a relative time. This strip is on screen precisely
            because nothing is updating, and a relative time on a still surface
            ages into a lie — which is the whole of hi-fi 17. */}
        Nothing since {state.lastBeatAt === null ? 'an unrecorded time' : clock(state.lastBeatAt)}.
        Everything below is at least that old, and vibe cannot confirm the phase is still
        running.
      </span>
      {/* Hi-fi 13 draws both clocks on this state as well as on `thinking`,
          and says why: they are the same two numbers the code branched on, so
          they are the cheapest possible explanation of why it reached this
          conclusion rather than the quiet one. */}
      <Clocks state={state} hostPid={hostPid} />
    </div>
  );
}
