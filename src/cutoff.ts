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

/**
 * A blank run as it is written inside a JSON string: literal blank characters
 * and the escapes `\n`, `\t` and `\r`, starting after an even number of
 * backslashes so that an escaped backslash followed by an `n` is not read as a
 * newline. Each token is one blank character of the text it encodes, so the
 * threshold is `BLANK_RUN_COLLAPSE` characters of the message, not of the stream.
 */
const ESCAPED_BLANK_RUN = new RegExp(
  String.raw`(?<=(?:^|[^\\])(?:\\\\)*)(?:[ \t\r\n]|\\[ntr]){` + `${BLANK_RUN_COLLAPSE},}`,
  'g',
);

/**
 * `collapseBlankRuns` for text that is still JSON-encoded: Codex's raw stdout,
 * where a newline inside a message arrives as the two characters `\n` and a
 * stall of `\n\r ` pairs is never a literal run at all (#429).
 *
 * For error text only. It rewrites inside string literals, so the result is no
 * longer the stream it came from, and nothing that is parsed may pass through it.
 */
export function collapseEscapedBlankRuns(text: string): string {
  return text.replace(ESCAPED_BLANK_RUN, (run) => {
    const chars = run.replace(/\\[ntr]/g, ' ').length;
    return `<… ${chars.toLocaleString('en-US')} blank characters …>`;
  });
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
        // Not followed by `:`, so a value that happens to be the word (a
        // `"summary":"findings"`) and not the key: scan on past it (#429).
        if (text[j] !== ':') {
          i = end;
          continue;
        }
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

/** `value[key]` when `value` is an object, and undefined otherwise. */
function member(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * The item schema of a schema's top-level `findings` array, or null when the
 * schema has none - the answerer's and the verifiers' do not (#429).
 */
export function findingsItemSchema(schema: unknown): object | null {
  const items = member(member(member(schema, 'properties'), 'findings'), 'items');
  return typeof items === 'object' && items !== null ? items : null;
}

/** Whether a schema node's `type` is, or includes, `name`. */
function allows(schema: unknown, name: string): boolean {
  const type = member(schema, 'type');
  return type === name || (Array.isArray(type) && type.includes(name));
}

/**
 * A value laid out as its schema puts it on the wire (#429): each object's keys
 * in the order of its `properties`, every one present, and nothing the schema
 * does not name.
 *
 * `parseFinding` gives vibe's own shape - `reproducer` after `evidence`, null
 * keys dropped, `evidence` absent when no entry was usable - and handing that to
 * a retry that is told to write every key would show it the very shape #416
 * removed. The order is read from the schema, never restated, so the two cannot
 * drift. A key the value lacks is `null` where the schema allows null and `[]`
 * where it is an array; that is what the parsed value already says ("no
 * reproducer", "no usable citation"), spelled the way the schema spells it.
 */
export function inWireShape(value: unknown, schema: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => inWireShape(v, member(schema, 'items')));
  const properties = member(schema, 'properties');
  if (typeof value !== 'object' || value === null || typeof properties !== 'object' || properties === null) {
    return value;
  }
  const from = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, sub] of Object.entries(properties)) {
    out[key] =
      from[key] !== undefined ? inWireShape(from[key], sub) : allows(sub, 'null') ? null : allows(sub, 'array') ? [] : null;
  }
  return out;
}

/**
 * What the retry of a cut-off turn is told, appended to its prompt.
 *
 * The findings are handed over as unverified, in the words the brief settled
 * on: the retry is what the loop acts on, so they must be checked again rather
 * than carried as though the cut-off answer had been a verdict.
 *
 * Worded for the turn's own schema (#429). One with no `findings` - the
 * answerer's, a verifier's vote - is told only that it was cut off: "it had not
 * written any finding" would be about a key its answer cannot contain. One with
 * findings sees them in that schema's wire shape, with every key.
 */
export function cutOffNote(findings: readonly Finding[], schema: object | undefined): string {
  const heading = '## An earlier attempt at this turn was cut off';
  const cut = 'An earlier attempt at this turn was cut off at its output limit before it finished.';
  const item = findingsItemSchema(schema);
  if (item === null) return `${heading}\n\n${cut}`;
  if (findings.length === 0) {
    return `${heading}\n\n${cut} It had not written any finding in full.`;
  }
  return (
    `${heading}\n\n${cut} ` +
    'It had written these findings in full. Check each one again as if it were new; it has ' +
    'not been verified.\n\n' +
    '```json\n' +
    `${JSON.stringify(findings.map((f) => inWireShape(f, item)), null, 2)}\n` +
    '```'
  );
}
