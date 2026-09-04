import { main } from '@src/cli.js';
import * as log from '@src/log.js';
import { createLineReader, decode, encode, PROTOCOL_VERSION } from '@src/protocol.js';
import { orchestrate } from '@src/orchestrator.js';
import type { RunLoop } from '@src/cli.js';
import type { GateContext, Host } from '@src/host.js';
import type { Narration } from '@src/log.js';
import type { Outbound } from '@src/protocol.js';

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
   * The supervisor closing stdin means what a `shutdown` request means, and it
   * arrives as an event rather than as a line. Calling this is how that event is
   * honoured; synthesising a `shutdown` frame with an invented id would put a
   * `result` on the wire answering a request nobody made.
   */
  shutdown(): void;
  /** Resolves once a shutdown has been asked for and nothing is in flight. */
  finished(): Promise<void>;
}

export interface SessionDeps {
  /**
   * What runs an argv. Defaults to the CLI's own `main`.
   *
   * The one seam a test needs, and the only one: everything else here is
   * framing, and framing that had to spawn `claude` to be tested would not be
   * tested.
   */
  invoke?: (argv: readonly string[], loop: RunLoop) => Promise<number>;
}

export function createSession(send: Send, deps: SessionDeps = {}): Session {
  const invoke = deps.invoke ?? ((argv, loop) => main(argv, loop));

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
  let settleFinished: () => void = () => undefined;
  const finishedPromise = new Promise<void>((resolve) => {
    settleFinished = resolve;
  });

  /** Nothing left to do and told to stop. Both halves, or the process lingers. */
  const settleIfDone = (): void => {
    if (shuttingDown && running === null) settleFinished();
  };

  const host: Host = {
    decide: (ctx: GateContext) =>
      new Promise<unknown>((resolve) => {
        const id = (nextAsk += 1);
        asks.set(id, resolve);
        send({ type: 'ask', id, context: ctx });
      }),
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
  // The supervisor closing stdin is the other way this ends, and it means the
  // same thing a `shutdown` does: no more requests are coming. An in-flight run
  // is still left to reach its own next boundary - `finished()` waits for it.
  process.stdin.on('end', () => {
    session.shutdown();
  });

  await session.finished();

  // Found by driving the built process from a pipe, and invisible to every
  // in-process test: `finished()` resolving means the WORK is done, and an open
  // stdin still holds the event loop open on its own. Without this the process
  // acknowledges the shutdown, writes nothing more, and never exits - which a
  // supervisor can only resolve by killing it.
  process.stdin.pause();
}
