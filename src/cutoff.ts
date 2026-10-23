import type { Finding } from '@src/types.js';
import { parseFinding } from '@src/validate.js';

/**
 * A Codex answer cut off at its output limit (#416): reading what it did say,
 * and saying it in a size a person can read.
 *
 * Nothing here turns a cut-off answer into an answer. The salvage keeps whole
 * findings only, as a note to the retry and a record for diagnosis; closing the
 * brackets or filling in the missing keys would be vibe writing the agent's
 * verdict, and would pass a REVISE with one finding of three as a whole review.
 */

/**
 * The shortest blank run that is shortened in a log or an error.
 *
 * An archive measurement, not a rule about JSON. The longest legitimate blank
 * run in this repo's 136 saved Codex outputs is 25 characters - code
 * indentation inside an `excerpt` - so 1,000 is 40 times that, and still far
 * below the 122,409 and 756,893 characters of the two answers that stalled.
 */
export const BLANK_RUN_COLLAPSE = 1000;

const BLANK_RUN = new RegExp(`[ \\t\\r\\n]{${BLANK_RUN_COLLAPSE},}`, 'g');

/** Every blank run of `BLANK_RUN_COLLAPSE` or more, replaced by its count. */
export function collapseBlankRuns(text: string): string {
  return text.replace(BLANK_RUN, (run) => `<… ${run.length.toLocaleString('en-US')} blank characters …>`);
}

/** How many characters of blank space the text ends on. */
export function trailingBlank(text: string): number {
  return text.length - text.replace(/[ \t\r\n]+$/, '').length;
}

/**
 * The findings a cut-off answer had written in full, and only those.
 *
 * A string-aware bracket scan: it finds the top-level `"findings"` array and
 * takes each element whose object closes, stopping at the first one that does
 * not. Each is parsed as written and kept only where `parseFinding` accepts it.
 * Nothing is closed and nothing is filled in, and anything it cannot read gives
 * an empty list rather than an error - a salvage that throws would replace the
 * cut-off with a less truthful failure.
 */
export function salvageFindings(text: string): Finding[] {
  const start = findingsArrayStart(text);
  if (start === null) return [];
  const out: Finding[] = [];
  let i = start;
  for (;;) {
    i = skipBlank(text, i);
    if (i >= text.length || text[i] === ']') return out;
    if (text[i] !== '{') return out;
    const end = closeOf(text, i);
    if (end === null) return out;
    try {
      out.push(parseFinding(JSON.parse(text.slice(i, end)) as unknown, out.length));
    } catch {
      // Not a finding this repo would accept: dropped, never repaired.
    }
    i = skipBlank(text, end);
    if (text[i] === ',') i += 1;
    else return out;
  }
}

/** The index just after the `[` of the top-level `"findings"` value, or null. */
function findingsArrayStart(text: string): number | null {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const end = stringEnd(text, i);
      if (end === null) return null;
      if (depth === 1 && text.slice(i, end) === '"findings"') {
        let j = skipBlank(text, end);
        if (text[j] !== ':') return null;
        j = skipBlank(text, j + 1);
        return text[j] === '[' ? j + 1 : null;
      }
      i = end;
      continue;
    }
    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') depth -= 1;
    i += 1;
  }
  return null;
}

/** The index just after the bracket that closes the one at `open`, or null. */
function closeOf(text: string, open: number): number | null {
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const end = stringEnd(text, i);
      if (end === null) return null;
      i = end;
      continue;
    }
    if (c === '{' || c === '[') depth += 1;
    else if (c === '}' || c === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return null;
}

/** The index just after the closing quote of the string at `open`, or null. */
function stringEnd(text: string, open: number): number | null {
  for (let i = open + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '"') return i + 1;
  }
  return null;
}

function skipBlank(text: string, i: number): number {
  while (i < text.length && ' \t\r\n'.includes(text[i] ?? '')) i += 1;
  return i;
}

/**
 * What the retry of a cut-off turn is told, appended to its prompt.
 *
 * The findings are handed over as unverified, in the words the brief settled
 * on: the retry is what the loop acts on, so they must be checked again rather
 * than carried as though the cut-off answer had been a verdict.
 */
export function cutOffNote(findings: readonly Finding[]): string {
  const heading = '## An earlier attempt at this turn was cut off';
  if (findings.length === 0) {
    return (
      `${heading}\n\n` +
      'An earlier attempt at this turn was cut off at its output limit before it finished. ' +
      'It had not written any finding in full.'
    );
  }
  return (
    `${heading}\n\n` +
    'An earlier attempt at this turn was cut off at its output limit before it finished. ' +
    'It had written these findings in full. Check each one again as if it were new; it has ' +
    'not been verified.\n\n' +
    '```json\n' +
    `${JSON.stringify(findings, null, 2)}\n` +
    '```'
  );
}
