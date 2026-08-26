import { randomUUID } from 'node:crypto';
import type { AgentProvider } from '@src/runtime.js';
import type { Config, RunState } from '@src/types.js';

/**
 * A managed conversation, with an explicit lifecycle.
 *
 * There were two conversations before this module, and they used opposite
 * conventions for the same two facts. The Claude session minted its id up front
 * and tracked success in a separate `sessionStarted` marker, so the id existing
 * meant nothing. The Codex thread had no marker, because its id only ever came
 * back from a turn that succeeded - the id *was* the marker. Both were correct,
 * and correct by accident of which half of the pattern each used.
 *
 * A second conversation built by taking one half from each convention - an id
 * created and saved before the first turn, then read back as proof that a turn
 * had happened - reports memory it does not have: `--resume` against a session
 * that never existed, and continuity claimed to prompts that never ran.
 *
 * So the contract is stated once, here, for every slot:
 *
 *   id        the conversation id, or null when there is none to resume
 *   origin    who mints the id: the client, before the first turn, or the provider
 *   started   a turn has ever SUCCEEDED here. Never inferred from `id`.
 *   persists  the run is configured to carry this conversation across turns
 *   hasMemory persists && started && id !== null
 *   rotatable the slot has a mechanism for abandoning its conversation
 *
 * `hasMemory` is the only question dispatch asks. The `id !== null` clause is
 * not a second marker: it is "there is something to resume". It is vacuously
 * true for a client-origin slot, whose id is always minted, and it is what makes
 * a provider-origin slot whose successful turn named no usable id fall back to a
 * fresh conversation.
 *
 * The storage is the flat `RunState` fields the run already had. This module is
 * the only place they are named, so a second slot cannot be built by copying
 * half of one convention and half of the other.
 */

export type SlotName = 'main' | 'judge' | 'review';

/**
 * Who mints the id.
 *
 * 'client' - vibe mints it before the first turn and spawns the agent under it,
 * which is what `claude --session-id` requires. Such an id says nothing about
 * whether anything has ever run.
 *
 * 'provider' - the agent names its own conversation and hands the id back, so
 * there is no id at all until a turn has returned.
 */
export type IdOrigin = 'client' | 'provider';

export interface SlotSpec {
  /** The agent this conversation is held with. Dispatch and slot must agree - see `slotForRole`. */
  provider: AgentProvider;
  origin: IdOrigin;
  /** The conversation id, or null when there is none to resume. Empty is null. */
  id: (state: RunState) => string | null;
  /** Whether a turn has ever succeeded here. Never derived from `id`. */
  started: (state: RunState) => boolean;
  /**
   * Record that a turn just succeeded. The marker is set unconditionally - a
   * turn either succeeded or it did not. `carryId` says whether this run keeps
   * the conversation, and only the *id* adoption is gated on it.
   */
  markStarted: (state: RunState, returnedId: string | null, carryId: boolean) => void;
  /** Whether this run carries the conversation across turns at all. */
  persists: (cfg: Config) => boolean;
  /**
   * Abandon this conversation for a fresh one, or null for a slot with no such
   * mechanism. `codex exec resume` has no session-id flag, so a fresh Codex
   * thread seeded with a handoff is a different operation - not this one with
   * another provider behind it - and belongs to the change that builds it.
   */
  reset: ((state: RunState) => void) | null;
  /**
   * The last measured occupancy of this conversation, and the denominator this
   * run can name - or null for a slot whose occupancy is not measured this way.
   *
   * `main` has none on purpose: Claude reports a ratio against a window it names
   * itself, recorded by `recordContextMeasurement`, and a second notion of the
   * same fact beside it is exactly what this does not build.
   */
  occupancy: {
    /** Tokens, but only while the stored id still names this slot's conversation. */
    read: (state: RunState) => number | null;
    /**
     * Store `tokens` against the conversation `ranOn` - the id the provider said
     * this turn ran under. Mutates NOTHING unless the tokens are a positive
     * integer and `ranOn` is a usable id equal to the one this slot holds now: a
     * measurement that cannot be attributed is not one, and an id this slot is
     * not using is not this slot's conversation. There is no fallback identity.
     */
    record: (state: RunState, tokens: number, ranOn: string | null) => void;
    /** The denominator this run can name, or null when it cannot. */
    window: (cfg: Config) => number | null;
  } | null;
}

