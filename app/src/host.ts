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
    /** Beside the other three since #140, which is what made `question-round` holdable. */
    questionRound: number;
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

/** A fragment of a pilot reply, in order (#193). */
export interface PilotDelta {
  type: 'pilot_delta';
  id: number;
  text: string;
}

/**
 * A pilot turn finished.
 *
 * **No money on it, and nowhere to put any.** A subscription turn bills nothing
 * at all, so a dollar figure would have no quantity to be an estimate *of* —
 * the same sentence that makes Codex cost unreportable. The tokens are real.
 */
export interface PilotReply {
  type: 'pilot_reply';
  id: number;
  text: string;
  /** What the CLI says the conversation is, which is authoritative over ours. */
  sessionId: string;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number; total: number };
}

/**
 * One archive entry, as `listRuns` returned it (#223, `1b`).
 *
 * A transcription of the core's `RunSummary`, and every optional field here is
 * optional there for a stated reason. **The ones that matter most say what could
 * not be read**, and the core keeps three different failures apart rather than
 * collapsing them:
 *
 * - `linked` — an entry vibe **refused to follow** because it is a symlink or a
 *   junction (#53). It never looked inside.
 * - `unverified` — an `lstat` that threw, so whether it is a link could not be
 *   established at all. The fail-closed half of `linked`, and a separate field
 *   because one is a measurement and the other is the absence of one.
 * - `status: 'unreadable'` — a `state.json` that **was** opened and could not be
 *   used. The entry itself was never in doubt.
 *
 * `costUsd: null` is a cost that is unknown rather than zero: `$0.00` would
 * assert that an unreadable run cost nothing.
 */
export interface ArchiveRun {
  id: string;
  status: string;
  task: string;
  costUsd: number | null;
  liveness?: string;
  forkedFrom?: { runId: string; checkpoint: number };
  linked?: true;
  unverified?: true;
}

/** The archive, in reply to a request for it. */
export interface Archive {
  type: 'archive';
  id: number;
  dir: string;
  runs: readonly ArchiveRun[];
}

/**
 * The configuration in force, and what the file itself claims (#223, `1h`).
 *
 * **Both, and they are not the same thing.** `effective` is what a run will do;
 * `raw` is what `vibe.config.json` says on its own. A form given only the first
 * would bake every current default into the file the moment it saved.
 *
 * `gateable`, `modes` and `ungateable` come from `src/gates.ts` rather than
 * being written here, so the matrix cannot offer a boundary the loop does not
 * have or a mode it does not honour — and the two boundaries with **no** row
 * arrive with their own reasons rather than being silently missing.
 */
export interface ConfigFrame {
  type: 'config';
  id: number;
  dir: string;
  effective: unknown;
  raw: Record<string, unknown>;
  path: string | null;
  gateable: readonly string[];
  modes: readonly string[];
  ungateable: Readonly<Record<string, string>>;
  /**
   * The role table's vocabulary (`1i`).
   *
   * Sent for the same reason `gateable` is: a form built from a list it wrote
   * itself can offer a role the loop does not have or a provider it cannot seat,
   * and the refusal would arrive as a validator error on save rather than as a
   * control that was never offered.
   */
  roleNames: readonly string[];
  providers: readonly string[];
  efforts: readonly string[];
}

/**
 * The diff a run has produced (#223, `1d`).
 *
 * `truncated` is a **flag, not a marker in the text**. The design's truncation
 * band is a judgement about what the reviewer actually read, and a window
 * matching English to find out would break on the next wording change — which is
 * the failure #133 exists to prevent, at the moment somebody is deciding whether
 * a review was thorough.
 */
export interface DiffFrame {
  type: 'diff';
  id: number;
  dir: string;
  patch: string;
  truncated: boolean;
}

/**
 * A command started, or was refused (#211).
 *
 * `command` and `refused` are exclusive: a refusal started nothing, so there is
 * no id to report output against, and drawing a card from one would be drawing
 * a process that does not exist.
 */
