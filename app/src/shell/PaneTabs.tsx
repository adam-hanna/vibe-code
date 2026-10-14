import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { SURFACE } from '../surface';

/**
 * The row of pane tabs, drawn the way this build draws its chrome (#347).
 *
 * On a desktop it is the bar it always was. On a phone (`SURFACE.compactChrome`)
 * it is the whole of the chrome above a pane: `lead` and `trail` are pinned at
 * its two ends and the tabs scroll between them. A phone draws no scrollbar
 * until somebody is already scrolling, so a row cut off at the edge said nothing
 * about the tabs past it, and three of the nine could not be found. Each edge
 * with more tabs beyond it fades instead, and the selected tab is scrolled into
 * view whenever it changes, so a tab opened from somewhere else - *open this
 * critique* - is never selected off screen.
 *
 * The scrollbar is hidden with `!` because the global rule in `theme.css` is
 * unlayered, and an unlayered rule beats every utility whatever its
 * specificity.
 */
export function PaneTabs({
  selected,
  lead,
  trail,
  children,
}: {
  /** The tab on screen, so a change can bring it into view. */
  selected: string;
  lead?: ReactNode;
  trail?: ReactNode;
  children: ReactNode;
}) {
  if (!SURFACE.compactChrome) {
    return (
      <nav
        className="flex flex-none items-stretch gap-0.5 overflow-x-auto border-b border-rule-structure bg-page px-6"
        aria-label="panes"
      >
        {children}
      </nav>
    );
  }
  return (
    <ScrollingTabs selected={selected} lead={lead} trail={trail}>
      {children}
    </ScrollingTabs>
  );
}

function ScrollingTabs({
  selected,
  lead,
  trail,
  children,
}: {
  selected: string;
  lead?: ReactNode;
  trail?: ReactNode;
  children: ReactNode;
}) {
  const row = useRef<HTMLElement>(null);
  const [more, setMore] = useState({ before: false, after: false });

  // Which edges have tabs beyond them. Measured, on a scroll and a resize, so a
  // fade is never drawn over an edge with nothing past it.
  useEffect(() => {
    const el = row.current;
    if (el === null) return;
    const measure = () => {
      const before = el.scrollLeft > 0;
      // A pixel of slack: a scaled layout can leave the last position a
      // fraction short of the width.
      const after = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setMore((m) => (m.before === before && m.after === after ? m : { before, after }));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      seen.disconnect();
    };
  }, []);

  useEffect(() => {
    row.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [selected]);

  return (
    <div className="flex flex-none items-stretch border-b border-rule-structure bg-page">
      {lead !== undefined && <div className="flex flex-none items-center pl-1">{lead}</div>}
      <div className="relative min-w-0 flex-1">
        <nav
          ref={row}
          className="flex items-stretch gap-0.5 overflow-x-auto px-1 [scrollbar-width:none]! [&::-webkit-scrollbar]:hidden"
          aria-label="panes"
        >
          {children}
        </nav>
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-y-0 left-0 w-10 bg-linear-to-r from-page to-transparent transition-opacity',
            more.before ? 'opacity-100' : 'opacity-0',
          )}
        />
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-y-0 right-0 w-10 bg-linear-to-l from-page to-transparent transition-opacity',
            more.after ? 'opacity-100' : 'opacity-0',
          )}
        />
      </div>
      {trail !== undefined && <div className="flex flex-none items-center pr-1">{trail}</div>}
    </div>
  );
}
