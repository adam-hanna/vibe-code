import { describe, expect, it } from 'vitest';
import source from './Cockpit.tsx?raw';

// The app has no jsdom, so the header is pinned as source, like the other
// Cockpit.tsx pins (#300).
describe('the main header (#300)', () => {
  it('carries no tagline', () => {
    expect(source).not.toContain('Make room for good work');
  });

  it('still labels an opened run, and only an opened run', () => {
    expect(source).toMatch(/viewing !== null && <p[^>]*>Run archive<\/p>/);
  });
});
