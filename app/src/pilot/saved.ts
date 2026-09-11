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
