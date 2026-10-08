import type { Frame } from '../host';
import { SERVICE_HOST } from '../host';

/**
 * Which host a frame came from, and what that means for the one live run (#246).
 *
 * The app runs one host process per run: a long-lived service host for
 * everything that is not a run, and a run host per `invoke`. The relay wraps
 * every event in the handle of the host that wrote it, and this is where the
 * window decides what to do with that handle. **Nothing here is matched by "the
 * current run"** - a run frame reaches the reducer because its handle is the
 * live run host's, even though Run A has at most one.
 *
 * Pure, for `model.ts`'s reason: the cockpit is the one place a routing mistake
 * would otherwise be invisible.
 */

/** The run host the window started, and the invoke it is serving. */
export interface LiveHost {
  handle: string;
  /** The id the `invoke` was sent with, from `nextRequestId`. */
  invokeId: number;
  /** Gate ids already answered on this host. See `mayAnswer`. */
  answered: ReadonlySet<number>;
}

/** Where a frame from `host` goes: the service host's listeners, the run, or nowhere. */
export function routeFrame(live: LiveHost | null, host: string): 'service' | 'run' | 'stale' {
  if (host === SERVICE_HOST) return 'service';
  return live !== null && host === live.handle ? 'run' : 'stale';
}

/**
 * Whether this frame ends the live run's invoke, and how.
 *
 * `completed` is the `result` carrying the invoke's id: the command returned.
 * `failed` is an `error` carrying it: the invoke was refused or escaped
 * `main()`'s own handling, so no `result` is coming.
 *
 * **An `error` with that id is always the invoke's**, and the reason is
 * `mayAnswer`: `serve.ts` refuses an answer only when its gate is not in `asks`,
 * a gate leaves `asks` only by being answered or by the clear that runs after
 * the invoke's own outcome has been sent, and the window answers each gate once.
 * So no answer refusal can arrive on the live handle while the run is live, even
 * when a gate's id happens to equal the invoke's - the two counters are the
 * host's and the window's, and neither range can be fenced off from the other.
 */
export function invokeOutcome(
  live: LiveHost | null,
  host: string,
  frame: Frame,
): 'completed' | 'failed' | null {
  if (live === null || host !== live.handle) return null;
  if (frame.type === 'result' && frame.id === live.invokeId) return 'completed';
  if (frame.type === 'error' && frame.id === live.invokeId) return 'failed';
  return null;
}

/** Whether the window may answer this gate: a run is live and it has not already. */
export function mayAnswer(live: LiveHost | null, askId: number): boolean {
  return live !== null && !live.answered.has(askId);
}

/**
 * What a host's exit means.
 *
 * The service host going is what "the host exited" has always meant. A run
 * host going while its run is live is that run lost. Any other run host going
 * is the expected close after its `result` - not an alarm.
 */
export function exitMeans(live: LiveHost | null, host: string): 'service' | 'run-lost' | 'expected' {
  if (host === SERVICE_HOST) return 'service';
  return live !== null && host === live.handle ? 'run-lost' : 'expected';
}

/** The sentence for a host that ended, moved verbatim from the cockpit. */
export function hostExitWording(code: number | null): string {
  return code === null
    ? 'the host was signalled and reported no exit code'
    : `the host exited ${String(code)}`;
}
