import { describe, expect, test } from 'vitest';
import cockpit from './Cockpit.tsx?raw';
import main from '../main.tsx?raw';
import { deviceKey, NOWHERE, OPEN_PANELS, readWhere, startPanels, WHERE_KEY, writableWhere } from './where';

/**
 * Where the window was pointed, kept between launches (#223). Every relaunch
 * used to land on the pilot with no run open. The panels joined it with the UI
 * rework: with drag handles between every region, an arrangement is a setting.
 */

const AT = {
  tab: 'critique' as const,
  viewing: { dir: '/repo', runId: '20261006-run', task: 'build it' },
  draftId: null,
  bottom: 'commands' as const,
  panels: { sidebar: false, loop: true, bottom: true, sizes: { shell: { center: 70, loop: 30 }, center: { main: 65, bottom: 35 } } },
};

describe('where the window was', () => {
  test('round-trips', () => {
    expect(readWhere(writableWhere(AT))).toEqual(AT);
  });

  test('nothing stored, or nothing readable, is a fresh window', () => {
    expect(readWhere(null)).toEqual(NOWHERE);
    expect(readWhere('{half')).toEqual(NOWHERE);
    expect(readWhere('7')).toEqual(NOWHERE);
  });

  test('each field fails on its own', () => {
    // A tab this build no longer has must not cost the run that was open.
    expect(readWhere(JSON.stringify({ ...AT, tab: 'findings' }))).toEqual({ ...AT, tab: 'pilot' });
    expect(readWhere(JSON.stringify({ ...AT, viewing: { dir: '/repo' } }))).toEqual({ ...AT, viewing: null });
    expect(readWhere(JSON.stringify({ ...AT, draftId: 3 }))).toEqual(AT);
    // The fallback is `commands`, the bottom panel's one pane since #284.
    expect(readWhere(JSON.stringify({ ...AT, bottom: 'terminal' }))).toEqual({ ...AT, bottom: 'commands' });
    // A record from before #284 whose bottom panel was on the output.
    expect(readWhere(JSON.stringify({ ...AT, bottom: 'output' }))).toEqual({ ...AT, bottom: 'commands' });
  });

  test('a record from before the panels opens every panel at its default', () => {
    const old = { tab: 'critique', viewing: AT.viewing, draftId: null };
    expect(readWhere(JSON.stringify(old))).toEqual({ ...old, bottom: 'commands', panels: OPEN_PANELS });
  });

  test('a record that had Output or Commands as the main tab comes back as the bottom panel, open', () => {
    // Case 2 of the two: those two panes moved to the bottom panel, so the old
    // tab name means the same screen in the new arrangement rather than a tab
    // this build does not have.
    const old = { tab: 'commands', viewing: null, draftId: null };
    expect(readWhere(JSON.stringify(old))).toEqual({
      tab: 'pilot',
      viewing: null,
      draftId: null,
      bottom: 'commands',
      panels: { ...OPEN_PANELS, bottom: true },
    });
  });

  test('a record whose main tab was Output comes back on the Output tab (#284)', () => {
    // Output is a main tab again, so a record from before the bottom panel - or
    // from after #284 - that says so is read as itself, not moved anywhere.
    const got = readWhere(JSON.stringify({ ...AT, tab: 'output' }));
    expect(got.tab).toBe('output');
    expect(got.panels).toEqual(AT.panels);
  });

  test('a size that is not a percentage drops its whole group, and the rest survive', () => {
    const got = readWhere(JSON.stringify({ ...AT, panels: { ...AT.panels, sizes: { shell: { center: 'wide' }, center: { main: 50, bottom: 50 } } } }));
    expect(got.panels.sizes).toEqual({ center: { main: 50, bottom: 50 } });
    expect(readWhere(JSON.stringify({ ...AT, panels: { sidebar: 'yes' } })).panels).toEqual({ ...OPEN_PANELS });
  });

  test('the cockpit starts from it and writes it back as it moves', () => {
    expect(cockpit).toMatch(/useState<Viewing \| null>\(\(\) => storedWhere\(\)\.viewing\)/);
    expect(cockpit).toMatch(/\(\(\) => storedWhere\(\)\.tab\)/);
    expect(cockpit).toMatch(/\(\(\) => startPanels\(storedWhere\(\)\.panels, SURFACE\.overlayPanels\)\)/);
    expect(cockpit).toMatch(/\(\(\) => storedWhere\(\)\.bottom\)/);
    // Case 2 (#347): the phone's Commands tab is the one tab never written,
    // because the record is the desktop's too and there `commands` means the
    // bottom panel. It writes the tab it was opened from; every other tab, and
    // the other four fields, are written as the cockpit holds them.
    expect(cockpit).toMatch(
      /writableWhere\(\{ tab: tab === 'commands' \? cameFrom\.current : tab, viewing, draftId, bottom, panels \}\)/,
    );
  });
});

