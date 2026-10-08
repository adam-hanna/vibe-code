import { requestCancel } from '@src/cancel.js';
import { main } from '@src/cli.js';
import { commandLogDir } from '@src/commandlog.js';
import { adoptedSnapshot, keepCommandLogs, refused as commandRefused, startCommand, stopTiedCommands, stopCommand } from '@src/commands.js';
import type { Handlers as CommandHandlers } from '@src/commands.js';
import type { PastCommand } from '@src/commandlog.js';
import { pilotChat } from '@src/pilotchat.js';
import { pilotCodex } from '@src/pilotcodex.js';
import { cliStatus } from '@src/clipaths.js';
import { acceptKeys } from '@src/heldkeys.js';
import { pilotFs, pilotRoots, readPilotAccess, resolvedAccess } from '@src/pilotaccess.js';
import { chatDir, listChats, listEntries, memoryDir, saveChat, saveEntry } from '@src/chatstore.js';
import type { PilotAccess } from '@src/pilotaccess.js';
import { promptBlocks } from '@src/prompts.js';
import * as log from '@src/log.js';
import { createLineReader, decode, encode, PROTOCOL_VERSION } from '@src/protocol.js';
import { orchestrate } from '@src/orchestrator.js';
import {
  answerQuestions,
  deleteRun,
  listRunArtifacts,
  listRuns,
  readRunArtifact,
  readRunReplay,
} from '@src/run.js';
import {
  DEFAULTS,
  globalConfigPath,
  loadConfig,
  mergeConfig,
  readGlobalConfig,
  readRawConfig,
  writeConfigPatch,
} from '@src/config.js';
import { GATEABLE, GATE_MODES, UNGATEABLE } from '@src/gates.js';
import { diffRange, diffSinceWithLimit } from '@src/git.js';
import { PROVIDERS, ROLE_NAMES } from '@src/roles.js';
import { listModels } from '@src/models.js';
import type { ModelListings } from '@src/models.js';
import { EFFORTS } from '@src/types.js';
import type { ArtifactRead, LoadedConfig, RunArtifact } from '@src/types.js';
import type { RunLoop } from '@src/cli.js';
import type { GateContext, Host } from '@src/host.js';
import type { Narration } from '@src/log.js';
import type { PilotChatOptions, PilotChatResult } from '@src/pilotchat.js';
import type { Outbound } from '@src/protocol.js';
import type { RunSummary } from '@src/types.js';

/**
 * The second entry point over `execute()` (#153).
 *
 * `src/main.ts -> cli.ts` renders the loop to a terminal and answers a gate by
 * exiting. This renders it to a pipe and answers a gate by resolving a promise.
 * **They are the same functions**: `invoke` hands its argv straight to `main()`,
 * so which flags exist, when the lock is taken relative to the first state
 * write, and what a resume does with `NEEDS-INPUT.md` all have exactly one
 * definition and it is the one the CLI already uses.
 *
 * That is not a stylistic preference. `loadRun`'s validators and
 * `consistency.ts` exist because a *stored* run could be incoherent, and a
 * second driver that built runs its own way would be the same threat arriving
 * through a new door - the argument #134 settled for decisions, one layer up.
 *
 * ## Why a gate can be an `await` here
 *
 * The desktop app links this source and runs it in its own process, so holding
 * at a boundary costs nothing: the process stays alive, the Claude session stays
 * warm, and answering `continue` re-sends no context. The CLI cannot do that -
 * a terminal cannot answer a promise - which is why `Host` is optional on
 * `orchestrate` and why the CLI passes none.
 *
 * ## stdout is the protocol, stderr is the prose
 *
 * `log.ts` writes to the console unconditionally and says so: *"a host that
 * wants the terminal quiet redirects the process's own stdout, which is a
 * decision about the process rather than about this module."* This is that
 * decision. `installProtocolStdout` moves `console.log` to stderr before a
 * single line of narration can be emitted, and every protocol frame is written
 * with `process.stdout.write` directly.
 *
 * The packaging spike proved this is not theoretical: one `log.step()` sharing
 * stdout with the protocol puts an unparseable frame in the stream, and it did.
 * Nothing here is worth more than that separation holding.
 */

/*
 * A pilot turn's ceiling is `pilot.timeoutMs` now (#223, `PILOT_TIMEOUT_MS` in
 * `pilotaccess.ts`), read with the rest of the machine's pilot settings on each
 * turn so a change in Settings reaches the next one.
 *
 * **The contention this creates is named rather than solved.** These tokens come
 * out of the same subscription window the run draws on, so a long conversation
 * beside a long run can push that run into a `ratelimits.ts` wait -
 * `src/pilotchat.ts` says so in its own words, and raising a `RateLimitError` as
 * itself is what gives a caller something to act on. What is *not* here is a
 * shared budget between the two: `app/src/pilot/ledger.ts` is the pilot's own
 * books precisely so a conversation cannot stop a run by spending its ceiling.
 */

/** Where a frame goes. Behind a function so a test needs no pipe. */
export type Send = (msg: Outbound) => void;

