import { isFinal } from './pilot';
import type { AssistantCall, PilotEvent, Message, Usage } from './pilot';
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

/**
 * A tool the model asked for, and whether its arguments could be read (#144).
 *
 * `input` is `undefined` when `arguments` did not parse — which is a fact worth
 * keeping rather than a crash in a reducer. A model can and does emit truncated
 * JSON when a turn hits its token ceiling mid-call, and the honest report of
 * that is a call that cannot be run, shown as such.
 */
export interface Call {
  id: string;
  name: string;
  /** Exactly what the vendor streamed. Kept even when it parsed, as the record. */
  arguments: string;
  input: unknown;
  /** Why `input` is absent, or null. Never both. */
  unreadable: string | null;
}

export interface Reply {
  turn: number;
  provider: Provider;
  /** What the vendor said answered, which is not always what was asked for. */
  model: string | null;
  /** The deltas, in order, concatenated. Never a summary and never trimmed. */
  text: string;
  /**
   * What the model asked for, in the order it asked.
   *
   * **Nothing runs these yet.** The table and its executor are the next step;
   * this build declares no tools, so the list is empty on every real turn. It
   * exists now because the adapters can already produce a call, and a call the
   * transcript dropped would be invisible rather than unimplemented.
   */
  calls: readonly Call[];
  /** The latest running total the vendor reported. Null until it reports one. */
  usage: Usage | null;
  /** Null while the turn is still streaming. */
  outcome: Outcome | null;
}

/**
 * Read a call's arguments, keeping the failure rather than throwing it.
 *
 * Exported because it is the one piece of parsing on this side of the wire and
 * it has its own cases: an empty string is a tool that takes no input, not a
 * broken call.
 */
export function readCall(id: string, name: string, args: string): Call {
  if (args.trim() === '') {
    // A tool whose schema takes no input gets no argument fragments at all.
    return { id, name, arguments: args, input: {}, unreadable: null };
  }
  try {
    return { id, name, arguments: args, input: JSON.parse(args) as unknown, unreadable: null };
  } catch (err) {
    return {
      id,
      name,
      arguments: args,
      input: undefined,
      unreadable: err instanceof Error ? err.message : String(err),
    };
  }
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
    live: { turn, provider, model: null, text: '', calls: [], usage: null, outcome: null },
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
    calls: [],
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
  if (event.kind === 'tool_call') {
    return {
      ...conversation,
      live: {
        ...live,
        calls: [...live.calls, readCall(event.id, event.name, event.arguments)],
      },
    };
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

  // Only a reply with something in it joins the conversation the next turn is
  // sent. A failed turn produced no assistant message, and sending an empty one
  // would have the vendor answer a conversation that never happened — but a turn
  // that said nothing and asked for two things is not empty, so the test is both
  // fields rather than the text alone.
  const said = done.text !== '' || done.calls.length > 0;
  return {
    ...conversation,
    live: null,
    replies: [...conversation.replies, done],
    messages: said ? [...conversation.messages, assistant(done)] : conversation.messages,
  };
}

/**
 * A finished reply, as the message the next turn sends back.
 *
 * **`calls` is omitted when there are none**, not sent as an empty array. Rust
 * defaults the field, so a conversation with no tools produces exactly the JSON
 * it produced before #144 — which is the whole claim this change is making, and
 * an empty array on every message would quietly falsify it.
 */
function assistant(reply: Reply): Message {
  const content = reply.text;
  return reply.calls.length === 0
    ? { role: 'assistant', content }
    : { role: 'assistant', content, calls: reply.calls.map(asCall) };
}

/** A recorded call in the shape the wire takes it back. */
function asCall(call: Call): AssistantCall {
  return { id: call.id, name: call.name, input: call.input };
}

/**
 * Calls that have been asked for and not answered.
 *
 * **A conversation with any of these cannot be sent.** Both vendors reject a
 * request whose assistant turn asked for a tool that no later message answers —
 * Anthropic with `tool_use ids were found without tool_result blocks`, OpenAI
 * with its own 400 — so this is a real precondition rather than a nicety, and
 * the composer reads it.
 *
 * It is always empty in this build, because nothing declares a tool. It exists
 * now so the executor has a seam to fill rather than a rule to rediscover.
 */
export function unanswered(conversation: Conversation): readonly Call[] {
  const answered = new Set(
    conversation.messages.filter((m) => m.role === 'tool').map((m) => m.id),
  );
  return conversation.replies.flatMap((reply) =>
    reply.calls.filter((call) => !answered.has(call.id)),
  );
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
