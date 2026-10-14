/**
 * The phone's answers to `surface.ts` (#345): none of the desktop's pieces
 * exist there, the side columns are overlays, and the chrome is one row (#347).
 */
export const SURFACE = {
  keyboard: false,
  palette: false,
  tray: false,
  overlayPanels: true,
  compactChrome: true,
} as const;
