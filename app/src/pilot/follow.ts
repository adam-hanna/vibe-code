import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Following the bottom of a scroller, and giving it up the moment somebody
 * scrolls away from it (#211).
 *
 * The pilot pane had no autoscroll at all, so every answer arrived below the
 * fold and had to be scrolled to by hand. The naive fix - scroll to the bottom
 * whenever anything changes - is worse than none: it yanks the view down while
 * somebody is reading back through the conversation, and it destroys a
 * selection mid-drag. A chat is the most-copied surface in the product.
 *
 * So the state is **the reader's**, not the pane's. Being at the bottom is what
 * arms following; scrolling up is what disarms it; scrolling back down is what
 * arms it again. Nothing else touches it - not sending, not a turn starting,
 * not a tool card opening.
 *
 * Two things about the mechanism are worth knowing:
 *
 * - **A mutation, not a render.** A streaming reply grows *inside* the last
 *   card, so the number of cards does not change and a `useEffect` keyed on a
 *   count would fire once per turn instead of once per chunk. A
 *   `MutationObserver` over the subtree sees the text arriving, a card being
 *   added, and a disclosure being opened alike. It does not see growth with no
 *   mutation behind it - a font loading, an image decoding - and this pane has
 *   none of those, which is why this is the measurement rather than a
 *   `ResizeObserver` over a wrapper element that would have to be introduced.
 * - **The jump is instant.** A smooth scroll is still in flight when the next
 *   chunk arrives, so the position it settles at is one the reader never chose,
 *   and the `scroll` event it emits on the way would be read here as somebody
 *   scrolling.
 */

/**
 * How close to the end still counts as being at it. Sub-pixel scroll positions
 * and a partly-visible last line both mean an exact comparison reads as *not at
 * the bottom* on a pane that visibly is. 24px is the figure `OutputPane` has
 * used inline since the cockpit landed; this is a second copy of it rather than
 * a shared one, because a cockpit component importing from `pilot/` would point
 * the dependency the wrong way. If a third pane wants it, that is the moment to
 * lift the hook out of here and have all three take it from one place.
 */
export const AT_BOTTOM_PX = 24;

/** What `atBottom` needs, so it can be asked about a plain object in a test. */
export interface ScrollPosition {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/**
 * Is this scroller at its end? The whole decision, pure, because it is the part
 * that can be wrong - the plumbing around it is a listener and an observer.
 *
 * A scroller with nothing to scroll is at the bottom: it is also at the top,
 * and answering `false` would leave a short conversation not following until
 * its first overflow.
 */
export function atBottom(at: ScrollPosition, within = AT_BOTTOM_PX): boolean {
  return at.scrollHeight - at.scrollTop - at.clientHeight <= within;
}

export interface Follow<T extends HTMLElement> {
  /** Put this on the element that scrolls. */
  readonly ref: RefObject<T | null>;
  /** And this on its `onScroll`. */
  readonly onScroll: () => void;
}

/** Keep a scroller pinned to its end for as long as its reader leaves it there. */
export function useFollow<T extends HTMLElement>(): Follow<T> {
  const ref = useRef<T>(null);
  // Armed to begin with: an empty pane is at its bottom, and the first reply
  // should arrive in view without anybody having to ask for it.
  const following = useRef(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (el !== null) following.current = atBottom(el);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (el === null) return;

    const stick = (): void => {
      if (!following.current) return;
      // Assigning `scrollTop` emits a `scroll` event, which lands in `onScroll`
      // above and recomputes from the position we just moved to - the bottom -
      // so following stays armed rather than being switched off by its own
      // effect.
      el.scrollTop = el.scrollHeight;
    };

    const watch = new MutationObserver(stick);
    watch.observe(el, { childList: true, subtree: true, characterData: true });
    stick();
    return () => {
      watch.disconnect();
    };
  }, []);

  return { ref, onScroll };
}
