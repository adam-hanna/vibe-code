import { describe, expect, test } from 'vitest';
import cockpit from './Cockpit.tsx?raw';
import statusBar from '../shell/StatusBar.tsx?raw';

/**
 * The phone's gate sheet (#347). The app has no jsdom, so these read the
 * source, as `layout.test.ts` does: what is pinned is the rule each piece
 * follows, not how it is drawn.
 */
describe('a held gate on a phone', () => {
  const sheet = cockpit.slice(cockpit.indexOf('{SURFACE.compactChrome && gateOpen && run.gate !== null && ('));

  test('is decided in a sheet drawing the footer, for the run the status bar holds for', () => {
    expect(sheet.length).toBeGreaterThan(0);
    const footer = sheet.slice(0, sheet.indexOf('</Footer>') > 0 ? sheet.indexOf('</Footer>') : sheet.indexOf('/>', sheet.indexOf('<Footer')));
    // One gate block, the loop column's, rather than a second drawing of it.
    expect(footer).toMatch(/<Footer\s+run=\{run\}/);
    expect(footer).toMatch(/onDecide=\{answer\}/);
  });

  test('opens only when asked, from the status bar, and only on a phone', () => {
    expect(cockpit).toMatch(/onGate=\{\s*SURFACE\.compactChrome\s*\?\s*\(\) => \{\s*shutSheets\(\);\s*setGateOpen\(true\);/);
    expect(cockpit.match(/setGateOpen\(true\)/g)).toHaveLength(1);
    expect(statusBar).toMatch(/onGate !== undefined \? \(\s*<Button size="sm" variant="primary" onClick=\{onGate\}>/);
  });

  test('shuts when the gate has gone, however it went', () => {
    expect(cockpit).toMatch(/const heldAsk = run\.gate\?\.askId \?\? null;\s*useEffect\(\(\) => \{\s*if \(heldAsk === null\) setGateOpen\(false\);/);
  });

  test('the desktop keeps its row: the boundary and the two buttons', () => {
    expect(statusBar).toMatch(/<span>at \{boundary\(run\.gate\.boundary\)\}<\/span>/);
  });
});
