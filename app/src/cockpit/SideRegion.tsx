import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { SURFACE } from '../surface';
import { ResizablePanel, ResizableSeparator } from '../ui/resizable';

/**
 * One of the two side columns, drawn the way this build draws them (#347).
 *
 * On a desktop it is a resizable panel in the shell's row, exactly as before.
 * On a phone (`SURFACE.overlayPanels`) it is a sheet over the main pane: the
 * row is too narrow for three columns - the two side minimums alone are wider
 * than a phone - so sharing it squeezed the main pane to a sliver and could
 * leave a panel unable to open at all. A shut sheet is not drawn; a press on
 * the scrim shuts it, the way it was opened is the way back, and the cockpit
 * keeps only one open at a time.
 *
 * The sheet is positioned against the shell's row, so the activity bar and the
 * status bar stay reachable while it is open.
 */
export function SideRegion({
  side,
  open,
  onShut,
  label,
  className,
  children,
  ...panel
}: ComponentProps<typeof ResizablePanel> & {
  side: 'left' | 'right';
  open: boolean;
  onShut: () => void;
  label: string;
  children: ReactNode;
}) {
  if (!SURFACE.overlayPanels) {
    return (
      <ResizablePanel className={className} {...panel}>
        {children}
      </ResizablePanel>
    );
  }
  if (!open) return null;
  return (
    <>
      <div className="absolute inset-0 z-30 bg-page/60" aria-hidden="true" onClick={onShut} />
      <aside
        aria-label={label}
        className={cn(
          className,
          'absolute inset-y-0 z-40 w-[min(88%,364px)] shadow-overlay',
          side === 'left' ? 'left-0 border-r border-rule-structure' : 'right-0 border-l border-rule-structure',
        )}
      >
        {children}
      </aside>
    </>
  );
}

/** The drag handle beside a side column - which a phone, with no columns to drag, does not have. */
export function SideSeparator() {
  return SURFACE.overlayPanels ? null : <ResizableSeparator orientation="horizontal" />;
}
