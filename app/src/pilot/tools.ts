import { launchArgv } from '../cockpit/argv';
import { OUTPUT_KEEP } from '../cockpit/model';
import type { Tool } from './pilot';
import type { Run } from '../cockpit/model';

/**
 * What the pilot may touch, and through what (#144).
 *
 * ## One sentence, made structural
 *
 * > **Every pilot capability is a host request the app already makes.** Nothing
 * > new reaches the loop.
 *
 * Every effect below is an `invoke` or an `answer` — the two inbound frames in
 * `src/protocol.ts` — built by the same functions the buttons use and sent down
 * the same wire. There is no path into `src/` here that the window's own
 * controls do not also have, which is what keeps `consistency.ts` the only
 * definition of a legal run. A tool that reached the loop another way would be a
 * third definition, and #134 settled that argument for decisions already.
 *
 * **Declared here and executed here.** Rust forwards the declaration and parses
 * the call; it never decides what a tool means. That is what makes the guarantee
 * structural rather than promised — the table and its executors are the same
 * file, so a tool cannot exist without an implementation, and a capability
 * cannot be added to the list without somebody writing what it does.
 *
 * ## Propose only
 *
 * **Nothing here changes a run without a person pressing something.** The two
 * tools that would act return a `proposes` settlement instead of doing it: the
 * pane draws the exact argv or the exact decision, and a human fires it. That is
 * decision 1 of the five the issue asks for, answered *propose only* rather than
 * inherited from the wireframe's 45-second auto-answer — `implement anyway` on a
 * plan that never converged is a real decision about real tokens, and a
 * countdown is the wrong place to make it. If it should ever fire on its own,
 * that is one more column on #140's gate matrix, not new machinery here.
 *
 * The same answer covers `start_run`, which the issue itself permits directly.
 * It is the most expensive thing the pilot can cause, and the brief is the part
 * that decides whether the run converges — AGENTS.md's hardest-won lesson is
 * about exactly that text — so showing it before it is spent is worth one click.
 *
 * ## What is deliberately absent
 *
 * - **No config tool.** Decision 3, answered no. `validateConfig` refuses bad
 *   values *by name*, and a wrong one is expensive and silent; the pilot can
 *   read a config file with the tools it has in the chat and say what it would
 *   change, which keeps the human where the cost is.
 * - **No archive tool.** Decision 4, answered yes-but-not-yet: `.vibe/runs/` is
 *   the thing that makes a pilot better than a generic assistant, and there is
 *   no mechanism to read it until #114. Named rather than omitted, so it is a
 *   gap with an issue on it instead of a question nobody asked.
 * - **No credential anything.** Decision 5, and it is the only real answer to
 *   "what never goes to a provider": a key. This module imports nothing from
 *   `keys`, cannot reach `keys::read` — which is `pub(crate)` in Rust — and has
 *   no context field one could sit in. Everything else here is the run's own
 *   narration and the user's own brief, which is the material the pilot exists
 *   to reason about.
 */

/** A host request, in the shape the cockpit already sends one. */
export type Effect =
  /** Start or resume a run. `argv` is what `main()` takes and `parseArgs` defines. */
  | { kind: 'invoke'; argv: readonly string[] }
  /**
   * Answer a waiting gate.
   *
   * `decision` is passed to the wire unnarrowed, exactly as the footer's is:
   * `readDecision` in the core is where that vocabulary is defined, and a second
   * definition here would disagree with it eventually. `origin` rides alongside
   * so the release leaves an attributed row in `state.events` — read by
   * `readOrigin`, which fails to absent rather than to a name.
   */
  | { kind: 'answer'; askId: number; decision: Record<string, unknown> };

/** The label every pilot-shaped decision carries into the run's event log. */
export const ORIGIN = 'pilot';

/**
 * What running a call produced.
 *
 * Three outcomes and not two, because "a human has to press this" is a real
 * third state: the model is owed an answer eventually, and answering it early
 * with "done" would be a claim about something that has not happened.
 */
export type Settlement =
  /** It ran. `content` is the tool result the model is sent. */
  | { kind: 'ran'; content: string }
  /** It needs a person. Nothing has been sent, and the call stays unanswered. */
  | { kind: 'proposes'; summary: string; effect: Effect }
  /** It could not be run at all, and the model is told why. */
  | { kind: 'refused'; content: string };

/** What a read may see: the run as the window holds it, and nothing else. */
export interface ToolContext {
  run: Run;
}

