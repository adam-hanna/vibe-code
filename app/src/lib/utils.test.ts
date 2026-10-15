import { describe, expect, test } from 'vitest';
import { cn } from './utils';

/** `cn` and the app's own font sizes (#347). */
describe('merging class names', () => {
  test('a font size never removes a text colour, nor the other way round', () => {
    expect(cn('text-on-accent h-6 text-label')).toBe('text-on-accent h-6 text-label');
    expect(cn('text-label text-primary')).toBe('text-label text-primary');
  });

  test('two sizes, or two colours, still resolve to the later one', () => {
    expect(cn('text-label text-body')).toBe('text-body');
    expect(cn('text-primary text-secondary')).toBe('text-secondary');
  });
  // That the list matches the sizes `theme.css` defines is `audit:contrast` §11:
  // vitest stubs a CSS import, so only that script can read the file.
});
