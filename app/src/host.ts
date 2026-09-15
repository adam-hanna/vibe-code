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
  /**
   * The model names this build knows, per agent (#223).
   *
   * **Offered, not enforced**, which is what separates it from the three lists
   * above. Those are closed sets the validator refuses a value outside of; a
   * model is any non-empty string, because *"guessing whether a model exists is
   * the never-invent-a-number rule applied to a name"* — so a row whose model is
   * not on this list is still shown and still saved, and there is an `other…`
   * way in for a model that shipped this morning.
   */
  models: Readonly<Record<string, readonly string[]>>;
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
 * What is at an artifact's name (#223).
 *
 * **Three answers, kept whole.** `absent` says a file was opened and could not
 * be used; `linked` says vibe never looked inside it, because it is a symlink or
 * a junction and vibe writes neither. Collapsing them into a nullable string
 * would tell a reader a file was unreadable when it was never read, which is the
 * distinction #53 drew and #129 kept.
 */
export type ArtifactRead =
  | { kind: 'text'; text: string }
  | { kind: 'absent' }
  | { kind: 'linked'; reason: string };

/** One entry in a run's directory, as `lstat` classified it. */
export interface ArtifactEntry {
  name: string;
  kind: 'file' | 'directory' | 'link' | 'unknown';
  /** Null for anything but a plain file: a size nobody measured is not a zero. */
  bytes: number | null;
}

/**
 * What a run's directory holds (#223).
 *
 * **This is what stops the window predicting filenames.** Drawing a plan round's
 * plan means naming a file, and the alternative to being told is composing
 * `plan-${round}.json` here — a copy of the loop's naming convention, living in
 * a process that cannot be kept in step with it, going stale on the release that
 * renames one. `listRunArtifacts` reads the directory instead.
 */
export interface ArtifactsFrame {
  type: 'artifacts';
  id: number;
  dir: string;
  runId: string;
  entries: readonly ArtifactEntry[];
}

/**
 * What a `questions_answered` reply says (#223).
 *
 * `filled` and `open` rather than a boolean, because *some of them* is the
 * common case and the two need different next actions: a resume with a question
 * still open spends a preflight and halts on the same question, so the window
 * says so before any of that.
 */
export interface QuestionsAnswered {
  type: 'questions_answered';
  id: number;
  dir: string;
  runId: string;
  filled: number;
  unmatched: readonly string[];
  open: readonly string[];
}

/**
 * A finished run, said again (#223).
 *
 * **Not a second shape, which is the whole point.** The first answer to *"when I
 * click on an existing run, I don't see the right nav update"* was a summary —
 * a different screen drawn from a different record — and the report on it was
 * exact: *"I want the right panel to look just as it would have when I click on
 * an old run as if I had run it myself."*
 *
 * So the core sends back the **narration**, and the window folds it through the
 * same `reduce` a live run goes through. The column, the round cards and the log
 * are then the same components rendering the same `Run`. There is no second
 * builder, so there is nothing to disagree with the first.
 *
 * Each step carries its own `at` from the run's record: stamping a replay with
 * arrival time would date a week-old run to this afternoon, and every duration
 * on it would be the time it took to send.
 */
export interface ReplayFrame {
  type: 'replay';
  id: number;
  dir: string;
  runId: string;
  steps: readonly {
    at: number;
    narration: { level: Level; message: string; id: string | null; data: Record<string, unknown> | null };
  }[];
  /**
   * The exit code the run reported, or null when its record does not say.
   *
   * Beside the steps rather than among them, because a `result` is not
   * narration — it is the frame that answers a request. Null rather than a
   * guessed zero: a status this build does not recognise has not said the run
   * succeeded, and the footer draws an unknown code as the number rather than as
   * a phrase invented for it.
   */
  exit: number | null;
}
/**
 * The standing instruction blocks each turn is given (#223).
 *
 * Verbatim, never summarised. A prompt is a function of the run — the task, the
 * plan, the findings, the diff — so what a settings screen can honestly show is
 * the part that does not vary, and showing it means quoting it.
 */
