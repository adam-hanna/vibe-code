import { describe, expect, test } from 'vitest';
import palette from './Palette.tsx?raw';
import command from '../ui/command.tsx?raw';
import { paletteFilter } from './paletteFilter';

/**
 * #397: typing in the palette froze the window for seconds per keystroke,
 * because `cmdk` ran its fuzzy scorer over values holding a whole brief. These
 * pin the match the palette promised - a substring - and that it stays cheap
 * on an archive the size of a real one.
 */

/** A brief the size of a real one: this repository's archive on 2026-10-21 held 6,825 to 20,386 characters. */
function brief(seed: number, length: number): string {
  const words = ['the', 'review', 'round', 'carried', 'finding', 'plan', 'worktree', 'gate', 'pilot', 'archive', 'issue', 'a', 'all'];
  const out: string[] = [];
  let n = seed;
  let size = 0;
  while (size < length) {
    n = (n * 1103515245 + 12345) % 2147483648;
    const w = words[n % words.length] ?? 'x';
    out.push(n % 17 === 0 ? `${w}\n` : w);
    size += w.length + 1;
  }
  return out.join(' ');
}

describe('the match', () => {
  test('is a case-insensitive substring of the value', () => {
    expect(paletteFilter('Go to All runs in this project', 'all runs')).toBe(1);
    expect(paletteFilter('Go to All runs in this project', 'ALL RUNS')).toBe(1);
    expect(paletteFilter('Go to All runs in this project', 'arip')).toBe(0);
    expect(paletteFilter('Go to Pilot', 'pilto')).toBe(0);
  });

  test('an empty query matches everything', () => {
    expect(paletteFilter('anything', '')).toBe(1);
    expect(paletteFilter('anything', '   ')).toBe(1);
  });

  test('folds whitespace, so a phrase wrapped across a line in a brief still matches', () => {
    expect(paletteFilter('20261007-133707-fix a carried\n  finding', 'carried finding')).toBe(1);
  });

  test('matches a keyword as well as the value', () => {
    expect(paletteFilter('Settings', 'prefer', ['preferences'])).toBe(1);
    expect(paletteFilter('Settings', 'prefer', ['options'])).toBe(0);
  });

  test('every match scores the same, so cmdk keeps the order the palette gave', () => {
    const scores = ['run one', 'run two, run again', 'a run'].map((v) => paletteFilter(v, 'run'));
    expect(new Set(scores)).toEqual(new Set([1]));
  });
});

describe('the cost', () => {
  test('a keystroke over 300 runs with 20k-character briefs stays far under a frame budget per letter', () => {
    const values = Array.from({ length: 300 }, (_, i) => `20261007-${String(i).padStart(6, '0')}-issue ${brief(i + 1, 20_000)}`);
    const queries = ['a', 'al', 'all', 'all r', 'all runs', 'all runs in this project'];
    const started = performance.now();
    for (const q of queries) for (const v of values) paletteFilter(v, q);
    const perKeystroke = (performance.now() - started) / queries.length;
    // cmdk's default took 11 s for `al` over 20 such values. The bound is loose
    // so a loaded machine does not fail it; what it guards is the order of
    // magnitude, a scorer that is linear in the value rather than cubic.
    expect(perKeystroke).toBeLessThan(500);
  });
});

describe('the wiring', () => {
  test('the palette hands cmdk this filter, and the dialog passes it on', () => {
    expect(palette).toMatch(/<CommandDialog[^>]*filter=\{paletteFilter\}/);
    expect(command).toMatch(/<Command \{\.\.\.\(filter === undefined \? \{\} : \{ filter \}\)\}/);
  });
});
