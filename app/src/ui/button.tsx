import { cva } from 'class-variance-authority';
import type { VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/**
 * The one button (shadcn's shape, this design's tokens).
 *
 * Every colour below is a token through `theme.css`, so `audit:contrast` §1
 * still decides whether a pairing is legible. `primary` is the accent on the
 * page ground, which is the one dark-on-light pairing in the product and is
 * reserved for the action a screen is for; `quiet` is navigation and chrome.
 *
 * It states its own ground and border, which is what §9 of the audit is about:
 * a `button` with neither takes the platform's near-white.
 */
export const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-sm border font-sans font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-accent-border disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'border-accent bg-accent text-page hover:bg-accent-muted',
        secondary: 'border-rule-control bg-card text-primary hover:bg-active hover:text-emphasis',
        quiet: 'border-transparent bg-transparent text-secondary hover:bg-card hover:text-emphasis',
        loss: 'border-rule-control bg-card text-loss hover:bg-alarm',
      },
      size: {
        sm: 'h-6 px-2 text-label',
        md: 'h-7 px-2.5 text-body-sm',
        icon: 'size-7 p-0',
        'icon-sm': 'size-6 p-0',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
