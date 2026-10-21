/**
 * The command palette's match: a case-insensitive substring, nothing cleverer
 * (#397).
 *
 * `Palette`'s header always said the runs were "substring-matched on the id and
 * the task", but nothing passed `cmdk` a `filter`, so its default ran instead:
 * `command-score`, a fuzzy scorer that memoises on (position, query index) and
 * scans forward for every occurrence of the next query letter from every state,
 * slicing and regex-matching the gap each time. That is roughly cubic in the
 * value's length, and a run's value is its id **and its whole brief** - 6,825 to
 * 20,386 characters across the 20 runs of this repository's own archive. Over
 * those 20, Node measured 360 ms for the query `a`, 11.0 s for `al` and 15.0 s
 * for `all`, per keystroke, on the main thread; that is the freeze the issue
 * describes. The same 20 values through this function took 6.8 ms on the first
 * keystroke, which folds each brief once, and 0.03 to 0.3 ms on each one after,
 * on the same machine and Node (`paletteFilter.test.ts` bounds a larger
 * archive).
 *
 * A substring is also what the palette meant to offer: a fuzzy reorder would
 * make the same keystrokes pick a different run on a different day. Every
 * match scores 1, so `cmdk`'s sort is a no-op and the rows keep the order
 * `Palette` gave them (runs needing a human first).
 *
 * Whitespace is folded on both sides, so a brief that wraps a phrase across a
 * line still matches it typed with a space.
 */
export function paletteFilter(value: string, search: string, keywords?: readonly string[]): number {
  const needle = fold(search);
  if (needle === '') return 1;
  if (folded(value).includes(needle)) return 1;
  return keywords?.some((k) => folded(k).includes(needle)) === true ? 1 : 0;
}

function fold(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Folding a 20k-character brief is most of the cost: without this, 300 values
 * (the 20 real briefs, repeated) took 60 to 70 ms a keystroke. The values are
 * the same strings on every keystroke while the palette is open, so each is
 * folded once. Bounded so a long session cannot grow it without limit.
 */
const FOLDED = new Map<string, string>();
const FOLDED_KEPT = 2_000;

function folded(text: string): string {
  const hit = FOLDED.get(text);
  if (hit !== undefined) return hit;
  if (FOLDED.size >= FOLDED_KEPT) FOLDED.clear();
  const out = fold(text);
  FOLDED.set(text, out);
  return out;
}
