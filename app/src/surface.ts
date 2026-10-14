/**
 * What this build of the window has that only a desktop has (#345).
 *
 * The phone runs this same cockpit, and `surface.mobile.ts` takes this module's
 * place there. Each flag is one of the engineering design's desktop-only pieces
 * that is a matter of drawing rather than of a module of its own: the folder
 * picker and the transport are swapped whole (`cockpit/pick.ts`,
 * `transport.ts`).
 *
 * - `keyboard`: the chords in `shell/actions.ts`, read off a window keydown. A
 *   phone has no keyboard to hold a modifier on.
 * - `palette`: ⌘K's command palette and the activity bar's tool for it, which
 *   exist to be reached by that chord.
 * - `tray`: the desktop's tray, whose Quit stops the app. A phone has none, so
 *   quitting the desktop app is in Settings there instead.
 * - `overlayPanels`: whether the two side columns slide OVER the main pane
 *   rather than sharing the row with it. A phone is too narrow for three
 *   resizable columns: the side panels' minimums alone exceed its width, so a
 *   panel there could be squeezed shut and then refuse to open. On a phone they
 *   start shut, one at a time, and the main pane keeps the whole width.
 */
export const SURFACE = { keyboard: true, palette: true, tray: true, overlayPanels: false } as const;
