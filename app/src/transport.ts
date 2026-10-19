/**
 * Where the window's commands go, and where its events come from (#345).
 *
 * **The one seam between the cockpit and the process it talks to.** On the
 * desktop that is this app's own Rust side, so these are Tauri's `invoke` and
 * `listen` unchanged. On the phone, `transport.mobile.ts` takes this module's
 * place at build time (`vite build --mode mobile`) and the same calls go to the
 * phone's Rust side, which carries them to a paired desktop. Every module that
 * reaches Rust imports from here, so nothing above it - `host.ts`, the pilot,
 * the cockpit, `model.ts` - can tell which side it is on.
 *
 * `local` is the exception, and the reason it is named: a few things happen on
 * the device in somebody's hand whatever it is connected to, like opening a
 * browser there. On the desktop the device is the desktop.
 */
export { invoke } from '@tauri-apps/api/core';
export { listen } from '@tauri-apps/api/event';
export { invoke as local } from '@tauri-apps/api/core';

export function confirmOnDevice(_reason: string): Promise<boolean> {
  return Promise.resolve(true);
}
