import { describe, expect, test } from 'vitest';
import cockpit from '../cockpit/Cockpit.tsx?raw';
import settings from '../cockpit/Settings.tsx?raw';
import phone from './PhoneSettings.tsx?raw';
import diagnostics from './PhoneDiagnostics.tsx?raw';
import statusBar from '../shell/StatusBar.tsx?raw';
import paneTabs from '../shell/PaneTabs.tsx?raw';

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
    expect(cockpit).toMatch(/tab === 'settings' \|\| tab === 'runs' \|\| tab === 'phone' \|\| tab === 'diagnostics'\) \? \(/);
  });

  test('are never written as the place, which the desktop shares', () => {
    expect(cockpit).toMatch(/tab: isPhoneView\(tab\) \? cameFrom\.current : tab/);
    expect(cockpit).toMatch(/tab !== 'runs' && !isPhoneView\(tab\)\) cameFrom\.current = tab;/);
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

describe("the phone's diagnostics", () => {
  test('are a screen opened by the status bar, never the popover, and the way back is Back', () => {
    expect(statusBar).toMatch(/\{!outside && SURFACE\.compactChrome && \(/);
    expect(statusBar).toMatch(/\{!outside && !SURFACE\.compactChrome && \(\s*<Popover/);
    expect(cockpit).toMatch(/onDiagnostics=\{SURFACE\.compactChrome \? \(open\) => open && openPhoneDiagnostics\(\) : setDiagnostics\}/);
    expect(cockpit).toMatch(/\{tab === 'diagnostics' && \(\s*<PhoneDiagnostics/);
  });

  test("draw the desktop's facts through the popover's own body, and the link as the desktop measured it", () => {
    expect(diagnostics).toMatch(/<Diagnostics status=\{status\} expected=\{EXPECTED_PROTOCOL\}/);
    expect(diagnostics).toMatch(/connectionOf\(remote, id\)/);
  });

  test("leave out the desktop's connected-phone chip, which on a phone names itself", () => {
    expect(cockpit).toMatch(/phones=\{SURFACE\.compactChrome \? \[\] : connectedNames\(remoteStatus\)\}/);
  });
});

describe("the phone's chrome fits its one row", () => {
  test('the spend readout never wraps, and the build stamp is left to Diagnostics', () => {
    expect(statusBar).toMatch(/shrink-0 cursor-pointer whitespace-nowrap[^"]*"\s+onClick=\{onSpend\}/);
    expect(statusBar).toMatch(/\{build !== null && !SURFACE\.compactChrome && \(/);
  });

  test("the run-status toggle is the Explorer button's size, behind a rule", () => {
    expect(cockpit).toMatch(/trail=\{[\s\S]*?<Tool label="Show run status" on=\{panels\.loop\} onClick=\{act\.toggleLoop\}>/);
    expect(paneTabs).toMatch(/border-l border-rule-inner[^"]*">\{trail\}/);
  });
});