export interface CommandStarted {
  type: 'command_started';
  id: number;
  command: {
    id: string;
    program: string;
    args: readonly string[];
    /** What was actually spawned. `npm` resolves to `node .../npm-cli.js`. */
    resolved: string;
    dir: string;
    startedAt: number;
  } | null;
  refused: string | null;
}

/** Output from a running command, in the order it arrived. */
export interface CommandOutput {
  type: 'command_output';
  commandId: string;
  chunk: string;
}

/** A command ended. `stopped` is what the exit code cannot carry on Windows. */
export interface CommandEnded {
  type: 'command_ended';
  commandId: string;
  code: number | null;
  signal: string | null;
  stopped: boolean;
  endedAt: number;
}

export type Frame =
  | Ready
  | Narration
  | Ask
  | Result
  | HostError
  | CommandStarted
  | CommandOutput
  | CommandEnded
  | PilotDelta
  | PilotReply
  | Archive
  | ConfigFrame
  | DiffFrame;

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
    type === 'error' ||
    // The pilot's two, which the cockpit's reducer ignores and the pilot pane
    // reads. Recognised here or they would be reported as unknown frames and
    // land in the diagnostics list instead of in the conversation (#193).
    type === 'pilot_delta' ||
    type === 'pilot_reply' ||
    // The archive, which the cockpit's reducer also ignores: it describes runs
    // that are over, and `Run` is about the one in progress (#223).
    type === 'archive' ||
    type === 'config' ||
    type === 'diff' ||
    // The command runner's three (#211). Also ignored by the cockpit's reducer:
    // a command is not part of a run - it outlives one, and it happens when
    // there is none - so `Cockpit` folds them with `reduceCommands` instead.
    type === 'command_started' ||
    type === 'command_output' ||
    type === 'command_ended'
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

/**
 * Which build the window is running in (#201).
 *
 * `commit` and `at` are nullable because a tree with no git cannot answer, and
 * the Rust side reports that as an absence rather than as `unknown`. A build
 * that cannot say which one it is has to say *that* — the whole value of the
 * stamp is that a reader can tell two builds of one version apart.
 */
export interface Build {
  version: string;
  commit: string | null;
  /** Milliseconds since the epoch, formatted here in the viewer's own locale. */
  at: number | null;
}

