import { AppServerClient, spawnCodexAppServer } from '@src/appserver.js';
import type { AppServerTransport } from '@src/appserver.js';
import { codexBin } from '@src/codex.js';
import { detail } from '@src/log.js';
import type { CodexRateLimitRecord, Config } from '@src/types.js';

export type WindowKind = 'primary' | 'secondary';

export interface CodexWindow {
  kind: WindowKind;
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: Date | null;
}

export interface CodexRateLimits {
  primary: CodexWindow | null;
  secondary: CodexWindow | null;
  /** The window `rateLimitReachedType` names, or null when it names none we know. */
  reachedWindow: CodexWindow | null;
  /** The raw reached type, kept for the message even when it names no window. */
  reachedType: string | null;
  /** The fuller of the two windows: the one that stops work first. */
  worstWindow: CodexWindow;
  usedPercent: number;
  planType: string | null;
  capturedAt: Date;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function finiteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * `resetsAt` is unix seconds on the account this was measured against, but the
 * protocol is versioned and an epoch already past 1e12 could only be
 * milliseconds - year 33658 in seconds. Multiplying that again would put the
 * reset far enough out that the wait cap rejects it and the run stops for a
 * limit that had already cleared.
 */
function parseResetsAt(v: unknown): Date | null {
  const raw = finiteNumber(v);
  if (raw === null || raw <= 0) return null;
  const ms = raw > 1e12 ? raw : raw * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseWindow(kind: WindowKind, payload: unknown): CodexWindow | null {
  if (!isRecord(payload)) return null;
  const usedPercent = finiteNumber(payload['usedPercent']);
  // Without a percentage there is nothing to brake on, and treating a missing
  // field as 0 would report a healthy window that was never reported at all.
  if (usedPercent === null) return null;
  return {
    kind,
    usedPercent,
    windowDurationMins: finiteNumber(payload['windowDurationMins']),
    resetsAt: parseResetsAt(payload['resetsAt']),
  };
}

/**
 * Read a rate-limit payload.
 *
 * Accepts the `account/rateLimits/read` result, the params of an
 * `account/rateLimits/updated` notification, or the bare `rateLimits` object:
 * all three carry the same shape, and one parser means the pushed update cannot
 * drift from the polled one.
 *
 * Returns null when neither window is usable, which is the signal to leave the
 * run alone - an optional brake with no reading applies no force.
 */
export function parseRateLimits(payload: unknown, now: Date = new Date()): CodexRateLimits | null {
  if (!isRecord(payload)) return null;
  const wrapped = payload['rateLimits'];
  const limits = isRecord(wrapped) ? wrapped : payload;

  const primary = parseWindow('primary', limits['primary']);
  const secondary = parseWindow('secondary', limits['secondary']);
  if (primary === null && secondary === null) return null;

  const known = [primary, secondary].filter((w): w is CodexWindow => w !== null);
  const worstWindow = known.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));

  // Absent on the measured payload, which is an account that was nowhere near
  // its limit - so absent has to mean "not reached" rather than "unknown".
  const rawReached = limits['rateLimitReachedType'];
  const reachedType = typeof rawReached === 'string' && rawReached !== '' ? rawReached : null;
  const named = reachedType?.toLowerCase();
  // Anything other than a window name leaves reachedWindow null on purpose:
  // guessing would mean waiting on a reset that does not govern the limit that
  // was actually hit, and resuming straight back into it.
  const reachedWindow =
    named === 'primary' ? primary : named === 'secondary' ? secondary : null;

  const planType = typeof limits['planType'] === 'string' ? limits['planType'] : null;

  return {
    primary,
    secondary,
    reachedWindow,
    reachedType,
    worstWindow,
    usedPercent: worstWindow.usedPercent,
    planType,
    capturedAt: now,
  };
}

function describeWindow(window: CodexWindow): string {
  const duration =
    window.windowDurationMins === null ? '' : ` of a ${window.windowDurationMins}-min window`;
  const reset = window.resetsAt === null ? '' : `, resets ${window.resetsAt.toLocaleString()}`;
  return `${window.usedPercent}%${duration}${reset}`;
}

export function describeLimits(limits: CodexRateLimits): string {
  const plan = limits.planType === null ? '' : ` (${limits.planType})`;
  const reached = limits.reachedType === null ? '' : ` - limit reached: ${limits.reachedType}`;
  return `codex rate limit${plan}: ${limits.worstWindow.kind} ${describeWindow(limits.worstWindow)}${reached}`;
}

