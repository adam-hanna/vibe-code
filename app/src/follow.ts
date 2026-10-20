import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/**
 * Following the bottom of a scroller, and giving it up the moment somebody
 * scrolls away from it (#211, #366).
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
 *
 * **Position alone could not disarm it while a reply streamed** (#366). It was
 * decided on each `scroll` event by `atBottom`, and two things beat it. A wheel
 * tick or a touchpad flick on WebKitGTK is a smooth scroll that moves a few
 * pixels a frame, so its first steps were still inside `AT_BOTTOM_PX` and read
 * as *at the bottom*. And a `scroll` event lands a frame after the move, while
 * a chunk can arrive in between: the observer saw `following` still set and
 * put the view back at the end, which also cancelled the smooth scroll. With a
 * chunk every frame the reader could not get out: *"scrolling up while a reply
 * streams is pulled back to the bottom"*.
 *
 * So it is disarmed by the reader's **intent**, which arrives before the move:
 * a wheel or a finger moving the content down, PageUp, ArrowUp, Home or
 * shift-space, or a press on the scrollbar. Backing that, a `scroll` that moved
 * up while the content did not shrink disarms at any distance, with no
 * threshold. It is armed again only by **arriving** at the bottom, which means
 * moving down to it, or by the jump button the panes draw while it is off.
 * `nextFollow` is the decision, pure; the hook is listeners around it.
 *
 * It is shared by the pilot's log and the run output, which had a second copy
 * of the same 24px rule and the same defect.
 */

/**
 * How close to the end still counts as being at it, for **arming** only.
 * Sub-pixel scroll positions and a partly-visible last line both mean an exact
 * comparison reads as *not at the bottom* on a pane that visibly is. 24px is
 * the figure `OutputPane` used inline since the cockpit landed. It no longer
 * decides disarming: a move up of any size does that (#366).
 */
export const AT_BOTTOM_PX = 24;

