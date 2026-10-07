import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

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
  // `ch` rather than a pixel width so the two glyphs occupy exactly the same
  // space and a section does not shift sideways when it opens.
  return (
    <span className="inline-block w-[1.2ch] flex-none text-tertiary" aria-hidden="true">
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

  // `flex-none` is what makes an opened section scrollable, and the reason is
  // the clipped overflow beside it: a flex item's automatic minimum size resolves
  // to zero when `overflow` is anything but `visible`, so a section holding a
  // nine-page plan shrank to whatever height was left and the pane never
  // scrolled. The clip stays - it is what keeps the head's hover ground inside
  // the border - and this says the section keeps its content height regardless.
  return (
    <section className="flex-none overflow-clip rounded-md border border-rule-card bg-card" id={id} ref={ref}>
      <button
        type="button"
        className={cn(
          'flex w-full cursor-pointer items-center gap-2 border-0 bg-chrome px-4 py-3.5 text-left text-inherit outline-none hover:bg-active-hdr focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent',
          open && 'border-b border-rule-inner',
        )}
        onClick={onToggle}
        aria-expanded={open}
      >
        <Caret open={open} />
        <span className="text-body-sm font-semibold text-emphasis">{title}</span>
        {/* `auto` margin rather than `space-between` on the parent: the row is
            three children and spreading them would push the caret away from the
            title it opens. */}
        {meta !== undefined && (
          <span className="ml-auto flex flex-wrap items-center justify-end gap-2">{meta}</span>
        )}
      </button>
      {open && <div className="flex flex-col gap-3 p-4.5">{children}</div>}
    </section>
  );
}