export interface PromptsFrame {
  type: 'prompts';
  id: number;
  blocks: readonly {
    name: string;
    usedBy: readonly string[];
    /** As it will RENDER: this project's override, or the product's own. */
    text: string;
    /** The product's own, always — so a screen can offer *revert* without
     *  holding a second copy of a constant it does not own. */
    fallback: string;
    /** Whether this project replaces it. Told, so a screen never infers it. */
    overridden: boolean;
  }[];
}

/**
 * A run that is gone, in reply to a `delete_run` request (#223).
 *
 * `removed` is the directory the core actually deleted, which is the one thing
 * worth carrying back: it is checkable, where a file count or a size would be a
 * measurement taken so it could be shown once. A refusal never arrives here — it
 * is an `error` frame carrying the core's own sentence.
 */
export interface RunDeleted {
  type: 'run_deleted';
  id: number;
  dir: string;
  runId: string;
  removed: string;
}

/** One artifact's contents, in reply to an `artifact` request (#223). */
export interface ArtifactFrame {
  type: 'artifact';
  id: number;
  dir: string;
  runId: string;
  name: string;
  read: ArtifactRead;
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
  | DiffFrame
  | ArtifactsFrame
  | ArtifactFrame
  | RunDeleted
  | PromptsFrame
  | ReplayFrame
  | QuestionsAnswered;

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
    // The two artifact reads (#223), ignored by the cockpit's reducer for the
    // archive's reason: they describe what a run WROTE, which is on disk, and
    // `Run` is assembled from what a run is doing.
    type === 'artifacts' ||
    type === 'artifact' ||
    // A run that was deleted, ignored by the cockpit's reducer for the same
    // reason: it is a fact about the archive, and the run it names is by
    // construction not the one being narrated — the core refuses to delete a
    // run whose lock is live.
    type === 'run_deleted' ||
    // The standing prompt blocks, ignored by the cockpit's reducer for the same
    // reason: they are the same in every run, so they say nothing about the one
    // being narrated.
    type === 'prompts' ||
    // A past run's narration, ignored by THIS reducer for a sharper version of
    // the same reason: it describes a run this process is NOT narrating, and
    // folding it into the live run is exactly the confusion it exists to end.
    type === 'replay' ||
    type === 'questions_answered' ||
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
  headSha?: string,
): Promise<{ patch: string; truncated: boolean }> {
  const id = nextRequestId();
  const frame = await ask<DiffFrame>(
    // `headSha` closes the range, which is what makes a diff ONE ROUND rather
    // than the whole change (#223). Both shas come from `round_committed`, which
    // reads HEAD before it commits — so a round's `from` is measured rather than
    // paired off the previous commit, which is a derivation that silently goes
    // wrong the first time a run is resumed.
    headSha === undefined
      ? { type: 'diff', id, dir, baseSha }
      : { type: 'diff', id, dir, baseSha, headSha },
    id,
    'diff',
    'the host did not answer with the diff',
  );
  return { patch: frame.patch, truncated: frame.truncated };
}

/**
 * What a run's directory holds (#223).
 *
 * The listing rather than a guess, for the reason on `ArtifactsFrame`: a window
 * that composed `plan-${round}.json` would be holding a second copy of the
 * loop's naming convention with no way to keep it in step.
 */
export async function artifacts(dir: string, runId: string): Promise<readonly ArtifactEntry[]> {
  const id = nextRequestId();
  const frame = await ask<ArtifactsFrame>(
    { type: 'artifacts', id, dir, runId },
    id,
    'artifacts',
    "the host did not answer with the run's artifacts",
  );
  return frame.entries;
}

/**
 * One artifact's contents (#223).
 *
 * The three-answer read is returned whole rather than reduced to `string |
 * null`: a pane has to be able to tell a reader *this was never written*, *this
 * could not be read* and *vibe refused to look inside this*, and those need
 * different sentences. A run id or a name the core will not join onto a path
 * comes back as a rejection carrying its refusal, which is not the same event as
 * a file that is not there.
 */
