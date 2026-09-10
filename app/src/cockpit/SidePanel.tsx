import type { ReactNode } from 'react';

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
 */
export function SidePanel({
  side,
  title,
  mark,
  open,
  onToggle,
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
  children: ReactNode;
}) {
  // Toward the edge it is pinned to when open — the direction it will go — and
  // back toward the middle when shut. A chevron that means "collapse" and
  // "expand" with the same glyph is the one thing this control must not do.
  const away = side === 'left' ? '‹' : '›';
  const back = side === 'left' ? '›' : '‹';

  if (!open) {
    return (
      <aside className={`v-side v-side--${side} v-side--shut`}>
        <button
          className="v-side__grip"
          onClick={onToggle}
          aria-expanded={false}
          title={`Show ${title}`}
        >
          <span className="v-side__chev">{back}</span>
          <span className="v-side__mark">{mark}</span>
          {/* Rotated rather than one letter per line: a name read down the strip
              is still the name, where a stack of letters is a puzzle. */}
          <span className="v-side__vertical">{title}</span>
        </button>
      </aside>
    );
  }

  return (
    <aside className={`v-side v-side--${side}`}>
      <header className="v-side__head">
        <span className="v-side__title">{title}</span>
        <button
          className="v-side__toggle"
          onClick={onToggle}
          aria-expanded
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
