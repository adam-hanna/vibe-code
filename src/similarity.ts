/**
 * One similarity measure, one threshold, and the two censuses they rest on.
 *
 * A leaf, and it has to be one. `src/questions.ts` built this to decide when two
 * wordings are one question (#65); `src/run.ts` now needs the same rule to decide
 * when two findings are one claim (#116), and `questions.ts` imports `run.ts`.
 * Copying the metric into `run.ts` was the other option and it is the mistake
 * `changedFiles` made: two readers of the same question, kept in step by hand,
 * until they were not. Nothing here imports anything.
 *
 * `questions.ts` re-exports all three, so every existing import site is
 * unchanged.
 */

/**
 * The key `answeredQuestions` is stored under, and the token source for every
 * score below.
 *
 * Moved here from `src/questions.ts` unchanged, and it must stay unchanged: it
 * is the key of a persisted list, and it is the function both thresholds below
 * were measured over. Altering it silently reclassifies every stored key and
 * invalidates both numbers.
 */
export const normalize = (s: string): string => s.toLowerCase().replace(/\W+/g, ' ').trim();

const tokens = (s: string): Set<string> => new Set(normalize(s).split(' ').filter(Boolean));

/**
 * Jaccard over `normalize`'s token set: shared tokens over the union.
 *
 * Zero when either side has no tokens, so an empty string can never divide by
 * zero and can never match anything.
 */
export function similarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const t of left) if (right.has(t)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/**
 * Above this, two strings say the same thing.
 *
 * Not a guessed number, and now measured twice - once per population that uses
 * it. Both censuses used *this* metric over *this* `normalize`; a different
 * similarity measure cannot inherit the constant, and neither can a third
 * population without its own census.
 *
 * **Questions (#65).** Every `plan-<n>.json` in this repository's 22 archived
 * runs, read 2026-08-28 against `develop` at `45cda5e` - 115 open questions, 335
 * within-run pairs. 247 pairs sat at or below 0.4, 88 at or above 0.8, and the 8
 * in the 0.81-0.90 band were every one a rephrasing on inspection. The gap is
 * NOT literally empty and the run that wrote that file proved it: it asked one
 * question twice, under the old build, and the pair scores **0.708** - a genuine
 * rephrasing, out of sample, inside the band the census found bare. What matters
 * survives strengthened. The highest-scoring pair that is NOT the same question
 * is 0.4 across the census and 0.219 within that run; the lowest-scoring pair
 * that IS the same question is 0.708. Do not restate the band as empty; state
 * the two extremes, which are what the number rests on.
 *
 * **Finding titles (#116).** Every `plan-critique-<n>.json` and `review-<n>.json`
 * in the archive, read 2026-09-02 - 276 findings across 61 rounds of 25 runs,
 * including the stalled #63 run. The population this has to separate is the
 * recycled label: an id that comes back carrying a different claim. There are 21
 * of them, 28 consecutive pairs, and they score **median 0.125, max 0.286**.
 * Across every cross-id pair in consecutive rounds the maximum is **0.429**, and
 * that one pair is arguably the same claim under two labels. So nothing in the
 * whole corpus reaches 0.6, and the population that must fall below it tops out
 * at 0.286 - about 0.31 of margin.
 *
 * **The limitation, stated rather than buried: that census has no positive
 * samples.** The archive contains no genuine repeat - not one id ever came back
 * carrying the same claim - so it bounds the false-positive side only and says
 * nothing about where a real repeat would score. What it cannot rule out is a
 * genuine repeat reworded below 0.6, where the repeat brake would fail to fire.
 * `recycledLabelNotice` in `src/run.ts` is the mitigation, and it is the same one
 * `writeRephrased` is for questions: the decision is reported, so being wrong
 * costs a visible line rather than a silent omission.
 */
export const REPHRASE_THRESHOLD = 0.6;
