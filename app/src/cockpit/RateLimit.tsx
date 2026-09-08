import { MetaChip, StateKicker } from '../design';
import { clock, elapsed } from './format';
import type { RateLimit } from './model';

/**
 * A rate-limit wait (`7e`, #223).
 *
 * **`waiting`, not `halted`, and that is the entire point of the screen.** The
 * design is explicit: a rate limit *"requires no decision, so it must not look
 * as though it does"*. Every other state that stops a run is asking somebody
 * something. This one is the loop sitting out a window it already knows the
 * length of, and it resumes by itself.
 *
 * So: no alarm ground, no primary action, no kicker that says the run is
 * broken. It is the quiet strip, and it says which account is out of headroom -
 * because the other provider's work is unaffected and somebody watching should
 * not conclude the whole tool has stopped.
 *
 * **"Run this phase on the other agent" is deliberately not offered.** The
 * design demotes it to a text link and states the cost, and the cost is why:
 * swapping providers mid-run means a fresh session with no memory of the
 * conversation so far, and for a writing role on a persisted Codex thread the
 * configuration is refused outright rather than repaired. It is a different run,
 * not a faster route to the same one - and there is no frame that would carry
 * such a request anyway, so a button here would be decoration.
 */
export function RateLimitStrip({ wait, now }: { wait: RateLimit | null; now: number }) {
  if (wait === null) return null;

  // Kept on screen after it clears rather than removed. A run that waited forty
  // minutes did so, and a screen that forgets cannot explain where the time
  // went - which is the first question somebody asks about a long run.
  if (wait.resumedAt !== null) {
    return (
      <div className="v-rate v-rate--past">
        <StateKicker tone="quiet">waited</StateKicker>
        <span>
          {elapsed(wait.resumedAt - wait.at)} on a rate limit
          {wait.provider !== null && <> · {wait.provider}</>} — resumed at {clock(wait.resumedAt)}
          {' '}and carried on from where it stopped.
        </span>
      </div>
    );
  }

  const waited = Math.max(0, now - wait.at);
  return (
    <div className="v-rate">
      {/* `waiting`, not `halted`. Quiet tone, no alarm ground. */}
      <StateKicker tone="quiet">waiting</StateKicker>
      <span>
        {wait.provider === null ? 'An agent' : wait.provider} has no headroom left, so &ldquo;
        {wait.label}&rdquo; is sitting out the window. Nothing needs you.
      </span>
      <span className="v-rate__times">
        {/* What is known, and only what is known. The reset instant comes from
            the provider; the planned wait is the loop's own figure; neither is
            derived from the other. */}
        waiting {elapsed(waited)}
        {wait.waitMs !== null && <> of about {elapsed(wait.waitMs)}</>}
        {wait.resetsAt !== null && <> · resets {clock(Date.parse(wait.resetsAt))}</>}
      </span>
      <MetaChip>the other provider keeps running</MetaChip>
    </div>
  );
}
