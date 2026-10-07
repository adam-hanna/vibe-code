import { describe, expect, test } from 'vitest';
import { AT_BOTTOM_PX, atBottom } from './follow';

/**
 * Whether a scroller counts as being at its end (#211).
 *
 * This is the whole of the decision behind the pilot's autoscroll, and it is
 * pure for that reason: the hook around it is a `scroll` listener and a
 * `MutationObserver`, and what could actually be *wrong* is the arithmetic.
 * There is no DOM in this suite to test the other half against.
 *
 * The thing every case here is really about: **following is armed by where the
 * reader is, and by nothing else.** A new reply does not re-arm it, sending
 * does not re-arm it, and a turn ending does not re-arm it - so if this
 * predicate says yes when the reader has scrolled up, the pane yanks the view
 * away from something somebody is reading or selecting.
 */

const at = (scrollTop: number, scrollHeight = 1000, clientHeight = 400) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe('when a scroller counts as being at its end', () => {
  test('parked at the bottom is at the bottom', () => {
    expect(atBottom(at(600))).toBe(true);
  });

  test('scrolled up is not, and that is what disarms following', () => {
    expect(atBottom(at(0))).toBe(false);
    expect(atBottom(at(300))).toBe(false);
  });

  test('a hair off the end still counts', () => {
    // Sub-pixel scroll positions and a partly-visible last line both leave a
    // pane that is visibly at its end a few pixels short of exactly at it. An
    // exact comparison would drop following the first time either happened,
    // and it would look like the autoscroll simply stopped working.
    expect(atBottom(at(600 - AT_BOTTOM_PX))).toBe(true);
    expect(atBottom(at(600 - AT_BOTTOM_PX - 1))).toBe(false);
  });

  test('nothing to scroll is at the bottom rather than not at it', () => {
    // A short conversation is at its top and its bottom at once. Answering
    // `false` would leave a fresh pane not following until the first message
    // long enough to overflow it - which is exactly the case where somebody is
    // most likely to conclude the feature does not work.
    expect(atBottom(at(0, 400, 400))).toBe(true);
    expect(atBottom(at(0, 0, 0))).toBe(true);
  });

  test('a scroller taller than its content is not read as scrolled up', () => {
    // `scrollHeight < clientHeight` should not happen, but a negative distance
    // must not come out as a large positive one somewhere. It is past the end,
    // which is at the end.
    expect(atBottom(at(0, 100, 400))).toBe(true);
  });
});
