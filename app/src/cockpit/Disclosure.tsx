import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/**
 * The one disclosure gesture, at every level it appears (#223).
 *
 * There were three spellings of this before it existed: the loop column's group
 * caret, its round caret, and the findings pane's own copy of the same glyph.
 * The three panes this file was written for would have made six. A caret is a
 * promise about what a click does, and six of them is six chances for one of
 * them to stop keeping it.
 *
 * The caret is `aria-hidden` and the button carries `aria-expanded`, so the
 * state is announced once rather than twice.
 */

export function Caret({ open }: { open: boolean }) {
  return (
    <span className="v-disclose" aria-hidden="true">
      {open ? '▾' : '▸'}
    </span>
  );
}

/**
 * A named section that opens.
 *
 * **The whole head is the control**, never a caret with a title beside it: a hit
 * target smaller than the thing it opens is the reason nobody finds it, and
 * these heads carry chips a person is reading anyway.
 *
 * `meta` is drawn whether the section is open or shut, because it is the reason
 * to open one — a round's severity counts, a commit's short sha, a plan's size.
 * Hiding the summary behind the fold hides the answer.
 */
export function Section({
  title,
  meta,
  open,
  onToggle,
  children,
  id,
  reveal = false,
}: {
  title: ReactNode;
  meta?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  /** Anchors the section so another pane can name it (#223). */
  id?: string | undefined;
  /**
   * Bring this section into view, once, when it becomes the open one.
   *
   * **Opening a section is not the same as landing on it.** A round card's
   * heading promises *"that tab, and that section expanded"*, and on a run with
   * a dozen rounds the right section can be expanded below the fold — which
   * looks exactly like a link that did nothing. Only the section a navigation
   * named gets this: a pane that scrolled to its own default would yank the view
   * every time somebody merely opened the tab.
   *
   * Guarded so it fires on the transition rather than on every render, and
   * `scrollIntoView` is called defensively because the Gallery and any future
   * non-DOM host have no layout to scroll.
   */
  reveal?: boolean;
}) {
  const ref = useRef<HTMLElement | null>(null);
  const shown = useRef(false);
  useEffect(() => {
    if (!reveal || !open) {
      shown.current = false;
      return;
    }
    if (shown.current) return;
    shown.current = true;
    ref.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [reveal, open]);

  return (
    <section className={`v-sect${open ? ' v-sect--open' : ''}`} id={id} ref={ref}>
      <button
        type="button"
        className="v-sect__head"
        onClick={onToggle}
        aria-expanded={open}
      >
        <Caret open={open} />
        <span className="v-sect__title">{title}</span>
        {meta !== undefined && <span className="v-sect__meta">{meta}</span>}
      </button>
      {open && <div className="v-sect__body">{children}</div>}
    </section>
  );
}