export interface ToolDef {
  readonly name: string;
  readonly description: string;
  /** JSON Schema, passed to the vendor verbatim by whichever adapter is seated. */
  readonly input_schema: Record<string, unknown>;
  /** Pure: what the model asked for and the run, in; what happened, out. */
  readonly call: (input: unknown, ctx: ToolContext) => Settlement;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * A required string field, or the sentence explaining what was wrong with it.
 *
 * **The schema is a request, not a guarantee.** A model can and does send a
 * number where a string was declared, an object where a scalar was, or nothing
 * at all — and every one of those reaches here. Refusing with the field's name
 * is what lets the next turn fix it; a coerced value would run something nobody
 * asked for.
 */
function text(input: Record<string, unknown>, field: string): string | { why: string } {
  const value = input[field];
  if (typeof value !== 'string') {
    return { why: `"${field}" has to be a string, and this call sent ${typeof value}.` };
  }
  if (value.trim() === '') return { why: `"${field}" was empty.` };
  return value;
}

function bad(v: string | { why: string }): v is { why: string } {
  return typeof v !== 'string';
}

/**
 * The run, as the tools hand it to a model.
 *
 * Assembled rather than serialised whole: `Run` carries our own clock in
 * `startedAt` and `beat.at`, and a wall-clock instant means nothing to a reader
 * that has no idea when the message was composed. What goes out instead is the
 * loop's **own** measurement of the turn it is in, which is a duration and is
 * true whenever it is read.
 */
function describeRun(run: Run): Record<string, unknown> {
  return {
    protocol: run.protocol,
    running:
      run.running === null
        ? null
        : {
            role: run.running.role,
            kind: run.running.kind,
            round: run.running.round,
            // The loop's figure, not ours. Absent until a heartbeat lands, and
            // absent rather than zero, because a turn nobody has measured is
            // not a turn that has taken no time.
            elapsedMs: run.running.beat?.elapsedMs ?? null,
            lastActivity: run.running.beat?.lastActivity ?? null,
          },
    gate:
      run.gate === null
        ? null
        : {
            boundary: run.gate.boundary,
            planRound: run.gate.planRound,
            reviewRound: run.gate.reviewRound,
            verifyRound: run.gate.verifyRound,
          },
    cycles: run.cycles.map((cycle) => ({
      kind: cycle.kind,
      phases: cycle.phases.map((phase) => ({
        phase: phase.phase,
        round: phase.round,
        gates: phase.gates,
        turns: phase.turns.map((turn) => ({ role: turn.role, kind: turn.kind, round: turn.round })),
      })),
    })),
    questions: run.questions,
    ended: run.ended,
    reason: run.reason,
    completed: run.completed,
    // Said rather than left out. A model that cannot see the archive will
    // otherwise answer "has this been tried before" from nothing at all, which
    // is the failure mode this whole issue is arranged against.
    unavailable: [
      'the run archive (.vibe/runs) is not readable from here yet — #114',
      'no file counts or diffstat: the loop reports none — #136',
    ],
  };
}

const READ_RUN: ToolDef = {
  name: 'read_run',
  description:
    'The run as the cockpit currently holds it: cycles, phases, turns, any gate it is holding ' +
    'at, and how it ended. Everything here came off the wire from the loop; nothing is inferred. ' +
    'Call this before saying anything about what the run is doing.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  call: (_input, ctx) => ({ kind: 'ran', content: JSON.stringify(describeRun(ctx.run)) }),
};

const READ_OUTPUT: ToolDef = {
  name: 'read_output',
  description:
    `The tail of the run's narration, oldest first, at most ${String(OUTPUT_KEEP)} lines — the ` +
    'same lines the output pane shows. Each carries its level and, where the loop gave one, a ' +
    'stable id. Use the ids rather than the sentences: the sentences change.',
  input_schema: {
    type: 'object',
    properties: {
      lines: {
        type: 'integer',
        minimum: 1,
        maximum: OUTPUT_KEEP,
        description: `How many of the most recent lines to return. Defaults to 40.`,
      },
    },
    additionalProperties: false,
  },
  call: (input, ctx) => {
    const asked = isRecord(input) ? input['lines'] : undefined;
    // A default here is a display choice, not a measurement, so it is allowed to
    // be one. A BAD value is refused rather than clamped: a model that asked for
    // 5000 lines was reasoning about a window that does not exist, and silently
    // giving it 500 leaves that belief intact.
    let want = 40;
    if (asked !== undefined) {
      if (typeof asked !== 'number' || !Number.isInteger(asked) || asked < 1 || asked > OUTPUT_KEEP) {
        return {
          kind: 'refused',
          content: `"lines" has to be a whole number between 1 and ${String(OUTPUT_KEEP)}. The pane keeps no more than that.`,
        };
      }
      want = asked;
    }
    const lines = ctx.run.output.slice(-want);
    return {
      kind: 'ran',
      content: JSON.stringify({
        // Both numbers, because "40 of 40" and "40 of 500" are different facts
        // and only one of them means there is more to ask for.
        returned: lines.length,
        kept: ctx.run.output.length,
        lines: lines.map((line) => ({ level: line.level, id: line.id, message: line.message })),
      }),
    };
  },
};

const START_RUN: ToolDef = {
  name: 'start_run',
  description:
    'Propose starting a run. This does NOT start one: it puts the exact command in front of the ' +
    'user, who runs it or does not. Write the brief in full and state the decisions already made ' +
    '— the runs that converge say "do not re-derive them"; the ones that stall leave the design ' +
    'open.',
  input_schema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The brief, in full. This is the text the planner is given.',
      },
      directory: {
        type: 'string',
        description: 'An absolute path to the git worktree the run works in.',
      },
      plan_only: {
        type: 'boolean',
        description:
          'true stops after the plan clears critique. false writes code and commits it. There ' +
          'is no default: say which one you mean.',
      },
    },
    required: ['task', 'directory', 'plan_only'],
    additionalProperties: false,
  },
  call: (input) => {
    if (!isRecord(input)) return { kind: 'refused', content: 'this call sent no arguments.' };
    const task = text(input, 'task');
    if (bad(task)) return { kind: 'refused', content: task.why };
    const dir = text(input, 'directory');
    if (bad(dir)) return { kind: 'refused', content: dir.why };
    const planOnly = input['plan_only'];
    // Refused rather than defaulted, and this is the one that matters. A default
    // here would be the app deciding whether a pilot-drafted run writes code,
    // which is not a decision that belongs in a fallback value.
    if (typeof planOnly !== 'boolean') {
      return {
        kind: 'refused',
        content:
          '"plan_only" has to be true or false. It is the difference between a plan and a run ' +
          'that commits, so there is no default for it.',
      };
    }
    const argv = launchArgv(task, dir, planOnly);
    return {
      kind: 'proposes',
      summary: planOnly
        ? `plan only, in ${dir.trim()}`
        : `a full run — this one writes code and commits — in ${dir.trim()}`,
      effect: { kind: 'invoke', argv },
    };
  },
};

