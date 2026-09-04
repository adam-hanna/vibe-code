import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Provider } from './keys';

/**
 * The webview's end of the pilot's wire (#143).
 *
 * The same relationship `host.ts` has to the run: **typed frames in, nothing
 * re-derived.** No usage is added up here, no reply is assembled from anything
 * but the deltas that arrived, and there is no request this module can make that
 * names a URL or carries a credential.
 *
 * **There is no command that returns a reply, and there is no command that
 * returns a key.** Sending starts a turn and returns its id; everything else
 * arrives as events. The request is made in Rust, with a key read through a
 * `pub(crate)` function nothing reachable from here can call — and the CSP says
 * the same thing from the other side, since `connect-src 'self' ipc:
 * http://ipc.localhost` means this page could not reach a vendor even holding
 * one.
 *
 * **The field names are the wire's, in both directions.** `max_tokens` and
 * `cache_read` are not renamed to camelCase on the way through, because a
 * renaming layer is a second spelling of every field and a place for the two to
 * drift. These types describe what crosses the boundary; they are not a nicer
 * model of it.
 */

/** The Tauri event every pilot event arrives on. Matches `event::EVENT` in Rust. */
export const EVENT = 'pilot://event';

/**
 * A tool the pilot may ask for, as declared to the vendor (#144).
 *
 * **Declared here and executed here.** Rust forwards the declaration and parses
 * the call; it never decides what a tool means, for the same reason the relay
 * never decides what a frame means. That is what makes "every pilot capability
 * is a host request the app already makes" structural — a tool cannot exist
 * without an implementation on this side of the wire.
 *
 * Nothing declares one yet: the table and its executor are the next step, and
 * every request this build makes carries an empty list.
 */
export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the input, passed through verbatim. */
  input_schema: unknown;
}

/** A call the model asked for, on its way back into the conversation. */
export interface AssistantCall {
  /** The vendor's own id. Opaque, and it has to come back unchanged. */
  id: string;
  name: string;
  /** Parsed, because this side had to parse it to run the call. */
  input: unknown;
}

/**
 * One message in the conversation.
 *
 * **`system` is deliberately not a role**: it is `Turn.system`, because the two
 * vendors want it in different places — Anthropic takes a top-level field,
 * OpenAI takes a message with `role: "system"` — and each adapter puts it where
 * its own vendor wants it. Rust refuses any role but these three.
 *
 * `tool` is a role, and that is #144's change: a tool result is a message, and
 * both vendors agree on that even though they disagree about the shape it takes.
 */
export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; calls?: readonly AssistantCall[] }
  | { role: 'tool'; id: string; name: string; content: string };

export interface Turn {
  provider: Provider;
  /** Named here, never defaulted in Rust: a default would go stale on the vendor's schedule. */
  model: string;
  system?: string | null;
  messages: readonly Message[];
  /** Empty on every request this build makes. See `Tool`. */
  tools?: readonly Tool[];
  /** Omitted to take Rust's default. Above its ceiling the request is refused, not clamped. */
  max_tokens?: number;
}

/**
 * What a turn spent, exactly as far as the vendor said.
 *
 * **Every field can be null, and null is never zero.** OpenAI has no cache-write
 * charge to report, so `cache_write` is null on every OpenAI turn — a different
 * fact from a cache write of zero, and it must be drawn differently.
 *
 * Each `spent` event carries the turn's **running total**, assembled in Rust
 * where the vendor difference lives: Anthropic reports usage in two events and
 * OpenAI in one, and reconciling that here would put arithmetic in the one place
 * this app does not have any.
 */
export interface Usage {
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
}

export type PilotEvent =
  | { kind: 'started'; turn: number; provider: Provider; model: string | null }
  | { kind: 'text'; turn: number; delta: string }
  /**
   * The model asked for a tool. **Arrives before the turn ends**, always.
   *
   * `arguments` is the JSON string the vendor streamed, unparsed — parsing it in
   * Rust as well would be two readings of the same bytes with two chances to
   * disagree, and this side has to parse it against the schema it declared.
   * A call whose arguments do not parse is a call that cannot be run, and that
   * is a fact worth having rather than a crash in a reducer.
   */
  | { kind: 'tool_call'; turn: number; id: string; name: string; arguments: string }
  | { kind: 'spent'; turn: number; usage: Usage }
  | { kind: 'ended'; turn: number; stop: string | null }
  | { kind: 'failed'; turn: number; message: string }
  | { kind: 'cancelled'; turn: number };

/**
 * Whether nothing further will arrive for this turn.
 *
 * Rust guarantees exactly one of these per turn and that it is the last event
 * the turn produces — which is what lets a pane stop its spinner on the first
 * one it sees without risking a cost report arriving afterwards.
 */
export function isFinal(event: PilotEvent): boolean {
  return event.kind === 'ended' || event.kind === 'failed' || event.kind === 'cancelled';
}

/**
 * Whether a value is an event this version recognises.
 *
 * A guard rather than a cast, and unrecognised is a legal answer — the same rule
 * `host.ts` follows. An event from a newer build is shown as unrecognised rather
 * than rendered out of fields it may not have.
 */
export function isPilotEvent(v: unknown): v is PilotEvent {
  if (typeof v !== 'object' || v === null) return false;
  const kind: unknown = (v as { kind?: unknown }).kind;
  if (typeof (v as { turn?: unknown }).turn !== 'number') return false;
  return (
    kind === 'started' ||
    kind === 'text' ||
    kind === 'tool_call' ||
    kind === 'spent' ||
    kind === 'ended' ||
    kind === 'failed' ||
    kind === 'cancelled'
  );
}

/** Start a turn. Returns its id; the reply arrives as events. */
export function send(turn: Turn): Promise<number> {
  return invoke<number>('pilot_send', { turn });
}

/** Ask a turn to stop. Rejects if it is not running, rather than doing nothing. */
export function cancel(turn: number): Promise<void> {
  return invoke('pilot_cancel', { turn });
}

/** Listen for events. Returns a function that stops. */
export function connect(
  on: (event: PilotEvent) => void,
  unknown?: (raw: unknown) => void,
): Promise<() => void> {
  return listen<unknown>(EVENT, (event) => {
    if (isPilotEvent(event.payload)) on(event.payload);
    else unknown?.(event.payload);
  });
}

/**
 * The models this build offers, per provider.
 *
 * Named here rather than in Rust, and sent on every request. A model compiled
 * into the crate would go stale on the vendor's schedule instead of ours, and
 * answer with something nobody chose.
 */
export const MODELS: Readonly<Record<Provider, readonly string[]>> = {
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  openai: ['gpt-5', 'gpt-5-mini'],
};
