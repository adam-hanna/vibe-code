import type { DesktopEntry, Reason } from './reason';

/**
 * The pairing screen's states (#346), as a pure step so every path through it
 * is tested without a camera.
 *
 * The order is the wire's: confirm on the device, name this phone, scan, then
 * dial. The six digits arrive on `phone://pair-code` **while** `phone_pair` is
 * still waiting for the desktop's answer, and carry the screen's own `attempt`
 * number, so a code from an earlier scan is never drawn.
 *
 * After Back, the screen ignores what the desktop says - except the two
 * outcomes in which the desktop has already paired this phone: `ok`, because
 * the phone committed an answer it had already read, and `pairedNotSaved`,
 * because the desktop holds this phone and the person has to be told how to
 * recover.
 */
export type PairState =
  | { step: 'confirming' }
  | { step: 'naming' }
  | { step: 'scanning' }
  | { step: 'dialling'; attempt: number }
  | { step: 'code'; attempt: number; digits: string }
  | { step: 'done'; entry: DesktopEntry }
  | { step: 'failed'; reason: Reason }
  | { step: 'cancelled' };

export type Outcome = { ok: DesktopEntry } | { reason: Reason };

export type PairInput =
  | { type: 'confirmed' }
  | { type: 'named' }
  | { type: 'scanned'; attempt: number }
  | { type: 'code'; attempt: number; code: string }
  | { type: 'outcome'; attempt: number; outcome: Outcome }
  | { type: 'back' }
  | { type: 'failed'; reason: Reason };

function attemptOf(state: PairState): number | null {
  return state.step === 'dialling' || state.step === 'code' ? state.attempt : null;
}

export function pairStep(state: PairState, input: PairInput): PairState {
  switch (input.type) {
    case 'confirmed':
      return state.step === 'confirming' ? { step: 'naming' } : state;
    case 'named':
      return state.step === 'naming' ? { step: 'scanning' } : state;
    case 'scanned':
      return state.step === 'scanning' ? { step: 'dialling', attempt: input.attempt } : state;
    case 'code':
      return state.step === 'dialling' && state.attempt === input.attempt
        ? { step: 'code', attempt: input.attempt, digits: input.code }
        : state;
    case 'outcome': {
      const { outcome } = input;
      if (state.step === 'cancelled') {
        if ('ok' in outcome) return { step: 'done', entry: outcome.ok };
        if (outcome.reason.kind === 'pairedNotSaved') return { step: 'failed', reason: outcome.reason };
        return state;
      }
      if (attemptOf(state) !== input.attempt) return state;
      return 'ok' in outcome ? { step: 'done', entry: outcome.ok } : { step: 'failed', reason: outcome.reason };
    }
    case 'back':
      return state.step === 'dialling' || state.step === 'code' ? { step: 'cancelled' } : state;
    case 'failed':
      return state.step === 'done' ? state : { step: 'failed', reason: input.reason };
    default: {
      const never: never = input;
      return never;
    }
  }
}

/** Whether the phone has a screen lock, as `phone_settings` reads it now. */
export type DeviceLock = 'set' | 'none' | 'unknown';

/**
 * The product spec's warning for a phone with no screen lock: it may still
 * pair, and is told plainly what that means. Null when there is a lock or it
 * cannot be told.
 */
export function lockWarning(deviceLock: DeviceLock, desktop?: string): string | null {
  if (deviceLock !== 'none') return null;
  return `This phone has no screen lock, so anybody holding it can control ${desktop ?? 'your desktops'}.`;
}
