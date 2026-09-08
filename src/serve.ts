import { requestCancel } from '@src/cancel.js';
import { main } from '@src/cli.js';
import { pilotChat } from '@src/pilotchat.js';
import * as log from '@src/log.js';
import { createLineReader, decode, encode, PROTOCOL_VERSION } from '@src/protocol.js';
import { orchestrate } from '@src/orchestrator.js';
import { listRuns } from '@src/run.js';
import { loadConfig, readRawConfig, writeConfigPatch } from '@src/config.js';
import { GATEABLE, GATE_MODES, UNGATEABLE } from '@src/gates.js';
import type { LoadedConfig } from '@src/types.js';
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

/**
 * How long a pilot chat turn may take before its child is killed (#193).
 *
 * Its own number rather than a role's `timeoutMs`, and shorter than any of
 * them: a role turn is a model working through a repository for as long as it
 * needs, and this is somebody waiting for a sentence with the window open. Five
 * minutes is generous for that and short enough that a wedged child does not sit
 * there for the length of a run.
 *
 * **The contention this creates is named rather than solved.** These tokens come
 * out of the same subscription window the run draws on, so a long conversation
 * beside a long run can push that run into a `ratelimits.ts` wait -
 * `src/pilotchat.ts` says so in its own words, and raising a `RateLimitError` as
 * itself is what gives a caller something to act on. What is *not* here is a
 * shared budget between the two: `app/src/pilot/ledger.ts` is the pilot's own
 * books precisely so a conversation cannot stop a run by spending its ceiling.
 */
const PILOT_TIMEOUT_MS = 5 * 60_000;

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
  writeConfig?: (dir: string, patch: Record<string, unknown>) => { path: string };
}

export function createSession(send: Send, deps: SessionDeps = {}): Session {
  const invoke = deps.invoke ?? ((argv, loop) => main(argv, loop));
  const chat = deps.pilot ?? pilotChat;
  const archive = deps.archive ?? ((dir: string) => listRuns(dir));
  const readConfig = deps.config ?? ((dir: string) => loadConfig(dir));
  const writeConfig = deps.writeConfig ?? writeConfigPatch;

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
        settleIfDone();
      });
  };

  const receive = (line: string): void => {
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
            `request ${String(running)} is still running; a run reads vibe.config.json once at ` +
            'the start, so saving now would leave the screen and the loop describing different ' +
            'configurations',
        });
        return;
      }
      try {
        const path = msg.patch === undefined ? null : writeConfig(msg.dir, msg.patch).path;
        // The config that RESULTED, whether this was a read or a write, so a
        // form never has to assume its own save took effect.
        const loaded = readConfig(msg.dir);
        send({
          type: 'config',
          id: msg.id,
          dir: msg.dir,
          effective: loaded,
          raw: readRawConfig(msg.dir),
          path: path ?? loaded.configPath,
          gateable: GATEABLE,
          modes: GATE_MODES,
          ungateable: UNGATEABLE,
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
      void chat({
        prompt: msg.prompt,
        system: msg.system,
        model: msg.model,
        sessionId: msg.sessionId,
        resume: msg.resume,
        cwd: process.cwd(),
        timeoutMs: PILOT_TIMEOUT_MS,
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
          });
        })
        .catch((err: unknown) => {
          // An `error` rather than an empty `pilot_reply`: a reply with no text
          // would look like a model that had nothing to say, and this is a turn
          // that did not happen. `RateLimitError` arrives here as itself, which
          // is what the module raised it for.
          send({
            type: 'error',
            id,
            message: err instanceof Error ? err.message : String(err),
          });
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

  const write = createLineReader(receive, (bytes) => {
    send({
      type: 'error',
      id: null,
      message: `dropped ${bytes} bytes of input with no newline in them`,
    });
  });

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
export async function serve(): Promise<void> {
  const send = installProtocolStdout();
  const session = createSession(send);
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
  process.exitCode = HOST_EXIT_ABANDONED;
  process.exit(HOST_EXIT_ABANDONED);
}
