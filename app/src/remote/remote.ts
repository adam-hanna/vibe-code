import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * The window's end of remote access (#341): the four commands and the two
 * events, typed, and nothing decided here.
 *
 * Every shape mirrors `src-tauri/src/remote/mod.rs`. **None carries the device
 * key or a pairing secret except `PairBegin.payload`**, which is the QR code's
 * text and exists to be shown; `keys.test.ts` pins the status shape.
 */

/** One paired phone. Times are milliseconds since the epoch. */
export interface PhoneStatus {
  id: string;
  name: string;
  pairedAt: number;
  /** Null until the desktop has recorded a connection. */
  lastSeen: number | null;
  connected: boolean;
}

/** What `remote_status` answers. It never fails, so `preview` always arrives. */
export interface RemoteStatus {
  /** The device's public id, or null when no key has been made yet. */
  endpointId: string | null;
  /** Why the keychain could not say, or null. */
  identityUnreadable: string | null;
  phones: PhoneStatus[];
  /** Why the list could not be read, or null. Never drawn as an empty list. */
  phonesUnreadable: string | null;
  /** Whether the section is drawn at all. */
  preview: boolean;
}

/** The QR code as modules, `true` for dark, with no quiet zone. */
export interface QrMatrix {
  size: number;
  rows: boolean[][];
}

/** A live pairing code: the QR's text, when it stops working, and the matrix. */
export interface PairBegin {
  payload: string;
  expiresAt: number;
  qr: QrMatrix;
}

/** `remote://pair-request`: *Allow `<phoneName>`?* with the six digits. */
export interface PairRequest {
  phoneName: string;
  code: string;
  expiresAt: number;
}

export type Outcome = 'paired' | 'declined' | 'expired';

/** `remote://pair-ended`, so the prompt is dismissed. */
export interface PairEnded {
  outcome: Outcome;
}

export function status(): Promise<RemoteStatus> {
  return invoke<RemoteStatus>('remote_status');
}

export function pairBegin(): Promise<PairBegin> {
  return invoke<PairBegin>('remote_pair_begin');
}

export function pairAnswer(yes: boolean): Promise<Outcome> {
  return invoke<Outcome>('remote_pair_answer', { yes });
}

export function revoke(id: string): Promise<void> {
  return invoke('remote_revoke', { id });
}

export function onPairRequest(handler: (request: PairRequest) => void): Promise<() => void> {
  return listen<PairRequest>('remote://pair-request', (event) => handler(event.payload));
}

export function onPairEnded(handler: (ended: PairEnded) => void): Promise<() => void> {
  return listen<PairEnded>('remote://pair-ended', (event) => handler(event.payload));
}
