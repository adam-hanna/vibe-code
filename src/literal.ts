/**
 * Agent text made safe to write into `NEEDS-INPUT.md` (#472).
 *
 * The resume reads that file by markers: `cmdResume` takes the answers path when
 * `**Your answer:**` appears anywhere in it, `parseHumanAnswers` splits on
 * line-initial `### `, `parseRaised` and `parseRequestedMoves` key on their
 * labels, and `parseDecisions` on the assumptions heading. Everything else in
 * the file is the reviewer's, the planner's or the brief's words, written as
 * they came - so a finding that quotes `**Your answer:**` flipped a findings stop
 * onto the answers path. Of 501 findings in the archive and the bench, 5 quoted
 * that marker (all from #465's own run, reviewing the feature that added it).
 *
 * Neutralise only what a parser keys on, and nothing else, so text holding none
 * of it is returned byte for byte:
 *
 * - a marker the parsers find anywhere has its asterisks escaped, which renders
 *   the same to a reader;
 * - a line starting (after up to three spaces) with `#`, `>` or `*` gets a
 *   backslash first - those are the headings, the answer lines and the
 *   line-anchored labels (`*Severity:*`, `*File:*`, `*Move to:*`).
 *
 * The parsers do not change: the point is that agent text can no longer contain
 * what they look for. Imports nothing, so every renderer can use it without a
 * cycle; `literal.test.ts` checks `MARKERS` against the parsers' own constants.
 */

/** Every marker some `NEEDS-INPUT.md` parser looks for anywhere in a line. */
export const MARKERS: readonly string[] = [
  '**Your answer:**',
  '**Your decision:**',
  '**What is wrong:**',
  '**Suggested fix:**',
  '**Why:**',
];

const LINE_START = /^( {0,3})([#>*])/gm;
const AFTER_NEWLINE = /(\n {0,3})([#>*])/g;

/**
 * `text` with every parser marker in it made inert, and nothing else changed.
 *
 * `inline` is for a field rendered after other text on its line - a heading's
 * title, a `*Label:*` value, the task after `**Task:**` - where its first
 * character is not at a line start, so only a line it breaks onto is. Without
 * it a title such as `#flush drains #pending` would gain a backslash it needs
 * no more than any other text does.
 */
export function literal(text: string, options: { inline?: boolean } = {}): string {
  let out = text;
  for (const marker of MARKERS) {
    if (out.includes(marker)) out = out.split(marker).join(marker.replace(/\*/g, '\\*'));
  }
  return options.inline === true ? out.replace(AFTER_NEWLINE, '$1\\$2') : out.replace(LINE_START, '$1\\$2');
}

/** `literal(text, { inline: true })`, for `Array.map` and the many inline fields. */
export const inlineLiteral = (text: string): string => literal(text, { inline: true });