export interface Session {
  /** The host to hand `orchestrate`. Emits `ask` and awaits the matching `answer`. */
  readonly host: Host;
  /** Feed one inbound line. Never throws; a bad line becomes an `error` frame. */
  receive(line: string): void;
  /** Feed a chunk of the inbound stream, which may hold any number of lines. */
  write(chunk: string): void;
  /** The sink to install, so narration reaches the wire. */
  readonly sink: (n: Narration) => void;
  /**
   * Stop accepting requests, without a frame having said so.
   *
   * Same meaning as a `shutdown` frame - no more requests are coming, and an
   * in-flight run is left to reach its own next boundary - for a caller that
   * has no id to answer. Synthesising a `shutdown` frame with an invented id
   * would put a `result` on the wire answering a request nobody made.
   */
  shutdown(): void;
  /**
   * The supervisor has gone. Stop **now**, not at the next boundary (#206).
   *
   * Deliberately not `shutdown()`, which is what this used to call, and the
   * difference is not a matter of degree. `shutdown` says *no more requests are
   * coming*; this says *there is nobody left to send one, and nobody left to
   * read a frame*. Two things follow that make waiting incoherent rather than
   * merely slow:
   *
   * - **A gate can never be answered again.** `host.decide` resolves only on an
   *   `answer` frame, and the stream that carries one has closed. A run holding
   *   at a boundary when this arrives would hold for ever.
   * - **`running` covers the whole of `main()`.** So even for a run that will
   *   reach a boundary, "wait for it" is tens of minutes - against a supervisor
   *   that closed stdin because it is about to kill this process (`QUIT_GRACE`
   *   in `app/src-tauri/src/host.rs` is five seconds).
   *
   * So `finished()` resolves immediately, naming the request that was
   * abandoned. What that costs is nothing the CLI does not already cost: the
   * run is resumable from its last checkpoint, and the process leaving under
   * its own control is what gets `ending.json` written - which is the whole
   * point, because the alternative is the kill, and a killed process writes no
   * stamp at all (#131).
   */
  closing(): void;
  /** Resolves once nothing is left to do, saying what was left undone. */
  finished(): Promise<Departure>;
}

/** How the session ended, for the process that has to choose an exit code. */
export interface Departure {
  /**
   * The request still running when the supervisor left, or null.
   *
   * Null covers both ordinary endings - a `shutdown` frame whose run then
   * finished, and a close with nothing in flight - because in both the process
   * is leaving with the work done. Non-null is the one case that is not, and
   * `serve()` is what turns it into a code and a sentence.
   */
  abandoned: number | null;
}

/**
 * The host's own exit code when it left with a run in flight (#206).
 *
 * **Outside `EXIT`'s 0-7 on purpose** (`src/charge.ts`). Those eight are a
 * *run's* endings: they arrive on a `result` frame and the app's footer maps
 * each to a sentence. This is the *process* saying how it left, on a different
 * frame (`host://exit`) for a different question, and a number inside that
 * range would be read as one of them by the first person to see it. Seventy
 * carries no meaning of its own beyond being clear of them.
 */
export const HOST_EXIT_ABANDONED = 70;

export interface SessionDeps {
  /**
   * What earlier launches left in the command log, read once by `serve()`
   * before anything starts (#223). Defaults to none: a session in a test has no
   * past, and reading the real one here would make every test depend on it.
   */
  pastCommands?: readonly PastCommand[];
  /**
   * What lists each CLI's models (#223). Defaults to `listModels`, which spawns
   * both CLIs; a test answers instead, for the reason `invoke` is a seam.
   */
  models?: () => Promise<ModelListings>;
  /**
   * What runs an argv. Defaults to the CLI's own `main`.
   *
   * The one seam a test needs, and the only one: everything else here is
   * framing, and framing that had to spawn `claude` to be tested would not be
   * tested.
   */
  invoke?: (argv: readonly string[], loop: RunLoop) => Promise<number>;
  /**
   * What runs one pilot chat turn. Defaults to `pilotChat` (#193).
   *
   * The second seam, and it exists for the reason the first does: this one
   * spawns `claude`, and framing that had to spawn a CLI to be tested would not
   * be tested. What is worth testing here is that a pilot turn runs **beside** a
   * run rather than through the one-at-a-time gate, and that its failure becomes
   * an `error` rather than an empty reply.
   */
  pilot?: (options: PilotChatOptions) => Promise<PilotChatResult>;
  /** What runs one Codex pilot turn. Defaults to `pilotCodex` (#223). */
  pilotCodex?: (options: PilotChatOptions) => Promise<PilotChatResult>;
  /**
   * What reads the archive. Defaults to `listRuns` (#223).
   *
   * A seam for the same reason as the other two, and this one is also the point:
   * `listRuns` is the **only** thing that decides what an archive entry is - a
   * real directory, a symlink it refused to follow (#53), something `lstat`
   * could not classify - so a test substituting it is substituting the whole
   * definition rather than a fixture around one.
   */
  archive?: (dir: string) => RunSummary[];
  /** What reads the config. Defaults to `loadConfig` (#223). */
  config?: (dir: string) => LoadedConfig;
  /**
   * What writes a config patch. Defaults to `writeConfigPatch` (#223).
   *
   * A seam because the default **touches the user's repository**, and a test
   * that had to write a real `vibe.config.json` to check the framing would be
   * testing the filesystem. What is worth testing here is that a write is
   * refused while a run is going, and that a refusal from the validator becomes
   * an `error` carrying the validator's own sentence.
   */
  writeConfig?: (
    dir: string,
    patch: Record<string, unknown>,
    scope: 'project' | 'global',
  ) => { path: string };
  /** What reads a diff. Defaults to `diffSince` (#223), which shells out to git. */
  diff?: (
    dir: string,
    baseSha: string,
    headSha?: string,
  ) => Promise<{ patch: string; truncated: boolean }>;
  /**
   * What lists a run's artifacts. Defaults to `listRunArtifacts` (#223).
   *
   * A seam for `archive`'s reason and it is the same point one level down: that
   * function is where "what is in a run directory" is decided, including which
   * entries it refuses to offer at all, so a test substituting it substitutes
   * the definition rather than a fixture around one.
   */
  artifacts?: (dir: string, runId: string) => RunArtifact[];
  /** What reads one artifact. Defaults to `readRunArtifact` (#223). */
  artifact?: (dir: string, runId: string, name: string) => ArtifactRead;
  /**
   * What deletes a run. Defaults to `deleteRun` (#223).
   *
   * A seam for a stronger reason than the reads above have one: the default
   * **removes a directory recursively**, and a test that had to build a real run
   * archive in order to check that a refusal becomes an `error` frame would be
   * testing the filesystem rather than the framing. The guards themselves are
   * `deleteRun`'s and are tested against real directories there, which is the
   * split the other seams already make.
   */
  deleteRun?: (dir: string, runId: string) => { runId: string; dir: string };
  /**
   * What the pilot may do without asking (#223). Defaults to the settings for
   * all projects. Read on every use rather than once, so a change in Settings
   * reaches the next turn without a restart - and a seam because the default
   * reads a file under the developer's home.
   */
  pilotAccess?: () => PilotAccess;
}

