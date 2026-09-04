import { isFinal } from './pilot';
import type { PilotEvent, Message, Usage } from './pilot';
import type { Provider } from './keys';

/**
 * The pilot conversation, assembled from events and from nothing else (#143).
 *
 * Pure, for the reason `cockpit/model.ts` is: this is where a bug would
 * otherwise be invisible, and the components have no tests by design. Every
 * field below came off the wire — no cost is added up here, no reply is
 * assembled from anything but the deltas that arrived, and a turn's outcome is
 * the terminal event the turn actually produced.
 *
 * **What this is not.** It is not the designed pilot chat. There is no tool
 * call, nothing reaches the loop, and no token counted here goes anywhere near
 * `budget.maxTokens` — those are #144 and #145, and #145 is the one with the
 * sharp constraint: a pilot's dollars are real money where a run's, on a
 * subscription, are documented as *"NOT money"*.
 */

/** How a turn ended, in the vendor's own word or the failure's own sentence. */
export type Outcome =
  | { kind: 'ended'; stop: string | null }
  | { kind: 'failed'; message: string }
  | { kind: 'cancelled' };

export interface Reply {
  turn: number;
  provider: Provider;
  /** What the vendor said answered, which is not always what was asked for. */
  model: string | null;
  /** The deltas, in order, concatenated. Never a summary and never trimmed. */
  text: string;
  /** The latest running total the vendor reported. Null until it reports one. */
  usage: Usage | null;
  /** Null while the turn is still streaming. */
  outcome: Outcome | null;
}

export interface Conversation {
  /** What has been said, in order. A reply joins this when its turn ends. */
  messages: readonly Message[];
  /** The turn in flight, or null. */
  live: Reply | null;
  /** Replies in the order they were made, including failed and cancelled ones. */
  replies: readonly Reply[];
  /** Events this build did not recognise. Counted, never discarded silently. */
  unknown: number;
}

export function emptyConversation(): Conversation {
  return { messages: [], live: null, replies: [], unknown: 0 };
}

/**
 * Add what the user just said, and open a turn for the answer.
 *
 * The message is appended **before** the request is sent, so the transcript
 * shows what was asked even if the request is refused a moment later. A
 * transcript that only recorded successful turns would be missing exactly the
 * ones somebody needs to look at.
 */
export function ask(
  conversation: Conversation,
  content: string,
  turn: number,
  provider: Provider,
): Conversation {
  return {
    ...conversation,
    messages: [...conversation.messages, { role: 'user', content }],
    live: { turn, provider, model: null, text: '', usage: null, outcome: null },
  };
}

/**
 * A turn that was refused before it started.
 *
 * `pilot_send` validates and can reject without ever emitting an event — an
 * unusable request, a keychain that will not open — so this is the one outcome
 * that never arrives on the wire. It is recorded as a reply rather than shown
 * as a toast, because a refusal is part of the conversation's history and a
 * toast is not.
 */
export function refuse(
  conversation: Conversation,
  content: string,
  provider: Provider,
  message: string,
): Conversation {
  const reply: Reply = {
    // Negative, so it can never collide with an id Rust handed out — those
    // start at 1 and only go up. A refused turn has no id because it never
    // reached the point of being given one.
    turn: -(conversation.replies.length + 1),
    provider,
    model: null,
    text: '',
    usage: null,
    outcome: { kind: 'failed', message },
  };
  return {
    ...conversation,
    messages: [...conversation.messages, { role: 'user', content }],
    live: null,
    replies: [...conversation.replies, reply],
  };
}

/** Fold one event into the conversation. */
export function reduce(conversation: Conversation, event: PilotEvent): Conversation {
  const live = conversation.live;
  // An event for a turn that is not the live one. Dropped rather than applied
  // to whatever happens to be open: `serve.ts`-style, one at a time, and an
  // event that cannot be attributed is not recorded.
  if (live === null || event.turn !== live.turn) return conversation;

  if (event.kind === 'started') {
    return { ...conversation, live: { ...live, model: event.model } };
  }
  if (event.kind === 'text') {
    return { ...conversation, live: { ...live, text: live.text + event.delta } };
  }
  if (event.kind === 'spent') {
    // Replaced, never accumulated. Each event carries the turn's running total,
    // assembled in Rust where the vendor difference lives.
    return { ...conversation, live: { ...live, usage: event.usage } };
  }
  if (!isFinal(event)) return conversation;

  const outcome: Outcome =
    event.kind === 'ended'
      ? { kind: 'ended', stop: event.stop }
      : event.kind === 'failed'
        ? { kind: 'failed', message: event.message }
        : { kind: 'cancelled' };
  const done: Reply = { ...live, outcome };

  return {
    ...conversation,
    live: null,
    replies: [...conversation.replies, done],
    // Only a reply with something in it joins the conversation the next turn is
    // sent. A failed turn produced no assistant message, and sending an empty
    // one would have the vendor answer a conversation that never happened.
    messages:
      done.text === ''
        ? conversation.messages
        : [...conversation.messages, { role: 'assistant', content: done.text }],
  };
}

/** Note an event this build did not recognise. Shown, never discarded. */
export function unrecognised(conversation: Conversation): Conversation {
  return { ...conversation, unknown: conversation.unknown + 1 };
}

/**
 * The usage line, as parts that were actually reported.
 *
 * **An absent count is left out rather than drawn as a zero**, which is the same
 * rule the running row follows for a context window it was never told. OpenAI
 * never reports a cache write, so that part is simply missing from an OpenAI
 * line — and a reader can tell the difference between "no cache write" and "a
 * cache write of zero", which is the entire point.
 */
export function spendParts(usage: Usage): readonly string[] {
  const parts: string[] = [];
  if (usage.input !== null) parts.push(`${usage.input} in`);
  if (usage.output !== null) parts.push(`${usage.output} out`);
  if (usage.cache_read !== null) parts.push(`${usage.cache_read} cache read`);
  if (usage.cache_write !== null) parts.push(`${usage.cache_write} cache write`);
  return parts;
}
