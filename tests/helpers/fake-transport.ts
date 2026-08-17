import { encodeMessage } from '@src/appserver.js';
import type { AppServerTransport } from '@src/appserver.js';

/**
 * An in-memory transport.
 *
 * The real one spawns `codex app-server`, which needs a logged-in account, takes
 * seconds and hits the network - none of which belongs in a test. Everything
 * above the transport seam is exercised for real against this.
 */
export class FakeTransport implements AppServerTransport {
  readonly sent: Record<string, unknown>[] = [];
  closed = false;
  /** Called with each outgoing message, so a test can answer it. */
  onSend: ((msg: Record<string, unknown>, transport: FakeTransport) => void) | null = null;

  private lineCb: ((line: string) => void) | null = null;
  private closeCb: ((reason: string) => void) | null = null;

  send(line: string): void {
    const msg = JSON.parse(line) as Record<string, unknown>;
    this.sent.push(msg);
    this.onSend?.(msg, this);
  }

  onLine(cb: (line: string) => void): void {
    this.lineCb = cb;
  }

  onClose(cb: (reason: string) => void): void {
    this.closeCb = cb;
  }

  close(): void {
    this.closed = true;
  }

  /** Deliver one message from the server. */
  emit(msg: Record<string, unknown>): void {
    this.lineCb?.(encodeMessage(msg));
  }

  /** Deliver raw bytes, for framing that a well-formed message cannot express. */
  emitRaw(chunk: string): void {
    this.lineCb?.(chunk);
  }

  emitClose(reason = 'exited with code 1'): void {
    this.closeCb?.(reason);
  }

  /** Every message sent so far for one method, in order. */
  sentFor(method: string): Record<string, unknown>[] {
    return this.sent.filter((m) => m['method'] === method);
  }
}

/**
 * A transport that answers `initialize` and lets the test answer the rest.
 *
 * `results` maps a method to the `result` it should return; a method with no
 * entry is left unanswered so a test can assert on a timeout or answer it later.
 */
export function respondingTransport(
  results: Readonly<Record<string, unknown>>,
  overrides: { failInitialize?: string; closeOnInitialize?: boolean } = {},
): FakeTransport {
  const transport = new FakeTransport();
  transport.onSend = (msg, t) => {
    const method = msg['method'];
    const id = msg['id'];
    if (typeof method !== 'string' || typeof id !== 'number') return;

    if (method === 'initialize') {
      if (overrides.closeOnInitialize === true) {
        t.emitClose('exited with code 1');
        return;
      }
      if (overrides.failInitialize !== undefined) {
        t.emit({ id, error: { code: -32600, message: overrides.failInitialize } });
        return;
      }
      t.emit({ id, result: { userAgent: 'codex' } });
      return;
    }
    if (method in results) t.emit({ id, result: results[method] });
  };
  return transport;
}
