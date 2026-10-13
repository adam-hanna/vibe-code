import type { PairRequest, PhoneStatus, QrMatrix, RemoteStatus } from './remote';

/**
 * What the window decides about remote access, and nothing it could get wrong
 * (#341). Pure, for `model.ts`'s reason: the app has no jsdom, so a rule in a
 * component is a rule nothing tests.
 */

/**
 * Whether the Remote access section is drawn at all. **The one gate**: every
 * piece of it - the status, an error, a refused pairing - is behind this, so a
 * build with the preview off shows nothing new whatever the status says.
 */
export function remoteVisible(status: RemoteStatus | null): boolean {
  return status?.preview === true;
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