export interface Status {
  running: boolean;
  pid: number | null;
  /** Seconds the running host has been up, or null when none is. Never zero for unknown. */
  uptimeSecs: number | null;
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
  /**
   * Why killing this app would leave the host running, or null if it would not.
   *
   * Null is a real guarantee here rather than an absence: on Windows the host is
   * in a job object the kernel empties when the app dies, however it dies. On a
   * platform with no such mechanism this carries the reason, because an
   * unenforced guarantee nobody can see is the same as no guarantee (#157).
   */
  uncontained: string | null;
  /** Which build this window is running in. Static, and asked for with the rest. */
  build: Build;
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

/**
 * Hold at the next boundary (#210), or kill the turn in flight (#209).
 *
 * Two functions rather than one with a flag, because they are alternatives
 * rather than degrees. `pause` costs nothing and the run carries on; `cancel`
 * kills a child that may be forty minutes in and ends the run. The one thing
 * they share is that both are resumable, and neither is a kill of the process.
 */
export function pause(): Promise<void> {
  return send({ type: 'pause', id: nextRequestId() });
}

export function cancel(reason: string): Promise<void> {
  return send({ type: 'cancel', id: nextRequestId(), reason });
}

/**
 * Listen for the pilot's own frames, and for errors (#193).
 *
 * A second listener on the same event as `connect`, which Tauri allows and which
 * is the right shape here: the cockpit reads run frames and the pilot pane reads
 * pilot frames, and neither has to know the other exists. **Reading is not
 * sending** - the one `host.send` still belongs to `Cockpit`, for #144's reason.
 *
 * `error` frames are included because a pilot turn that could not run at all
 * arrives as one, carrying the id it was given. The pane matches on that id; a
 * relay cannot, because it does not know whose id it is.
 */
export async function onPilotFrame(
  handler: (frame: PilotDelta | PilotReply | HostError) => void,
): Promise<() => void> {
  return listen<unknown>('host://frame', (event) => {
    const frame: unknown = event.payload;
    if (!isFrame(frame)) return;
    if (frame.type === 'pilot_delta' || frame.type === 'pilot_reply' || frame.type === 'error') {
      handler(frame);
    }
  });
}

/**
 * Ask for the archive, and resolve with what came back (#223, `1b`).
 *
 * **A request/response, unlike everything else on this wire**, and it is the one
 * place that shape is right: the archive is not a thing that happens to a run,
 * it is a question with an answer, and a screen that had to wait for a run to
 * narrate before it could learn the history would be unusable on the exact
 * screen it is for — triage after a night of unattended work, when nothing is
 * happening.
 *
 * The listener is torn down whichever way it settles, including the timeout. A
 * frame that never arrives has to fail rather than hang: an unanswered promise
 * on this wire is a spinner nobody can clear, and `listRuns` has an unreadable
 * archive to survive.
 */
const ASK_TIMEOUT_MS = 15_000;

/**
 * Send a request and resolve with the frame that answers it.
 *
 * Shared by both readers rather than written twice, and the shared part is the
 * three things that are easy to get wrong once and impossible to get wrong twice
 * the same way: **the listener goes up before the request goes out** (the host
 * answers synchronously, so a request sent first can be answered before anything
 * is listening); **the match is on the id**, because two asks in flight with a
 * `dir` match would hand one of them the other's answer; and **it times out**,
 * because an unanswered promise on this wire is a spinner nobody can clear.
 */
async function ask<T extends Frame>(
  request: object,
  id: number,
  wanted: T['type'],
  missing: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let stop: (() => void) | null = null;
    const timer = setTimeout(() => {
      stop?.();
      reject(new Error(missing));
    }, ASK_TIMEOUT_MS);
    const done = (f: () => void): void => {
      clearTimeout(timer);
      stop?.();
      f();
    };
    void listen<unknown>('host://frame', (event) => {
      const frame: unknown = event.payload;
      if (!isFrame(frame)) return;
      // `Ready` carries no id, so the union has none in common. Narrowed on the
      // wanted type first and read through a record after, rather than widening
      // `Frame` to give every member an id it does not have.
      const carried: unknown = (frame as { id?: unknown }).id;
      if (frame.type === wanted && carried === id) done(() => resolve(frame as T));
      else if (frame.type === 'error' && frame.id === id) {
        done(() => reject(new Error(frame.message)));
      }
    })
      .then((off) => {
        stop = off;
        return send(request);
      })
      .catch((err: unknown) =>
        done(() => reject(err instanceof Error ? err : new Error(String(err)))),
      );
  });
}

export async function archive(dir: string): Promise<readonly ArchiveRun[]> {
  const id = nextRequestId();
  const frame = await ask<Archive>(
    { type: 'archive', id, dir },
    id,
    'archive',
    'the host did not answer with the archive',
  );
  return frame.runs;
}

/**
 * Read the configuration, or write a patch into it (#223, `1h`).
 *
 * **One function for both, because a write answers with what resulted.** A form
 * that saved and then assumed its own patch was in force would be the second
 * definition of the configuration that `AGENTS.md` says must not exist — the
 * form and the raw file are the same file the CLI reads, and this is how that
 * stays true rather than being hoped for.
 *
 * A patch that does not validate comes back as a rejection carrying the core
 * validator's own sentence, which names the field. Nothing was written.
 */
