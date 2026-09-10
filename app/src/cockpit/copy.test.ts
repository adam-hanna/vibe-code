import { describe, expect, test } from 'vitest';

const sources = import.meta.glob('../**/*.tsx', { query: '?raw', import: 'default', eager: true });

/**
 * No issue number reaches the screen.
 *
 * **The complaint was general, so the check is too.** *"There's copy all over the
 * app that includes a ticket number. I think I've seen reference to #114, for
 * example. End users don't need to know that."* Seven components carried one, in
 * body text and in `title` attributes, and each was individually defensible — the
 * issue is the thing that would supply the missing figure, and naming it is how
 * this repo keeps a gap legible. That reasoning is right about the **source** and
 * wrong about the screen: `#114` is unactionable to anybody who is not holding
 * this repository open.
 *
 * So the numbers stay in comments, where the next reader of the module is, and
 * this walks every component to keep them there.
 *
 * **It globs rather than naming files**, for the reason `audit:contrast`'s hex
 * check does: AGENTS.md records that a named list *"missed `cockpit.css` the day
 * it appeared, which is the failure mode of any allow-list somebody has to
 * remember to extend"*. A component added tomorrow is checked without anybody
 * remembering to add it.
 *
 * It reads what is left after comments are removed, which is an approximation and
 * is deliberately the *strict* one: a `#123` in a string literal that never
 * renders would fail this, and that is the right way round — the cost is one
 * comment, and the alternative is a parser.
 */

/** Everything that is not a comment. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('the product says nothing an end user cannot act on', () => {
  test('no component renders an issue number', () => {
    const offenders: string[] = [];
    for (const [file, source] of Object.entries(sources)) {
      const found = code(source as string).match(/#\d{1,4}\b/g);
      if (found !== null) offenders.push(`${file}: ${found.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  test('the check is looking at something', () => {
    // A glob that matched nothing would pass the case above for ever. This is
    // the guard against that, and it is why the number is a floor rather than an
    // exact count.
    expect(Object.keys(sources).length).toBeGreaterThan(20);
  });
});
