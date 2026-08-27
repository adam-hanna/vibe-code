/**
 * The `## Scope` region of a rendered prompt, and how to splice one into a
 * frozen baseline.
 *
 * #56 moved `scopeGuidance`, which is rendered into `critiquePrompt` and
 * `reviewPrompt` alike, so the golden review prompts in
 * `tests/fixtures/prompts/` no longer match byte for byte. The fixtures are NOT
 * regenerated: a regenerated fixture proves only that the current build equals
 * itself, while asserting `current === baseline with exactly this one region
 * replaced` proves the far stronger thing - that nothing outside `## Scope`
 * moved. That is the pattern `review-round3-nomemory.txt` already established
 * for #49, generalised from a literal paragraph to a delimited region.
 *
 * The region is taken from the output under test rather than hardcoded here,
 * so there is no second copy of the prompt prose to drift. What a literal would
 * have given for free - proof that the block actually changed - is bought back
 * by throwing when the two regions are identical.
 */

/** Where the `## Scope` block starts and ends. Both prompts render it immediately before `## Acceptance criteria`. */
const START = '## Scope\n';
const END = '\n## Acceptance criteria';

function region(text: string, label: string): { start: number; end: number } {
  const start = text.indexOf(START);
  if (start < 0) throw new Error(`${label}: no "## Scope" heading - the prompt shape moved`);
  const end = text.indexOf(END, start);
  if (end < 0) {
    throw new Error(`${label}: no "## Acceptance criteria" after "## Scope" - the prompt shape moved`);
  }
  return { start, end };
}

/**
 * `baseline` with its `## Scope` block replaced by the one from `current`.
 *
 * Index arithmetic rather than `String.prototype.replace`, because `$&` and
 * friends in a replacement string are not literal - a prompt that ever grows a
 * `$` would silently corrupt the comparison.
 *
 * Throws rather than returning `baseline` unchanged when the region cannot be
 * found in either string, or when the two regions are identical: either case
 * would make the caller's equality assertion pass while proving nothing.
 */
export function spliceScope(baseline: string, current: string): string {
  const b = region(baseline, 'baseline');
  const c = region(current, 'current');

  const from = baseline.slice(b.start, b.end);
  const to = current.slice(c.start, c.end);
  if (from === to) {
    throw new Error(
      'the "## Scope" blocks are identical - splicing proves nothing, so assert byte-equality directly instead',
    );
  }

  return baseline.slice(0, b.start) + to + baseline.slice(b.end);
}

/** The `## Scope` block of `text`, for asserting on what the splice carried in. */
export function scopeBlock(text: string): string {
  const { start, end } = region(text, 'text');
  return text.slice(start, end);
}
