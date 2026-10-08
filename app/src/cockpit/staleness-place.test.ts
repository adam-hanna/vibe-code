import { describe, expect, test } from 'vitest';
import staleness from './Staleness.tsx?raw';
import statusBar from '../shell/StatusBar.tsx?raw';
import cockpit from './Cockpit.tsx?raw';

/**
 * The quiet states of `7c` come and go without moving the window (#267).
 *
 * `thinking · no output for 42s · activity 3s ago` was a full-width strip above
 * the columns, drawn only while the turn was quiet - and a working agent goes
 * quiet and resumes constantly, so the whole window moved down and back up by a
 * row each time. The app has no jsdom, so these read the source.
 */
describe('where each state is drawn', () => {
  test('the strip draws only not-live', () => {
    const strip = staleness.slice(staleness.indexOf('export function StalenessStrip'), staleness.indexOf('export function StalenessNote'));
    expect(strip).toContain("if (state.state !== 'not-live') return null;");
    expect(strip).not.toContain('<Badge>thinking</Badge>');
    expect(strip).not.toContain('<Badge>cannot tell</Badge>');
  });

  test('thinking and cannot tell are drawn inline, and do not wrap', () => {
    const note = staleness.slice(staleness.indexOf('export function StalenessNote'));
    expect(note).toContain('<Badge>thinking</Badge>');
    expect(note).toContain('<Badge>cannot tell</Badge>');
    expect(note).toContain('no output for {');
    expect(note).toContain('truncate tabular-nums');
  });

  test('the status bar draws them before its spacer, so nothing to the right moves', () => {
    const note = statusBar.indexOf('<StalenessNote state={staleness} />');
    const spacer = statusBar.indexOf('<span className="flex-1" />');
    expect(note).toBeGreaterThan(-1);
    expect(note).toBeLessThan(spacer);
    // The bar's height is fixed, which is what makes it a place things can appear.
    expect(statusBar).toMatch(/<footer\s+className="flex h-6 shrink-0/);
  });

  test('both read the same reading of the live turn', () => {
    expect(cockpit).toContain('const quiet = staleness(run, now);');
    expect(cockpit).toContain('<StalenessStrip state={quiet}');
    expect(cockpit).toContain('staleness={quiet}');
  });
});