export async function artifact(
  dir: string,
  runId: string,
  name: string,
): Promise<ArtifactRead> {
  const id = nextRequestId();
  const frame = await ask<ArtifactFrame>(
    { type: 'artifact', id, dir, runId, name },
    id,
    'artifact',
    'the host did not answer with the artifact',
  );
  return frame.read;
}

/**
 * One finished run, said again (#223).
 *
 * **What makes opening a run change the column beside the panes.** The six
 * artifact panes already followed the opened run, because each reads a file that
 * run wrote; the loop column had nothing to follow with and stayed on the live
 * run, saying so in a strip. That was honest and was still the wrong answer.
 *
 * The steps are narration, and the caller folds them through the **same**
 * `reduce` a live run goes through — so this returns no shape of its own to
 * render, which is the difference between this and the summary it replaced.
 *
 * A failure is a rejection carrying the core's own sentence, never an empty
 * replay: a run whose id will not join onto a path, a directory vibe refuses to
 * follow (#53) and a `state.json` the validators reject are three findings
 * needing three responses, and an empty replay would say the run did nothing.
 */
export async function replay(dir: string, runId: string): Promise<{
  steps: ReplayFrame['steps'];
  exit: number | null;
}> {
  const id = nextRequestId();
  const frame = await ask<ReplayFrame>(
    { type: 'replay', id, dir, runId },
    id,
    'replay',
    'the host did not answer with the run',
  );
  return { steps: frame.steps, exit: frame.exit };
}

/**
 * The standing instruction blocks each turn is given (#223).
 *
 * The only read in this file that names neither a repository nor a run, and the
 * absence is the point: these blocks are the same in every run, which is what
 * makes them a **setting** rather than a fact about one. A `dir` here would be a
 * field nobody reads and a later reader has to work out is unused.
 */
export async function prompts(): Promise<PromptsFrame['blocks']> {
  const id = nextRequestId();
  const frame = await ask<PromptsFrame>(
    { type: 'prompts', id },
    id,
    'prompts',
    'the host did not answer with the prompt blocks',
  );
  return frame.blocks;
}

/**
 * Answer a halted run's questions, without resuming it (#223).
 *
 * **Two acts, in this order, and the split is deliberate.** This writes into the
 * run's own `NEEDS-INPUT.md` — the same file a text editor would fill in, so the
 * resume that follows is the ordinary one and `parseHumanAnswers` stays the
 * single definition of what an answer is. A frame that also resumed would be a
 * write nobody could take back, and would put spending behind a Save button.
 *
 * Every refusal is the core's: a run that is not stopped on a question, one
 * whose lock names a live process, and an id it will not join onto a path.
 */
export async function answerQuestions(
  dir: string,
  runId: string,
  answers: readonly { question: string; answer: string }[],
): Promise<{ filled: number; unmatched: readonly string[]; open: readonly string[] }> {
  const id = nextRequestId();
  const frame = await ask<QuestionsAnswered>(
    { type: 'answer_questions', id, dir, runId, answers },
    id,
    'questions_answered',
    'the host did not say whether the answers were written',
  );
  return { filled: frame.filled, unmatched: frame.unmatched, open: frame.open };
}

/**
 * Delete a run from the archive (#223).
 *
 * **The only function in this file that destroys anything**, and the only
 * protection the window offers is the confirmation in front of it — every guard
 * that matters is the core's, because the core is the process holding the
 * filesystem. It refuses a run whose lock names a live process, refuses one
 * whose lock it cannot read, refuses an id that is not a single entry under
 * `.vibe/runs`, and refuses a run directory that is a link (#53).
 *
 * All four arrive here as a rejection carrying the core's own sentence, and the
 * caller shows it rather than paraphrasing it: *"it is running, stop it first"*
 * and *"vibe will not follow a link to delete"* are things a person acts on
 * differently, and a window that collapsed them into *"could not delete"* would
 * be answering neither.
 */
export async function deleteRun(dir: string, runId: string): Promise<string> {
  const id = nextRequestId();
  const frame = await ask<RunDeleted>(
    { type: 'delete_run', id, dir, runId },
    id,
    'run_deleted',
    'the host did not say whether the run was deleted',
  );
  return frame.removed;
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
