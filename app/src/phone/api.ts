import { local } from '../transport';
import type { PhoneSettings } from './boot';
import type { Desktops } from './reason';

/**
 * The phone's own commands (#346), the ones about the device rather than the
 * desktop, typed. `phone_settings`, `phone_open`, `phone_pair` and the pairing
 * code's event are called where they are used, so the order they are called in
 * can be read (and is pinned by `mobile.test.ts`).
 */

export function desktops(): Promise<Desktops> {
  return local<Desktops>('phone_desktops');
}

export function probe(): Promise<void> {
  return local('phone_probe');
}

export function rename(id: string, name: string | null): Promise<void> {
  return local('phone_rename', { id, name });
}

export function unpair(id: string): Promise<{ unpaired: 'sent' | 'unreachable' }> {
  return local('phone_unpair', { id });
}

export function session(): Promise<{ generation: number; idBase: number }> {
  return local('phone_session');
}

export function release(generation: number): Promise<void> {
  return local('phone_release', { generation });
}

export function setSettings(patch: Partial<Pick<PhoneSettings, 'lock' | 'notify' | 'name'>>): Promise<PhoneSettings> {
  return local<PhoneSettings>('phone_settings_set', { patch });
}

export function unlock(): Promise<boolean> {
  return local<boolean>('phone_unlock');
}

export function notify(title: string, body: string): Promise<void> {
  return local('phone_notify', { title, body });
}

export function networkChange(online: boolean): Promise<void> {
  return local('phone_network_change', { online });
}
