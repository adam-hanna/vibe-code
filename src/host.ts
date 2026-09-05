import type { CheckpointBoundary, RunPhase } from '@src/types.js';

/**
 * The one place something outside the loop can get in front of it.
 *
 * A leaf, for the reason `@src/charge.js` and `@src/roles.js` are leaves: the
 * orchestrator owns the loop but not the vocabulary a host answers in, and
 * putting that vocabulary inside the orchestrator would make it unreadable to
 * anything that is not already importing the loop.
 *
 * ## Why this is an `await` and not an exit
 *
 * Before the desktop app, a gate could only be "the CLI stops itself and exits
 * resumable" - the machinery a round cap already uses (`Escalation` ->
 * `writeEscalation` -> `status: 'needs-input'` -> `vibe resume`). That works,
 * and it costs the agent session every time: resuming re-sends context and the
 * run pays for it again.
 *
 * The app links this source and calls `orchestrate()` in its own process, so a
 * gate is an `await` at a phase boundary. The process stays alive, the Claude
 * session stays warm, and resuming costs nothing.
 *
 * ## Pause is not a decision
 *
 * There is no `pause` in the vocabulary below, and its absence is the design
 * rather than an omission:
 *
 * - **Pause** is a host that has not answered yet. The `await` is the pause.
 *   Nothing is lost because nothing has happened - the checkpoint is already
 *   written and the next turn has not begun.
 * - **Stop** is the process ending. Resuming starts a fresh session and re-sends
 *   context, and that cost is real.
 *
 * A `pause` member would be a third thing that means the first, and the UI would
 * then have two ways to say "hold" that differ in what they cost.
 *
 * **No SIGINT handler belongs here.** `src/lock.ts` deliberately installs none,
 * on the reasoning that Ctrl-C leaving a stale lock with a dead pid reads as
 * `interrupted` - which is exactly what happened. An in-process pause is a
 * boundary the loop reaches, not a signal it traps, and the two must never be
 * confused.
 */

/**
 * What a host is told when the loop stops to ask.
 *
 * The round counters travel with the boundary because a boundary alone does not
 * say where in the run it is: `review-round` is reached up to `maxReviewRounds`
 * times, and a host deciding whether to hold needs to know which one this is.
 */
export interface GateContext {
  boundary: CheckpointBoundary;
  /** Null when the stored phase was unreadable. Absent is never filled in. */
  phase: RunPhase | null;
  planRound: number;
  reviewRound: number;
  verifyRound: number;
}

/**
 * What a host may answer. Closed, and deliberately small.
 *
 * #134 offered three shapes and settled on this one:
 *
 * 1. *Continue or stop, nothing else* - safest, and it makes half the halt-state
 *    buttons undeliverable.
 * 2. *A closed vocabulary of decisions*, each validated the way a loaded run
 *    already is.
 * 3. *The host may edit state* - fastest to build and the one that ends with two
 *    definitions of what a legal run is.
 *
 * (2), because of `consistency.ts`: the rules that say which combinations of
 * `status`/`phase`/`planOnly` can exist were written because a *stored* state
 * could be incoherent, and a host-supplied decision is the same threat arriving
 * through a new door. A decision that goes through the same validators is safe
 * by construction; one that does not re-opens #54 with a GUI attached.
 *
 * This is the vocabulary's first two members. Everything that mutates run state
 * - `+2 rounds` past a cap, `implement anyway`, `skip verify`, `downgrade P1 to
 * P2` - is a further member and each one needs its own validator before it is
 * offered, because each is a way for a decision made outside the loop to leave
 * the run in a shape the loop's guards were written assuming could not exist.
 */
export type Decision =
  | { kind: 'continue' }
  /** End the run at this boundary, resumably. `reason` reaches NEEDS-INPUT.md. */
  | { kind: 'stop'; reason: string | null };

/**
 * Something that can be asked.
 *
 * `decide` returns `unknown` on purpose. A host is not necessarily in this
 * process - the desktop app answers over a pipe, and what comes back is JSON
 * somebody else parsed. Typing it as `Decision` would be asserting a shape this
 * module never checked, which is the one thing `src/validate.ts` exists to stop
 * happening elsewhere.
 */
export interface Host {
  decide(ctx: GateContext): Promise<unknown>;
}

const CONTINUE: Decision = { kind: 'continue' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Narrow whatever a host said into the closed vocabulary, or refuse it.
 *
 * **Fail closed, and note which way that points.** An unreadable answer becomes
 * `stop`, not `continue`. Continuing on an instruction nobody could parse is the
 * dangerous direction: it spends tokens and writes code on the strength of a
 * message that may have said the opposite. Stopping on one is recoverable - the
 * run is at a checkpoint, nothing is lost, and `vibe resume` picks it up.
 *
 * The reason is carried out with it so the refusal is legible in NEEDS-INPUT.md
 * rather than looking like the host chose to stop.
 */
export function readDecision(v: unknown): Decision {
  if (!isRecord(v)) return { kind: 'stop', reason: 'the host answered with no decision' };
  const kind = v['kind'];
  if (kind === 'continue') return CONTINUE;
  if (kind === 'stop') {
    const reason = v['reason'];
    return { kind: 'stop', reason: typeof reason === 'string' && reason !== '' ? reason : null };
  }
  return {
    kind: 'stop',
    reason: `the host answered "${typeof kind === 'string' ? kind : typeof kind}", which is not a decision this version understands`,
  };
}

/**
 * How long an origin may be. Long enough to name a thing, short enough that it
 * cannot become a message.
 */
const MAX_ORIGIN = 40;

/**
 * Who shaped this decision, when it was not simply the person at the window.
 *
 * **Read separately from the decision, and failing a different way on purpose.**
 * `readDecision` turns an unreadable answer into `stop`, because an instruction
 * nobody could parse is the dangerous thing to act on. An origin is not an
 * instruction - it is a label on one - and refusing to run because a label was
 * malformed would stop work for a reason that has nothing to do with the work.
 * So this drops what it cannot read instead.
 *
 * The consequence is worth stating rather than discovering: **absent and
 * unreadable are both `null` here**, and a null origin leaves no row in
 * `state.events` at all. A record that says nothing about who released a gate is
 * better than one that names somebody it might not have been - and the only
 * writer of this field is the app itself, so an unreadable one means a host we
 * could not account for either way.
 *
 * The core deliberately holds no vocabulary of origins. `roles.ts` is the table
 * of things that are agents in the loop, and #144 refuses to add the pilot to
 * it; a closed list here would be that same table under another name. This
 * records the label it was given, and what a label means is the app's business.
 */
export function readOrigin(v: unknown): string | null {
  if (!isRecord(v)) return null;
  const origin = v['origin'];
  if (typeof origin !== 'string') return null;
  const trimmed = origin.trim();
  if (trimmed === '' || trimmed.length > MAX_ORIGIN) return null;
  return trimmed;
}
