/**
 * Every action the shell offers, in one table.
 *
 * The command palette lists this table and the keyboard reads it, and
 * `Cockpit` supplies a handler per id as a `Record<ActionId, () => void>` - so
 * a palette entry **cannot exist without a control**, and a shortcut cannot
 * name an action nothing handles. The compiler checks that, which is stronger
 * than a list somebody has to keep in step.
 *
 * Pure, for `model.ts`'s reason: which actions are offered in which state is a
 * decision, and a decision in a component is one nothing tests.
 */

export type ActionId =
  | 'palette'
  | 'newRun'
  | 'toggleSidebar'
  | 'toggleLoop'
  | 'toggleBottom'
  | 'settings'
  | 'diagnostics'
  | 'goPilot'
  | 'goPlans'
  | 'goCritique'
  | 'goReview'
  | 'goCode'
  | 'goQuestions'
  | 'goVerify'
  | 'goSpend'
  | 'goOutput'
  | 'goCommands'
  | 'goRuns'
  | 'pause'
  | 'unpause'
  | 'stop'
  | 'gateContinue'
  | 'gateStop'
  | 'backToLive';

export type ActionGroup = 'Go to' | 'Run' | 'View' | 'Window';

export interface Shortcut {
  /** `KeyboardEvent.code`, so the chord survives a layout where the key is not the letter. */
  code: string;
  shift: boolean;
}

export interface Action {
  id: ActionId;
  label: string;
  group: ActionGroup;
  /** With the platform's modifier held. Absent means palette-only. */
  shortcut?: Shortcut;
}

export const ACTIONS: readonly Action[] = [
  { id: 'goPilot', label: 'Pilot', group: 'Go to', shortcut: { code: 'Digit1', shift: false } },
  { id: 'goPlans', label: 'Plans', group: 'Go to', shortcut: { code: 'Digit2', shift: false } },
  { id: 'goCritique', label: 'Plan critique', group: 'Go to', shortcut: { code: 'Digit3', shift: false } },
  { id: 'goCode', label: 'Code changes', group: 'Go to', shortcut: { code: 'Digit4', shift: false } },
  { id: 'goReview', label: 'Code review', group: 'Go to', shortcut: { code: 'Digit5', shift: false } },
  { id: 'goQuestions', label: 'Questions', group: 'Go to', shortcut: { code: 'Digit6', shift: false } },
  { id: 'goVerify', label: 'Verification', group: 'Go to', shortcut: { code: 'Digit7', shift: false } },
  { id: 'goSpend', label: 'Usage', group: 'Go to', shortcut: { code: 'Digit8', shift: false } },
  { id: 'goOutput', label: 'Output', group: 'Go to' },
  { id: 'goCommands', label: 'Commands', group: 'Go to' },
  // `1b`: every run in the project with status, cost and liveness, and the one
  // control that may overrule a lock. It was a link at the foot of each project
  // in the sidebar and the owner asked for that gone; this is its only route
  // now, so `1b` is still reachable and still has no tab of its own.
  { id: 'goRuns', label: 'All runs in this project', group: 'Go to' },
  { id: 'backToLive', label: 'Back to the live run', group: 'Go to' },

  { id: 'newRun', label: 'New run…', group: 'Run', shortcut: { code: 'KeyN', shift: false } },
  { id: 'pause', label: 'Pause after this step', group: 'Run' },
  { id: 'unpause', label: 'Cancel pause', group: 'Run' },
  { id: 'stop', label: 'Stop run…', group: 'Run' },
  { id: 'gateContinue', label: 'Continue past the gate', group: 'Run' },
  { id: 'gateStop', label: 'Stop at the gate', group: 'Run' },

  { id: 'toggleSidebar', label: 'Toggle sidebar', group: 'View', shortcut: { code: 'KeyB', shift: false } },
  { id: 'toggleBottom', label: 'Toggle bottom panel', group: 'View', shortcut: { code: 'KeyJ', shift: false } },
  { id: 'toggleLoop', label: 'Toggle run status column', group: 'View', shortcut: { code: 'KeyB', shift: true } },

  { id: 'palette', label: 'Command palette', group: 'Window', shortcut: { code: 'KeyK', shift: false } },
  { id: 'settings', label: 'Settings for all projects', group: 'Window', shortcut: { code: 'Comma', shift: false } },
  { id: 'diagnostics', label: 'Diagnostics', group: 'Window', shortcut: { code: 'KeyD', shift: true } },
];

/** What the window is doing, as far as the table needs to know. */
export interface ActionContext {
  /** A run is in flight in this window - preflight or a turn. */
  live: boolean;
  /** A gate is holding and can be answered. */
  gate: boolean;
  /** A pause is armed and not yet reached, so it can be taken back (#276). */
  pausing: boolean;
  /** The window is pointed at a past run, so there is a live one to go back to. */
  past: boolean;
  /** Inside the desktop shell. A browser preview has no host and no diagnostics worth the name. */
  inShell: boolean;
}

/**
 * The actions that make sense now. An action whose precondition is false is
 * left out rather than disabled, because a palette is searched and a greyed
 * row is one more thing to read past.
 */
export function available(ctx: ActionContext): readonly Action[] {
  return ACTIONS.filter((a) => {
    switch (a.id) {
      // One of the two at a time (#276): an armed pause can be cancelled and
      // cannot be asked for again, since a second pause is the same request.
      case 'pause':
        return ctx.live && !ctx.pausing;
      case 'unpause':
        return ctx.live && ctx.pausing;
      case 'stop':
        return ctx.live;
      case 'gateContinue':
      case 'gateStop':
        return ctx.gate;
      case 'backToLive':
        return ctx.past;
      case 'diagnostics':
        return ctx.inShell;
      default:
        return true;
    }
  });
}

/** A pressed chord, as the keyboard handler reads it. */
export interface Chord {
  code: string;
  /** ⌘ on a Mac, Ctrl elsewhere. */
  mod: boolean;
  shift: boolean;
}

/** The action a chord names, or null. Only chords with the modifier held count. */
export function shortcutFor(chord: Chord): ActionId | null {
  if (!chord.mod) return null;
  const hit = ACTIONS.find((a) => a.shortcut?.code === chord.code && a.shortcut.shift === chord.shift);
  return hit?.id ?? null;
}

/** `⌘K` or `Ctrl+K`, as the palette and the tooltips print it. */
export function chordLabel(shortcut: Shortcut, platform: string): string {
  const mac = /mac|iphone|ipad/i.test(platform);
  const key = shortcut.code.startsWith('Key')
    ? shortcut.code.slice(3)
    : shortcut.code.startsWith('Digit')
      ? shortcut.code.slice(5)
      : shortcut.code === 'Comma'
        ? ','
        : shortcut.code;
  if (mac) return `⌘${shortcut.shift ? '⇧' : ''}${key}`;
  return `Ctrl+${shortcut.shift ? 'Shift+' : ''}${key}`;
}
