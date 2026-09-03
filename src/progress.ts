import { detail } from '@src/log.js';
import type { Meta } from '@src/log.js';
import { markActivity, measuredWindow } from '@src/run.js';
import type { AgentProvider } from '@src/runtime.js';
import type { Config, InFlightTurn, RunState, TurnActivity } from '@src/types.js';

/**
 * In-turn progress: what the live event stream says, and how often to say it.
 *
 * A planning or implementation turn is a single `claude -p` invocation that can
 * run for half an hour. The stream that already reports its tool uses was
 * thrown away until the process exited, so the terminal printed one line and
 * then went silent - indistinguishable from a hung run, and diagnosing it took
 * `Get-Process` plus reading state.json. Everything here is display: nothing in
 * this file decides anything about the run.
 *
 * Since #66 that last sentence has one exception, and it is deliberately narrow:
 * the per-turn *tally* gathered here (`items`, `toolItems`) is carried out
 * through `Heartbeat.activity` and does reach a decision - `downgradeInert` in
 * evidence.ts. Everything else remains display.
 */

export interface ProgressSnapshot {
  /**
   * Tool uses (Claude) or stream items (Codex) seen so far.
   *
   * A *liveness* counter, and deliberately not the same number as `items` below.
   * It counts `item.started` AND `item.completed`, because a three-minute
   * `npm test` emits the start and then nothing at all - under a
   * completions-only counter the heartbeat would sit frozen through it, and
   * silence is the exact failure `createHeartbeat` exists to fix. On the #65
   * run's review turn the last heartbeat line read `61 events` for a turn whose
   * rollout records 30 commands: 61 = 2 x 30 + 1. Both numbers are truthful
   * about what they are; only the tally is a record of what happened.
   */
  activities: number;
  /**
   * How many items of each kind this turn emitted, counted once each (#66).
   *
   * The provider's own vocabulary: Claude's tool names plus `message`, Codex's
   * item types. Empty means nothing was observed, which is not the same fact as
   * "nothing was done" - see `activity()`.
   */
  items: Map<string, number>;
  /** How many of `items` were the agent using a tool. See `NON_TOOL_CODEX_ITEMS`. */
  toolItems: number;
  /** Most recent activity, already trimmed: "Read src/orchestrator.ts". */
  lastActivity: string | null;
  /** Turn tokens so far, summed the way claude.ts extractTokens sums them. */
  tokens: number;
  /** Prompt size of the most recent request: the live context proxy. */
  promptTokens: number;
  /**
   * Assistant message ids whose usage has already been added to `tokens`.
   *
   * Claude emits one `assistant` event per content block, each repeating the
   * whole message's usage, so counting every event triples a message carrying
   * text plus two tool_use blocks. See `parseClaudeLine`.
   */
  countedMessages: Set<string>;
  /**
   * Assistant message ids already counted as a `message` item in `items`.
   *
   * Deliberately a second set rather than a reuse of `countedMessages`, because
   * the two record different facts and one event can establish either without
   * the other. An assistant message may arrive with no `usage` at all - the
   * adapter accepts such a turn, `extractUsage` returns null for it - and that
   * message still happened, so it belongs in the tally. If it were added to
   * `countedMessages` to dedupe the item, a later usage-bearing event repeating
   * the same id would read as already counted and its tokens would be dropped,
   * which is the undercount #77 depends on not happening. So: one set for "its
   * tokens are in", one for "it is in the tally" (#66).
   */
  itemisedMessages: Set<string>;
}

export function emptySnapshot(): ProgressSnapshot {
  return {
    activities: 0,
    items: new Map(),
    toolItems: 0,
    lastActivity: null,
    tokens: 0,
    promptTokens: 0,
    countedMessages: new Set(),
    itemisedMessages: new Set(),
  };
}

