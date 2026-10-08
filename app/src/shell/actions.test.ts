import { describe, expect, test } from 'vitest';
import cockpit from '../cockpit/Cockpit.tsx?raw';
import { ACTIONS, available, chordLabel, shortcutFor } from './actions';
import type { ActionContext } from './actions';

/**
 * The shell's one action table. A palette entry cannot exist without a control
 * and a shortcut cannot name an action nothing handles - the compiler enforces
 * the second through `Record<ActionId, () => void>`, and these pin the rest.
 */

const ALL: ActionContext = { live: true, gate: true, pausing: false, past: true, inShell: true };
const NONE: ActionContext = { live: false, gate: false, pausing: false, past: false, inShell: false };

describe('the table', () => {
  test('every id appears once, and every shortcut names one action', () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const chords = ACTIONS.filter((a) => a.shortcut !== undefined).map((a) => `${a.shortcut?.code}+${String(a.shortcut?.shift)}`);
    expect(new Set(chords).size).toBe(chords.length);
  });

  test('the cockpit handles every id, by type', () => {
    // `Record<ActionId, () => void>` is what makes an unhandled id a compile
    // error rather than a palette row that does nothing.
    expect(cockpit).toMatch(/const act: Record<ActionId, \(\) => void> = \{/);
  });
});

describe('what is offered', () => {
  test('a run control needs a run, a gate control needs a gate, back-to-live needs a past run', () => {
    const none = available(NONE).map((a) => a.id);
    expect(none).not.toContain('pause');
    expect(none).not.toContain('unpause');
    expect(none).not.toContain('stop');
    expect(none).not.toContain('gateContinue');
    expect(none).not.toContain('gateStop');
    expect(none).not.toContain('backToLive');
    expect(none).not.toContain('diagnostics');
    expect(none).toContain('goPilot');
    expect(none).toContain('newRun');
    expect(none).toContain('toggleBottom');

    // Every action is reachable in SOME context. Pause and cancel-pause are
    // alternatives since #276, so no one context offers both, and the claim is
    // checked over the two that differ only in whether a pause is armed.
    const reachable = new Set([
      ...available(ALL).map((a) => a.id),
      ...available({ ...ALL, pausing: true }).map((a) => a.id),
    ]);
    expect([...reachable].sort()).toEqual(ACTIONS.map((a) => a.id).sort());
  });

  test('an armed pause can be cancelled and not asked for again (#276)', () => {
    const armed = available({ ...ALL, pausing: true }).map((a) => a.id);
    expect(armed).toContain('unpause');
    expect(armed).not.toContain('pause');
    const idle = available(ALL).map((a) => a.id);
    expect(idle).toContain('pause');
    expect(idle).not.toContain('unpause');
  });
});

describe('the keyboard', () => {
  test('reads the chord by code with the modifier held, and nothing without it', () => {
    expect(shortcutFor({ code: 'KeyK', mod: true, shift: false })).toBe('palette');
    expect(shortcutFor({ code: 'KeyK', mod: false, shift: false })).toBeNull();
    expect(shortcutFor({ code: 'KeyB', mod: true, shift: false })).toBe('toggleSidebar');
    expect(shortcutFor({ code: 'KeyB', mod: true, shift: true })).toBe('toggleLoop');
    expect(shortcutFor({ code: 'KeyD', mod: true, shift: true })).toBe('diagnostics');
    expect(shortcutFor({ code: 'KeyZ', mod: true, shift: false })).toBeNull();
  });

  test('prints the chord for the platform', () => {
    expect(chordLabel({ code: 'KeyK', shift: false }, 'MacIntel')).toBe('⌘K');
    expect(chordLabel({ code: 'KeyB', shift: true }, 'Linux x86_64')).toBe('Ctrl+Shift+B');
    expect(chordLabel({ code: 'Comma', shift: false }, 'Win32')).toBe('Ctrl+,');
    expect(chordLabel({ code: 'Digit3', shift: false }, 'MacIntel')).toBe('⌘3');
  });
});
