/**
 * Rendering numbers, and only numbers somebody measured.
 *
 * Split out from the components so the two rules that keep getting broken live
 * in one place: **elapsed is a duration, never a fraction**, and **a quantity
 * with no denominator is not a bar**.
 */

/** `9m12s`, `1h04m`, `8s` - the same shape `formatElapsed` prints in the terminal. */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}h${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m${pad(seconds)}s`;
  return `${seconds}s`;
}

/** `2.14M`, `120k`, `47`. Matches the core's own `fmtTokens`. */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** `47 tool uses`, `1 event`. The unit travels with the count because they do not count the same thing. */
export function counted(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * The boundary a gate is holding at, in words.
 *
 * A closed map rather than a prettifier over the string: a boundary this version
 * does not know is shown as itself, which is honest, where a
 * `replace(/-/g, ' ')` would quietly make up a phrase for it.
 */
const BOUNDARIES: Readonly<Record<string, string>> = {
  'plan-round': 'the end of a plan round',
  'plan-approved': 'the approved plan',
  implemented: 'the finished implementation',
  'verify-round': 'a verification round',
  'review-round': 'the end of a review round',
  'final-fix': 'the final carried-finding fix',
  complete: 'the end of the run',
};

export function boundary(name: string): string {
  return BOUNDARIES[name] ?? name;
}
