import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SURFACE } from '../surface';

/**
 * The pilot's controls above the conversation, drawn the way this build draws
 * its chrome (#347).
 *
 * On a desktop they are the two rows they always were, and `children` is drawn
 * as it is. On a phone those rows - vendor, model, effort, the checkpoint
 * switch, the day's books, the context and its two ways to empty it - stacked
 * to about half the screen before the first message. So the phone draws one
 * line: which vendor and model the next turn goes to, and how full the context
 * is, because both are about the turn you are about to send. A press opens the
 * same rows in a sheet over the pane.
 *
 * The sheet guards nothing, so a press on its scrim shuts it, as a side sheet
 * does; that is the opposite of `Modal`'s rule, and `Modal` is for dialogs in
 * front of something that costs. Escape shuts it too.
 */
export function PilotControls({
  vendor,
  model,
  context,
  alarm,
  proposals,
  children,
}: {
  /** The vendor's name as the picker shows it. */
  vendor: string;
  /** The model's label as the picker shows it. */
  model: string;
  /** The context line, word for word as the rows draw it. */
  context: string;
  /** Past the context's warning line: drawn with emphasis, as the rows do. */
  alarm: boolean;
  /** Proposals waiting on a person, which block sending and must stay said. */
  proposals: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const shut = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', shut);
    return () => window.removeEventListener('keydown', shut);
  }, [open]);

  if (!SURFACE.compactChrome) return <>{children}</>;

  return (
    <>
      <div className="flex flex-none items-center gap-2 border-b border-rule-structure px-3 py-1.5">
        <button
          type="button"
          className="flex max-w-[60%] flex-none cursor-pointer items-center gap-1 rounded-sm border border-rule-control bg-transparent px-2 py-1 text-body-sm text-primary hover:bg-column"
          aria-label="Pilot settings"
          aria-expanded={open}
          onClick={() => setOpen(true)}
        >
          <span className="truncate">
            {vendor} · {model}
          </span>
          <ChevronDown className="size-3.5 flex-none text-tertiary" aria-hidden />
        </button>
        <span className={cn('min-w-0 truncate text-body-sm text-secondary', alarm && 'text-emphasis')}>{context}</span>
        {proposals > 0 && (
          <span className="ml-auto flex-none text-body-sm text-emphasis">{proposals} waiting on you</span>
        )}
      </div>
      {open && (
        <>
          <div className="absolute inset-0 z-30 bg-page/60" aria-hidden="true" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-label="Pilot settings"
            className="absolute inset-x-0 top-0 z-40 flex max-h-[85%] flex-col border-b border-rule-structure bg-panel shadow-overlay"
          >
            <div className="flex flex-none items-center justify-between px-4 pt-2">
              <span className="text-chip uppercase tracking-[0.12em] text-tertiary">Pilot settings</span>
              <button
                type="button"
                className="flex size-8 cursor-pointer items-center justify-center rounded-sm border border-transparent bg-transparent text-tertiary hover:text-emphasis"
                aria-label="Close pilot settings"
                onClick={() => setOpen(false)}
              >
                <X className="size-4" aria-hidden />
              </button>
            </div>
            {/* The rows cap each select's width for a desktop bar; a phone's sheet
                has the width to show their whole labels, and wraps instead. */}
            <div className="min-h-0 overflow-y-auto [&_select]:max-w-none">{children}</div>
          </div>
        </>
      )}
    </>
  );
}
