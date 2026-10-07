import { Group, Panel, Separator } from 'react-resizable-panels';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * The dockable panels, over `react-resizable-panels` v4.
 *
 * `Group` and `Panel` pass straight through; what this file adds is the
 * **separator**: a 1px rule with an 8px hit area either side of it, so the
 * line the design draws and the handle a hand can find are not in conflict -
 * the same trade `--dim-scroll-track` makes for the scrollbar. The accent on
 * hover is the only hint, because a permanently drawn grip is structure.
 *
 * Sizes and collapsed states are the caller's, kept in `where.ts`.
 */
export const ResizableGroup = Group;
export const ResizablePanel = Panel;

export function ResizableSeparator({
  className,
  orientation,
  ...props
}: ComponentProps<typeof Separator> & { orientation: 'horizontal' | 'vertical' }) {
  // In a horizontal group the separator is a vertical line, and vice versa.
  const vertical = orientation === 'horizontal';
  return (
    <Separator
      className={cn(
        'relative shrink-0 bg-rule-structure outline-none transition-colors hover:bg-accent-border focus-visible:bg-accent-border data-[resize-handle-active]:bg-accent-border',
        vertical
          ? 'w-px cursor-col-resize after:absolute after:inset-y-0 after:-left-1 after:w-2'
          : 'h-px cursor-row-resize after:absolute after:inset-x-0 after:-top-1 after:h-2',
        className,
      )}
      {...props}
    />
  );
}
