import { clock, dayOf } from '../cockpit/format';
import type { LinkInfo, Reach, Reason } from './reason';

/**
 * What the phone says when it cannot connect (#346), one sentence per reason,
 * from the product spec's "What the phone says when it cannot connect" and the
 * engineering plan's first correction to it.
 *
 * **A reset desktop has no sentence of its own**: it is indistinguishable from
 * one that is off, so *can't reach* gains *or it was reset* once the desktop has
 * gone unseen for [`RESET_HINT_AFTER_MS`].
 */

/**
 * How long a desktop must have gone unseen before *can't reach* also says *or
 * it was reset*. A choice, not a measurement: a week is longer than a holiday
 * with the desktop asleep and short enough that a desktop reinstalled last
 * month is not still described as merely off.
 */
export const RESET_HINT_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** What a sentence offers to do about it. */
export type Action = 'pairAgain' | null;

export interface Said {
  text: string;
  action: Action;
}

function lastSeen(at: number | null): string {
  return at === null ? 'Never connected.' : `Last seen ${dayOf(at)}, ${clock(at)}.`;
}

/** The sentence for a reason. `desktop` is what this phone calls it. */
export function sentence(reason: Reason, desktop: string, seenAt: number | null, now: number): Said {
  switch (reason.kind) {
    case 'notPaired':
      return { text: `${desktop} removed this phone.`, action: 'pairAgain' };
    case 'versionMismatch':
      return {
        text:
          reason.desktopAppVersion === null
            ? `${desktop} and this phone run versions of Vibe that cannot talk to each other. Update whichever is older.`
            : `${desktop} runs Vibe ${reason.desktopAppVersion} and this phone runs ${reason.phoneAppVersion}. Update whichever is older.`,
        action: null,
      };
    case 'remoteOff':
      return { text: `Remote access is off on ${desktop}. Turn it on in Settings → Remote access.`, action: null };
    case 'unreachable': {
      const reset = seenAt !== null && now - seenAt >= RESET_HINT_AFTER_MS ? ', or it was reset' : '';
      return {
        text: `Can't reach ${desktop}. It may be off, asleep or not logged in, or Vibe isn't running${reset}. ${lastSeen(seenAt)}`,
        action: null,
      };
    }
    case 'offline':
      return { text: 'This phone is offline.', action: null };
    case 'relaysUnreachable':
      return { text: "Can't reach the relay servers. Connections on the same network still work.", action: null };
    case 'pairRefused':
      return { text: `${desktop} refused the pairing: ${reason.reason}.`, action: null };
    case 'pairDeclined':
      return { text: `${desktop} did not allow this phone, or the code expired. Start again from the desktop.`, action: null };
    case 'pairCancelled':
      return {
        text: 'Cancelled. If the desktop already shows this phone as paired, remove it there or pair again.',
        action: null,
      };
    case 'phoneListUnreadable':
      return {
        text: `This phone's list of desktops can't be read (${reason.why}), so nothing was paired. The file has been left as it is.`,
        action: null,
      };
    case 'pairedNotSaved':
      return {
        text: `${reason.desktopName ?? desktop} paired with this phone, but this phone could not save it (${reason.why}). Remove this phone on the desktop, then pair again.`,
        action: null,
      };
    default: {
      const never: never = reason;
      return never;
    }
  }
}

/** A Desktops row's status line: what it shows, and whether it is an error. */
export interface RowStatus {
  text: string;
  error: boolean;
  action: Action;
}

/**
 * The status of one row. The open desktop reads its live link; any other reads
 * its last probe. **A connected link is never an error**, relayed or direct:
 * a relay is how most connections start, and it sees only ciphertext.
 */
export function rowStatus(reach: Reach, link: LinkInfo | null, desktop: string, seenAt: number | null, now: number): RowStatus {
  if (reach.state === 'open' && link !== null) {
    switch (link.phase) {
      case 'up':
        return { text: link.path === 'relayed' ? 'Connected, through a relay' : 'Connected', error: false, action: null };
      case 'connecting':
      case 'idle':
        return { text: 'Connecting…', error: false, action: null };
      case 'down': {
        if (link.reason === null) return { text: 'Not connected', error: false, action: null };
        const said = sentence(link.reason, desktop, seenAt, now);
        return { text: said.text, error: true, action: said.action };
      }
      default: {
        const never: never = link.phase;
        return never;
      }
    }
  }
  switch (reach.state) {
    case 'open':
    case 'unchecked':
      return { text: 'Not checked yet', error: false, action: null };
    case 'checking':
      return { text: 'Checking…', error: false, action: null };
    case 'reachable':
      return { text: 'Reachable', error: false, action: null };
    case 'down': {
      const said = sentence(reach.reason, desktop, seenAt, now);
      return { text: said.text, error: true, action: said.action };
    }
    default: {
      const never: never = reach;
      return never;
    }
  }
}
