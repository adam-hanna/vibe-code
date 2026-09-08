/**
 * The block a person pastes to raise a finding (`1d`, #223).
 *
 * **This is composed here and parsed by `src/raise.ts`, so its shape is a
 * contract rather than a layout.** Four things about it are load-bearing, and
 * every one of them is a rule that file states:
 *
 * - The heading is `### Finding: <one line>`. The parser finds blocks by it.
 * - `*Severity:*` and `*File:*` are single-starred emphasis, not bold, and the
 *   file line takes `path:line`.
 * - The detail and the fix are **`> ` blockquote lines under their markers**.
 *   `AGENTS.md` says the same thing about answers, in the same words: *"a `### `
 *   heading and `> ` blockquote lines — the parser needs both."*
 * - A block left as its template raises nothing, and a **partly** filled one
 *   stops the resume and says which part is missing rather than being guessed
 *   at. So this fills every field or leaves it visibly empty; it never
 *   substitutes a plausible default.
 *
 * A test reads `src/raise.ts` as source and asserts the four markers still match,
 * because the two files are one contract and nothing else connects them.
 */

export interface Raised {
  file: string;
  line: number;
  title: string;
  detail: string;
  fix: string;
  severity: string;
}

/**
 * The exact markers `src/raise.ts` looks for.
 *
 * Duplicated rather than imported: the app does not link the core's modules, and
 * a mismatch here produces a block the resume refuses **with a reason** rather
 * than one it silently misreads — which is the fail-closed direction, and the
 * one the parser was written to take.
 */
export const HEADING = '### Finding:';
export const DETAIL = '**What is wrong:**';
export const FIX = '**Suggested fix:**';

/** Every line of a paragraph as `> ` quotes, or one empty quote for nothing. */
function quote(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  // A single `>` rather than nothing: an empty marker with no quote under it is
  // exactly the half-finished block the parser refuses, and it should refuse it
  // — that is the person having started and not finished, which is a different
  // thing from them having written nothing at all.
  if (lines.length === 0) return '>';
  return lines.map((l) => `> ${l}`).join('\n');
}

export function raiseBlock(r: Raised): string {
  return [
    `${HEADING} ${r.title.trim()}`,
    '',
    `*Severity:* ${r.severity}`,
    // The citation, from the hunk rather than typed. This is what makes the
    // finding **grounded**: `checkEvidence` runs on a human finding exactly as
    // it does on the reviewer's, and a P0 or P1 citing nothing that resolves is
    // carried as a P2 with the reason recorded.
    `*File:* ${r.file}:${String(r.line)}`,
    '',
    DETAIL,
    '',
    quote(r.detail),
    '',
    FIX,
    '',
    quote(r.fix),
    '',
  ].join('\n');
}