/**
 * An id, or null. Empty is not an id: a conversation you cannot name is one you
 * cannot resume.
 *
 * `codex.ts` composes its returned thread id with `??`, which does not skip
 * `''`, so an empty string can reach this boundary. Adoption used to be gated on
 * truthiness at the call site; that rule lives here now, and it runs on the way
 * in *and* on the way out, so an empty id can neither be adopted nor read back
 * out of a stored state as something resumable.
 */
function asId(raw: string | null | undefined): string | null {
  return raw === undefined || raw === null || raw === '' ? null : raw;
}

/**
 * A usable conversation id: a non-empty string, or null for anything else.
 *
 * Not `asId`, which is typed for ids this codebase produced. `validateStoredState`
 * now owns this invariant on the way in; the check remains as defence in depth,
 * because a measurement compared against a number or an object would be
 * attributed on the strength of a coincidence, and these fields are also written
 * mid-run from provider output. Everything that is not an id fails closed to
 * null, which matches nothing.
 */
function usableId(raw: unknown): string | null {
  return typeof raw === 'string' && raw !== '' ? raw : null;
}

export const SLOTS: Record<SlotName, SlotSpec> = {
  /** The conversation Claude plans and implements through, and the one rotation compacts. */
  main: {
    provider: 'claude',
    origin: 'client',
    id: (state) => asId(state.sessionId),
    started: (state) => state.sessionStarted === true,
    // The returned id is ignored, and `carryId` cannot matter: the id is vibe's,
    // minted before the turn was spawned. `claudeDispatch` already discards what
    // the CLI echoes back.
    markStarted: (state) => {
      state.sessionStarted = true;
    },
    // Constant, because there is no Claude equivalent of `codex.persistSession`
    // and inventing one would be a config key rather than a lifecycle.
    persists: () => true,
    reset: (state) => {
      state.sessionId = randomUUID();
      state.sessionStarted = false;
    },
    // Claude reports a ratio against a window it names itself, recorded by
    // `recordContextMeasurement` and acted on by `shouldRotate`. Measuring it a
    // second way here would be two answers to one question.
    occupancy: null,
  },
  /**
   * The plan-side judge's Codex thread: the critic, and the answerer with it.
   *
   * The reviewer used to be here too, which meant the agent reviewing the code
   * was the conversation that had argued the plan into shape and approved it.
   * `review` below is the answer to that (#45); the answerer stays here on
   * purpose, because answering the planner's blocking questions is plan-side
   * work and the conversation that has argued about the plan is the right one to
   * answer questions about it.
   *
   * `codexSessionId`, `codexSessionStarted`, `judgeContextTokens` and
   * `judgeContextThread` keep their provider-shaped names. Renaming a slot is
   * cosmetic; renaming those is a stored-state migration, and this comment does
   * the job.
   */
  judge: {
    provider: 'codex',
    origin: 'provider',
    id: (state) => asId(state.codexSessionId),
    // The fallback is the whole stored-state migration, and it is honest rather
    // than a shim: for a provider-minted id, an id present *is* evidence a turn
    // succeeded, because that is the only way one is ever produced. `??` means an
    // explicit `false` outranks a present id, so the marker is real storage and a
    // future slot cannot be handed an id up front and inherit "started" from it.
    started: (state) => state.codexSessionStarted ?? asId(state.codexSessionId) !== null,
    markStarted: (state, returnedId, carryId) => {
      state.codexSessionStarted = true;
      if (carryId && returnedId !== null) state.codexSessionId = returnedId;
    },
    persists: (cfg) => cfg.codex.persistSession,
    reset: null,
    occupancy: {
      read: (state) => {
        const tokens: unknown = state.judgeContextTokens;
        const on = usableId(state.judgeContextThread);
        const now = usableId(state.codexSessionId);
        // Absent is not a match, and neither is an id this slot has left behind.
        // Both sides have to name the same conversation before a number here says
        // anything at all.
        if (now === null || on === null || on !== now) return null;
        return typeof tokens === 'number' && Number.isInteger(tokens) && tokens > 0 ? tokens : null;
      },
      record: (state, tokens, ranOn) => {
        const now = usableId(state.codexSessionId);
        const on = usableId(ranOn);
        // Fail closed and mutate nothing: no id now, no id from the provider, or
        // two different conversations all mean there is nothing to attribute this
        // measurement to - and an unattributable measurement is not one. This is
        // what makes a one-shot run, whose turns the slot never adopts, carry no
        // cross-turn figure rather than a mislabelled one.
        if (now === null || on === null || on !== now) return;
        if (typeof tokens !== 'number' || !Number.isInteger(tokens) || tokens <= 0) return;
        state.judgeContextTokens = tokens;
        state.judgeContextThread = now;
      },
      window: (cfg) => cfg.codex.contextWindow ?? null,
    },
  },
  /**
   * The reviewer's own Codex thread, so the code review is not formed inside the
   * conversation that approved the plan.
   *
   * Everything here mirrors `judge` except the storage and the `started` rule:
   * the two conversations are the same *kind* of thing, held with the same
   * provider under the same `codex.persistSession`, and what makes them
   * independent is that neither can read the other's id. There is no ordering
   * between them and no handoff: a reviewer that inherited a briefing from the
   * critique would be the defect wearing a different mechanism.
   */
  review: {
    provider: 'codex',
    origin: 'provider',
    id: (state) => asId(state.reviewSessionId),
    // No `?? id !== null` fallback, unlike `judge`. That fallback IS the legacy
    // reading for a field older states wrote without a marker beside it; nothing
    // has ever written this one, so absent means never run and the marker is the
    // only evidence a turn happened here.
    started: (state) => state.reviewSessionStarted === true,
    markStarted: (state, returnedId, carryId) => {
      state.reviewSessionStarted = true;
      if (carryId && returnedId !== null) state.reviewSessionId = returnedId;
    },
    persists: (cfg) => cfg.codex.persistSession,
    // Still nothing that rotates a Codex thread (#30): `codex exec resume` takes
    // no session-id flag, and a second slot is not the place to invent one.
    reset: null,
    occupancy: {
      read: (state) => {
        const tokens: unknown = state.reviewContextTokens;
        const on = usableId(state.reviewContextThread);
        const now = usableId(state.reviewSessionId);
        // The judge's rule, against this slot's own fields: both sides have to
        // name the same conversation before a number here says anything. Keyed
        // to this thread and no other, so a figure measured here can never be
        // read as the judge's however the two runs interleave.
        if (now === null || on === null || on !== now) return null;
        return typeof tokens === 'number' && Number.isInteger(tokens) && tokens > 0 ? tokens : null;
      },
      record: (state, tokens, ranOn) => {
        const now = usableId(state.reviewSessionId);
        const on = usableId(ranOn);
        // Fail closed and mutate nothing, exactly as the judge does: an
        // unattributable measurement is not one. Writing only this slot's fields
        // is what makes a turn here leave the judge's figure standing.
        if (now === null || on === null || on !== now) return;
        if (typeof tokens !== 'number' || !Number.isInteger(tokens) || tokens <= 0) return;
        state.reviewContextTokens = tokens;
        state.reviewContextThread = now;
      },
      // The same setting for both Codex conversations. `codex.contextWindow` is
      // a fact about a model, and since #60 the two threads may name two - so
      // this describes at most one of them, which is what `roleWarnings` W5
      // says out loud rather than inventing a second number here.
      window: (cfg) => cfg.codex.contextWindow ?? null,
    },
  },
};

