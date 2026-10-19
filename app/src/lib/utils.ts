import { clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';
import type { ClassValue } from 'clsx';

/**
 * The font sizes `theme.css` defines as `--text-*` (#347).
 *
 * tailwind-merge knows Tailwind's own sizes and nothing of these, so it read
 * `text-label` as a COLOUR and dropped whichever `text-*` colour came before
 * it: a small primary button lost `text-on-accent` and took its parent's grey.
 * On the dark palette that grey on blue happened to be legible and nobody saw
 * it; on the light one it was dark on blue. `audit:contrast` §11 reads
 * `theme.css` and fails when this list and the sizes it defines disagree.
 */
export const FONT_SIZES = [
  'chip',
  'label',
  'tab',
  'body-sm',
  'body',
  'kicker',
  'section',
  'title',
  'mono-sm',
  'mono',
] as const;

const twMerge = extendTailwindMerge({ extend: { theme: { text: [...FONT_SIZES] } } });

/**
 * Join class names, with later Tailwind utilities winning over earlier ones.
 *
 * The shadcn convention: every copied-in component in `src/ui/` takes a
 * `className` and merges it through here, so a caller can override one utility
 * without the two fighting over which `p-*` applies.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