export async function config(
  dir: string,
  patch?: Record<string, unknown>,
): Promise<ConfigFrame> {
  const id = nextRequestId();
  return ask<ConfigFrame>(
    patch === undefined ? { type: 'config', id, dir } : { type: 'config', id, dir, patch },
    id,
    'config',
    'the host did not answer with the configuration',
  );
}

/**
 * Read the diff a run has produced (#223, `1d`).
 *
 * `baseSha` is **required and comes from `phase_started`**, which carries it from
 * the moment the implement phase marks it. Nothing here invents one: given no
 * base, `diffSince` runs `git add -A` before it diffs and stages the user's whole
 * working tree, so a read that could not name its base is refused at the decoder
 * rather than falling into that path.
 */
export async function diff(
  dir: string,
  baseSha: string,
): Promise<{ patch: string; truncated: boolean }> {
  const id = nextRequestId();
  const frame = await ask<DiffFrame>(
    { type: 'diff', id, dir, baseSha },
    id,
    'diff',
    'the host did not answer with the diff',
  );
  return { patch: frame.patch, truncated: frame.truncated };
}

/**
 * Run a command, and answer with what started or why nothing did (#211).
 *
 * **`program` and `args` are separate all the way down** and are never joined
 * into a line: the one invariant of `src/commands.ts` is that what runs is what
 * was displayed, and a string would put a `;` back within reach of text a model
 * wrote.
 *
 * The output does not come back from here. It arrives as `command_output` and
 * `command_ended`, the way a run's narration does, because the interesting
 * commands are the ones that have not finished.
 */
export async function runCommand(
  dir: string,
  program: string,
  args: readonly string[],
): Promise<CommandStarted> {
  const id = nextRequestId();
  return ask<CommandStarted>(
    { type: 'command', id, dir, program, args },
    id,
    'command_started',
    'the host did not say whether the command started',
  );
}

/** Stop one this session started. */
export async function stopCommand(commandId: string): Promise<void> {
  await send({ type: 'command_stop', id: nextRequestId(), commandId });
}

/**
 * Listen for the command runner's frames (#211).
 *
 * A third listener on the same event, beside `connect` and `onPilotFrame`, for
 * the reason that one exists: the cockpit reads run frames, the pilot pane
 * reads pilot frames, and neither has to know about commands.
 */
export async function onCommandFrame(
  handler: (frame: CommandOutput | CommandEnded) => void,
): Promise<() => void> {
  return listen<unknown>('host://frame', (event) => {
    const frame: unknown = event.payload;
    if (!isFrame(frame)) return;
    if (frame.type === 'command_output' || frame.type === 'command_ended') handler(frame);
  });
}

/** What one subscription-backed pilot turn needs (#193). */
export interface PilotTurn {
  prompt: string;
  system: string;
  model: string;
  /**
   * The repository the turn runs in, and the only one it can read.
   *
   * `--restricted` confines the pilot's file tools to the child's working
   * directory, so this is the permission boundary and not an incidental cwd.
   * The host refuses a frame without it rather than falling back to its own
   * directory, which under the app is whatever Rust spawned it in.
   */
  dir: string;
  sessionId: string;
  resume: boolean;
}

/**
 * Run one pilot turn on the subscription, through the host.
 *
 * Returns the id its frames will carry, so a caller can tell its own turn's
 * deltas from anything else on the stream — the same shape `pilot.send` returns
 * for the API-backed path, and for the same reason.
 *
 * **The reply does not come back from here.** It arrives as `pilot_delta` and
 * `pilot_reply` frames, exactly as a run's narration does, because the wire is
 * one-way in that direction and a promise resolving with a whole reply would be
 * a second way for one to arrive.
 */
export async function pilotTurn(turn: PilotTurn): Promise<number> {
  const id = nextRequestId();
  await send({ type: 'pilot', id, ...turn });
  return id;
}

/** Ids the app allocates for its own requests. Gate ids come from the host. */
let nextId = 0;
export function nextRequestId(): number {
  return (nextId += 1);
}
