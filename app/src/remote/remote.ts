import { confirmed } from '../confirm';
import { invoke, listen } from '../transport';

/**
 * The window's end of remote access (#341, #344): the five commands and the
 * three events, typed, and nothing decided here.
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

/** What `remote_status` and `remote_set` answer. It never fails. */
export interface RemoteStatus {
  /** The device's public id, or null when no key has been made yet. */
  endpointId: string | null;
  /** Why the keychain could not say, or null. */
  identityUnreadable: string | null;
  phones: PhoneStatus[];
  /** Why the list could not be read, or null. Never drawn as an empty list. */
  phonesUnreadable: string | null;
  /** `remote.json` as read - all off when it could not be. */
  settings: RemoteSettings;
  /** Why `remote.json` could not be read, which is why remote access is off. */
  settingsUnreadable: string | null;
  /** What the system says about start at login, which wins over the file. */
  startAtLogin: LoginReport;
  /** Whether keep awake holds the system awake now, and why it could not. */
  awake: AwakeReport;
  /** The endpoint a phone dials. `off` whenever the switch is. */
  endpoint: EndpointReport;
}

/** The four settings in `remote.json`, a file Rust owns (#344). */
export interface RemoteSettings {
  enabled: boolean;
  startAtLogin: boolean;
  keepAwake: boolean;
  /** An https URL naming a relay of one's own, or null for n0's. */
  relay: string | null;
}

/** A change to some of them. `relay: null` clears it; an absent field is left alone. */
export type RemotePatch = Partial<RemoteSettings>;

/** Start at login as the system reports it. `enabled` is null when it could not say. */
export interface LoginReport {
  enabled: boolean | null;
  error: string | null;
}

export interface AwakeReport {
  held: boolean;
  error: string | null;
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

/** A yes is asked on the device first (#346); a no never is. */
export async function pairAnswer(yes: boolean): Promise<Outcome> {
  if (yes) await confirmed('Pair a phone');
  return invoke<Outcome>('remote_pair_answer', { yes });
}

/** Asked on the device first (#346). */
export async function revoke(id: string): Promise<void> {
  await confirmed('Unpair a phone');
  await invoke('remote_revoke', { id });
}

/**
 * Change the settings. Rust writes `remote.json`, applies it, and answers with
 * the status that follows - from the window, once the endpoint has settled.
 */
export function set(patch: RemotePatch): Promise<RemoteStatus> {
  return invoke<RemoteStatus>('remote_set', { patch });
}

/**
 * `remote://connections`: a paired phone connected or went. It carries
 * nothing - re-read `status()`, so there is one source for who is connected.
 */
export function onConnections(handler: () => void): Promise<() => void> {
  return listen<null>('remote://connections', () => handler());
}

export function onPairRequest(handler: (request: PairRequest) => void): Promise<() => void> {
  return listen<PairRequest>('remote://pair-request', (event) => handler(event.payload));
}

export function onPairEnded(handler: (ended: PairEnded) => void): Promise<() => void> {
  return listen<PairEnded>('remote://pair-ended', (event) => handler(event.payload));
}

/** A subscription, as `onConnections` and its siblings return one. */
export type Subscribe = (handler: () => void) => Promise<() => void>;

/** Following `remote_status`: re-read it, or take an answer that carries it. */
export interface Follower {
  /** Read the status again. Any read started before this one is ignored. */
  refresh(): void;
  /** A status that came back from a change: drawn, then read once more. */
  accept(next: RemoteStatus): void;
  stop(): void;
}

/**
 * Follow `remote_status` on pushed events (#344). Two rules, both about a
 * snapshot that would otherwise go stale with no later event to correct it:
 *
 * - **Subscribe, then read.** The first read starts only once every listener
 *   is installed, so an event between the read and the subscription is not
 *   lost.
 * - **Only the newest read is drawn.** Every read takes a number, and an
 *   answer to any but the newest is dropped, so two events in quick succession
 *   cannot resolve out of order and leave the older snapshot on screen. A
 *   change's own answer is drawn and then read once more, because an event may
 *   have arrived after Rust took it.
 */
export function followStatus(
  onStatus: (status: RemoteStatus | null) => void,
  events: Subscribe[],
  read: () => Promise<RemoteStatus> = status,
): Follower {
  let latest = 0;
  let live = true;
  const refresh = () => {
    const mine = ++latest;
    const settle = (s: RemoteStatus | null) => {
      if (live && mine === latest) onStatus(s);
    };
    // A rejection is the IPC itself failing - the command never refuses.
    read().then(settle, () => settle(null));
  };
  const stops = events.map((on) => on(() => live && refresh()));
  void Promise.all(stops).then(
    () => live && refresh(),
    () => live && refresh(),
  );
  return {
    refresh,
    accept(next) {
      if (!live) return;
      ++latest;
      onStatus(next);
      refresh();
    },
    stop() {
      live = false;
      for (const s of stops) void s.then((f) => f(), () => undefined);
    },
  };
}
