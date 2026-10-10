import { PanelLeft, Plus, Search, Settings } from 'lucide-react';
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { VibeMark } from '../design/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * The strip of icons down the left edge, VS Code's shape.
 *
 * It replaces the 54px rail and the sidebar's shut strip, and what it must
 * keep from both is `＋ ⌘K ⚙`: `design/AUDIT.md` §1.1's finding was never
 * *"there should be a strip"*, it was that those three had nowhere to live.
 * Here they have a permanent home at every width, and the sidebar can be put
 * away without taking them with it.
 *
 * Every control is an icon with a tooltip and an `aria-label`, because an icon
 * alone is a guess.
 */
export function ActivityBar({
  sidebarOpen,
  onSidebar,
  onNew,
  onPalette,
  onSettings,
  paletteChord,
  update,
}: {
  sidebarOpen: boolean;
  onSidebar: () => void;
  onNew: () => void;
  onPalette: () => void;
  onSettings: () => void;
  /** `⌘K` or `Ctrl+K`, for the tooltip. */
  paletteChord: string;
  /**
   * The ⬆ tool and its popover, directly above ⚙ (#299) - passed only while a
   * newer, unskipped version exists, so the foot reads `＋ ⌘K ⬆ ⚙` then and
   * `＋ ⌘K ⚙` the rest of the time.
   */
  update?: ReactNode;
}) {
  return (
    <nav
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-rule-structure bg-chrome py-2"
      aria-label="Activity"
    >
      <div className="mb-2 flex size-8 items-center justify-center text-accent" aria-hidden>
        <VibeMark />
      </div>
      <Tool label="Explorer: runs and projects" on={sidebarOpen} onClick={onSidebar}>
        <PanelLeft className="size-5" aria-hidden />
      </Tool>
      <Tool label="New run" onClick={onNew}>
        <Plus className="size-5" aria-hidden />
      </Tool>
      <Tool label={`Find a run or action (${paletteChord})`} onClick={onPalette}>
        <Search className="size-5" aria-hidden />
      </Tool>
      <div className="flex-1" />
      {update}
      <Tool label="Settings for all projects" onClick={onSettings}>
        <Settings className="size-5" aria-hidden />
      </Tool>
    </nav>
  );
}

/**
 * One icon in the strip. Exported, and forwarding its ref and any other button
 * props, so a popover's trigger can be a `Tool` (#299): Radix's `asChild` hands
 * the trigger its click handler, ref and `aria-*`, and they have to land on the
 * button itself. `onClick` is therefore optional - a trigger supplies none.
 */
export const Tool = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
    label: string;
    on?: boolean;
    children: ReactNode;
  }
>(function Tool({ label, on = false, className, children, ...rest }, ref) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={ref}
          type="button"
          aria-label={label}
          aria-pressed={on}
          {...rest}
          className={cn(
            'relative flex size-10 cursor-pointer items-center justify-center rounded-sm border border-transparent bg-transparent text-tertiary outline-none transition-colors hover:text-emphasis focus-visible:ring-1 focus-visible:ring-accent-border',
            // The active mark is a 2px bar on the outer edge, VS Code's own cue.
            on && 'text-emphasis before:absolute before:inset-y-2 before:-left-2 before:w-0.5 before:rounded-r before:bg-accent',
            className,
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
});
