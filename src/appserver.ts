import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';

const isWin = process.platform === 'win32';

/**
 * A JSON-RPC message as it goes on the wire.
 *
 * app-server speaks newline-delimited JSON and omits the `"jsonrpc":"2.0"`
 * member, so this adds a newline and nothing else. `JSON.stringify` never emits
 * a raw newline inside a string, which is what makes line framing safe here.
 */
export function encodeMessage(msg: Record<string, unknown>): string {
  return `${JSON.stringify(msg)}\n`;
}

/**
 * Reassembles whole lines out of stdio chunks.
 *
 * A chunk boundary lands mid-message as soon as a payload exceeds the pipe
 * buffer, so parsing each chunk as if it were a message loses exactly the large
 * responses - and the rate-limit payload grows with the number of windows the
 * account has.
 */
export class LineDecoder {
  private carry = '';

  push(chunk: string): string[] {
    const combined = this.carry + chunk;
    const parts = combined.split('\n');
    // The last element is either an incomplete line or '' after a trailing
    // newline; both are correct to carry forward.
    this.carry = parts.pop() ?? '';
    return parts.map((line) => line.replace(/\r$/, '')).filter((line) => line !== '');
  }
}

export type Incoming =
  | { kind: 'response'; id: number; result: unknown }
  | { kind: 'error'; id: number; code: number; message: string }
  | { kind: 'notification'; method: string; params: unknown };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Classify one line.
 *
 * Tolerant on purpose: app-server is experimental and anything it prints to
 * stdout that is not a JSON-RPC message - a warning, a progress line - must be
 * skipped rather than treated as a protocol violation. `null` means "not for
 * us", never "the connection is broken".
 */
export function parseIncoming(line: string): Incoming | null {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(msg)) return null;

  const method = msg['method'];
  if (typeof method === 'string') {
    // A method *with* an id is a server-initiated request. Nothing here answers
    // one, and mistaking it for a notification would fire a handler for a
    // message the server is still waiting on.
    return msg['id'] === undefined ? { kind: 'notification', method, params: msg['params'] } : null;
  }

  const id = msg['id'];
  if (typeof id !== 'number') return null;

  const error = msg['error'];
  if (isRecord(error)) {
    const code = typeof error['code'] === 'number' ? error['code'] : 0;
    const message = typeof error['message'] === 'string' ? error['message'] : 'unknown error';
    return { kind: 'error', id, code, message };
  }
  if ('result' in msg) return { kind: 'response', id, result: msg['result'] };
  return null;
}

export interface AppServerTransport {
  send(line: string): void;
  onLine(cb: (line: string) => void): void;
  onClose(cb: (reason: string) => void): void;
  close(): void;
}

/**
 * Every way the connection can fail, collapsed into one type.
 *
 * The rate-limit signal is optional, so its caller needs a single thing to
 * catch. A protocol error and a dead child are the same outcome from there:
 * no number this turn.
 */
export class AppServerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AppServerUnavailableError';
  }
}

export interface AppServerClientOptions {
  /**
   * Ceiling on the `initialize` round trip. Separate from `requestTimeoutMs`
   * because they are different waits: the handshake includes process startup
   * and, on a cold machine, an auth check, while a later call is talking to an
   * already-running server. Sharing one number means either aborting healthy
   * startups or waiting startup-length for a read that has already hung.
   */
  handshakeTimeoutMs: number;
  /** Ceiling on every call after the handshake. */
  requestTimeoutMs: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * app-server rejects every call with `-32600 Not initialized` unless
 * `initialize` carried a `clientInfo` object, so this is not decoration.
 */
const CLIENT_INFO = { name: 'vibe', title: 'vibe', version: '1' } as const;

export class AppServerClient {
  private readonly decoder = new LineDecoder();
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, ((params: unknown) => void)[]>();
  private nextId = 0;
  private closed = false;

  constructor(
    private readonly transport: AppServerTransport,
    private readonly options: AppServerClientOptions,
  ) {
    transport.onLine((chunk) => this.receive(chunk));
    transport.onClose((reason) => this.failAll(`app-server closed: ${reason}`));
  }

  /** `initialize`, then the `initialized` notification. Order is load-bearing. */
  async handshake(): Promise<void> {
    await this.request('initialize', { clientInfo: CLIENT_INFO }, this.options.handshakeTimeoutMs);
    this.send({ method: 'initialized', params: {} });
  }

