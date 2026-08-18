import { detail } from '@src/log.js';
import { markActivity, measuredWindow } from '@src/run.js';
import type { Config, RunState } from '@src/types.js';

/**
 * In-turn progress: what the live event stream says, and how often to say it.
 *
 * A planning or implementation turn is a single `claude -p` invocation that can
 * run for half an hour. The stream that already reports its tool uses was
 * thrown away until the process exited, so the terminal printed one line and
 * then went silent - indistinguishable from a hung run, and diagnosing it took
 * `Get-Process` plus reading state.json. Everything here is display: nothing in
 * this file decides anything about the run.
 */

export interface ProgressSnapshot {
  /** Tool uses (Claude) or stream items (Codex) seen so far. */
  activities: number;
  /** Most recent activity, already trimmed: "Read src/orchestrator.ts". */
  lastActivity: string | null;
  /** Turn tokens so far, summed the way claude.ts extractTokens sums them. */
  tokens: number;
  /** Prompt size of the most recent request: the live context proxy. */
  promptTokens: number;
}

export function emptySnapshot(): ProgressSnapshot {
  return { activities: 0, lastActivity: null, tokens: 0, promptTokens: 0 };
}

/** Returns true when the line was recognised. Never throws. */
export type LineParser = (snapshot: ProgressSnapshot, line: string) => boolean;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Parse one line, or return null. A malformed line is not worth a turn. */
function asEvent(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (trimmed === '' || !trimmed.startsWith('{')) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  return isRecord(event) ? event : null;
}

const TARGET_KEYS = ['file_path', 'path', 'pattern', 'command', 'description'] as const;
/** Total budget for the rendered target, ellipsis included. */
const TARGET_MAX = 60;
const ELLIPSIS = '...';

/** The most identifying string in a tool's input, if it carries one. */
function toolTarget(input: unknown): string | null {
  if (!isRecord(input)) return null;
  for (const key of TARGET_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') {
      const flat = value.replace(/\s+/g, ' ').trim();
      return flat.length > TARGET_MAX
        ? `${flat.slice(0, TARGET_MAX - ELLIPSIS.length)}${ELLIPSIS}`
        : flat;
    }
  }
  return null;
}

/**
 * Claude's `--output-format stream-json --verbose` stream.
 *
 * `promptTokens` follows extractUsage in claude.ts - input plus both cache
 * fields, which is the last request's real prompt size. `tokens` follows
 * extractTokens and adds output too, so the running figure converges on the
 * number the finished turn reports rather than being a second, differently
 * defined metric.
 */
export const parseClaudeLine: LineParser = (snapshot, line) => {
  const event = asEvent(line);
  if (event === null) return false;
  if (event['type'] === 'result') return true;
  if (event['type'] !== 'assistant') return false;

  const message = event['message'];
  if (!isRecord(message)) return false;
  let recognised = false;

  const content = message['content'];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block) || block['type'] !== 'tool_use') continue;
      const name = typeof block['name'] === 'string' ? block['name'] : 'tool';
      const target = toolTarget(block['input']);
      snapshot.activities += 1;
      snapshot.lastActivity = target === null ? name : `${name} ${target}`;
      recognised = true;
    }
  }

  const usage = message['usage'];
  if (isRecord(usage)) {
    const input = num(usage['input_tokens']);
    const output = num(usage['output_tokens']);
    const cacheRead = num(usage['cache_read_input_tokens']);
    const cacheCreation = num(usage['cache_creation_input_tokens']);
    snapshot.tokens += input + output + cacheRead + cacheCreation;
    snapshot.promptTokens = input + cacheRead + cacheCreation;
    recognised = true;
  }

  return recognised;
};

/**
 * Codex's `--json` stream, which is sparser: it names item types but reports no
 * per-request usage, so there is nothing here to drive a context percentage.
 *
 * Tokens add two fields, not four: `cached_input_tokens` is a subset of
 * `input_tokens` on OpenAI's nesting, as codex.ts extractTokens documents.
 */
