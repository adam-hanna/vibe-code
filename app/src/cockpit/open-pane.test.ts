import { describe, expect, test } from 'vitest';
import loopColumn from './LoopColumn.tsx?raw';
import cockpit from './Cockpit.tsx?raw';
import { BOTTOM_TABS, TABS } from './where';

/**
 * Opening a pane by name (#260).
 *
 * "Open full activity" called `onOpen('activity')`, `open()` cast it into the
 * tab, and the window drew a tab that does not exist: a blank main area with
 * nothing selected. The type now refuses a name that is not a pane; these pin
 * the fix and the type, since a later `string` would let it back in silently.
 */
describe('a pane is opened by its name', () => {
  test('the activity control opens the output, which is where the activity is', () => {
    expect(loopColumn).toMatch(/onClick=\{\(\) => onOpen\('output'\)\} title="Open full activity"/);
    expect([...TABS, ...BOTTOM_TABS]).toContain('output');
  });

  test('open() and OpenAt take a pane, not any string', () => {
    expect(loopColumn).toMatch(/export type OpenAt = \(tab: Tab \| BottomTab/);
    expect(cockpit).toMatch(/const open = useCallback\(\(next: Tab \| BottomTab/);
    expect(cockpit).not.toMatch(/next as typeof tab/);
  });
});
