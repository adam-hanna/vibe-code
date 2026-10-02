import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react';

/**
 * A column that can be put away without being lost (#223).
 *
 * **Both of the cockpit's side columns are one thing, so they are one
 * component.** The runs pane and the loop column sit on opposite sides of the
 * main pane and do the same job — standing context you glance at rather than
 * work in — and two implementations of that would drift in exactly the way
 * nobody notices, because you are never looking at both edges at once.
 *
 * ## Collapsed is a state, not an absence
 *
 * The requirement was stated precisely: *"when collapsed, it shouldn't disappear
 * — just collapsed, and use small icons"*. That is the difference between a
 * layout you can put back and one you have to remember exists. A shut panel
 * keeps its strip, its mark and its name, so the way back is in the same place
 * the panel was, and the main pane's width changes rather than the window's
 * structure.
 *
 * The mark is two characters, for the reason `squares.ts` gives about the rail:
 * at this width anything longer is truncated, and a truncated word is a worse
 * label than a chosen abbreviation.
 *
 * ## Both start open, and nothing remembers otherwise
 *
 * Deliberately not persisted. A collapse is a thing you do for the next few
 * minutes — to read a diff, to look at a plan — and a window that opened three
 * days later still folded up would be answering a question nobody asked twice.
 * `localStorage` holds the repository and the pilot's spend ceiling because both
 * are decisions; this is a gesture.
 *
 * ## The width is dragged, and that one is remembered
 *
 * *"The two side bars (left and right) should be width adjustable when open."*
 * The inner edge of an open panel is a handle: drag it, or focus it and use the
 * arrow keys, and double-click puts the design's width back. **This one is
 * kept**, per edge, and the line between it and the collapse is the one drawn
 * above: how wide you like the runs column is a preference you set once, like
 * the type scale, where a collapse is for the next few minutes. The bounds are
 * truncations rather than measurements — wide enough that a row's controls fit,
 * and never more than half the window, so the main pane cannot be squeezed out.
 */

/** The design's width, and what a double-click on the handle goes back to. */
export const SIDE_DEFAULT = 364;
const SIDE_MIN = 240;
const SIDE_MAX = 720;
/** How far one arrow key moves the edge. */
const SIDE_STEP = 16;
const widthKey = (side: 'left' | 'right'): string => `vibe.side.${side}.width`;

/** A width the panel may take in a window `viewport` pixels wide. */
export function clampWidth(px: number, viewport: number): number {
  if (!Number.isFinite(px)) return SIDE_DEFAULT;
  const ceiling = Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.floor(viewport / 2)));
  return Math.round(Math.min(ceiling, Math.max(SIDE_MIN, px)));
}

/** A stored width, or the default when there is none or it is not a number. */
export function readWidth(raw: string | null): number {
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : SIDE_DEFAULT;
}

/** The width state for one edge, read once and written on every change. */
function useSideWidth(side: 'left' | 'right'): [number, (next: number) => void] {
  const [width, setWidth] = useState(() => {
    try {
      return clampWidth(readWidth(localStorage.getItem(widthKey(side))), window.innerWidth);
    } catch {
      return SIDE_DEFAULT;
    }
  });
  const set = useCallback(
    (next: number) => {
      const clamped = clampWidth(next, window.innerWidth);
      setWidth(clamped);
      try {
        localStorage.setItem(widthKey(side), String(clamped));
      } catch {
        // Kept for this session; it will not be back next time.
      }
    },
    [side],
  );
  // A window made narrower must not leave a panel wider than half of it.
  useEffect(() => {
    const fit = (): void => setWidth((w) => clampWidth(w, window.innerWidth));
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  return [width, set];
}
export function SidePanel({
  side,
  title,
  mark,
  open,
  onToggle,
  shut,
  children,
}: {
  /** Which edge it is pinned to. Decides which way the chevrons point. */
  side: 'left' | 'right';
  /** The panel's name, shown open and shut. */
  title: string;
  /** Two characters for the shut strip. */
  mark: string;
  open: boolean;
  onToggle: () => void;
  /**
   * What the shut strip carries below the expand control, if anything.
   *
   * **This is how the rail survived being merged into the sidebar.**
   * `design/AUDIT.md` §1.1's finding was never *"there should be a strip"* — it
   * was that `＋ ⌘K ⚙` had nowhere to live and ended up in the tab bar. A panel
   * that shut them away would put the finding back, so the left sidebar passes
   * them here and they stay on screen at every width.
   */
  shut?: ReactNode;
  children: ReactNode;
}) {
  // Toward the edge it is pinned to when open — the direction it will go — and
  // back toward the middle when shut. A chevron that means "collapse" and
  // "expand" with the same glyph is the one thing this control must not do.
  const away = side === 'left' ? '‹' : '›';
  const back = side === 'left' ? '›' : '‹';
  const [width, setWidth] = useSideWidth(side);
  /** Where a drag started: the pointer's x and the width at that moment. */
  const drag = useRef<{ x: number; width: number } | null>(null);
  // Dragging toward the main pane widens the panel, so the sign depends on the
  // edge it is pinned to.
  const toward = side === 'left' ? 1 : -1;
  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, width };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const at = drag.current;
    if (at === null) return;
    setWidth(at.width + toward * (e.clientX - at.x));
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const right = e.key === 'ArrowRight' ? 1 : -1;
    setWidth(width + (side === 'left' ? right : -right) * SIDE_STEP);
  };

  if (!open) {
    return (
      <aside
        className={`v-side v-side--${side} v-side--shut${shut === undefined ? '' : ' v-side--tools'}`}
        aria-label={title}
      >
        <button
          className="v-side__grip"
          onClick={onToggle}
          aria-expanded={false}
          aria-label={`Show ${title}`}
          title={`Show ${title}`}
        >
          <span className="v-side__chev">{back}</span>
          <span className="v-side__mark">{mark}</span>
          {/* Rotated rather than one letter per line: a name read down the strip
              is still the name, where a stack of letters is a puzzle. Dropped
              when the strip carries controls, which need the room and say what
              the panel is by being the panel's own controls. */}
          {shut === undefined && <span className="v-side__vertical">{title}</span>}
        </button>
        {shut !== undefined && <div className="v-side__stub">{shut}</div>}
      </aside>
    );
  }

  return (
    <aside className={`v-side v-side--${side}`} aria-label={title} style={{ width }}>
      <div
        className="v-side__resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${title}`}
        aria-valuenow={width}
        aria-valuemin={SIDE_MIN}
        aria-valuemax={SIDE_MAX}
        tabIndex={0}
        title="Drag to resize · double-click for the default width"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => setWidth(SIDE_DEFAULT)}
        onKeyDown={onKeyDown}
      />
      <header className="v-side__head">
        <span className="v-side__title">{title}</span>
        <button
          className="v-side__toggle"
          onClick={onToggle}
          aria-expanded
          aria-label={`Hide ${title}`}
          title={`Hide ${title}`}
        >
          {away}
        </button>
      </header>
      {/* A column that gives its child the height, so a pane inside can pin a
          footer and scroll the rest — which is what the loop column does. */}
      <div className="v-side__body">{children}</div>
    </aside>
  );
}
