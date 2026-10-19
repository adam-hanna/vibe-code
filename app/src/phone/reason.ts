/**
 * Why the phone is not connected to a desktop, or why a pairing ended (#346),
 * as the phone's Rust says it: `vibe_remote::client::Reason`, serialised with a
 * `kind` tag. Closed - `sentences.ts` has one sentence per kind and a `never`
 * check, so a new kind fails to compile rather than drawing nothing.
 */
export type Reason =
  | { kind: 'notPaired' }
  | { kind: 'remoteOff' }
  | { kind: 'versionMismatch'; desktopAppVersion: string | null; phoneAppVersion: string }
  | { kind: 'unreachable' }
  | { kind: 'offline' }
  | { kind: 'relaysUnreachable' }
  | { kind: 'pairRefused'; reason: string }
  | { kind: 'pairDeclined' }
  | { kind: 'pairCancelled' }
  | { kind: 'phoneListUnreadable'; why: string }
  | { kind: 'pairedNotSaved'; desktopName: string | null; why: string };

/** One paired desktop, as `phone_desktops` lists it. */
export interface DesktopEntry {
  id: string;
  relay: string | null;
  desktopName: string | null;
  /** The person's own name for it. Never sent to the desktop. */
  name: string | null;
  pairedAt: number;
  lastSeen: number | null;
}

/** How a desktop that is not the open one was last found. */
export type Reach =
  | { state: 'open' }
  | { state: 'unchecked' }
  | { state: 'checking' }
  | { state: 'reachable' }
  | { state: 'down'; reason: Reason };

export type Phase = 'idle' | 'connecting' | 'up' | 'down';
export type Path = 'direct' | 'relayed' | 'none';

/** The open desktop's connection. */
export interface LinkInfo {
  id: string | null;
  phase: Phase;
  reason: Reason | null;
  path: Path;
  connectMs: number | null;
}

export interface Desktops {
  desktops: readonly (DesktopEntry & { reach: Reach })[];
  /** Why the list could not be read. Never drawn as an empty list. */
  problem: string | null;
  current: string | null;
  link: LinkInfo | null;
}

/** What this phone calls a desktop: the person's name, else the desktop's own, else its id cut short. */
export function called(d: Pick<DesktopEntry, 'name' | 'desktopName' | 'id'>): string {
  return d.name ?? d.desktopName ?? d.id.slice(0, 10);
}