export const parseCodexLine: LineParser = (snapshot, line) => {
  const event = asEvent(line);
  if (event === null) return false;
  const type = event['type'];

  if (type === 'item.started' || type === 'item.completed') {
    const item = event['item'];
    const itemType = isRecord(item) ? item['type'] : undefined;
    snapshot.activities += 1;
    if (typeof itemType === 'string' && itemType !== '') snapshot.lastActivity = itemType;
    return true;
  }

  if (type === 'turn.completed' && isRecord(event['usage'])) {
    const usage = event['usage'];
    snapshot.tokens = num(usage['input_tokens']) + num(usage['output_tokens']);
    return true;
  }

  return false;
};

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}h${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m${pad(seconds)}s`;
  return `${seconds}s`;
}

/** Same shape as the orchestrator's own token formatting, kept local. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export interface HeartbeatLine {
  label: string;
  elapsedMs: number;
  snapshot: ProgressSnapshot;
  /** Singular noun for what `activities` counts: 'tool use' or 'event'. */
  unit: string;
  contextWindow?: number | undefined;
}

/**
 * One heartbeat line.
 *
 * Every segment except elapsed time is omitted when the stream has not supplied
 * a number for it. That is what lets the sparser Codex stream degrade to
 * elapsed-only rather than reporting invented figures.
 */
export function formatHeartbeat(args: HeartbeatLine): string {
  const { label, elapsedMs, snapshot, unit, contextWindow } = args;
  const parts: string[] = [formatElapsed(elapsedMs)];

  if (snapshot.activities > 0) {
    parts.push(`${snapshot.activities} ${unit}${snapshot.activities === 1 ? '' : 's'}`);
  }
  if (snapshot.lastActivity !== null) parts.push(snapshot.lastActivity);
  if (snapshot.tokens > 0) parts.push(`${fmtTokens(snapshot.tokens)} tok`);
  if (contextWindow !== undefined && contextWindow > 0 && snapshot.promptTokens > 0) {
    parts.push(`ctx ${Math.round((snapshot.promptTokens / contextWindow) * 100)}%`);
  }

  return `${label}: ${parts.join(' · ')}`;
}

export function dueForEmit(lastEmitAt: number, now: number, intervalMs: number): boolean {
  return now - lastEmitAt >= intervalMs;
}

/**
 * One progress observation, handed to the state layer.
 *
 * `lastLineAt` and `turnStartedAt` are *recomputed across every live turn* on
 * each observation rather than reported per heartbeat, and the state layer
 * writes them as given. That is what keeps them describing the turns actually
 * running: `withConcurrentCompaction` overlaps a rotation with a Codex turn, and
 * when the shorter one ended, a per-heartbeat value left the finished
 * rotation's output time and start behind while the Codex turn was still going.
 * They are carried separately from `at` so a throttled write records when a
 * child really spoke rather than when vibe got round to writing the file.
 *
 * `'start'` is the turn boundary, `'end'` a turn leaving while others continue,
 * and `'final'` the end-of-turn flush; all three bypass the write throttle.
 * Without `'final'`, a line arriving inside the throttle window immediately
 * before the child closed would never be persisted at all. Without `'start'`, a
 * turn that failed before saying anything left the previous turn's timestamps in
 * place, and a watcher read them as this turn's.
 */
export interface ActivityObservation {
  source: 'start' | 'stdout' | 'heartbeat' | 'final' | 'end';
  at: Date;
  /** Most recent line from any live turn; null when none has spoken yet. */
  lastLineAt: Date | null;
  /** Start of the most recently started live turn; null when none is live. */
  turnStartedAt: Date | null;
}

/** Behind an interface so a test can observe that `unref` was called. */
export interface RepeatingTimer {
  unref(): void;
  cancel(): void;
}

export interface TimerApi {
  repeat(tick: () => void, intervalMs: number): RepeatingTimer;
}

export const nodeTimers: TimerApi = {
  repeat: (tick, intervalMs) => {
    const timer = setInterval(tick, intervalMs);
    return {
      unref: () => {
        timer.unref();
      },
      cancel: () => {
        clearInterval(timer);
      },
    };
  },
};

export interface ProgressOptions {
  label: string;
  intervalMs: number;
  /** Enables the `ctx N%` segment. Omitted means the segment is omitted. */
  contextWindow?: number | undefined;
  /**
   * Which run's live turns this heartbeat is one of - the `RunState` it reports
   * to, supplied by `progressOptions`.
   *
   * Liveness is aggregated per scope, not per process: two runs driven from one
   * process each write their own state.json, and a turn in one must not make a
   * turn in the other look concurrent - which would stop its turn boundary
   * clearing a stale output time. Omitted shares one default scope, which is
   * right for a single heartbeat under test.
   */
  scope?: object | undefined;
  /** Called once per observation. See the ownership rule in createHeartbeat. */
  onActivity?: ((observation: ActivityObservation) => void) | undefined;
  now?: (() => number) | undefined;
  emit?: ((line: string) => void) | undefined;
  timers?: TimerApi | undefined;
}

export interface Heartbeat {
  /** Open the turn: rebase the persisted liveness fields onto it. Emits nothing. */
  begin: () => void;
  onLine: (line: string) => void;
  /** Persist the last line's time, ignoring the write throttle. Emits nothing. */
  flush: () => void;
  stop: () => void;
}

/** What one live turn contributes to the shared liveness fields. */
interface LiveTurn {
  startedAt: number;
  lastLineAt: number | null;
}

/**
 * Turns with an open heartbeat, per run.
 *
 * `withConcurrentCompaction` overlaps a rotation turn with a Codex turn, so
 * "the current turn" is occasionally two turns, and every observation has to be
 * computed from the set rather than from whichever heartbeat happened to fire.
 * Deliberately in memory only: a persisted liveness record left behind by a
 * killed process would assert that a turn is running when none is, which is the
 * stale claim this whole area exists to remove.
 */
const liveTurns = new WeakMap<object, Map<number, LiveTurn>>();
/** The scope for heartbeats that name none - one heartbeat under test. */
const DEFAULT_SCOPE: object = {};
let nextTurnId = 0;

function liveTurnsFor(scope: object): Map<number, LiveTurn> {
  let turns = liveTurns.get(scope);
  if (turns === undefined) {
    turns = new Map<number, LiveTurn>();
    liveTurns.set(scope, turns);
  }
  return turns;
}

/** The latest of a set of times, or null when the set contributes none. */
function latest(values: readonly (number | null)[]): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (value !== null && (best === null || value > best)) best = value;
  }
  return best;
}

/**
 * A throttled progress reporter for one turn.
 *
 * Driven by arriving lines *and* by a repeating timer. The timer is not
 * redundant: a long single reasoning block emits no stream events at all, and
 * silence was the failure this exists to fix. It is unref'd so it can never
 * hold the event loop open, and `stop()` makes it inert for turns that threw.
 */
export function createHeartbeat(
  options: ProgressOptions & { parse: LineParser; unit: string },
): Heartbeat {
  const {
    label,
    intervalMs,
    contextWindow,
    onActivity,
    parse,
    unit,
    scope = DEFAULT_SCOPE,
    now = () => Date.now(),
    emit = detail,
    timers = nodeTimers,
  } = options;

  const snapshot = emptySnapshot();
  const startedAt = now();
  const turns = liveTurnsFor(scope);
  const id = (nextTurnId += 1);
  const self: LiveTurn = { startedAt, lastLineAt: null };
  let lastEmitAt = startedAt;
  let lastLineAt: number | null = null;
  let stopped = false;
  let begun = false;

  /** Emits if the throttle allows. Notifies nobody: see the ownership rule. */
  const emitNow = (): boolean => {
    if (stopped || !dueForEmit(lastEmitAt, now(), intervalMs)) return false;
    lastEmitAt = now();
    try {
      emit(
        formatHeartbeat({
          label,
          elapsedMs: lastEmitAt - startedAt,
          snapshot,
          unit,
          contextWindow,
        }),
      );
    } catch {
      // A broken sink must not take down a run.
    }
    return true;
  };

  /**
   * Every live turn in this scope, plus this one when it is not registered.
   *
   * The unregistered case is a heartbeat that reports before `begin` or that has
   * already stopped: it still describes itself rather than reporting nothing,
   * which is what keeps a single heartbeat's behaviour independent of whether
   * the turn boundary was opened.
   */
  const contributors = (includeSelf: boolean): readonly LiveTurn[] => {
    const live = [...turns.values()];
    return includeSelf && !turns.has(id) ? [...live, self] : live;
  };

  const notify = (source: ActivityObservation['source'], includeSelf = true): void => {
    try {
      const live = contributors(includeSelf);
      const line = latest(live.map((turn) => turn.lastLineAt));
      const started = latest(live.map((turn) => turn.startedAt));
      onActivity?.({
        source,
        at: new Date(now()),
        lastLineAt: line === null ? null : new Date(line),
        turnStartedAt: started === null ? null : new Date(started),
      });
    } catch {
      // A failing state write must not take down a run either.
    }
  };

  // Ownership: begin is the ONLY caller for 'start', onLine the ONLY caller for
  // 'stdout', the tick the ONLY caller for 'heartbeat', flush the ONLY caller
  // for 'final', and emitNow calls none of them. A line that also triggers an
  // emission notifies exactly once.
  const onLine = (line: string): void => {
    if (stopped) return;
    lastLineAt = now();
    self.lastLineAt = lastLineAt;
    try {
      parse(snapshot, line);
    } catch {
      // A malformed line is not a run-ending event.
    }
    notify('stdout');
    emitNow();
  };

  const handle = timers.repeat(() => {
    if (emitNow()) notify('heartbeat');
  }, intervalMs);
  handle.unref();

  return {
    begin: () => {
      if (stopped || begun) return;
      begun = true;
      self.startedAt = now();
      turns.set(id, self);
      notify('start');
    },
    onLine,
    flush: () => {
      if (!stopped && lastLineAt !== null) notify('final');
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      handle.cancel();
      if (!begun) return;
      begun = false;
      turns.delete(id);
      // Only while another turn is still running. That turn's output time and
      // start have to replace this one's, or a watcher reads the finished
      // rotation's last line as the live Codex turn's progress. With nothing
      // left running there is nothing to recompute *to*: the completed turn's
      // final state stands as the run's last known pulse until the next turn
      // boundary rebases it.
      if (turns.size > 0) notify('end', false);
    },
  };
}

/**
 * Run `work` with a heartbeat attached.
 *
 * `begin()` opens the turn, which is what rebases the persisted liveness fields
 * onto it - this is the one seam both adapters share, so the boundary exists
 * once rather than per adapter.
 *
 * The flush happens only once `work` has succeeded, and `work` now spans the
 * adapter's validation of the buffered output as well as the child process: a
 * turn whose output the adapter rejected must not record a completed-turn
 * observation, which is what it did while only the raw `run()` call was wrapped.
 * "Accepted" means the payload the adapter requires, not the child's exit
 * status - see the exit-status note on `claudeTurn` and `codexTurn`. A line
 * arriving inside the write throttle just before the child closed would
 * otherwise never reach state.json, while a timed-out turn must write nothing
 * at all after its promise has settled.
 */
export async function withHeartbeat<T>(
  heartbeat: Heartbeat | null,
  work: () => Promise<T>,
): Promise<T> {
  try {
    heartbeat?.begin();
    const result = await work();
    heartbeat?.flush();
    return result;
  } finally {
    heartbeat?.stop();
  }
}

/**
 * Context windows reported by completed Claude turns, this process only.
 *
 * The persisted window in state.json now carries the model that measured it
 * (issue #6), so it is a second, equally justifiable source - see
 * progressOptions. This map stays because it is the fresher of the two and
 * needs no state write to maintain.
 */
const windows = new Map<string, number>();

export function rememberContextWindow(model: string, contextWindow: number): void {
  if (contextWindow > 0) windows.set(model, contextWindow);
}

export function progressOptions(
  state: RunState,
  cfg: Config,
  label: string,
): ProgressOptions | undefined {
  if (!cfg.progress.enabled) return undefined;
  // Either source has to name this exact model: the in-process map is keyed by
  // it, and the persisted one is only returned when its `contextModel` tag
  // matches. A resumed run can therefore show `ctx%` on its first turn instead
  // of its second, without the rule changing.
  const contextWindow = windows.get(cfg.claude.model) ?? measuredWindow(state, cfg.claude.model);
  return {
    label,
    intervalMs: cfg.progress.intervalMs,
    // The run this turn belongs to, so liveness is aggregated per run rather
    // than per process: the fields it feeds live in this state.json and nowhere
    // else, and a turn from another run must not be counted among them.
    scope: state,
    onActivity: (observation) => markActivity(state, observation),
    // Absent until some turn under this exact model has reported a window.
    // Omitting the segment is always preferable to a number that cannot be
    // justified.
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}
