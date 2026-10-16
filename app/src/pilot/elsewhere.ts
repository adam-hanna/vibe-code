import type { Backend } from './backend';
import type { Reply } from './transcript';

/**
 * A pilot turn another client started in the conversation on screen (#371).
 *
 * A message sent from the phone was answered on the desktop's host and drawn on
 * the phone alone; the desktop showed it only once the reply was saved, and
 * then only after somebody switched chats. The host now says a turn has begun
 * and which conversation it continues (`pilot_started`), and every delta was
 * already reaching every client - so a pane showing that conversation draws the
 * message, the thinking and the reply as it arrives, and keeps its composer
 * shut until it ends, since the host would refuse a second turn there anyway.
 *
 * **It is drawn and never kept.** The client that asked owns the turn: it folds
 * the reply into the conversation and saves it, and that save reaches this pane
 * as a changed conversation. Until then the turn stays on screen, ended, so the
 * answer does not blink out between its last delta and the save. A save that
 * never comes - the asking client gone mid-turn - lets go of it after
 * `LINGER_MS`, a choice and not a measurement.
 *
 * Pure, because the app has no jsdom: the pane feeds it frames and a clock.
 */
export interface Elsewhere {
  id: number;
  chat: string;
  asked: string;
  startedAt: number;
  text: string;
  /** When its last frame arrived, or null while it runs. */
  endedAt: number | null;
  /** How it ended, for the card: answered, stopped or failed. */
  ending: 'answered' | 'stopped' | 'failed' | null;
}

/** How long an ended turn waits for the asker's save before it is let go. */
export const LINGER_MS = 15_000;

/** A turn announced for `chat`, unless this client asked for it. */
export function startElsewhere(
  turn: { id: number; chat: string; asked: string; startedAt: number; text?: string },
  chat: string | null,
  mine: (id: number) => boolean,
): Elsewhere | null {
  if (mine(turn.id) || chat === null || turn.chat !== chat) return null;
  return {
    id: turn.id,
    chat: turn.chat,
    asked: turn.asked,
    startedAt: turn.startedAt,
    text: turn.text ?? '',
    endedAt: null,
    ending: null,
  };
}

type Frame =
  | { type: 'pilot_delta'; id: number; text: string }
  | { type: 'pilot_reply'; id: number; text: string }
  | { type: 'pilot_stopped'; id: number }
  | { type: 'error'; id: number | null };

/** One of its frames. A frame for any other turn changes nothing. */
export function foldElsewhere(turn: Elsewhere, frame: Frame, now: number): Elsewhere {
  if (frame.id !== turn.id || turn.endedAt !== null) return turn;
  switch (frame.type) {
    case 'pilot_delta':
      return { ...turn, text: turn.text + frame.text };
    case 'pilot_reply':
      // The final message replaces the deltas, as it does in the asker's pane.
      return { ...turn, text: frame.text, endedAt: now, ending: 'answered' };
    case 'pilot_stopped':
      return { ...turn, endedAt: now, ending: 'stopped' };
    case 'error':
      return { ...turn, endedAt: now, ending: 'failed' };
  }
}

/** Whether it has gone: its conversation was saved since it ended, or it waited long enough. */
export function letGo(turn: Elsewhere, savedSince: boolean, now: number): boolean {
  if (turn.endedAt === null) return false;
  return savedSince || now - turn.endedAt >= LINGER_MS;
}

/** Whether a send must wait: a turn is still being written here by another client. */
export function holdsComposer(turn: Elsewhere | null): boolean {
  return turn !== null && turn.endedAt === null;
}

/** As the card the asker draws, so both screens show one turn the same way. */
export function asReply(turn: Elsewhere, provider: Backend): Reply {
  return {
    turn: turn.id,
    provider,
    model: null,
    text: turn.text,
    calls: [],
    usage: null,
    outcome:
      turn.ending === null
        ? null
        : turn.ending === 'answered'
          ? { kind: 'ended', stop: null }
          : turn.ending === 'stopped'
            ? { kind: 'cancelled' }
            : { kind: 'failed', message: 'the reply could not be written' },
    asked: turn.asked === '' ? null : turn.asked,
    woke: null,
    startedAt: turn.startedAt,
  };
}
