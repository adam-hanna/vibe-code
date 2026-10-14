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
  /** The endpoint a phone dials. `off` whenever `preview` is false. */
  endpoint: EndpointReport;
}

/** One home relay, as the endpoint sees it. `error` is iroh's own text. */
export interface RelayInfo {
  url: string;
  connected: boolean;
  error: string | null;
}

/** How a connected phone's traffic is travelling right now. */
export type PathKind = 'direct' | 'relay' | 'none';

export interface LinkInfo {
  id: string;
  path: PathKind;
}

/** Where the endpoint is, read off iroh when `remote_status` was asked. */
export type EndpointReport =
  | { state: 'off' }
  | { state: 'noKey' }
  | { state: 'starting' }
  | { state: 'up'; relays: RelayInfo[]; links: LinkInfo[] }
  | { state: 'failed'; reason: string };

/**
 * The diagnostics' sentence for the endpoint, or null when there is nothing to
 * say because remote access is off.
 *
 * **Whether a phone reaches this desktop directly is said only of a phone that
 * is connected**, because only a connection has a path to measure. With none,
 * the sentence says so rather than guessing from the network.
 */
export function endpointNote(report: EndpointReport): string | null {
  switch (report.state) {
    case 'off':
      return null;
    case 'noKey':
      return 'on, and waiting for a device key: the first pairing code makes one, and the endpoint starts then';
    case 'starting':
      return 'starting';
    case 'failed':
      return `could not start: ${report.reason}`;
    case 'up': {
      const relay = report.relays[0];
      const relayPart =
        relay === undefined
          ? 'no home relay chosen yet'
          : relay.connected
            ? `home relay ${relay.url}`
            : `home relay ${relay.url} not connected${relay.error === null ? '' : `: ${relay.error}`}`;
      const counts = { direct: 0, relay: 0, none: 0 };
      for (const link of report.links) counts[link.path] += 1;
      const phones =
        report.links.length === 0
          ? 'no phone connected, so no path to report'
          : [
              counts.direct > 0 ? `${String(counts.direct)} direct` : null,
              counts.relay > 0 ? `${String(counts.relay)} only through the relay` : null,
              counts.none > 0 ? `${String(counts.none)} between paths` : null,
            ]
              .filter((part): part is string => part !== null)
              .join(', ') + (report.links.length === 1 ? ' (1 phone)' : ` (${String(report.links.length)} phones)`);
      return `up · ${relayPart} · ${phones}`;
    }
  }
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
