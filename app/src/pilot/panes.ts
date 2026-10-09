import { dirKey } from '../cockpit/projects';
import { DRAFT_PREFIX } from '../cockpit/pending';
import type { Draft } from '../cockpit/pending';
import { chatKey } from './saved';

/**
 * Which pilot panes are mounted, and which conversation each one is (#305).
 *
 * **One pane per conversation that is still doing something.** The pane holds
 * one conversation and one turn in flight, and every result it is handed lands
 * in whichever conversation it is holding when the result arrives. That was
 * safe while a window had one run and so, in practice, one conversation; with
 * two drafts in the sidebar it is not. Two briefs typed twenty seconds apart
 * both landed in the first draft's chat, the second draft kept nothing, and the
 * one reply that came back was saved nowhere - *"the pilot for each is blank"*.
 *
 * Giving each conversation its own pane makes every piece of turn state - the
 * conversation, the turn in flight, the tool chain, the save key - belong to
 * one conversation by construction, rather than by every dispatch site
 * remembering which one it meant. The pane on screen is visible; the others are
 * mounted and hidden, finishing what they started.
 *
 * Pure, because the app has no jsdom: the cockpit holds the state and asks here.
 */

/** Where a pane is pointed: the same pair `chatKey` takes. */
export interface PaneSpot {
  dir: string;
  runId: string | null;
}

/**
 * The pane a conversation lives in.
 *
 * Its own key, **except for a run that started from a draft**, which stays in
 * the draft's pane. Adoption copies the draft's conversation to the run's key,
 * and the pane follows it there in place - keeping a reply still streaming,
 * which `PilotPane`'s restore already handles. A new pane for the run's key
 * would read back the copy and leave that reply in the draft's pane, saved
 * under a key nobody will open again.
 */
export function paneOf(spot: PaneSpot, drafts: readonly Draft[]): string {
  if (spot.runId !== null) {
    const from = drafts.find((d) => d.runId === spot.runId && dirKey(d.dir) === dirKey(spot.dir));
    if (from !== undefined) return chatKey(from.dir, from.id);
  }
  return chatKey(spot.dir, spot.runId);
}

/**
 * The draft whose proposal an `invoke` from this pane starts, or null.
 *
 * Only a draft still waiting for its run: a run that started from one keeps
 * the draft's pane, and a second proposal in that conversation is a new run,
 * not the one the draft already became.
 */
export function draftOfPane(pane: string, drafts: readonly Draft[]): string | null {
  return drafts.find((d) => d.runId === null && chatKey(d.dir, d.id) === pane)?.id ?? null;
}

/** A draft's pane, by its key - `newDraft` names every draft `draft-…`. */
function isDraftPane(pane: string): boolean {
  return pane.includes(`::${DRAFT_PREFIX}`);
}

/**
 * The panes to mount, the one on screen first.
 *
 * A pane that has been on screen stays mounted while it is a **draft** - a
 * conversation somebody is in the middle of, which has no run to come back to -
 * or while it is **busy**, so a turn it opened gets its reply. Anything else is
 * let go: its conversation is saved, and opening it again restores it. A
 * discarded draft is let go even when busy.
 *
 * Only panes that have been on screen, because a pane's props are the ones it
 * had there (`known`); a draft restored at launch and never opened has nothing
 * in flight to protect.
 */
export function mountedPanes(
  shown: string,
  known: readonly string[],
  busy: ReadonlySet<string>,
  drafts: readonly Draft[],
): readonly string[] {
  const kept = new Set(drafts.map((d) => chatKey(d.dir, d.id)));
  // A draft that has been discarded is let go even mid-turn: its conversation
  // was deleted with it, and a reply saved afterwards would bring it back.
  const wanted = (p: string): boolean => kept.has(p) || (busy.has(p) && !isDraftPane(p));
  return [shown, ...known.filter((p) => p !== shown && wanted(p))];
}

/** A brief goes to the draft it was typed for, and to no other pane. */
export function askFor<T extends { id: string }>(brief: T | null, spot: PaneSpot): T | null {
  return brief !== null && brief.id === spot.runId ? brief : null;
}
