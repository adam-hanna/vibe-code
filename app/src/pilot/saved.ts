import { dirKey } from '../cockpit/projects';
import { emptyConversation } from './transcript';
import type { Conversation } from './transcript';

/**
 * A conversation, kept between launches (#223).
 *
 * **Opening a past run used to show an empty pane.** The plans, the reports and
 * the transcript all came back because they are files the run wrote; the
 * conversation *about* the run is the one thing nothing writes down, so it was
 * the one thing that did not. Reported with the rest: *"the pilot chat should
 * repopulate but it doesn't. Honestly, EVERYTHING should repopulate."*
 *
 * ## A conversation belongs to the run it is about
 *
 * Keyed by `(project, run)`, because a run id is only unique inside one archive
 * — the same reason a pin carries both. Before a run exists there is still a
 * conversation, and it is the one that will *propose* the run, so it is kept
 * under the project alone and **adopted** by the run when one starts. Without
 * that, the exchange that decided what to build would be dropped at the moment
 * it succeeded.
 *
 * ## It is not run state and must never become it
 *
 * `src/charge.ts`, `src/types.ts` and `src/orchestrator.ts` contain no `pilot`,
 * and a run's `state.json` is byte-identical whether the pane was open or shut
 * (#145). Writing a conversation into the run's directory would reverse that in
 * the most expensive possible way — a chat about a run is not part of the run's
 * record, which is the same sentence `pilotchat.ts` uses to explain why a pilot
 * turn does not narrate. So this is `localStorage`, beside the projects, the
 * pins and the spend ceiling.
 */

const PREFIX = 'vibe.chat.';

/** Where a conversation lives. `none` is the one that has not launched yet. */
export function chatKey(dir: string, runId: string | null): string {
  return `${PREFIX}${dirKey(dir)}::${runId ?? 'none'}`;
}

/**
 * Read one back, or an empty conversation.
 *
 * **Every failure is an empty conversation**, which is the only safe direction:
 * a pane that threw on a stored value somebody else wrote would take the window
 * with it, and the cost of being wrong is a chat that starts fresh.
 *
 * The live turn is deliberately dropped. A reply that was streaming when the
 * window closed has no vendor behind it any more — restoring it would draw a
 * pulsing card for a request nobody is waiting on, which is the stall the
 * thinking indicator exists to avoid claiming.
 */
export function readChat(raw: string | null): Conversation {
  if (raw === null) return emptyConversation();
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return emptyConversation();
    const row = value as Record<string, unknown>;
    const messages = Array.isArray(row['messages']) ? row['messages'] : [];
    const replies = Array.isArray(row['replies']) ? row['replies'] : [];
    if (messages.length === 0 && replies.length === 0) return emptyConversation();
    return {
      messages: messages as Conversation['messages'],
      replies: replies as Conversation['replies'],
      // Never restored. See above: a turn in flight has no vendor behind it.
      live: null,
      // A count of events THIS window did not recognise. A stored one describes
      // a session that has ended and would be a warning about nothing.
      unknown: 0,
    };
  } catch {
    return emptyConversation();
  }
}

/**
 * What is worth storing.
 *
 * `live` is dropped at the write as well as at the read, so a window killed
 * mid-turn does not leave a half-streamed reply on disk to be read back.
 */
export function writable(conversation: Conversation): string {
  return JSON.stringify({
    messages: conversation.messages,
    replies: conversation.replies,
  });
}

/** Whether there is anything worth keeping. An empty chat is not saved. */
export function worthSaving(conversation: Conversation): boolean {
  return conversation.messages.length > 0 || conversation.replies.length > 0;
}

/**
 * What to do when the window is pointed at a different conversation (#223).
 *
 * **Pulled out of the effect that does it, because the effect could not be
 * tested and got this wrong in a way nobody could see.** The app has no jsdom,
 * so a decision living inside a component is a decision nothing checks; this is
 * pure, and `saved.test.ts` drives every transition through it.
 *
 * ## The defect it is the fix for
 *
 * Adoption used to be allowed only *from* the project bucket — `chatKey(dir,
 * null)` — which is right about where a pre-run conversation lives and wrong
 * about where one can be *typed*. Open run A, type the brief for a new run into
 * the composer, press the proposal: the conversation went to A's key, because
 * that is where the window was pointed, and the run that it proposed started
 * life with nothing. Then opening that run showed an empty pane, which is the
 * report — *"I don't see the pilot chat update"* — arriving one step removed
 * from its cause.
 *
 * ## The rule
 *
 * A conversation belongs to the run it is *about*, and a run that is starting is
 * about whatever proposed it. So:
 *
 * - **`adopt`** — a run id has arrived, there is something on screen, and that
 *   run has nothing stored. What is on screen proposed it, wherever it was
 *   typed. This is the widening.
 * - **`restore`** — anything else with a different key, including a *resume*,
 *   where the target already has its own conversation. Adopting over that would
 *   destroy a real exchange to keep a stray one, which is strictly worse than
 *   the bug above.
 * - **`stay`** — the key has not moved.
 *
 * `stored` is passed in rather than read here, because a pure function that
 * touched `localStorage` would be neither.
 */
export type ChatMove = 'adopt' | 'restore' | 'stay';

export function chatMove(args: {
  /** The key the conversation on screen belongs to, or null before the first. */
  from: string | null;
  /** The key the window is now pointed at. */
  to: string;
  /** Whether the run id the window is now pointed at is a run at all. */
  intoRun: boolean;
  /**
   * Whether the window was **pointed** at this run rather than starting it
   * (#223).
   *
   * **The clause that was missing, and adoption without it swallowed the
   * archive.** `intoRun && holding && !stored` is true of two completely
   * different acts: a run this window just launched, which the conversation on
   * screen proposed — and a past run somebody **clicked on** that happens to
   * have no conversation of its own. The second took the chat with it, so
   * browsing the archive left the same exchange on screen no matter which run
   * was open, and worse, wrote it into that run's key on the way past.
   * Reported as *"changing runs doesn't change the pilot chat"*.
   *
   * The two are indistinguishable from the arguments above, which is why this
   * one is passed: only the cockpit knows whether `viewing` moved. Adoption is
   * for a run that was *started* here; opening one is a read.
   */
  opened: boolean;
  /** Whether anything is stored under `to`. */
  stored: boolean;
  /** Whether what is on screen is worth carrying. */
  holding: boolean;
}): ChatMove {
  if (args.from === args.to) return 'stay';
  // Never on the first load: `from` is null because this window has shown
  // nothing yet, and there is no exchange to have proposed anything.
  if (args.from === null) return 'restore';
  if (args.intoRun && !args.opened && args.holding && !args.stored) return 'adopt';
  return 'restore';
}