/** What `atBottom` needs, so it can be asked about a plain object in a test. */
export interface ScrollPosition {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/**
 * Is this scroller at its end?
 *
 * A scroller with nothing to scroll is at the bottom: it is also at the top,
 * and answering `false` would leave a short conversation not following until
 * its first overflow.
 */
export function atBottom(at: ScrollPosition, within = AT_BOTTOM_PX): boolean {
  return at.scrollHeight - at.scrollTop - at.clientHeight <= within;
}

/** Whether the view follows the end, and where the last `scroll` left it. */
export interface FollowState {
  readonly following: boolean;
  readonly top: number;
  readonly height: number;
}

/** Armed, at the top of nothing: an empty pane is at its bottom. */
export const START: FollowState = { following: true, top: 0, height: 0 };

/**
 * What can change following. `up` is the reader's intent to move the content
 * down (see the intent helpers below); `scroll` is a `scroll` event, the
 * reader's or the hook's own; `jump` is the button that goes back to the end.
 */
export type FollowInput =
  | { readonly kind: 'up' }
  | { readonly kind: 'scroll'; readonly at: ScrollPosition }
  | { readonly kind: 'jump' };

/**
 * The whole decision, pure, because it is the part that can be wrong.
 *
 * - `up` disarms at once, before the move it announces.
 * - A `scroll` that moved up disarms, at any distance, unless the content got
 *   shorter: a scroller clamps `scrollTop` when its content shrinks (a card
 *   folding, a streamed text replaced by its final one), and that is not the
 *   reader.
 * - A `scroll` that moved down and ends at the bottom arms. That is a reader
 *   arriving there, and it is also the hook's own jump to the end, which
 *   therefore never disarms anything. One that did not move changes nothing,
 *   so an upward intent outlives the stick's own late event.
 * - Anything else leaves following as it was.
 */
export function nextFollow(state: FollowState, input: FollowInput): FollowState {
  if (input.kind === 'up') return { ...state, following: false };
  if (input.kind === 'jump') return { ...state, following: true };
  const { at } = input;
  const movedUp = at.scrollTop < state.top;
  const movedDown = at.scrollTop > state.top;
  const shrank = at.scrollHeight < state.height;
  let following = state.following;
  if (movedUp && !shrank) following = false;
  // Staying put keeps an armed view armed; it never re-arms a disarmed one.
  // The stick's own `scroll` event can land after an upward intent and before
  // the reader's move, still at the end and not moved, and reading that as
  // arriving undid the intent (review of #384). Only a move down arrives.
  else if (movedDown && atBottom(at)) following = true;
  return { following, top: at.scrollTop, height: at.scrollHeight };
}

/**
 * Where the hook's own move to the end left the view, recorded at once.
 *
 * `nextFollow` compares each `scroll` with the position the last one left, and
 * a `scroll` event lands a frame after the move it reports. So when `stick`
 * moved the view (826 -> 856, say) and the reader's wheel disarmed and moved
 * it back to 853 before that event ran, the baseline was still 826, 853 read
 * as a move down near the end, and following re-armed: the pull back to the
 * bottom #366 is about, through a narrower gap (review of #384). Recording the
 * position the hook itself set makes the baseline the true one. Following is
 * left alone: a stick only runs while armed and never decides anything.
 */
export function stuck(state: FollowState, at: ScrollPosition): FollowState {
  return { ...state, top: at.scrollTop, height: at.scrollHeight };
}

/** A wheel that moves the content down, which is scrolling up. */
export function wheelUp(deltaY: number): boolean {
  return deltaY < 0;
}

/** A key that scrolls up. Never from a field: typing there is not reading. */
export function keyUp(key: string, shift: boolean, editable: boolean): boolean {
  if (editable) return false;
  return key === 'PageUp' || key === 'ArrowUp' || key === 'Home' || (key === ' ' && shift);
}

/** A finger moving down the screen drags the content down, which is scrolling up. */
export function touchUp(fromY: number, toY: number): boolean {
  return toY > fromY;
}

/**
 * A press on a classic scrollbar: past the content box, which `clientWidth`
 * ends at. An overlay scrollbar takes no width and is never matched, so a tap
 * on the padding is not read as a drag.
 */
export function onScrollbar(offsetX: number, clientWidth: number): boolean {
  return offsetX >= clientWidth;
}

export interface Follow<T extends HTMLElement> {
  /** Put this on the element that scrolls. */
  readonly ref: RefObject<T | null>;
  /** And this on its `onScroll`. */
  readonly onScroll: () => void;
  /** Whether the view is following the end. False is when to draw the jump button. */
  readonly following: boolean;
  /** Go to the end and follow it again: the jump button's action. */
  readonly jump: () => void;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

/** Keep a scroller pinned to its end for as long as its reader leaves it there. */
export function useFollow<T extends HTMLElement>(enabled = true): Follow<T> {
  const ref = useRef<T>(null);
  const state = useRef<FollowState>(START);
  // A copy for drawing, set only when following changes, so a stream of
  // scroll events does not re-render the pane.
  const [following, setFollowing] = useState(true);

  const apply = useCallback((input: FollowInput) => {
    const next = nextFollow(state.current, input);
    state.current = next;
    setFollowing((was) => (was === next.following ? was : next.following));
  }, []);

  const onScroll = useCallback(() => {
    if (!enabled) return;
    const el = ref.current;
    if (el !== null) apply({ kind: 'scroll', at: el });
  }, [enabled, apply]);

  const jump = useCallback(() => {
    apply({ kind: 'jump' });
    const el = ref.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
    state.current = stuck(state.current, el);
  }, [apply]);

  useEffect(() => {
    // The welcome is a document to read from its beginning, not the end of a
    // conversation. Start observing only once there is a real log to follow.
    if (!enabled) {
      // There is no log yet. Scrolling the welcome must not disarm the first
      // reply of a new conversation; later replies still respect the reader.
      state.current = START;
      setFollowing(true);
      return;
    }
    const el = ref.current;
    if (el === null) return;

    const stick = (): void => {
      if (!state.current.following) return;
      // Assigning `scrollTop` emits a `scroll` event, which `nextFollow` reads
      // as arriving at the bottom, so following stays armed rather than being
      // switched off by its own effect.
      el.scrollTop = el.scrollHeight;
      // Before its `scroll` event runs, an upward intent can arrive: compare
      // that event with where this left the view, not where the last one did.
      state.current = stuck(state.current, el);
    };

    // Intent arrives before the move, which is what beats the next chunk.
    let touchY: number | null = null;
    const wheel = (e: WheelEvent): void => {
      if (wheelUp(e.deltaY)) apply({ kind: 'up' });
    };
    const key = (e: KeyboardEvent): void => {
      if (keyUp(e.key, e.shiftKey, isEditable(e.target))) apply({ kind: 'up' });
    };
    const touchStart = (e: TouchEvent): void => {
      touchY = e.touches[0]?.clientY ?? null;
    };
    const touchMove = (e: TouchEvent): void => {
      const y = e.touches[0]?.clientY;
      if (touchY !== null && y !== undefined && touchUp(touchY, y)) apply({ kind: 'up' });
      touchY = y ?? touchY;
    };
    const press = (e: PointerEvent): void => {
      if (e.target === el && onScrollbar(e.offsetX, el.clientWidth)) apply({ kind: 'up' });
    };

    el.addEventListener('wheel', wheel, { passive: true });
    el.addEventListener('keydown', key);
    el.addEventListener('touchstart', touchStart, { passive: true });
    el.addEventListener('touchmove', touchMove, { passive: true });
    el.addEventListener('pointerdown', press);
    const watch = new MutationObserver(stick);
    watch.observe(el, { childList: true, subtree: true, characterData: true });
    stick();
    return () => {
      watch.disconnect();
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('keydown', key);
      el.removeEventListener('touchstart', touchStart);
      el.removeEventListener('touchmove', touchMove);
      el.removeEventListener('pointerdown', press);
    };
  }, [enabled, apply]);

  return { ref, onScroll, following, jump };
}
