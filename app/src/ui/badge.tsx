import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * A small labelled chip. `alarm` is for a value that is wrong - a protocol
 * disagreement, a host that is gone - and is the only variant allowed in the
 * chrome while nothing is wrong, because it is never drawn then.
 */
export const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-sm border px-1.5 py-px font-sans text-chip font-bold uppercase tracking-wide',
  {
    variants: {
      variant: {
        quiet: 'border-rule-control-dim bg-card text-tertiary',
        accent: 'border-accent-border bg-accent-tint text-accent-on-tint',
        alarm: 'border-loss bg-alarm text-emphasis',
        live: 'border-accent-border-dim bg-active text-accent-muted',
      },
    },
    defaultVariants: { variant: 'quiet' },
  },
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