/** One item into the tally. `isTool` is the parse site's judgement, not a guess here. */
function tally(snapshot: ProgressSnapshot, kind: string, isTool: boolean): void {
  snapshot.items.set(kind, (snapshot.items.get(kind) ?? 0) + 1);
  if (isTool) snapshot.toolItems += 1;
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
 *
 * The dedupe by `message.id` is what makes that last sentence true. Claude emits
 * one `assistant` event per content block and repeats the whole message's usage
 * on each, while the result envelope counts it once - so the running figure used
 * to overstate, badly and silently. On the #60 run's killed implement turn the
 * undeduped sum was 22,756,746 against the envelope's 17,390,262, and on its
 * plan turn the heartbeat overstated by 99%. Deduped, the running figure matched
 * what vibe charged to the token on all three chargeable turns of that run,
 * which is what lets a killed turn's spend be reconstructed from it (#77).
 *
 * A message with no id counts as distinct: the real stream always carries one,
 * and inventing an identity for a message that named none would merge two
 * genuinely separate messages, which is the error in the expensive direction.
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
      // Every `tool_use` block is by definition the agent using a tool, so the
      // Claude side needs no vocabulary at all - the kind IS the tool name (#66).
      tally(snapshot, name, true);
      snapshot.lastActivity = target === null ? name : `${name} ${target}`;
      recognised = true;
    }
  }

  const rawId = message['id'];
  const id = typeof rawId === 'string' && rawId !== '' ? rawId : null;
  const usage = message['usage'];
  const hasUsage = isRecord(usage);

  // One non-tool `message` item per message, and NOT gated on usage (#66).
  //
  // Gating it on usage was a hole: `parseStream` accepts a turn whose assistant
  // events carry none - `extractUsage` returns null and the run proceeds - so a
  // Claude reviewer that wrote one text-only message and used no tools would
  // leave an empty tally. An empty tally is "nothing observed", which is never
  // inert, so exactly the turn this rule exists to catch would have escaped it
  // on that provider.
  //
  // An id is required, because that is what separates a real message from the
  // malformed shapes the parser must leave alone - the module comment above
  // records that the real stream always carries one. A usage-bearing message
  // without one is still tallied per event, matching how its tokens are counted.
  if (id !== null) {
    if (!snapshot.itemisedMessages.has(id)) {
      snapshot.itemisedMessages.add(id);
      tally(snapshot, 'message', false);
    }
    recognised = true;
  } else if (hasUsage) {
    tally(snapshot, 'message', false);
  }

  if (hasUsage) {
    // Its own dedupe, over its own set: a usage-less event must not mark this id
    // as counted, or the usage-bearing event that follows it would be read as a
    // repeat and its tokens dropped. See `itemisedMessages`.
    const seen = id !== null && snapshot.countedMessages.has(id);
    if (id !== null) snapshot.countedMessages.add(id);
    // Recognised either way: this event WAS a usage-bearing assistant event, and
    // saying otherwise would make the parser's return value mean something new.
    // Only the arithmetic is skipped, `promptTokens` included - a repeat carries
    // the same prompt size, so re-assigning it would be a no-op with a hazard.
    if (!seen) {
      const input = num(usage['input_tokens']);
      const output = num(usage['output_tokens']);
      const cacheRead = num(usage['cache_read_input_tokens']);
      const cacheCreation = num(usage['cache_creation_input_tokens']);
      snapshot.tokens += input + output + cacheRead + cacheCreation;
      snapshot.promptTokens = input + cacheRead + cacheCreation;
    }
    recognised = true;
  }

  return recognised;
};

/**
 * Codex item types that are the model thinking or talking, not using a tool.
 *
 * A deny-list over an *observed* set, never an allow-list of tools, because the
 * two vocabularies in play do not agree. Across all 23 archived `transcript.log`
 * files `lastActivity` has ever taken exactly three values - `command_execution`
 * (1628), `agent_message` (58), `web_search` (10) - while the rollouts under
 * `~/.codex/sessions` name `Reasoning`, `CommandExecution`, `AgentMessage`,
 * `UserMessage`, `ContextCompaction` and `Extension` in PascalCase, and record
 * no `web_search` at all. So neither set can be enumerated from the other, and
 * an allow-list would silently classify a kind vibe has never seen as "not a
 * tool" - which is a false downgrade.
 *
 * Both entries here are observed: `agent_message` on the stream, `reasoning` in
 * the rollout. `context_compaction` is a known candidate and is deliberately
 * NOT listed - its stream spelling has never been seen here, and inventing one
 * would be guessing at a mapping. Leaving it off fails open: an unrecognised
 * kind makes a turn look active, which loses a detection rather than downgrading
 * a true finding, and evidence.ts records why that is the right direction.
 */
