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

export type SlotName = 'main' | 'judge';

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
  },
  /** The Codex thread the critic, answerer and reviewer share. */
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
 */
export function initialSlotFields(): Pick<
  RunState,
  'sessionId' | 'sessionStarted' | 'codexSessionId'
> {
  return { sessionId: randomUUID(), sessionStarted: false, codexSessionId: null };
}
