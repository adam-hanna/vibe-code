import type { ChildEnding } from '@src/proc.js';

/**
 * Stopping a turn that is already running (#209).
 *
 * Every other way a run ends waits for a boundary. A `stop` gate row ends it at
 * the next checkpoint, a round cap raises an `Escalation` between turns, and
 * `shutdown` is documented as *"not a kill"*. None of them helps somebody
 * watching a turn that is forty minutes in and going the wrong way, and the
 * footer's own `STOP` only exists while a gate is holding - so until now the
 * only way to end a live turn was to kill the process.
 *
 * ## Why this is a module latch rather than a token threaded through
 *
 * A cancel has to reach a child that is *already spawned*, several layers below
 * whoever asked. Threading a token from `serve.ts` through `orchestrate`, the
 * turn dispatch, `claudeTurn`, `claude.ts` and into `run()` would put a
 * parameter on every function between them, and every one of those is a place
 * for a future call site to forget it - a turn silently uncancellable is worse
 * than no cancel at all, because the button is still there.
 *
 * The latch is safe *because of a rule that already exists and is enforced
 * elsewhere*: one run per process. `src/lock.ts` is written expecting it and
 * `serve.ts` refuses a second `invoke` while one is running. So "the run" is
 * unambiguous here, and there is no second run for this to reach by mistake.
 *
 * ## What it kills, and what it deliberately does not
 *
 * Only children registered as **interruptible**, which is the two agent
 * adapters and nothing else. `git`, the verification gate and the app-server
 * client all go through the same `run()` and none is killable this way:
 *
 * - Killing `git commit` mid-write leaves an index a later resume has to
 *   recover from, which is a cost the person pressing stop did not agree to.
 * - The verification gate is the **user's own command**. "Stop the turn" is not
 *   permission to kill their test runner mid-suite, and a gate that dies
 *   half-way is a `failing` verdict about a suite nobody ran (#135).
 *
 * ## It latches, and that is the fail-closed direction
 *
 * Once fired it stays fired for the life of the process. A cancelled turn's
 * error has to travel up through the retry logic and the loop's own handlers,
 * and any one of those could plausibly decide to have another go; a latch means
 * the next interruptible child **refuses to start** rather than relying on every
 * layer in between to have done the right thing. `clearCancel` exists for the
 * tests and for a resume in the same process, and is not called by the loop.
 */

/** Why the run was cancelled, or null if it was not. */
let reason: string | null = null;

/** Live interruptible children, by the kill they registered. */
const interruptible = new Set<() => void>();

/**
 * Ask for the turn in flight to be killed and the run to end.
 *
 * Returns how many children it actually killed, which is a fact worth having:
 * zero means the cancel arrived between turns, and the run still ends - just
 * without any work being discarded, which is a different thing to tell somebody.
 *
 * Never throws. A kill that fails leaves the latch set, and the latch is what
 * ends the run; a cancel that reported an error because one dying child could
 * not be signalled would be refusing to do the part that worked.
 */
export function requestCancel(why: string): number {
  reason = why;
  let killed = 0;
  for (const kill of [...interruptible]) {
    try {
      kill();
      killed += 1;
    } catch {
      // See above. The latch is the mechanism; the kill is the courtesy.
    }
  }
  return killed;
}

/** Why the run is being cancelled, or null. Latched. */
export function cancelRequested(): string | null {
  return reason;
}

/** Forget the request. For tests, and for a second run in one process. */
export function clearCancel(): void {
  reason = null;
}

/**
 * Register a child that a cancel may kill. Returns its unregister.
 *
 * The caller unregisters in a `finally`, so a child that ended on its own is
 * never in the set when the next cancel walks it - a stale entry would be a kill
 * aimed at a pid the OS may have handed to somebody else by then.
 */
export function registerInterruptible(kill: () => void): () => void {
  interruptible.add(kill);
  return () => interruptible.delete(kill);
}

/**
 * How this process describes a child it killed on purpose.
 *
 * The signal is attached even though vibe sent it, for the reason the timeout
 * path gives in the same words: a reader of the run record wants to know the
 * child died on a signal, and the sentence beside it already says who sent it
 * and why. An ending omitted because "we know this one" is a hole the next
 * reader has to know about (#131).
 */
export const CANCEL_ENDING: ChildEnding = { code: null, signal: 'SIGKILL' };

/**
 * The error a cancelled child rejects with.
 *
 * Its own class so the layers between here and `execute` can tell it from an
 * ordinary turn failure without matching a message. That distinction is the
 * whole point: a turn that failed may be worth retrying and a turn somebody
 * stopped never is.
 */
export class Cancelled extends Error {
  constructor(readonly why: string) {
    super(`the run was stopped: ${why}`);
    this.name = 'Cancelled';
  }
}
