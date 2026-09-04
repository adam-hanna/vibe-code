import type { Level, Narration } from '@src/log.js';
import type { GateContext } from '@src/host.js';

/**
 * The wire between the loop and whatever is driving it (#153).
 *
 * A leaf, for the reason `@src/host.js` is one: this is the vocabulary two
 * processes agree on, and neither of them should have to import the other to
 * read it. `serve.ts` speaks it; the desktop app's Rust relay forwards it
 * without interpreting it; the webview renders from it.
 *
 * ## One object per line, both directions
 *
 * NDJSON over stdio, not a socket. This repo has no network code of its own and
 * should not grow a port, an allocation strategy and an auth story in order to
 * talk to itself - the process boundary already exists. Every frame is one JSON
 * object on one line, so a reader needs a newline split and `JSON.parse` and
 * nothing else.
 *
 * ## Every frame says what it is, and requests say which one they are
 *
 * `type` names the frame. `id` correlates a request with its reply, and it is
 * required on every frame that expects one, because **a run can reach two
 * boundaries before a slow host has answered the first**. Matching by arrival
 * order would answer the wrong question the moment the app hesitated.
 *
 * Narration carries no `id` and is never acknowledged. It is one-way by design:
 * a run that could block on a renderer is a run a hung window can stop.
 *
 * ## The version is a number, and it is checked
 *
 * `ready` states it once. A host built against a different one should say so
 * rather than guess which fields it still recognises - the same reason
 * `readDecision` refuses a `kind` it does not know instead of assuming
 * `continue`.
 */

/**
 * Bumped when an existing frame changes shape or leaves.
 *
 * Adding a new `type` is not a bump: an unrecognised frame is ignored by a
 * reader and refused by this one, and both of those are already the contract.
 */
export const PROTOCOL_VERSION = 1;

/** What the loop's process says. */
export type Outbound =
  /** First frame, before anything else. `pid` so a supervisor can act on it. */
  | { type: 'ready'; protocol: number; pid: number }
  /**
   * One `Narration`, spread rather than nested.
   *
   * Flat because everything that reads it - `state.events`, the heartbeat
   * record - is flat, and a host switching on `type` then on `id` should not
   * have to reach through a wrapper to find the second one.
   */
  | ({ type: 'narration' } & Narration)
  /** The loop is holding at a boundary. Answered by an `answer` carrying this `id`. */
  | { type: 'ask'; id: number; context: GateContext }
  /** A request finished. `exit` is the exit code the same command would have returned. */
  | { type: 'result'; id: number; exit: number }
  /**
   * A request could not be run at all.
   *
   * Distinct from a `result` with a non-zero exit, and the distinction matters:
   * a non-zero exit is a run that happened and failed, an `error` is a frame
   * this process would not act on. Only the second one means "nothing was
   * started".
   */
  | { type: 'error'; id: number | null; message: string };

/** What the thing driving the loop says. */
export type Inbound =
  /**
   * Start or resume a run, as argv.
   *
   * **Argv rather than a structured request**, and this is the load-bearing
   * decision in the file. `main(argv)` is already the one definition of what a
   * legal invocation is: which flags exist, which combinations are refused, how
   * a run directory is allocated, when the lock is taken relative to the first
   * state write. A structured `{task, model, maxTokens, ...}` request would be a
   * second definition of all of it, drifting from the first on the next flag
   * anybody adds - which is the failure #134 settled for run state and this is
   * the same failure one layer up.
   *
   * It also means the app gains every future flag for free, with no version
   * bump: the GUI's job is a form to an argv, which is a pure function it can
   * test on its own side.
   */
  | { type: 'invoke'; id: number; argv: readonly string[] }
  /** The decision for the `ask` carrying this `id`. Shape checked by `readDecision`. */
  | { type: 'answer'; id: number; decision: unknown }
  /**
   * Stop accepting requests and exit once the current one settles.
   *
   * Not a kill: an in-flight run is left to reach its own next boundary. A host
   * that wants it stopped sooner answers the next `ask` with `stop`, which is
   * the resumable ending; killing the process is the supervisor's job and is a
   * different, more expensive thing (see `@src/host.js` on pause).
   */
  | { type: 'shutdown'; id: number };