export type CodexLimitDecision =
  | { action: 'proceed' }
  | { action: 'wait'; window: CodexWindow | null; resetsAt: Date | null; reason: string }
  | { action: 'stop'; window: CodexWindow; reason: string };

/**
 * The whole policy, kept out of the orchestrator so it can be tested without
 * spawning anything or waiting for anything.
 */
export function decideCodexLimit(limits: CodexRateLimits, percent: number): CodexLimitDecision {
  if (limits.reachedType !== null) {
    const window = limits.reachedWindow;
    const where =
      window === null
        ? `on a window vibe does not recognise ("${limits.reachedType}")`
        : `on its ${window.kind} window (${describeWindow(window)})`;
    return {
      action: 'wait',
      window,
      // Null when the reached type names no window: `plannedWait` then backs off
      // a fixed step, which is honest about not knowing. The other window's
      // reset would be a fabricated time.
      resetsAt: window?.resetsAt ?? null,
      reason: `Codex reports its rate limit reached ${where}.`,
    };
  }

  const worst = limits.worstWindow;
  if (percent > 0 && worst.usedPercent >= percent) {
    return {
      action: 'stop',
      window: worst,
      reason:
        `Codex's ${worst.kind} rate-limit window is ${describeWindow(worst)}, at or above ` +
        `budget.codexLimitPercent (${percent}). Stopping before a Codex turn that the window ` +
        'would likely kill partway through. Resume once it resets, or raise the threshold.',
    };
  }
  return { action: 'proceed' };
}

/**
 * Build the persisted record.
 *
 * Takes the window the decision named - null for `proceed`, and null for a
 * reached limit whose type names no window - and falls back to the fuller
 * window explicitly, flagging that it did. Without the flag a summary line
 * would present a window vibe picked as one the server reported.
 */
export function recordLimits(
  limits: CodexRateLimits,
  window: CodexWindow | null,
): CodexRateLimitRecord {
  const chosen = window ?? limits.worstWindow;
  return {
    window: chosen.kind,
    windowFromServer: window !== null && window === limits.reachedWindow,
    usedPercent: chosen.usedPercent,
    windowDurationMins: chosen.windowDurationMins,
    resetsAt: chosen.resetsAt === null ? null : chosen.resetsAt.toISOString(),
    reachedType: limits.reachedType,
    planType: limits.planType,
    capturedAt: limits.capturedAt.toISOString(),
  };
}

export type TransportFactory = (cwd: string) => AppServerTransport;

/** Startup includes process spawn and an auth check; a later read does not. */
const HANDSHAKE_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * Pure optimisation: pushed updates keep it current, and every decision that
 * needs a guaranteed-fresh reading calls `invalidate()` first.
 */
const SNAPSHOT_TTL_MS = 60_000;

const RATE_LIMITS_READ = 'account/rateLimits/read';
const RATE_LIMITS_UPDATED = 'account/rateLimits/updated';

interface Snapshot {
  limits: CodexRateLimits;
  at: number;
}

/**
 * One app-server connection per run, read before each Codex turn.
 *
 * Everything here is best-effort: app-server is experimental, the account may
 * not be logged in, and older Codex builds have no `app-server` subcommand at
 * all. A single failure disables the monitor for the rest of the run, so a
 * machine without it pays the handshake timeout once rather than before every
 * turn.
 */
export interface MonitorOptions {
  ttlMs?: number | undefined;
  handshakeTimeoutMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
}

export class CodexRateLimitMonitor {
  private client: AppServerClient | null = null;
  private snapshot: Snapshot | null = null;
  private disabled = false;
  private readonly ttlMs: number;
  private readonly handshakeTimeoutMs: number;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly createTransport: TransportFactory,
    options: MonitorOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? SNAPSHOT_TTL_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async read(cfg: Config, cwd: string): Promise<CodexRateLimits | null> {
    if (this.disabled || !cfg.codex.readRateLimits) return null;

    // Catches `unknown`, not just AppServerUnavailableError: codexBin() throws a
    // plain Error when codex cannot be located, and a transport can fail while
    // being constructed, before any child event exists to reject a promise. An
    // optional signal must never become a new way for a run to die.
    try {
      const client = this.client ?? (await this.connect(cwd));

      const cached = this.snapshot;
      if (cached !== null && this.stillDescribesNow(cached)) return cached.limits;

      const result = await client.request(RATE_LIMITS_READ, undefined, this.requestTimeoutMs);
      const limits = parseRateLimits(result);
      if (limits !== null) this.snapshot = { limits, at: Date.now() };
      return limits;
    } catch (err: unknown) {
      this.disable(err);
      return null;
    }
  }