/**
 * The longest line this process will take from the window (#223).
 *
 * The reader's own default is 1 MB, which was right while every inbound frame
 * was a request or an answer. A pilot conversation is now saved through here
 * (`chat_save`), and one ERM chat is 1.1 MB as JSON: its save was dropped, the
 * window waited out its timeout, and the move out of `localStorage` stopped. The
 * ceiling still exists - a sender that never writes a newline must not be an
 * unbounded allocation in the process holding the run - but it is sized for a
 * long conversation. The number is a bound, not a measurement: 64 MB is about
 * thirty times the largest chat seen.
 */
export const INBOUND_MAX_BYTES = 64 * 1024 * 1024;

export function createSession(send: Send, deps: SessionDeps = {}): Session {
  const invoke = deps.invoke ?? ((argv, loop) => main(argv, loop));
  const chat = deps.pilot ?? pilotChat;
  const chatCodex = deps.pilotCodex ?? pilotCodex;
  /** Subscription pilot turns in flight, by request id, so `pilot_stop` can reach one. */
  const pilotTurns = new Map<number, AbortController>();
  const archive = deps.archive ?? ((dir: string) => listRuns(dir));
  const listModelsWith = deps.models ?? listModels;
  let listings: Promise<ModelListings> | null = null;
  const readConfig = deps.config ?? ((dir: string) => loadConfig(dir));
  const writeConfig = deps.writeConfig ?? writeConfigPatch;
  // `head` is what makes this one round rather than the whole change. Undefined
  // takes `diffSince`, which is `1d`'s original question - everything since the
  // base - and a named head takes `diffRange`, which runs one command and
  // answers an empty round emptily rather than falling back to the working tree.
  const readDiff =
    deps.diff ??
    ((dir: string, baseSha: string, head?: string) =>
      head === undefined
        ? diffSinceWithLimit(dir, baseSha)
        : diffRange(dir, baseSha, head));
  const listArtifacts =
    deps.artifacts ?? ((dir: string, runId: string) => listRunArtifacts(dir, runId));
  const readOneArtifact =
    deps.artifact ??
    ((dir: string, runId: string, name: string) => readRunArtifact(dir, runId, name));
  const removeRun = deps.deleteRun ?? ((dir: string, runId: string) => deleteRun(dir, runId));
  const access = deps.pilotAccess ?? (() => readPilotAccess(readGlobalConfig()));

  /**
   * Gates awaiting an answer, by the id this process allocated for them.
   *
   * **A separate id space from the app's request ids**, and the direction is
   * what tells them apart: an `ask` carries an id we chose and an `answer`
   * echoes it, while a `result` echoes an id the app chose. A map each, so a
   * request numbered 1 and a gate numbered 1 can coexist - which they will,
   * since both counters start at the bottom.
   */
  const asks = new Map<number, (decision: unknown) => void>();
  let nextAsk = 0;

  /**
   * The id of the request being run, or null.
   *
   * One at a time, deliberately. `src/lock.ts` is written expecting one process
   * per run, `execute` reports a summary for the run it drove, and two
   * concurrent runs in one process would interleave their narration on a wire
   * that carries no run id yet. A second `invoke` is refused with a reason
   * rather than queued, because a queue would leave the app waiting with no way
   * to know it was waiting.
   */
  let running: number | null = null;
  let shuttingDown = false;
  // A no-op initializer rather than `null`: the executor below runs
  // synchronously and always assigns, but the compiler cannot see that through
  // a callback and narrows the variable to its initial type at every use.
  let settleFinished: (departure: Departure) => void = () => undefined;
  const finishedPromise = new Promise<Departure>((resolve) => {
    settleFinished = resolve;
  });

  /** Nothing left to do and told to stop. Both halves, or the process lingers. */
  const settleIfDone = (): void => {
    if (shuttingDown && running === null) settleFinished({ abandoned: null });
  };

  /**
   * A hold asked for since the last boundary, waiting to be taken (#210).
   *
   * One boolean rather than a count: two `pause` frames before the loop reaches
   * a boundary are the same request twice, and holding twice for them would be
   * the app deciding a person meant something they did not say.
   */
  let pauseRequested = false;

  const host: Host = {
    decide: (ctx: GateContext) =>
      new Promise<unknown>((resolve) => {
        const id = (nextAsk += 1);
        asks.set(id, resolve);
        send({ type: 'ask', id, context: ctx });
      }),
    takePause: () => {
      const asked = pauseRequested;
      pauseRequested = false;
      return asked;
    },
  };

  // The whole difference between this entry point and the CLI's, in one line:
  // the same loop, called with a host attached.
  const loop: RunLoop = (state, cfg, resume) => orchestrate(state, cfg, resume, undefined, host);

  const runInvoke = (id: number, argv: readonly string[]): void => {
    running = id;
    void invoke(argv, loop)
      .then((exit) => {
        send({ type: 'result', id, exit });
      })
      .catch((err: unknown) => {
        // `main` already catches inside itself and returns an exit code, so
        // reaching here means something escaped it entirely. Reported as an
        // `error` rather than a non-zero `result`: a result would claim the
        // command ran and returned that code, and it did neither.
        send({
          type: 'error',
          id,
          message: err instanceof Error ? (err.stack ?? err.message) : String(err),
        });
      })
      .finally(() => {
        running = null;
        // Every gate this run was holding is gone with it. Left in the map they
        // would be answered by a later run's `answer` frame, resolving a promise
        // nobody is awaiting - and, worse, silently consuming an id the next
        // gate might reuse.
        asks.clear();
        // A pause belongs to the run it was asked during (#253). `takePause`
        // clears it at the next boundary, but a run that stops or finishes
        // before reaching one left it armed - and the NEXT run, minutes or days
        // later, held at its first boundary for a request nobody made of it.
        // A pause asked for before any run starts still holds that run: this
        // clears only when a run returns.
        pauseRequested = false;
        settleIfDone();
      });
  };

  const receive = (line: string): void => {
    // The app's keychain read, before `decode` and outside the protocol (#223):
    // it carries no id, answers nothing and is never echoed - a refusal says
    // only that it was refused, because the line holds a key. See `heldkeys.ts`.
    if (line.includes('"keys"')) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        parsed = null;
      }
      if (typeof parsed === 'object' && parsed !== null && (parsed as Record<string, unknown>)['type'] === 'keys') {
        if (!acceptKeys(parsed as Record<string, unknown>)) {
          send({ type: 'error', id: null, message: 'a keys frame was refused' });
        }
        return;
      }
    }
    const read = decode(line);
    if (!read.ok) {
      send({ type: 'error', id: read.id, message: read.reason });
      return;
    }
    const msg = read.message;

    if (msg.type === 'shutdown') {
      shuttingDown = true;
      // Acknowledged immediately, before whatever is running has finished. The
      // frame answers "was the request accepted", not "is the process gone" -
      // stdout closing is the second of those, and it is the only honest signal
      // for it.
      send({ type: 'result', id: msg.id, exit: 0 });
      settleIfDone();
      return;
    }

    if (msg.type === 'fs') {
      // A read, beside a run, for `archive`'s reason: it writes nothing. The
      // boundary is decided here from the machine's settings, so a window - or
      // a model talking through one - cannot name its way outside it (#223).
      try {
        const answer = pilotFs(msg.op, msg.dir, msg.path, pilotRoots(msg.dir, access()));
        send(
          'refused' in answer
            ? { type: 'error', id: msg.id, message: answer.refused }
            : { type: 'fs', id: msg.id, ...answer },
        );
      } catch (err: unknown) {
        send({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (msg.type === 'archive') {
      // **Outside the one-at-a-time rule too, and for a stronger reason than the
      // pilot's.** `listRuns` is documented as never throwing and never writing,
      // so answering it while a run is going cannot affect that run - and
      // `1b`'s whole subject is triage after a night of unattended work, which
      // is exactly the moment a run is still going.
      //
      // Synchronous, because `listRuns` is: it reads a directory and parses what
      // it finds, and wrapping a sync call in a promise to look asynchronous
      // would add a tick between the request and the answer for no gain.
      try {
        send({ type: 'archive', id: msg.id, dir: msg.dir, runs: archive(msg.dir) });
      } catch (err: unknown) {
        // `listRuns` promises not to throw and this is the belt on that: a
        // window that asked for the archive and got silence would sit on a
        // spinner for ever, and an `error` frame is answerable.
        send({
          type: 'error',
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (msg.type === 'artifacts' || msg.type === 'artifact') {
      // Reads, beside a run, exactly as the archive is - both open files under
      // `.vibe/runs` and write nothing - and beside a run is where they are
      // wanted: the plan somebody asks to read is usually the plan the run in
      // flight is working from.
      //
      // Synchronous for `archive`'s reason: both read a directory and parse what
      // they find, and wrapping a sync call in a promise to look asynchronous
      // adds a tick between the request and the answer for no gain.
      //
      // **The throw is the refusal, not a failure.** `readRunArtifact` throws a
      // `StoredStateError` for a run id or a name this process will not join
      // onto a path, and that sentence is the whole answer - so it reaches the
      // sender as an `error` frame naming what was refused, rather than as an
      // empty read that would look like a missing file.
      try {
        if (msg.type === 'artifacts') {
          send({
            type: 'artifacts',
            id: msg.id,
            dir: msg.dir,
            runId: msg.runId,
            entries: listArtifacts(msg.dir, msg.runId),
          });
        } else {
          send({
            type: 'artifact',
            id: msg.id,
            dir: msg.dir,
            runId: msg.runId,
            name: msg.name,
            read: readOneArtifact(msg.dir, msg.runId, msg.name),
          });
        }
      } catch (err: unknown) {
        send({
          type: 'error',
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (msg.type === 'replay') {
      // A read like the four above it, and the last of them to be built. It is
      // exempt from the one-at-a-time rule for `archive`'s reason and a
      // narrower one of its own: `loadRun` opens one file and writes nothing,
      // and the run somebody opens while another is going is by definition not
      // the run in flight.
      //
      // **The throw is the refusal.** `loadRun` throws a `StoredStateError` for
      // an id it will not join onto a path, a run directory it will not follow
      // (#53) and a `state.json` its validators reject — three different
      // findings with three different sentences, and each is the whole answer.
      // An empty replay would say a run did nothing.
      try {
        send({
          type: 'replay',
          id: msg.id,
          dir: msg.dir,
          runId: msg.runId,
          ...readRunReplay(msg.dir, msg.runId),
        });
      } catch (err: unknown) {
        send({
          type: 'error',
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // The window's conversations (#223). Reads and writes beside a run, like
    // the other reads: they touch only the app's own data directory, never a
    // run's, so they cannot observe or disturb one.
    if (msg.type === 'models') {
      // A read, beside a run like the others: it spawns each CLI to ask and
      // takes no turn. Asked once per host and kept, because the answer changes
      // when a vendor ships rather than between two screens - and `fresh` asks
      // again. A listing that failed is never kept, so the next ask retries it:
      // the usual cause is a key that had not arrived yet.
      if (msg.fresh || listings === null) listings = listModelsWith();
      const asked = listings;
      void asked.then((got) => {
        if (!got.claude.ok || !got.codex.ok) {
          if (listings === asked) listings = null;
        }
        send({ type: 'models', id: msg.id, listings: got });
      });
      return;
    }

    if (msg.type === 'commands_past') {
      // A read of what was loaded at start-up, never of the directory now: a
      // command this process started is already in the window, live, and
      // listing it again here would draw it twice.
      //
      // One that was picked back up is the exception, and is answered as it is
      // NOW: its output has moved on since start-up, and the frames carrying
      // that went to a window that did not know the id yet.
      const past = (deps.pastCommands ?? []).map((p) => adoptedSnapshot(p.id) ?? p);
      send({ type: 'commands_past', id: msg.id, commands: past });
      return;
    }

    if (msg.type === 'chats' || msg.type === 'chat_save') {
      const dir = chatDir();
      if (dir === null) {
        send({ type: 'error', id: msg.id, message: 'this host was not told where the app keeps its data (VIBE_APP_DATA)' });
        return;
      }
      try {
        if (msg.type === 'chats') {
          send({ type: 'chats', id: msg.id, chats: listChats(dir) });
        } else {
          saveChat(dir, msg.key, msg.value);
          send({ type: 'chat_saved', id: msg.id, key: msg.key });
        }
      } catch (err: unknown) {
        send({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (msg.type === 'memory' || msg.type === 'memory_save') {
      // The chats' twin, in a directory of its own (#223). Refused rather than
      // defaulted without the data directory, for the chats' reason: a
      // directory this process picked is one the next launch may not look in.
      const dir = memoryDir();
      if (dir === null) {
        send({ type: 'error', id: msg.id, message: 'this host was not told where the app keeps its data (VIBE_APP_DATA)' });
        return;
      }
      try {
        if (msg.type === 'memory') {
          send({ type: 'memory', id: msg.id, entries: listEntries(dir) });
        } else {
          saveEntry(dir, msg.key, msg.value);
          send({ type: 'memory_saved', id: msg.id, key: msg.key });
        }
      } catch (err: unknown) {
        send({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    if (msg.type === 'prompts') {
      // A read like the four above it and the simplest of them: `promptBlocks`
      // opens nothing, reads no directory and returns the same four constants
      // every time. It is answerable beside a run for the strongest version of
      // the reason the others are - it cannot even observe one.
      send({ type: 'prompts', id: msg.id, blocks: promptBlocks() });
      return;
    }

    if (msg.type === 'answer_questions') {
      // A write, beside a run, and its own guard is what makes that safe: it
      // refuses a run whose lock names a live process and refuses one whose lock
      // it cannot read, so the run in flight is the one run this frame cannot
      // reach - the same reasoning `delete_run` rests on.
      //
      // It does not resume. The caller sends the resume argv as a separate
      // `invoke`, which is what keeps this a write nobody has spent anything on
      // yet and keeps the resume itself the ordinary one.
      try {
        const placed = answerQuestions(msg.dir, msg.runId, msg.answers);
        send({
          type: 'questions_answered',
          id: msg.id,
          dir: msg.dir,
          runId: msg.runId,
          filled: placed.filled,
          unmatched: placed.unmatched,
          open: placed.open,
        });
      } catch (err: unknown) {
        send({
          type: 'error',
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (msg.type === 'delete_run') {
      // **Beside a run, and that is a claim about the guards rather than about
      // this frame being harmless.** The reads above are exempt from the
      // one-at-a-time rule because they write nothing; this writes, so it needs
      // its own reason, and the reason is that `deleteRun` refuses a run whose
      // lock names a live process and refuses one whose lock it cannot read.
      // The run in flight is therefore the one run this cannot reach, and every
      // other entry in the archive is a directory nothing is working on.
      //
      // Synchronous, for the reason the reads are: it is one `rmSync` behind
      // three checks, and wrapping it to look asynchronous would put a tick
      // between the request and the answer for no gain.
      //
      // **The throw is the refusal.** A live lock, an unreadable one, an id
      // that is not a single entry under `.vibe/runs` and a run directory that
      // is a link all arrive here as a `StoredStateError` whose message is the
      // whole answer - so it reaches the sender as an `error` frame naming what
      // it refused and why, which is the only form a person can act on.
      try {
        const gone = removeRun(msg.dir, msg.runId);
        send({
          type: 'run_deleted',
          id: msg.id,
          dir: msg.dir,
          runId: msg.runId,
          removed: gone.dir,
        });
      } catch (err: unknown) {
        send({
          type: 'error',
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (msg.type === 'diff') {
      // A read, beside a run, like the archive - `git diff <base>..HEAD` writes
      // nothing. The `git add -A` path in `diffSince` is unreachable from here
      // because `decode` refuses a request with no base.
      const id = msg.id;
      void readDiff(msg.dir, msg.baseSha, msg.headSha)
        .then(({ patch, truncated }) => {
          // `truncated` as a flag rather than a marker in the text: the design's
          // truncation band is a judgement about what the reviewer READ, and a
          // window matching English for it would break on the next wording
          // change - which is the failure #133 exists to prevent.
          send({ type: 'diff', id, dir: msg.dir, patch, truncated });
        })
        .catch((err: unknown) => {
          send({
            type: 'error',
            id,
            message: err instanceof Error ? err.message : String(err),
          });
        });
      return;
    }

    if (msg.type === 'config') {
      // **A read runs beside a run; a WRITE does not.** `vibe.config.json` is
      // read once, at the top of `main`, so changing it mid-run cannot affect
      // the run in flight - but it would mean the settings screen and the
      // running loop disagreed about the configuration with nothing on screen
      // saying so. Refused with a reason rather than queued, exactly as a second
      // `invoke` is.
      if (msg.patch !== undefined && running !== null) {
        send({
          type: 'error',
          id: msg.id,
          message:
            // Says what to do, not only why (#223): the sentence used to end on
            // the reason, and a person who wanted to raise a cap for the run
            // they were about to resume was left with nothing to act on.
            'a run is still running, and it read vibe.config.json when it started, so it would ' +
            'not see the change. Stop it or let it finish, then save — a resume reads the file ' +
            'again',
        });
        return;
      }
      try {
        const path =
          msg.patch === undefined ? null : writeConfig(msg.dir, msg.patch, msg.scope ?? 'project').path;
        // The config that RESULTED, whether this was a read or a write, so a
        // form never has to assume its own save took effect.
        const loaded = readConfig(msg.dir);
        send({
          type: 'config',
          id: msg.id,
          dir: msg.dir,
          effective: loaded,
          raw: readRawConfig(msg.dir),
          // The project's path even after a global write: `path` has always
          // meant the project's file, and the global one has its own field.
          path: msg.scope === 'global' ? loaded.configPath : (path ?? loaded.configPath),
          globalRaw: readGlobalConfig(),
          globalPath: globalConfigPath(),
          globalEffective: mergeConfig(DEFAULTS, readGlobalConfig()),
          gateable: GATEABLE,
          modes: GATE_MODES,
          ungateable: UNGATEABLE,
          roleNames: ROLE_NAMES,
          providers: PROVIDERS,
          efforts: EFFORTS,
          pilot: resolvedAccess(access()),
          clis: { claude: cliStatus('claude'), codex: cliStatus('codex') },
        });
      } catch (err: unknown) {
        // `validate`'s own message, naming the field - which is what lets a
        // settings form say WHICH value it refused rather than that something
        // was wrong. Refuse, never repair: nothing was written.
        send({
          type: 'error',
          id: msg.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    if (msg.type === 'command') {
      // **Outside the one-at-a-time rule, like the pilot and the three reads.**
      // That rule is about *runs*: `src/lock.ts` expects one process per run and
      // two runs would interleave their narration. A command takes no lock,
      // writes no state and narrates nothing into the run - and checking whether
      // the thing a run just built starts is most wanted the moment the run has
      // finished, which is exactly when a `finished()` gate would refuse it.
      //
      // Deliberately not awaited. A dev server does not exit, and that is the
      // point of it: `command_started` answers now, output arrives as it comes,
      // and `command_ended` lands whenever it lands.
      const started = startCommand({ program: msg.program, args: msg.args, dir: msg.dir, ...commandFrames(send) });
      send(
        commandRefused(started)
          ? { type: 'command_started', id: msg.id, command: null, refused: started.refused }
          : {
              type: 'command_started',
              id: msg.id,
              command: {
                id: started.id,
                program: started.program,
                args: started.args,
                resolved: started.resolved,
                dir: started.dir,
                startedAt: started.startedAt,
              },
              refused: null,
            },
      );
      return;
    }

    if (msg.type === 'pilot_stop') {
      // A turn that has already ended is not an error: the click raced the
      // reply, and the reply is what the pane is about to draw anyway.
      pilotTurns.get(msg.turn)?.abort();
      send({ type: 'result', id: msg.id, exit: 0 });
      return;
    }

    if (msg.type === 'command_stop') {
      // No reply beyond the ordinary `result`: the kill is observable as the
      // `command_ended` the close event produces, and a second answer saying it
      // was asked for would be a claim about a process rather than about the
      // request.
      stopCommand(msg.commandId);
      send({ type: 'result', id: msg.id, exit: 0 });
      return;
    }

    if (msg.type === 'pilot') {
      // **Outside the one-at-a-time rule, and outside `finished()`.** That rule
      // is about *runs*: `src/lock.ts` expects one process per run and two runs
      // would interleave their narration. A pilot turn takes no lock, writes no
      // state and narrates nothing - it is a conversation about the run, and it
      // is most useful *during* one, so refusing it while a run is going would
      // refuse it exactly when it is wanted.
      //
      // It is also deliberately not awaited by `finished()`. A quit should not
      // wait on a chat turn, and #206 already decided that a supervisor going
      // away abandons work rather than finishing it.
      const id = msg.id;
      // Where the turn may read, from the machine's settings and never the
      // frame (#223). A section that does not parse refuses the turn with its
      // own sentence rather than running it under a guess.
      let addDirs: string[];
      let granted: PilotAccess;
      try {
        granted = access();
        addDirs = pilotRoots(msg.dir, granted);
      } catch (err: unknown) {
        send({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
        return;
      }
      // This turn's own off switch (#223), held until it settles either way.
      const stopper = new AbortController();
      pilotTurns.set(id, stopper);
      const turnStarted = Date.now();
      void (msg.agent === 'codex' ? chatCodex : chat)({
        prompt: msg.prompt,
        system: msg.system,
        model: msg.model,
        sessionId: msg.sessionId,
        resume: msg.resume,
        // **The repository the window named, never this process's cwd.** Under
        // the app the host is spawned by Rust and inherits whatever directory
        // that spawn had - which in a manual pass was a home directory, so the
        // pilot's `Glob` walked the whole of it and timed out at 20s on every
        // search. `--restricted` confines the file tools to *this* path, so it
        // is the permission boundary rather than an incidental working
        // directory, and the frame is refused without it.
        cwd: msg.dir,
        addDirs,
        // What its own tools may do without asking (#223), from the same
        // machine settings as the directories, never from the frame.
        access: { yolo: granted.yolo, safeCommands: granted.safeCommands },
        timeoutMs: granted.timeoutMs,
        signal: stopper.signal,
        onDelta: (text: string) => {
          send({ type: 'pilot_delta', id, text });
        },
      })
        .then((reply) => {
          send({
            type: 'pilot_reply',
            id,
            text: reply.text,
            sessionId: reply.sessionId,
            tokens: reply.tokens,
            context: reply.context,
          });
        })
        .catch((err: unknown) => {
          // Stopped from the window: said as itself, never as a failure.
          if (stopper.signal.aborted) {
            send({ type: 'pilot_stopped', id });
            return;
          }
          // An `error` rather than an empty `pilot_reply`: a reply with no text
          // would look like a model that had nothing to say, and this is a turn
          // that did not happen. `RateLimitError` arrives here as itself, which
          // is what the module raised it for.
          const said = err instanceof Error ? err.message : String(err);
          // A turn that reached its ceiling says where the ceiling is (#223).
          // Decided by the clock, not by reading the sentence: the turn has
          // lasted at least as long as it was allowed to.
          const ranOut = Date.now() - turnStarted >= granted.timeoutMs;
          send({
            type: 'error',
            id,
            message: ranOut
              ? `${said} - the pilot's limit is ${String(Math.round(granted.timeoutMs / 60_000))} min, set as "pilot turn limit" in Settings (pilot.timeoutMs)`
              : said,
          });
        })
        .finally(() => {
          pilotTurns.delete(id);
        });
      return;
    }

    if (msg.type === 'cancel') {
      // Acted on immediately rather than at a boundary, which is the whole
      // difference from `pause`: the child is killed now and the run ends the
      // way a round cap ends it, resumably. `requestCancel` latches, so no
      // further agent turn can start even if the killed turn's error is
      // swallowed on its way up.
      const why = msg.reason ?? 'stopped from the window';
      const killed = requestCancel(why);
      // The count is on the wire because it is a different thing to tell
      // somebody: zero means the cancel arrived between turns, so the run still
      // ends but no work was discarded.
      send({ type: 'result', id: msg.id, exit: killed });
      return;
    }

    if (msg.type === 'unpause') {
      // Whether there was one to take back is the answer (#276): 0 cleared an
      // armed hold, 1 found none, because the boundary took it first or no
      // pause was asked for. Never an error - too late is a run that is holding.
      const had = pauseRequested;
      pauseRequested = false;
      send({ type: 'result', id: msg.id, exit: had ? 0 : 1 });
      return;
    }

    if (msg.type === 'pause') {
      pauseRequested = true;
      // Accepted, not honoured — and the two are different facts, the same way
      // a `shutdown` is acknowledged before the run it is waiting on has ended.
      // What says a hold actually happened is the `ask` that follows it.
      //
      // Accepted with no run in flight too, and deliberately: a person who
      // presses pause a moment before a run starts meant to hold that run, and
      // refusing it would be this seam deciding their timing was wrong. It costs
      // nothing, because `takePause` clears itself at the first boundary.
      send({ type: 'result', id: msg.id, exit: 0 });
      return;
    }

    if (msg.type === 'answer') {
      const resolve = asks.get(msg.id);
      if (resolve === undefined) {
        // Not silently dropped. An answer to a gate that has already been
        // answered, or to one that died with its run, means the two sides
        // disagree about what the loop is doing, and a host that is told will
        // stop waiting for something that is never coming.
        send({ type: 'error', id: msg.id, message: 'no gate is waiting on that id' });
        return;
      }
      asks.delete(msg.id);
      // Passed through unnarrowed: `readDecision` is where that vocabulary is
      // defined, and it is applied by the orchestrator on the way out of
      // `decide`. Checking it here as well would be two definitions of a legal
      // decision, in two files, and they would disagree eventually.
      resolve(msg.decision);
      return;
    }

    if (shuttingDown) {
      send({ type: 'error', id: msg.id, message: 'shutting down; not accepting new requests' });
      return;
    }
    if (running !== null) {
      send({
        type: 'error',
        id: msg.id,
        message: `request ${running} is still running; one run at a time`,
      });
      return;
    }
    runInvoke(msg.id, msg.argv);
  };

  const write = createLineReader(
    receive,
    (bytes) => {
      send({
        type: 'error',
        id: null,
        message: `dropped ${bytes} bytes of input with no newline in them`,
      });
    },
    INBOUND_MAX_BYTES,
  );

  return {
    host,
    receive,
    write,
    sink: (n: Narration) => {
      send({ type: 'narration', ...n });
    },
    shutdown: () => {
      shuttingDown = true;
      settleIfDone();
    },
    closing: () => {
      shuttingDown = true;
      // Resolving with the id rather than after it: a promise settles once, so
      // the run's own `.finally` calling `settleIfDone` afterwards cannot
      // overwrite this with `abandoned: null` and report an ordinary quit.
      settleFinished({ abandoned: running });
    },
    finished: () => finishedPromise,
  };
}

/**
 * Take stdout for the protocol and move the console to stderr.
 *
 * Returns the writer for protocol frames. **Call this before anything narrates**
 * - which in practice means before `createSession`'s sink is installed, since
 * that is the first thing that can put a `log.*` line anywhere.
 *
 * `console.error` is left alone. It already goes to stderr, which is where
 * `log.fail` belongs: stderr is the unstructured human channel a supervisor
 * captures as a log, and stdout is the one that must parse.
 */
export function installProtocolStdout(): Send {
  const out = process.stdout;
  const err = process.stderr;
  // Bound before the reassignment, so the replacement cannot recurse into
  // whatever else may have already wrapped `console.log`.
  console.log = (...args: unknown[]): void => {
    err.write(`${args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')}\n`);
  };
  return (msg: Outbound): void => {
    // Not `console.log`: that is the thing that was just redirected, and a frame
    // is written raw so nothing can add a prefix to it.
    out.write(encode(msg));
  };
}

/**
 * The process. `src/hostmain.ts` is the four lines that call it.
 *
 * Order matters and is the whole point: take stdout, install the sink, say
 * `ready`, and only then read a byte of input. A `ready` frame that arrived
 * after the first request would tell a host the protocol version too late to
 * act on it.
 */
/**
 * The frames a command's output and ending travel as - one definition for a
 * command this process starts and one an earlier launch left running (#223).
 */
export function commandFrames(send: (m: Outbound) => void): CommandHandlers {
  return {
    onOutput: (commandId, chunk) => send({ type: 'command_output', commandId, chunk }),
    onEnd: (record) =>
      send({
        type: 'command_ended',
        commandId: record.id,
        code: record.code,
        signal: record.signal,
        stopped: record.stopped,
        endedAt: record.endedAt ?? Date.now(),
      }),
  };
}

export async function serve(): Promise<void> {
  const send = installProtocolStdout();
  const logs = commandLogDir();
  const session = createSession(send, { pastCommands: logs === null ? [] : keepCommandLogs(logs, commandFrames(send)) });
  log.setSink(session.sink);

  send({ type: 'ready', protocol: PROTOCOL_VERSION, pid: process.pid });

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    session.write(chunk);
  });
  // The supervisor closing stdin is the other way this ends, and it is the
  // stronger one: nobody is left to send a request, and nobody is left to answer
  // a gate. See `closing()` for why that is not a `shutdown`.
  process.stdin.on('end', () => {
    session.closing();
  });

  const departure = await session.finished();

  // Found by driving the built process from a pipe, and invisible to every
  // in-process test: `finished()` resolving means the WORK is done, and an open
  // stdin still holds the event loop open on its own. Without this the process
  // acknowledges the shutdown, writes nothing more, and never exits - which a
  // supervisor can only resolve by killing it.
  process.stdin.pause();

  if (departure.abandoned === null) return;

  // Stderr, because this is prose and stdout is the protocol - and because it
  // is the app's own log that keeps it (`applog::host`), which is where somebody
  // asking why a quit abandoned a turn will be looking (#186).
  process.stderr.write(
    `the app closed while request ${departure.abandoned} was still running; ` +
      `stopping now rather than waiting for a boundary nothing is left to answer\n`,
  );

  // `process.exit` rather than falling off the end, and the two reasons are
  // different. The run's children - `claude`, `codex` - hold the event loop
  // open, so returning here would not end the process at all; and the exit
  // hook `installEndingStamp` registered is what writes `ending.json`, so
  // leaving under our own control is the difference between an archive that
  // says vibe stopped and one that says something killed it without running a
  // line of its code (#131).
  //
  // Those children are not killed here. On Windows the job object in
  // `reaper.rs` takes them with the app; where it cannot, `Status.uncontained`
  // already says so rather than the app pretending otherwise.
  //
  // **A command is left running when the next launch can pick it up** (#223).
  // This used to kill every one, because a dev server left listening after its
  // window had gone was a port nobody could find the owner of (#211). Once its
  // pid and its output are on disk the next launch finds it - and a relaunch
  // killing every server the pilot had started was the report that moved it.
  // What cannot be picked up - a piped command, on Windows or with no log
  // directory - is still stopped here, since `process.exit` runs no `close`
  // handler and this is the last point at which anything can ask.
  stopTiedCommands();
  process.exitCode = HOST_EXIT_ABANDONED;
  process.exit(HOST_EXIT_ABANDONED);
}