const ANSWER_GATE: ToolDef = {
  name: 'answer_gate',
  description:
    'Propose an answer to the gate the loop is currently holding at. This does NOT answer it: ' +
    'the user sees the decision and fires it or does not. Call read_run first — there is a gate ' +
    'to answer only when it reports one.',
  input_schema: {
    type: 'object',
    properties: {
      decision: {
        type: 'string',
        enum: ['continue', 'stop'],
        description:
          'continue releases the loop onto the next phase. stop ends the run here, resumably, ' +
          'and writes NEEDS-INPUT.md.',
      },
      reason: {
        type: 'string',
        description: 'Why, for a stop. It reaches NEEDS-INPUT.md and is what the user reads later.',
      },
    },
    required: ['decision'],
    additionalProperties: false,
  },
  call: (input, ctx) => {
    if (!isRecord(input)) return { kind: 'refused', content: 'this call sent no arguments.' };
    const gate = ctx.run.gate;
    // Refused with the state rather than proposed into the void: an answer to a
    // gate that is not open is rejected by `serve.ts` with "no gate is waiting
    // on that id", and finding that out after a person pressed a button is
    // finding it out in the wrong place.
    if (gate === null) {
      return {
        kind: 'refused',
        content: 'the loop is not holding at a gate right now, so there is nothing to answer.',
      };
    }
    const decision = input['decision'];
    if (decision === 'continue') {
      return {
        kind: 'proposes',
        summary: `continue at ${gate.boundary}`,
        effect: {
          kind: 'answer',
          askId: gate.askId,
          decision: { kind: 'continue', origin: ORIGIN },
        },
      };
    }
    if (decision === 'stop') {
      const reason = input['reason'];
      // Null rather than a manufactured sentence. `holdAt` has its own wording
      // for a stop with no reason, and inventing one here would put words in
      // NEEDS-INPUT.md that nobody wrote.
      const why = typeof reason === 'string' && reason.trim() !== '' ? reason.trim() : null;
      return {
        kind: 'proposes',
        summary: `stop at ${gate.boundary}${why === null ? '' : ` — ${why}`}`,
        effect: {
          kind: 'answer',
          askId: gate.askId,
          decision: { kind: 'stop', reason: why, origin: ORIGIN },
        },
      };
    }
    return {
      kind: 'refused',
      content:
        '"decision" has to be "continue" or "stop". Those are the two the loop understands; ' +
        'anything else it would read as a stop.',
    };
  },
};

/**
 * The table.
 *
 * Reads first, then the two that need a person, which is also the order they are
 * useful in: a model that proposes before it has looked is proposing about a run
 * it has not read.
 */
export const TOOLS: readonly ToolDef[] = [READ_RUN, READ_OUTPUT, START_RUN, ANSWER_GATE];

/** The table as the vendor is told it — the executors stripped off. */
export function declare(): readonly Tool[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }));
}

/**
 * Run one call.
 *
 * A name this build does not have is refused by name rather than ignored. Both
 * vendors will happily invent a plausible tool when a conversation drifts, and
 * the model can only correct for it if it is told which one it asked for.
 */
export function execute(
  call: { name: string; input: unknown; unreadable: string | null },
  ctx: ToolContext,
): Settlement {
  if (call.unreadable !== null) {
    return {
      kind: 'refused',
      content: `the arguments did not parse as JSON: ${call.unreadable}`,
    };
  }
  const tool = TOOLS.find((t) => t.name === call.name);
  if (tool === undefined) {
    return {
      kind: 'refused',
      content: `there is no tool called "${call.name}". This build has: ${TOOLS.map((t) => t.name).join(', ')}.`,
    };
  }
  return tool.call(call.input, ctx);
}