  /** Drop the cached reading so the next `read()` must go to the server. */
  invalidate(): void {
    this.snapshot = null;
  }

  /**
   * Whether a cached reading can still stand in for a fresh one.
   *
   * The TTL alone was not enough to keep the cache out of the decision. Two
   * readings must never be served from it, however recent:
   *
   * - one that says the limit is *reached*, because that is the only state that
   *   changes what the run does, and re-reading it costs a single round trip;
   * - one whose window has since reset, because it describes a window that no
   *   longer exists - which would keep a run waiting, or stopped, on a limit
   *   that had already cleared.
   *
   * What is left is the ordinary case: a window nowhere near its threshold,
   * where a reading up to `ttlMs` old cannot change any decision.
   */
  private stillDescribesNow(snapshot: Snapshot): boolean {
    const { limits } = snapshot;
    if (limits.reachedType !== null) return false;

    const now = Date.now();
    for (const window of [limits.primary, limits.secondary]) {
      if (window?.resetsAt != null && window.resetsAt.getTime() <= now) return false;
    }
    return now - snapshot.at < this.ttlMs;
  }

  close(): void {
    // Disabled as well as closed: a probe arriving after the run has finished
    // must not spawn a fresh app-server that then outlives the process.
    this.disabled = true;
    this.closeClient();
  }

  private async connect(cwd: string): Promise<AppServerClient> {
    const transport = this.createTransport(cwd);

    let client: AppServerClient;
    try {
      client = new AppServerClient(transport, {
        handshakeTimeoutMs: this.handshakeTimeoutMs,
        requestTimeoutMs: this.requestTimeoutMs,
      });
    } catch (err) {
      // The constructor registers stream callbacks, so it can fail after the
      // child exists. Nothing else holds the transport at this point.
      try {
        transport.close();
      } catch {
        // Already gone.
      }
      throw err;
    }

    // Assigned before the await, and closed in the catch: a handshake that times
    // out otherwise rejects with the only reference to the spawned child still
    // on the stack, leaving an app-server process and its pipes alive for the
    // rest of the run.
    this.client = client;
    // A child that dies of its own accord is otherwise invisible: no request is
    // in flight to reject, so the cached reading kept being served for the rest
    // of the TTL - a run deciding on a number read from a process that no longer
    // existed.
    client.onClosed((reason) => {
      if (this.client === client) this.disable(new Error(reason));
    });
    try {
      await client.handshake();
    } catch (err) {
      client.close();
      this.client = null;
      throw err;
    }

    // The protocol pushes updates to a client that holds the connection open, so
    // most turns need no request at all.
    client.onNotification(RATE_LIMITS_UPDATED, (params) => {
      const limits = parseRateLimits(params);
      if (limits !== null) this.snapshot = { limits, at: Date.now() };
    });
    return client;
  }

  private disable(err: unknown): void {
    // Guarded so the reason is reported once: a dying child reaches here through
    // both the close callback and the rejected request it caused.
    const first = !this.disabled;
    this.disabled = true;
    this.closeClient();
    if (!first) return;
    const message = err instanceof Error ? err.message : String(err);
    detail(`codex rate limits unavailable, continuing without them: ${message}`);
  }

  private closeClient(): void {
    const client = this.client;
    this.client = null;
    this.snapshot = null;
    try {
      client?.close();
    } catch {
      // A connection that cannot be closed cleanly is already gone.
    }
  }
}

/**
 * A module-level instance rather than a parameter threaded through
 * `runCritique`, `runReview` and `runAnswers`: there is one run per process and
 * one connection per run.
 */
let monitor: CodexRateLimitMonitor | null = null;

function shared(): CodexRateLimitMonitor {
  monitor ??= new CodexRateLimitMonitor((cwd) => spawnCodexAppServer(codexBin(), cwd));
  return monitor;
}

export function readCodexRateLimits(cfg: Config, cwd: string): Promise<CodexRateLimits | null> {
  return shared().read(cfg, cwd);
}

export function invalidateCodexRateLimits(): void {
  monitor?.invalidate();
}

export function closeCodexRateLimits(): void {
  // The instance is kept, not dropped: `close()` disables it, and replacing it
  // with null would let a probe arriving after the run spawn a fresh
  // app-server that then has nothing left to close it.
  monitor?.close();
}
