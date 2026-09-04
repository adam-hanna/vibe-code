import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * The webview's end of the wire.
 *
 * Everything the app will ever know about a run arrives through here, as frames
 * the host process wrote and the Rust side forwarded without reading. This
 * module's whole job is to give those frames a type and hand them on.
 *
 * **It re-derives nothing.** No run state is computed here from a message, no
 * default is filled in for a field a frame did not carry, and no sentence is
 * parsed. The types below are a description of what arrives, not a second model
 * of what a run is - `src/protocol.ts` is the definition and this follows it.
 */

/** Kept in step with `PROTOCOL_VERSION` in `src/protocol.ts`. */
export const EXPECTED_PROTOCOL = 1;

export type Level = 'heading' | 'step' | 'info' | 'detail' | 'ok' | 'warn' | 'error';

export interface Narration {
  type: 'narration';
  level: Level;
  message: string;
  /** A stable identity to branch on. Null for the many lines that are only prose. */
  id: string | null;
  data: Record<string, unknown> | null;
}

export interface Ready {
  type: 'ready';
  protocol: number;
  pid: number;
}

export interface Ask {
  type: 'ask';
  id: number;
  context: {
    boundary: string;
    phase: string | null;
    planRound: number;
    reviewRound: number;
    verifyRound: number;
  };
}

export interface Result {
  type: 'result';
  id: number;
  exit: number;
}

export interface HostError {
  type: 'error';
  id: number | null;
  message: string;
}

export type Frame = Ready | Narration | Ask | Result | HostError;

/**
 * Whether a value is a frame this version recognises.
 *
 * A guard rather than a cast, and unrecognised is a legal answer. The Rust relay
 * forwards whatever the host wrote, which is right - it must not interpret - so
 * this is the first place anything checks, and a frame from a newer protocol
 * should be shown as unrecognised rather than rendered from fields it may not
 * have.
 */
export function isFrame(v: unknown): v is Frame {
  if (typeof v !== 'object' || v === null) return false;
  const type: unknown = (v as { type?: unknown }).type;
  return (
    type === 'ready' ||
    type === 'narration' ||
    type === 'ask' ||
    type === 'result' ||
    type === 'error'
  );
}

export interface Handlers {
  frame(frame: Frame): void;
  /** A frame this version does not recognise. Shown, never discarded. */
  unknown(raw: unknown): void;
  /** Host prose: its stderr, and any stdout line the relay could not parse. */
  log(line: string): void;
  /** The host ended. `code` is null where it was signalled and has none. */
  exit(code: number | null): void;
}

export interface Status {
  running: boolean;
  pid: number | null;
  /**
   * The `ready` frame, kept by the Rust side.
   *
   * The host is started as the app starts, before a webview exists to listen,
   * and a Tauri event emitted with no listener is gone. So the one frame that
   * states the protocol version is asked for rather than waited for.
   */
  ready: Ready | null;
  /** Why there is no host, when there is none. Null while one is running. */
  failure: string | null;
}

/** Whether this page is inside the desktop shell at all. */
export function inShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Start listening. Returns a function that stops.
 *
 * The host is already running by the time any of this executes - Rust starts it
 * in `setup`, because the host process is the app and its lifetime is not the
 * window's to own. So `ready` has almost certainly gone past unheard, and
 * `status()` is where it is picked up instead.
 */
export async function connect(handlers: Handlers): Promise<() => void> {
  const stops = await Promise.all([
    listen<unknown>('host://frame', (event) => {
      if (isFrame(event.payload)) handlers.frame(event.payload);
      else handlers.unknown(event.payload);
    }),
    listen<string>('host://log', (event) => handlers.log(event.payload)),
    listen<{ code: number | null }>('host://exit', (event) =>
      handlers.exit(event.payload.code),
    ),
  ]);
  return () => {
    for (const stop of stops) stop();
  };
}

/**
 * Try again after a failed launch.
 *
 * Not called on the happy path: Rust starts the host at launch. This is the
 * retry for a window showing a `failure`, and it refuses rather than restarts if
 * one is already running - a second host is a second writer, and `src/lock.ts`
 * expects one process per run.
 */
export function start(): Promise<number> {
  return invoke<number>('host_start');
}

export function status(): Promise<Status> {
  return invoke<Status>('host_status');
}

/**
 * Send one request.
 *
 * Serialised here rather than by the caller so there is one place a frame
 * becomes a line, and so the Rust relay keeps receiving a string it never has to
 * understand.
 */
export function send(request: object): Promise<void> {
  return invoke('host_send', { line: JSON.stringify(request) });
}

/** Ids the app allocates for its own requests. Gate ids come from the host. */
let nextId = 0;
export function nextRequestId(): number {
  return (nextId += 1);
}