const NON_TOOL_CODEX_ITEMS = new Set(['agent_message', 'reasoning']);

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
    // The tally counts completions only, where `activities` counts both: an item
    // that started and never finished happened once, not twice, and the record
    // has no reason to double it the way the liveness counter must (#66).
    if (type === 'item.completed' && typeof itemType === 'string' && itemType !== '') {
      tally(snapshot, itemType, !NON_TOOL_CODEX_ITEMS.has(itemType));
    }
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
 * The same heartbeat as data, for a host that renders a row rather than a line.
 *
 * `formatHeartbeat` below is one renderer of this record, not the record itself
 * (#133) - a host that had to parse `implement: 9m12s · 47 tool calls · ...`
 * back apart would break on the next wording change.
 *
 * **The omission rule is the formatter's, deliberately.** A field is present
 * when the stream supplied it and absent when it did not, exactly as the string
 * drops the segment. `activities: 0` and `tokens: 0` are counted zeros and are
 * facts; `lastActivity: null` and an unmeasured `contextWindow` are absences,
 * and an absence reported as zero is the one thing this repo never records.
 *
 * `unit` travels with `activities` because it is the noun that makes the number
 * mean something: 'tool use' for Claude, 'event' for Codex, and they do not
 * count the same thing.
 */
export function heartbeatData(args: HeartbeatLine): Record<string, unknown> {
  const { label, elapsedMs, snapshot, unit, contextWindow } = args;
  const data: Record<string, unknown> = {
    label,
    elapsedMs,
    activities: snapshot.activities,
    unit,
    tokens: snapshot.tokens,
    promptTokens: snapshot.promptTokens,
  };
  if (snapshot.lastActivity !== null) data['lastActivity'] = snapshot.lastActivity;
  if (contextWindow !== undefined && contextWindow > 0) data['contextWindow'] = contextWindow;
  return data;
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
 * `'final'` the end-of-turn flush, and `'failed'` the flush of a turn that
 * threw; all of them bypass the write throttle. Without `'final'`, a line
 * arriving inside the throttle window immediately before the child closed would
 * never be persisted at all. Without `'start'`, a turn that failed before saying
 * anything left the previous turn's timestamps in place, and a watcher read them
 * as this turn's. Without `'failed'`, a turn that reported usage and then threw
 * inside the throttle window would be charged the last figure written up to five
 * seconds earlier - see the source rule in `markActivity`.
 */
export interface ActivityObservation {
  source: 'start' | 'stdout' | 'heartbeat' | 'final' | 'end' | 'failed';
  at: Date;
  /** Most recent line from any live turn; null when none has spoken yet. */
  lastLineAt: Date | null;
  /** Start of the most recently started live turn; null when none is live. */
  turnStartedAt: Date | null;
  /**
   * What each contributing turn has spent so far, for the accounting (#77).
   *
   * Optional and additive: an observation that carries none says nothing about
   * spend, and the state layer leaves the record alone rather than reading the
   * absence as "nothing in flight".
   */
  turns?: readonly InFlightTurn[] | undefined;
  /**
   * Write even inside the throttle window.
   *
   * Set for the first observation in which a turn's token figure becomes
   * non-zero. One extra write per turn, and it is the difference between
   * recovering a turn killed in its first five seconds and recording a zero for
   * it.
   */
  urgent?: boolean | undefined;
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
  /**
   * Where a heartbeat goes. Defaults to `log.detail`, which since #133 carries
   * the record alongside the line - so a host gets `{elapsedMs, activities,
   * tokens, ...}` and the terminal gets the sentence, from one call.
   */
  emit?: ((line: string, meta?: Meta) => void) | undefined;
  timers?: TimerApi | undefined;
}

export interface Heartbeat {
  /** Open the turn: rebase the persisted liveness fields onto it. Emits nothing. */
  begin: () => void;
  onLine: (line: string) => void;
  /** Persist the last line's time, ignoring the write throttle. Emits nothing. */
  flush: () => void;
  /**
   * Persist what this turn spent before it threw, ignoring the write throttle.
   *
   * The counterpart to `flush` for a turn that failed, and deliberately not the
   * same call: `flush` records a completed turn's output time, which a failed
   * turn has not earned. This carries the spend and nothing else, so the charge
   * that follows reads the figure the stream actually reached (#77).
   */
  fail: () => void;
  /**
   * What this turn did, or undefined when nothing was observed (#66).
   *
   * A copy, never a live view: the adapter reads it once at the end of the turn
   * and the object is then stored on the result, in the event log and - for a
   * reviewer - in the downgrade decision. A view would let a line arriving after
   * the read edit a fact already recorded.
   *
   * Undefined on an empty tally, which is what makes "unmeasured" and "used no
   * tools" different answers rather than the same zero.
   */
  activity: () => TurnActivity | undefined;
  stop: () => void;
}

/** What one live turn contributes to the shared liveness fields. */
interface LiveTurn {
  startedAt: number;
  lastLineAt: number | null;
  /** What this turn is, for the accounting record. See `InFlightTurn`. */
  label: string;
  provider: 'claude' | 'codex';
  /**
   * This turn's spend so far, or null where the provider reports none in flight.
   *
   * A function rather than a number because each heartbeat owns its own
   * snapshot and the set is read from every contributor on every observation.
   */
  tokens: () => number | null;
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
  options: ProgressOptions & {
    parse: LineParser;
    unit: string;
    /**
     * Whose stream this is, for the in-flight record (#77).
     *
     * Supplied by the adapters rather than by `progressOptions`, because the
     * adapter is what knows which parser it is handing over - which keeps a
     * per-role provider (#60) correct without a second place to state it, and
     * leaves every `ProgressOptions` literal untouched.
     */
    provider: 'claude' | 'codex';
  },
): Heartbeat {
  const {
    label,
    intervalMs,
    contextWindow,
    onActivity,
    parse,
    unit,
    provider,
    scope = DEFAULT_SCOPE,
    now = () => Date.now(),
    emit = detail,
    timers = nodeTimers,
  } = options;

  const snapshot = emptySnapshot();
  const startedAt = now();
  const turns = liveTurnsFor(scope);
  const id = (nextTurnId += 1);
  const self: LiveTurn = {
    startedAt,
    lastLineAt: null,
    label,
    provider,
    // Codex reports no usage until `turn.completed`, so there is nothing to
    // observe in flight and nothing honest to persist. A killed Codex turn is a
    // known unknown, not a zero.
    tokens: () => (provider === 'codex' ? null : snapshot.tokens),
  };
  let lastEmitAt = startedAt;
  let lastLineAt: number | null = null;
  let stopped = false;
  let begun = false;
  /** Whether this turn's spend has already been persisted once. See `urgent`. */
  let spendSeen = false;

  /** Emits if the throttle allows. Notifies nobody: see the ownership rule. */
  const emitNow = (): boolean => {
    if (stopped || !dueForEmit(lastEmitAt, now(), intervalMs)) return false;
    lastEmitAt = now();
    try {
      // Built once and rendered twice: the string for the terminal, the record
      // for a host. Two calls here would let the two drift apart in exactly the
      // way #133 exists to prevent.
      const line: HeartbeatLine = {
        label,
        elapsedMs: lastEmitAt - startedAt,
        snapshot,
        unit,
        contextWindow,
      };
      emit(formatHeartbeat(line), { id: 'heartbeat', data: heartbeatData(line) });
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

  /** What the contributing turns have spent, in the shape the state layer stores. */
  const spend = (live: readonly LiveTurn[]): InFlightTurn[] =>
    live.map((turn) => {
      const tokens = turn.tokens();
      return {
        label: turn.label,
        provider: turn.provider,
        ...(tokens === null ? {} : { tokens }),
      };
    });

  const notify = (
    source: ActivityObservation['source'],
    includeSelf = true,
    urgent = false,
  ): void => {
    try {
      const live = contributors(includeSelf);
      const line = latest(live.map((turn) => turn.lastLineAt));
      const started = latest(live.map((turn) => turn.startedAt));
      onActivity?.({
        source,
        at: new Date(now()),
        lastLineAt: line === null ? null : new Date(line),
        turnStartedAt: started === null ? null : new Date(started),
        turns: spend(live),
        ...(urgent ? { urgent } : {}),
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
    // The first line that puts a figure on this turn is written immediately,
    // once. Everything after it rides the ordinary throttle: writing per usage
    // event would rewrite state.json thousands of times a turn, which is what
    // the throttle exists to prevent.
    const first = !spendSeen && (self.tokens() ?? 0) > 0;
    if (first) spendSeen = true;
    notify('stdout', true, first);
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
    // Unconditional where `flush` is not: a turn that threw without ever
    // speaking still has to clear its own record, and a turn that spoke inside
    // the throttle window has a figure the charge is about to read.
    fail: () => {
      if (!stopped) notify('failed');
    },
    // Deliberately not gated on `stopped`: this is a read of what already
    // happened, and a caller reading it after the turn has been torn down must
    // get the same answer it would have got a moment earlier.
    activity: () =>
      snapshot.items.size === 0
        ? undefined
        : { items: Object.fromEntries(snapshot.items), tool: snapshot.toolItems },
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
  } catch (err: unknown) {
    // Before the rethrow, so the last observed spend is in state.json and in
    // memory by the time `chargeFailure` looks for it. Not `flush`: this records
    // what the turn spent, never that its output completed (#77).
    heartbeat?.fail();
    throw err;
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
 *
 * **Claude measurements, keyed by a bare model name.** Both writers are Claude
 * paths (`recordTurnContext` and `rotateSession` in context.ts) and nothing Codex ever
 * puts an entry here, so a hit says "some Claude turn measured this name" and
 * not "this window belongs to whoever asked". A model name is not unique across
 * providers - `claude.model` and a Codex role's model may legally be the same
 * string, since config checks only that a model is a non-empty name - so the
 * caller has to qualify by provider. `progressOptions` does; anything else
 * reading this map must too, and the day a Codex conversation reports a window
 * this map and `state.contextModel` need a provider tag before it can be stored
 * (#86).
 */
const windows = new Map<string, number>();

export function rememberContextWindow(model: string, contextWindow: number): void {
  if (contextWindow > 0) windows.set(model, contextWindow);
}

export function progressOptions(
  state: RunState,
  cfg: Config,
  label: string,
  /**
   * Which model this turn runs. No default: one used to exist, `cfg.claude.model`,
   * as #60's migration device - and a caller that named nothing therefore
   * inherited Claude's model silently, which is exactly how a Codex turn came to
   * be handed Claude's window (#86). Every caller now says whose window it is
   * asking for, so the trap cannot be re-armed by the next one.
   */
  model: string,
  /**
   * Which provider's conversation this turn runs on, and the other half of the
   * key. Both window sources hold Claude measurements under a bare model name
   * (see `windows`), and the same name may legally be configured for both
   * providers - `claude.model = "shared"` with a Codex role on `"shared"` is a
   * valid config, so the name alone cannot say whose conversation a window
   * describes. Without this, that config hands a Claude-measured window to a
   * Codex turn (#86).
   */
  provider: AgentProvider,
): ProgressOptions | undefined {
  if (!cfg.progress.enabled) return undefined;
  // Either source has to name this exact model: the in-process map is keyed by
  // it, and the persisted one is only returned when its `contextModel` tag
  // matches. A resumed run can therefore show `ctx%` on its first turn instead
  // of its second, without the rule changing.
  //
  // And only a Claude turn may read them at all, because only Claude turns write
  // them. Suppressing an unqualified hit is the fail-closed reading: a window
  // that cannot be attributed to this conversation is not evidence about it.
  const contextWindow =
    provider === 'claude' ? (windows.get(model) ?? measuredWindow(state, model)) : undefined;
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