export function slotId(state: RunState, slot: SlotName): string | null {
  return SLOTS[slot].id(state);
}

export function slotStarted(state: RunState, slot: SlotName): boolean {
  return SLOTS[slot].started(state);
}

/**
 * Whether this conversation already carries the run: the one question dispatch
 * asks, and the one `--resume`, the handoff prefix and the continuity told to
 * the prompts are all decided by.
 */
export function slotHasMemory(state: RunState, cfg: Config, slot: SlotName): boolean {
  const spec = SLOTS[slot];
  return spec.persists(cfg) && spec.started(state) && spec.id(state) !== null;
}

/** The id to hand a turn: the conversation to continue, or null to start fresh. */
export function slotResumeId(state: RunState, cfg: Config, slot: SlotName): string | null {
  return slotHasMemory(state, cfg, slot) ? SLOTS[slot].id(state) : null;
}

/**
 * The id a client-origin slot must be spawned under, minting one if it has none.
 *
 * Minting rather than throwing: a state with no id is not producible by any
 * version of this tool, and what such a state does today is hand `undefined`
 * straight to `claude --session-id`. Throws for a provider-origin slot, which has
 * no id to spawn under by definition - the provider names the conversation.
 */
export function ensureSlotId(state: RunState, slot: SlotName): string {
  const spec = SLOTS[slot];
  if (spec.origin !== 'client') {
    throw new Error(`slot "${slot}" is provider-minted; it has no id until a turn returns one`);
  }
  const existing = spec.id(state);
  if (existing !== null) return existing;
  // Through `reset`, so "what a fresh conversation on this slot looks like" is
  // stated once - minting here as well would be the second half-convention.
  spec.reset?.(state);
  const minted = spec.id(state);
  if (minted === null) throw new Error(`slot "${slot}" could not mint an id`);
  return minted;
}

