import { APPROVE_COST } from '@src/prompts.js';

/**
 * A frozen review baseline with #115's one paragraph spliced in.
 *
 * The fixtures in `tests/fixtures/prompts/` are not regenerated for #115, for
 * the reason `scope-block.ts` gives: a regenerated fixture proves only that the
 * build equals itself, while `current === baseline plus exactly this paragraph`
 * proves nothing else in the reviewer's prompt moved. The paragraph is read
 * from `src/prompts.ts` rather than copied here, so there is no second copy to
 * drift.
 *
 * Throws rather than returning `baseline` unchanged when the anchor is missing
 * or the paragraph is already there: either would let the caller's equality
 * pass while proving nothing.
 */
const ANCHOR =
  'Do not wave through a real defect. Reserve P1 for defects you can name a concrete failure ' +
  'case for, and prefer P1 over P0 for anything a test run could settle.\n';

export function withApproveCost(baseline: string): string {
  const at = baseline.indexOf(ANCHOR);
  if (at < 0) throw new Error('baseline: the "Do not wave through" line moved, so the splice point is gone');
  if (baseline.includes(APPROVE_COST)) throw new Error('baseline already carries the approve paragraph');
  const end = at + ANCHOR.length;
  return `${baseline.slice(0, end)}\n${APPROVE_COST}\n${baseline.slice(end)}`;
}