  request(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs: number = this.options.requestTimeoutMs,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new AppServerUnavailableError(`app-server is closed (${method})`));
    }

    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      // Deliberately left referenced: something has to hold the event loop open
      // while a caller is awaiting this, or node exits mid-probe when the
      // request is the only work in flight. It is cleared on every settle path,
      // so it cannot outlive the call.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppServerUnavailableError(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      try {
        this.send(params === undefined ? { method, id } : { method, id, params });
      } catch (err) {
        this.settle(id, (p) => p.reject(asUnavailable(err, method)));
      }
    });
  }

  onNotification(method: string, cb: (params: unknown) => void): void {
    const existing = this.handlers.get(method);
    if (existing) existing.push(cb);
    else this.handlers.set(method, [cb]);
  }

  /**
   * Idempotent: the monitor closes on a failed handshake and again when it
   * disables itself, and a second close must not throw or re-settle a promise
   * that already settled.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll('app-server connection closed');
    try {
      this.transport.close();
    } catch {
      // Closing a transport that is already gone is not a failure worth raising
      // to a caller that only wanted a percentage.
    }
  }

  private send(msg: Record<string, unknown>): void {
    this.transport.send(encodeMessage(msg));
  }

  private receive(chunk: string): void {
    // This runs from a stream 'data' event, where a throw is an unhandled
    // exception that takes the whole run down rather than a rejected promise.
    try {
      for (const line of this.decoder.push(chunk)) this.dispatch(line);
    } catch {
      // A malformed line is not worth losing a run over.
    }
  }

  private dispatch(line: string): void {
    const incoming = parseIncoming(line);
    if (incoming === null) return;

    if (incoming.kind === 'notification') {
      for (const cb of this.handlers.get(incoming.method) ?? []) {
        try {
          cb(incoming.params);
        } catch {
          // Same reason as receive(): a handler fault must not escape the
          // stream event it was called from.
        }
      }
      return;
    }

    if (incoming.kind === 'error') {
      const { code, message } = incoming;
      this.settle(incoming.id, (p) =>
        p.reject(new AppServerUnavailableError(`app-server error ${code}: ${message}`)),
      );
      return;
    }
    const { result } = incoming;
    this.settle(incoming.id, (p) => p.resolve(result));
  }

  private settle(id: number, finish: (pending: Pending) => void): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    finish(pending);
  }

  private failAll(reason: string): void {
    for (const id of [...this.pending.keys()]) {
      this.settle(id, (p) => p.reject(new AppServerUnavailableError(reason)));
    }
  }
}

function asUnavailable(err: unknown, context: string): AppServerUnavailableError {
  const message = err instanceof Error ? err.message : String(err);
  return new AppServerUnavailableError(`${context}: ${message}`);
}

/** How much stderr to keep for the diagnostic message. */
const STDERR_TAIL = 2000;

/**
 * Release the child's pipes, on close only.
 *
 * `child.unref()` covers the process handle alone; the three stdio pipes are
 * separate handles, and an app-server that stops answering keeps every one of
 * them open - measured with a stub that never replied to `initialize`, where
 * `vibe doctor` printed its whole report, returned, and then hung for good.
 *
 * Doing this up front instead is worse than the hang it fixes: with nothing
 * referenced, node exits the moment a rate-limit probe is the only work in
 * flight, which truncated `doctor` mid-report and would abandon a run mid-turn.
 */
function destroyStream(stream: unknown): void {
  const maybe = stream as { destroy?: () => void };
  try {
    maybe.destroy?.();
  } catch {
    // A pipe that is already gone needs no destroying.
  }
}

/**
 * Kill the child and anything it started.
 *
 * `child.kill` terminates only the process that was spawned. Where that is a
 * `.cmd` shim the real app-server is its grandchild and survives, still holding
 * the inherited pipes - the same measured hang as above, from the other side.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (isWin && pid !== undefined) {
    try {
      // Absolute path for the same reason proc.ts resolves where.exe that way:
      // this has to work on a host whose PATH is broken.
      const taskkill = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'taskkill.exe');
      spawnSync(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    } catch {
      // Fall through to the direct kill below.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already dead is the outcome we wanted.
  }
}

/**
 * Spawn `codex app-server` and expose it as a transport.
 *
 * Mirrors the shim rule in proc.ts: a `.cmd` needs a shell, a real `.exe` must
 * not get one. The child is unref'd and killed on close so an app-server that
 * stops answering cannot keep the process alive after the run ends.
 */
export function spawnCodexAppServer(bin: string, cwd: string): AppServerTransport {
  const child = spawn(bin, ['app-server'], {
    cwd,
    shell: isWin && /\.(cmd|bat)$/i.test(bin),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  try {
    child.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    let stderr = '';
    let closed = false;
    let onClose: (reason: string) => void = () => {};

    child.stderr.on('data', (d: string) => {
      stderr = (stderr + d).slice(-STDERR_TAIL);
    });
    const reportClosed = (reason: string): void => {
      if (closed) return;
      closed = true;
      onClose(stderr.trim() === '' ? reason : `${reason}: ${stderr.trim().slice(-500)}`);
    };
    // Routed through the same path as a normal exit: an ENOENT here is just
    // "app-server is unavailable", and an unhandled 'error' event would instead
    // crash a run that was only asking for a percentage.
    child.on('error', (err: Error) => reportClosed(err.message));
    child.on('close', (code) => reportClosed(`exited with code ${String(code)}`));

    return {
      send(line: string): void {
        child.stdin.write(line, 'utf8');
      },
      onLine(cb: (line: string) => void): void {
        child.stdout.on('data', (d: string) => cb(d));
      },
      onClose(cb: (reason: string) => void): void {
        onClose = cb;
      },
      close(): void {
        try {
          child.stdin.end();
        } catch {
          // A pipe that is already gone needs no closing.
        }
        killTree(child);
        for (const pipe of [child.stdin, child.stdout, child.stderr]) destroyStream(pipe);
      },
    };
  } catch (err) {
    // A throw between spawn and return would strand the child with nobody
    // holding a reference to kill it.
    killTree(child);
    throw asUnavailable(err, `${path.basename(bin)} app-server`);
  }
}
