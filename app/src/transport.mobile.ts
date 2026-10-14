import { invoke as tauri } from '@tauri-apps/api/core';
import type { InvokeArgs } from '@tauri-apps/api/core';

/**
 * The phone's half of `transport.ts` (#345), swapped in by `vite build --mode
 * mobile`.
 *
 * **Every command is the desktop's**, so each one is wrapped as a
 * `remote_call` naming it, and the phone's Rust side carries it over the
 * connection and hands back the desktop's answer, or its refusal, unchanged.
 * The phone does not check the command against anything: the desktop's allowed
 * list is the one that decides (#343), and a second list here would be a second
 * answer.
 *
 * **Events are local.** The phone's Rust side re-emits each event the desktop
 * sent under the desktop's own name, so `listen` is Tauri's.
 *
 * `local` reaches the phone's own commands - the ones about the device in
 * somebody's hand rather than about the desktop.
 */
export function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  return tauri<T>('remote_call', { command, args: args ?? {} });
}

export { listen } from '@tauri-apps/api/event';
export { tauri as local };
