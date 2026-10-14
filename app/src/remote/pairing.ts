import type { PairRequest, PathKind, PhoneStatus, QrMatrix, RemoteStatus } from './remote';

/**
 * What the window decides about remote access, and nothing it could get wrong
 * (#341, #344). Pure, for `model.ts`'s reason: the app has no jsdom, so a rule
 * in a component is a rule nothing tests.
 */

/**
 * The paired phones connected now, by the name on the paired list - never a
 * name a phone sent when it connected. Empty draws no chip.
 */
export function connectedNames(status: RemoteStatus | null): string[] {
  if (status === null) return [];
  return status.phones.filter((p) => p.connected).map((p) => p.name);
}

/** How a connected phone is travelling, in the diagnostics' words. */
const PATH_WORDS: Record<PathKind, string> = {
  direct: 'direct',
  relay: 'through the relay',
  none: 'between paths',
};

/**
 * Every connected phone with its path, from the endpoint's own links. The name
 * comes from the paired list; a link the list does not name is shown as its id
 * rather than given a name nobody chose.
 */
export function linkRows(status: RemoteStatus | null): { id: string; name: string; path: string }[] {
  if (status === null || status.endpoint.state !== 'up') return [];
  const phones = status.phones;
  return status.endpoint.links.map((link) => ({
    id: link.id,
    name: phones.find((p) => p.id === link.id)?.name ?? link.id,
    path: PATH_WORDS[link.path],
  }));
}

/**
 * How this phone reaches the desktop, for the phone's diagnostics (#347): the
 * path the **desktop** measured for this phone's link, matched by the phone's
 * own id. The phone's end of the connection is not measured in this build, so
 * the desktop's reading is the one there is, and the note says whose it is.
 * Each way of not knowing says which it is; none is drawn as `direct`.
 */
export function connectionOf(
  status: RemoteStatus | null,
  phoneId: string | null,
): { value: string | null; note: string } {
  if (phoneId === null) return { value: null, note: 'this phone has no id to find its connection by' };
  if (status === null) return { value: null, note: 'the desktop has not said how this phone reaches it' };
  if (status.endpoint.state !== 'up') {
    return { value: null, note: 'the desktop reports its remote endpoint is not up, so it measures no connection' };
  }
  const link = status.endpoint.links.find((l) => l.id === phoneId);
  if (link === undefined) return { value: null, note: 'the desktop lists no connection from this phone' };
  const note =
    link.path === 'none'
      ? 'as the desktop measures it: the connection is moving between paths'
      : link.path === 'relay'
        ? 'as the desktop measures it. Relayed is not an error: it works, a little slower than direct'
        : 'as the desktop measures it';
  return { value: PATH_WORDS[link.path], note };
}

/** The phones turning remote access off would drop. Empty asks nothing. */
export function offNeedsConfirm(status: RemoteStatus): string[] {
  return connectedNames(status);
}

/**
 * Start at login is drawn as the system reports it. This is the sentence
 * beside it when that is not what the settings file says, or when the system
 * could not say - somebody may have removed the entry by hand.
 */
export function loginSentence(status: RemoteStatus): string | null {
  const { enabled, error } = status.startAtLogin;
  if (enabled === null) {
    return `The system could not say whether Vibe starts at login${error === null ? '.' : `: ${error}`}`;
  }
  if (error !== null) return error;
  if (enabled !== status.settings.startAtLogin) {
    return enabled
      ? 'The system starts Vibe at login, though it was last turned off here.'
      : 'The system no longer starts Vibe at login - the entry may have been removed by hand.';
  }
  return null;
}

/** The pairing prompt: nothing, or a phone waiting for a yes or a no. */
export type PromptState = { kind: 'none' } | { kind: 'asking'; request: PairRequest };

export type PromptEvent =
  | { kind: 'request'; request: PairRequest }
  | { kind: 'ended' }
  | { kind: 'tick'; now: number }
  | { kind: 'close' };

export const NO_PROMPT: PromptState = { kind: 'none' };

/**
 * One step of the prompt.
 *
 * **Rust has no timer**, so the window closes an unanswered prompt itself when
 * its clock reaches `expiresAt`, which the request already carries as an
 * absolute time. Any `pair-ended` closes it, whatever the outcome - including
 * a pairing whose write failed, whose sentence is shown in Settings instead.
 */
export function promptStep(state: PromptState, event: PromptEvent): PromptState {
  switch (event.kind) {
    case 'request':
      return { kind: 'asking', request: event.request };
    case 'ended':
    case 'close':
      return NO_PROMPT;
    case 'tick':
      return state.kind === 'asking' && promptClosesIn(state.request.expiresAt, event.now) <= 0
        ? NO_PROMPT
        : state;
  }
}

/** Milliseconds until a prompt closes; zero or less means now. */
export function promptClosesIn(expiresAt: number, now: number): number {
  return expiresAt - now;
}

/** The dark modules, offset by a quiet zone, and the side of the whole square. */
export function qrRects(m: QrMatrix, quiet = 4): { size: number; cells: { x: number; y: number }[] } {
  const cells: { x: number; y: number }[] = [];
  m.rows.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) cells.push({ x: x + quiet, y: y + quiet });
    }),
  );
  return { size: m.size + 2 * quiet, cells };
}

/** An absolute local clock time, which is what an expiry has to be shown as. */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** A date and time, for when a phone was paired or last connected. */
export function when(ms: number): string {
  return new Date(ms).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export interface PhoneRow {
  id: string;
  name: string;
  pairedAt: string;
  lastConnected: string;
  connected: string;
}

/**
 * The paired-phones list as rows, or the reason there is none to draw.
 *
 * **An unreadable list is never rows**: drawn as *no phones paired* it would
 * tell somebody whose phones are all still paired that none are.
 */
export function phoneRows(status: RemoteStatus): { unreadable: string } | { rows: PhoneRow[] } {
  if (status.phonesUnreadable !== null) return { unreadable: status.phonesUnreadable };
  return {
    rows: status.phones.map((p: PhoneStatus) => ({
      id: p.id,
      name: p.name,
      pairedAt: when(p.pairedAt),
      lastConnected: p.lastSeen === null ? 'never' : when(p.lastSeen),
      connected: p.connected ? 'connected' : 'not connected',
    })),
  };
}
