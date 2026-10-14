import { describe, expect, test } from 'vitest';
import cockpit from '../cockpit/Cockpit.tsx?raw';
import settings from '../cockpit/Settings.tsx?raw';
import phone from './PhoneSettings.tsx?raw';

/**
 * The phone's own settings (#347). Source-read, because the claims are about
 * wiring and the app has no jsdom.
 */
describe("the phone's own settings", () => {
  test('are reached from the head of the sidebar, on a phone only, and the way back is Back', () => {
    expect(cockpit).toMatch(/<Tool label="This phone" onClick=\{openPhone\}>/);
    // The head is drawn only on a phone.
    const head = cockpit.slice(cockpit.indexOf('{SURFACE.compactChrome && panels.sidebar && ('), cockpit.indexOf('label="This phone"'));
    expect(head).not.toBe('');
    expect(cockpit).toMatch(/tab === 'settings' \|\| tab === 'runs' \|\| tab === 'phone'\) \? \(/);
  });

  test('are never written as the place, which the desktop shares', () => {
    expect(cockpit).toMatch(/tab: tab === 'commands' \|\| tab === 'phone' \? cameFrom\.current : tab/);
    expect(cockpit).toMatch(/tab !== 'commands' && tab !== 'phone'\) cameFrom\.current = tab;/);
  });

  test('hold the text size, and the desktop’s settings on a phone do not', () => {
    expect(cockpit).toMatch(/<PhoneSettings\s+scale=\{scale\}\s+onScale=\{rescale\}/);
    expect(phone).toMatch(/STEPS\.map/);
    expect(settings).toMatch(/\{!SURFACE\.compactChrome && \(\s*<section className=\{S\.block\}>\s*<h3 className=\{S\.h\}>how this is drawn<\/h3>/);
  });

  test("show the phone's public id and nothing that could stand in for its key", () => {
    expect(phone).toMatch(/local<\{ endpointId: string \}>\('phone_identity'\)/);
    expect(phone).not.toMatch(/secret|privateKey|to_bytes/i);
  });
});
