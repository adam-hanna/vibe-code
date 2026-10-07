import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { ClassValue } from 'clsx';

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