describe('the panels a window starts with', () => {
  const kept = { sidebar: true, loop: false, bottom: true, sizes: { shell: { sidebar: 20, center: 60, loop: 20 } } };

  test('a desktop starts exactly as it was kept', () => {
    expect(startPanels(kept, false)).toBe(kept);
  });

  test('a phone starts with both side sheets shut, and keeps the rest', () => {
    expect(startPanels(kept, true)).toEqual({ ...kept, sidebar: false, loop: false });
  });
});

describe("a device's own keys (#347)", () => {
  test('the desktop keeps the key it always had', () => {
    expect(deviceKey(WHERE_KEY, undefined)).toBe(WHERE_KEY);
  });

  test('a phone keeps its own key, named by its endpoint id, so two phones never share one', () => {
    expect(deviceKey(WHERE_KEY, 'abc123')).toBe(`${WHERE_KEY}.phone.abc123`);
    expect(deviceKey(WHERE_KEY, 'abc123')).not.toBe(deviceKey(WHERE_KEY, 'def456'));
    expect(deviceKey(WHERE_KEY, 'abc123')).not.toBe(WHERE_KEY);
  });

  test('a phone that cannot say who it is keeps no key, rather than the desktop’s', () => {
    expect(deviceKey(WHERE_KEY, null)).toBeNull();
    expect(deviceKey(WHERE_KEY, '  ')).toBeNull();
  });

  test('the place, the text size and the repository are the three a device keeps, set before the cockpit mounts', () => {
    expect(cockpit).toMatch(/placeKey = deviceKey\(WHERE_KEY, device\);/);
    expect(cockpit).toMatch(/scaleKey = deviceKey\(SCALE_KEY, device\);/);
    expect(cockpit).toMatch(/repoKey = deviceKey\(REPO_KEY, device\);/);
    expect(main).toMatch(/if \(SURFACE\.ownPlace\) \{[\s\S]*keepDeviceKeys\(device\);[\s\S]*\}/);
    expect(main.indexOf('keepDeviceKeys(')).toBeLessThan(main.indexOf('createRoot('));
  });

  test('each is read and written only under its device key, and a null key writes nothing', () => {
    expect(cockpit).toMatch(/if \(placeKey === null\) return NOWHERE;/);
    expect(cockpit).toMatch(/readWhere\(memory\.getItem\(placeKey\)\)/);
    expect(cockpit).toMatch(/if \(placeKey === null\) return;\s*memory\.setItem\(\s*placeKey,/);
    expect(cockpit).toMatch(/scaleKey === null \? 1 : readScale\(memory\.getItem\(scaleKey\)\)/);
    expect(cockpit).toMatch(/if \(scaleKey === null\) return;\s*try \{\s*memory\.setItem\(scaleKey,/);
    expect(cockpit).toMatch(/if \(repoKey === null\) return;\s*try \{\s*memory\.setItem\(repoKey, dir\)/);
    // The desktop's repository seeds a phone that has named none, and is
    // never written by one.
    expect(cockpit).not.toMatch(/memory\.setItem\((WHERE_KEY|SCALE_KEY|REPO_KEY)/);
    expect(cockpit).toMatch(/memory\.getItem\(repoKey\) \?\? memory\.getItem\(REPO_KEY\)/);
  });
});
