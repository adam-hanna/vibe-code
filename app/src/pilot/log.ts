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
export function logOf(run: Run, replies: readonly Reply[]): Entry[] {
  return interleave(rounds(run), replies);
}
