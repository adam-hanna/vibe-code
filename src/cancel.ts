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
/** Live interruptible children, by the kill they registered. */
const interruptible = new Set<() => void>();

/**
 * Waits a cancel should cut short, by the wake they registered (#223).
 *
 * **Deliberately not in `interruptible`**, though the shape is the same. That
 * set is *children*, and `requestCancel` returns how many of them it killed —
 * a number whose whole meaning is that zero tells somebody the cancel arrived
 * between turns and no work was discarded. A rate-limit wait IS between turns,
 * so counting one as a kill would report work destroyed where none was.
 *
 * It exists because a wait is the one place a run spends real time with no
 * child to kill, and that made stop a button that did nothing: the loop sleeps
 * out a rate-limit window on a bare timer, `serve.ts` holds the one-at-a-time
 * gate for the whole of `main()`, and so a fifteen-minute wait locked the window
 * out of starting anything for fifteen minutes. Reported exactly that way —
 * *"I ended a run, and now I can't create a new one."*
 */
const waiting = new Set<() => void>();

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
  // Woken after the children are killed and deliberately not counted among
  // them: a wait is not work, so cutting one short discards nothing. The wake
  // only ends the sleeping; what ends the *run* is the latch, which every
  // waiter checks the moment it comes back.
  for (const wake of [...waiting]) {
    try {
      wake();
    } catch {
      // Same rule as a kill that failed: the latch is the mechanism and the
      // wake is the courtesy. A waiter that cannot be woken still finds the
      // latch set when its timer expires.
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

/**
 * Register a wait a cancel may cut short. Returns its unregister.
 *
 * The caller unregisters in a `finally`, exactly as `registerInterruptible`'s
 * callers do and for a weaker version of the same reason: a stale entry here
 * wakes nothing rather than signalling a stranger's pid, but it is still a
 * reference the process holds for no reason.
 *
 * **Waking is not ending.** The wake resolves the wait early; the caller then
 * reads `cancelRequested()` and decides, which keeps the decision in the loop
 * where every other ending is decided rather than in a timer callback.
 */
export function registerWait(wake: () => void): () => void {
  waiting.add(wake);
  return () => waiting.delete(wake);
}

/**
 * Sleep, unless the run is cancelled first.
 *
 * **Here rather than in `orchestrator.ts` because this is where the latch
 * lives.** The loop's own `sleep` was `new Promise((r) => setTimeout(r, ms))` —
 * a timer with no way to be woken and no knowledge of the latch — and it is the
 * one thing in a run that cannot be interrupted while it is happening. That made
 * `stop` a no-op for the length of a rate-limit window and, because `serve.ts`
 * holds the one-at-a-time gate for the whole of `main()`, made a new run
 * impossible to start for exactly as long.
 *
 * Returns whether it slept the whole way. A caller that gets `false` has been
 * cancelled and should read `cancelRequested()` for the reason; it is a return
 * rather than a throw so the decision stays at the call site, which is the same
 * arrangement `guardTurnSpend` uses for a ceiling it cannot itself enforce.
 *
 * A cancel that is *already* latched returns immediately without sleeping at
 * all, which is the fail-closed direction: a run being stopped must not spend
 * fifteen minutes doing nothing first.
 */
export function sleepUnlessCancelled(ms: number, timers = globalThis): Promise<boolean> {
  if (reason !== null) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let done = false;
    // One settle, whichever arrives first. `clearTimeout` and the unregister are
    // both safe twice, but `finished` guards the *decision*, so a wake landing
    // in the same tick as the timer cannot resolve two different answers.
    const finished = (slept: boolean): void => {
      if (done) return;
      done = true;
      timers.clearTimeout(timer);
      unregister();
      resolve(slept);
    };
    const timer = timers.setTimeout(() => finished(true), ms);
    const unregister = registerWait(() => finished(false));
  });
}