/**
 * Record a successful turn.
 *
 * Returns what the caller needs in order to log and persist exactly as it did
 * before slots existed: `idChanged` is false whenever the run does not carry
 * this conversation, when the provider named no usable id, and when it named the
 * one already stored. Both flags are computed before adoption.
 *
 * Deliberately performs no `saveState` and no logging, and contains no `await`:
 * a rotation running concurrently with a Codex turn must not be able to land
 * between a provider returning and its charge being applied.
 */
export function markSlotStarted(
  state: RunState,
  cfg: Config,
  slot: SlotName,
  returnedId: string | null,
): { idChanged: boolean; first: boolean } {
  const spec = SLOTS[slot];
  const carryId = spec.persists(cfg);
  const incoming = asId(returnedId);
  const before = spec.id(state);
  const first = before === null;
  const idChanged = carryId && incoming !== null && incoming !== before;
  spec.markStarted(state, incoming, carryId);
  return { idChanged, first };
}

/**
 * How much of this slot's CURRENT conversation is occupied, or null when nothing
 * measured it - which is not zero, and must never be read as zero.
 */
export function slotOccupancy(state: RunState, slot: SlotName): number | null {
  return SLOTS[slot].occupancy?.read(state) ?? null;
}

/**
 * Record what a completed turn measured.
 *
 * `ranOn` is the conversation id the provider said the turn ran under. It is
 * required rather than assumed: a run that does not carry the conversation never
 * adopts that id, so "the id in state" and "the thread this turn spoke to" are
 * different things, and only their agreement makes a measurement attributable.
 * A no-op for a slot with no occupancy notion.
 */
export function recordSlotOccupancy(
  state: RunState,
  slot: SlotName,
  tokens: number,
  ranOn: string | null,
): void {
  SLOTS[slot].occupancy?.record(state, tokens, ranOn);
}

/** The window this run can name for the slot's conversation, or null. */
export function slotContextWindow(cfg: Config, slot: SlotName): number | null {
  return SLOTS[slot].occupancy?.window(cfg) ?? null;
}

/**
 * Whether this run can express this conversation as a fraction: it has an
 * occupancy notion AND a window to divide by. Read by the role warnings, which
 * must not claim a thread is unmeasured once it is.
 */
export function slotMeasured(cfg: Config, slot: SlotName): boolean {
  return slotContextWindow(cfg, slot) !== null;
}

/** Whether this slot has a mechanism for abandoning its conversation. */
export function slotRotatable(slot: SlotName): boolean {
  return SLOTS[slot].reset !== null;
}

/** Abandon this conversation for a fresh one. Throws for a slot that cannot. */
export function resetSlot(state: RunState, slot: SlotName): void {
  const reset = SLOTS[slot].reset;
  if (reset === null) {
    throw new Error(`slot "${slot}" has no rotation mechanism; nothing may compact it`);
  }
  reset(state);
}

/**
 * The slot fields a fresh run starts with.
 *
 * `codexSessionStarted` is deliberately absent rather than `false`: absent is
 * the correct reading for a slot that has never run, and it is the same state a
 * run recorded before this module presents.
 *
 * The `review` slot's fields are absent for the same reason, and all four of
 * them: a fresh run and a run recorded before that conversation existed present
 * the identical fact, which is that nothing has ever run there.
 */
export function initialSlotFields(): Pick<
  RunState,
  'sessionId' | 'sessionStarted' | 'codexSessionId'
> {
  return { sessionId: randomUUID(), sessionStarted: false, codexSessionId: null };
}