export function encode(msg: Outbound): string {
  return `${JSON.stringify(msg)}\n`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A correlation id: a finite non-negative integer, and nothing else. */
function readId(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * What a line was, or why it was not a frame.
 *
 * A discriminated result rather than a throw or a null, because the caller owes
 * the sender an `error` frame naming the reason - and "the id, if we could find
 * one" is part of that. A frame with a readable `id` and an unreadable body can
 * still be refused *to the request that sent it*, which is the difference
 * between a host seeing its request rejected and a host waiting for ever.
 */
export type Decoded =
  | { ok: true; message: Inbound }
  | { ok: false; id: number | null; reason: string };

/**
 * Read one line into the closed inbound vocabulary, or refuse it.
 *
 * **Refuse, never repair.** Every branch below that could plausibly guess -
 * an `argv` with one non-string entry, a missing `id`, a `type` from a newer
 * protocol - reports instead. The direction is the one `readDecision` already
 * points: acting on a request nobody could parse spends tokens and writes code
 * on the strength of a message that may have said the opposite.
 *
 * The decision inside an `answer` is deliberately NOT checked here. It is passed
 * through as `unknown` and narrowed by `readDecision`, which is the one place
 * that vocabulary is defined; checking it twice would be two definitions of a
 * legal decision, in two files, disagreeing eventually.
 */
export function decode(line: string): Decoded {
  const trimmed = line.trim();
  if (trimmed === '') return { ok: false, id: null, reason: 'empty line' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { ok: false, id: null, reason: 'not JSON' };
  }
  if (!isRecord(parsed)) return { ok: false, id: null, reason: 'not a JSON object' };

  const id = readId(parsed['id']);
  const type = parsed['type'];
  if (typeof type !== 'string') return { ok: false, id, reason: 'no type' };
  if (id === null) {
    return { ok: false, id: null, reason: `"${type}" carried no id, so it cannot be answered` };
  }

  switch (type) {
    case 'invoke': {
      const argv = parsed['argv'];
      if (!Array.isArray(argv)) return { ok: false, id, reason: 'invoke carried no argv' };
      // Every entry, not just the array: one number among the strings would
      // reach `parseArgs` as a value it never has to handle today.
      if (!argv.every((a): a is string => typeof a === 'string')) {
        return { ok: false, id, reason: 'invoke argv held something that was not a string' };
      }
      return { ok: true, message: { type: 'invoke', id, argv } };
    }
    case 'answer':
      return { ok: true, message: { type: 'answer', id, decision: parsed['decision'] } };
    case 'shutdown':
      return { ok: true, message: { type: 'shutdown', id } };
    default:
      return {
        ok: false,
        id,
        reason: `"${type}" is not a request this version understands`,
      };
  }
}

/**
 * Split a byte stream into lines.
 *
 * A frame is not a chunk: a pipe splits wherever it likes, and a 4KB plan
 * summary in a narration message arrives in pieces. The remainder is held until
 * its newline arrives, which is the whole job.
 *
 * A line longer than `maxLineBytes` is dropped along with the buffer, and the
 * drop is reported rather than silently swallowed. Without a ceiling, a sender
 * that never emits a newline is an unbounded allocation on the receiving side,
 * and the receiving side here is the process holding the run.
 */
export function createLineReader(
  onLine: (line: string) => void,
  onOverflow?: (bytes: number) => void,
  maxLineBytes = 1_000_000,
): (chunk: string) => void {
  let buffer = '';
  return (chunk: string): void => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      onLine(line);
      nl = buffer.indexOf('\n');
    }
    if (buffer.length > maxLineBytes) {
      const dropped = buffer.length;
      buffer = '';
      onOverflow?.(dropped);
    }
  };
}

/** Narration levels, so a host can be exhaustive over them without importing the loop. */
export const LEVELS: readonly Level[] = [
  'heading',
  'step',
  'info',
  'detail',
  'ok',
  'warn',
  'error',
];
