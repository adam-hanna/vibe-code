import { rounds } from '../cockpit/rounds';
import type { RoundCard } from '../cockpit/rounds';
import type { Run } from '../cockpit/model';
import type { Reply } from './transcript';

/**
 * The run's log: rounds and conversation in one scroll (hi-fi 5, #223).
 *
 * The design's first tab is not a chat beside a run — it is the run's log, with
 * *"what you said"* and *"what the pilot said back"* interleaved among the cards
 * each round leaves behind. Two lists arrive from two places, so the ordering has
 * to be decided somewhere, and it is decided here rather than in the component:
 * this is the one part with a rule in it, and a rule that is only in a `.map`
 * cannot be tested.
 *
 * ## The conversation's order is never rearranged
 *
 * Replies come out in exactly the order they went in. That is not a convenience —
 * a `Reply.startedAt` is `number | null`, because a reply drawn by a build older
 * than that field has no start time, and sorting a mixed list by a key half of it
 * lacks would silently reorder a conversation. So replies hold their sequence and
 * **cards are placed among them**, which is the direction where a missing
 * timestamp costs nothing: a card with nowhere obvious to go lands at the end,
 * where the newest thing belongs anyway.
 */

export type Entry =
  | { kind: 'round'; card: RoundCard }
  | { kind: 'reply'; reply: Reply };

/**
 * Merge a run's rounds into a conversation, oldest first.
 *
 * A card is emitted before the first reply that was opened after it. A reply with
 * no start time is passed through untouched and holds nothing back: it cannot say
 * whether a card belongs above or below it, so it declines to decide rather than
 * guessing, and the card is placed by the next reply that *can* say.
 */
export function interleave(cards: readonly RoundCard[], replies: readonly Reply[]): Entry[] {
  const out: Entry[] = [];
  let next = 0;
  for (const reply of replies) {
    if (reply.startedAt !== null) {
      while (next < cards.length) {
        const card = cards[next];
        if (card === undefined || card.startedAt > reply.startedAt) break;
        out.push({ kind: 'round', card });
        next += 1;
      }
    }
    out.push({ kind: 'reply', reply });
  }
  for (; next < cards.length; next += 1) {
    const card = cards[next];
    if (card !== undefined) out.push({ kind: 'round', card });
  }
  return out;
}

/** The whole log for a run and a conversation. The pane's one call. */
export function logOf(run: Run | null, replies: readonly Reply[]): Entry[] {
  return interleave(run === null ? [] : rounds(run), replies);
}

/** What `chatRun` is told: which conversation is shown, and the runs it could be about. */
export interface ChatRunArgs {
  /** The conversation's run id: `pilotRunId`. Null is the project's pre-run chat. */
  runId: string | null;
  /** The conversation is a draft's, keyed by its `draft-…` id. */
  drafting: boolean;
  /** A launch is holding the chat that proposed it until the run has an id (`holdChat`). */
  holding: boolean;
  /** The run this window is narrating. */
  live: Run;
  /** An opened past run: its id, and its replay once it has loaded. */
  opened: { runId: string; run: Run | null } | null;
}

/**
 * The run a conversation is about, whose rounds go in its log (#247).
 *
 * The pane was handed the live run whatever conversation was on screen, so the
 * live run's cards were placed into every chat: an opened past run's, a draft's,
 * another project's - *"showing up in EVERY run pilot chat, not just the run
 * that it's running in"*. The conversation followed `pilotRunId` and the cards
 * followed `run`, which is two answers to *which run is this*.
 *
 * - **A launch being held** is the live run's: the chat on screen proposed the
 *   run that is starting, and its rounds are about to be adopted with it.
 * - **A draft or a project's pre-run chat** is about no run yet, so its log is
 *   the conversation alone.
 * - **The live run's own chat** gets the live run.
 * - **An opened past run's chat** gets its replay - the same `Run` the column
 *   draws - and nothing while that is still loading, rather than another run's
 *   cards in the meantime.
 *
 * Only the log moves. What the pilot's tools act on stays the live run, because
 * a proposal from any chat still addresses the loop that is running.
 */
export function chatRun(args: ChatRunArgs): Run | null {
  if (args.holding) return args.live;
  if (args.drafting || args.runId === null) return null;
  if (args.runId === args.live.identity?.runId) return args.live;
  if (args.opened !== null && args.runId === args.opened.runId) return args.opened.run;
  return null;
}
