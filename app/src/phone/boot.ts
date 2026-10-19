import type { DeviceLock } from './pairing';

/** `phone_settings`'s answer (#346). */
export interface PhoneSettings {
  lock: boolean;
  notify: boolean;
  name: string;
  deviceLock: DeviceLock;
  /** Whether the app is locked now. Rust refuses every desktop command while it is. */
  locked: boolean;
  problem: string | null;
}

/** What the phone shows first: the lock cover, or the app. Nothing else is read while locked. */
export function bootStep(settings: Pick<PhoneSettings, 'locked'>): 'locked' | 'open' {
  return settings.locked ? 'locked' : 'open';
}
