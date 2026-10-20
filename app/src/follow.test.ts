import { describe, expect, test } from 'vitest';
import { AT_BOTTOM_PX, START, atBottom, keyUp, nextFollow, onScrollbar, stuck, touchUp, wheelUp } from './follow';
import type { FollowState } from './follow';

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

/**
 * When following is armed and disarmed (#366).
 *
 * The defect: while a reply streamed, a scroll up of a few pixels was still
 * "at the bottom" by `atBottom`'s 24px, so the next chunk pulled the view back
 * and the reader could not get out. The decision is now `nextFollow`, and these
 * are the issue's done-when as pure cases: an upward intent disarms, arriving
 * at the bottom arms, and a programmatic stick never disarms.
 */
describe('when the view follows the end', () => {
  const scroll = (scrollTop: number, scrollHeight = 1000, clientHeight = 400) =>
    ({ kind: 'scroll', at: { scrollTop, scrollHeight, clientHeight } }) as const;
  const following = (top = 600, height = 1000): FollowState => ({ following: true, top, height });

  test('an upward intent disarms at once, before any scroll arrives', () => {
    expect(nextFollow(following(), { kind: 'up' }).following).toBe(false);
  });

  test('a scroll up of a few pixels disarms, though it is still inside the band', () => {
    // The reported defect: 3px up is within AT_BOTTOM_PX of the end, and used
    // to read as at the bottom, so the next chunk put the view back.
    const next = nextFollow(following(600, 1000), scroll(597, 1010));
    expect(atBottom({ scrollTop: 597, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(next.following).toBe(false);
  });

  test('the hook sticking to the end never disarms it', () => {
    // Content grew by 50px and the observer assigned scrollTop = scrollHeight.
    const next = nextFollow(following(600, 1000), scroll(650, 1050));
    expect(next.following).toBe(true);
  });

  test('once disarmed, content arriving below does not re-arm it', () => {
    let s = nextFollow(following(), { kind: 'up' });
    s = nextFollow(s, scroll(300, 1000));
    // The stream grows the content; the reader's scrollTop stays where it was.
    expect(s.following).toBe(false);
    expect(nextFollow(s, scroll(300, 1400)).following).toBe(false);
  });

  test('scrolling back down to the end arms it again', () => {
    let s = nextFollow(following(), { kind: 'up' });
    s = nextFollow(s, scroll(300, 1000));
    s = nextFollow(s, scroll(590, 1000));
    expect(s.following).toBe(true);
  });

  test('scrolling up into the band from above does not arm it', () => {
    // Arriving means moving down or staying put; a move up that ends near the
    // end is still a move up.
    const s: FollowState = { following: false, top: 610, height: 1000 };
    expect(nextFollow(s, scroll(590, 1000)).following).toBe(false);
  });

  test('a scroll the browser made because the content shrank does not disarm', () => {
    // A card folding clamps scrollTop down; that is not the reader.
    const next = nextFollow(following(600, 1000), scroll(500, 900));
    expect(next.following).toBe(true);
  });

  test('the jump button arms it', () => {
    const s: FollowState = { following: false, top: 100, height: 1000 };
    expect(nextFollow(s, { kind: 'jump' }).following).toBe(true);
  });

  test('an upward intent survives a scroll event still pending from the hook\'s own stick', () => {
    // The review finding on #384: a chunk grew the content and the observer
    // moved scrollTop 826 -> 856, but that move's scroll event had not run
    // when the reader's wheel disarmed and moved the view back to 853. With
    // the last scroll event's 826 as the baseline, 853 read as a move DOWN
    // near the end and re-armed, and the next chunk pulled the reader back.
    let s = following(826, 1226);
    s = stuck(s, at(856, 1256));
    s = nextFollow(s, { kind: 'up' });
    s = nextFollow(s, scroll(853, 1256));
    expect(s.following).toBe(false);
    // And a later chunk arriving below keeps it off.
    expect(nextFollow(s, scroll(853, 1300)).following).toBe(false);
  });

  test("the stick's own late scroll event does not undo an upward intent", () => {
    // The other order: the wheel disarms before the reader's move has begun,
    // and the stick's pending event arrives first, still at 856 - at the end,
    // and not moved. Staying put re-arms only a view that was already armed;
    // a disarmed one needs a real move down to the end.
    let s = stuck(following(826, 1226), at(856, 1256));
    s = nextFollow(s, { kind: 'up' });
    s = nextFollow(s, scroll(856, 1256));
    expect(s.following).toBe(false);
    s = nextFollow(s, scroll(853, 1256));
    expect(s.following).toBe(false);
    // Coming back down to the end is still how it re-arms.
    expect(nextFollow(s, scroll(856, 1256)).following).toBe(true);
  });

  test('a stick records where it left the view and changes nothing else', () => {
    expect(stuck(following(826, 1226), at(856, 1256))).toEqual({ following: true, top: 856, height: 1256 });
    const off: FollowState = { following: false, top: 100, height: 1000 };
    expect(stuck(off, at(600, 1000)).following).toBe(false);
  });

  test('a fresh pane starts armed', () => {
    expect(START.following).toBe(true);
  });
});

describe("what counts as the reader's intent to scroll up", () => {
  test('a wheel moving the content down', () => {
    expect(wheelUp(-3)).toBe(true);
    expect(wheelUp(3)).toBe(false);
    expect(wheelUp(0)).toBe(false);
  });

  test('the keys that scroll up, never from a field', () => {
    for (const key of ['PageUp', 'ArrowUp', 'Home']) expect(keyUp(key, false, false)).toBe(true);
    expect(keyUp(' ', true, false)).toBe(true);
    expect(keyUp(' ', false, false)).toBe(false);
    expect(keyUp('ArrowDown', false, false)).toBe(false);
    expect(keyUp('ArrowUp', false, true)).toBe(false);
  });

  test('a finger moving down the screen', () => {
    expect(touchUp(100, 140)).toBe(true);
    expect(touchUp(140, 100)).toBe(false);
    expect(touchUp(100, 100)).toBe(false);
  });

  test('a press on a classic scrollbar, and not on the padding', () => {
    expect(onScrollbar(600, 594)).toBe(true);
    expect(onScrollbar(20, 594)).toBe(false);
  });
});
