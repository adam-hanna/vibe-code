import { Command as CommandPrimitive } from 'cmdk';
import { Dialog as DialogPrimitive, VisuallyHidden } from 'radix-ui';
import { Search } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The command palette's parts, over `cmdk` (shadcn's shape).
 *
 * `CommandDialog` is a modal and is bounded by the viewport - `max-h-[70vh]`
 * with the list scrolling inside - for the reason `audit:contrast` §10 bounds
 * `.v-modal`: a scrim is `position: fixed; inset: 0`, so a dialog that outgrows
 * the window is a stuck application, not a stuck dialog. Escape leaves it from
 * the window (`Cockpit`'s key handler) as well as from Radix.
 */
export function Command({ className, ...props }: ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn('flex h-full w-full flex-col overflow-hidden rounded-md bg-card text-primary', className)}
      {...props}
    />
  );
}

export function CommandDialog({
  title,
  children,
  ...props
}: ComponentProps<typeof DialogPrimitive.Root> & { title: string; children: ReactNode }) {
  return (
    <DialogPrimitive.Root {...props}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-page/60" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-[12vh] z-50 w-[min(640px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-md border border-rule-card bg-card shadow-overlay outline-none"
          aria-describedby={undefined}
        >
          <VisuallyHidden.Root>
            <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
          </VisuallyHidden.Root>
          <Command className="max-h-[70vh] [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-chip [&_[cmdk-group-heading]]:font-bold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-tertiary">
            {children}
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function CommandInput({ className, ...props }: ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div className="flex items-center gap-2 border-b border-rule-structure px-3">
      <Search className="size-4 shrink-0 text-tertiary" aria-hidden />
      <CommandPrimitive.Input
        className={cn(
          'h-10 w-full bg-transparent py-2 font-sans text-body text-emphasis outline-none placeholder:text-tertiary',
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function CommandList({ className, ...props }: ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List className={cn('min-h-0 flex-1 overflow-y-auto p-1', className)} {...props} />
  );
}

export function CommandEmpty(props: ComponentProps<typeof CommandPrimitive.Empty>) {
  return <CommandPrimitive.Empty className="px-2 py-6 text-center text-body-sm text-tertiary" {...props} />;
}

export function CommandGroup({ className, ...props }: ComponentProps<typeof CommandPrimitive.Group>) {
  return <CommandPrimitive.Group className={cn('overflow-hidden', className)} {...props} />;
}

export function CommandSeparator({ className, ...props }: ComponentProps<typeof CommandPrimitive.Separator>) {
  return <CommandPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-rule-inner', className)} {...props} />;
}

export function CommandItem({ className, ...props }: ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-body-sm text-primary outline-none data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50 data-[selected=true]:bg-active data-[selected=true]:text-emphasis',
        className,
      )}
      {...props}
    />
  );
}

/** The key chord, right-aligned on an item. A label, never a handler. */
export function CommandShortcut({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('ml-auto font-mono text-mono-sm text-tertiary', className)} {...props} />;
}
