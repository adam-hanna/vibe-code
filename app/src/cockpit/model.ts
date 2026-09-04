import type { Frame, Level } from '../host';

/**
 * The run, assembled from frames and from nothing else (#159).
 *
 * **This is the only file in the app with logic, and it is pure on purpose.**
 * Every card the cockpit draws comes from a frame it was sent: no phase inferred
 * from a sentence, no default filled in for a field a frame did not carry, no
 * quantity computed out of two others. `src/protocol.ts` defines what arrives
 * and this follows it - the moment the cockpit starts computing what it thinks
 * the run is doing, there are two answers to that question and the wrong one is
 * the one on screen.
 *
 * The narration ids exist so this is possible. A cockpit that matched English
 * would break the next time somebody improved a sentence, which is the failure
 * #133 was written to prevent.
 *
 * ## Two clocks, and they are not the same measurement
 *
 * `heartbeat.elapsedMs` is the **loop's** measurement of the turn it is in, and
 * it is authoritative. It arrives every 30 seconds (`progress.intervalMs`), so a
 * display that only moved when one landed would look frozen for half a minute
 * at a time.
 *
 * So a turn carries `startedAt` on **our** clock, and every heartbeat re-anchors
 * it to `now - elapsedMs`. Between beats the display ticks locally; on each beat
 * it snaps back to what the loop says. Neither number is invented and the
 * authoritative one always wins.
 */

/** The three convergence cycles. Not three stages - see the domain model. */
export type CycleKind = 'plan' | 'code' | 'review';

/**
 * Which cycle a phase belongs to.
 *
 * `critique` is in the plan cycle rather than beside it because a plan round IS
 * the pair: the planner produces a version, the critic judges it. `verify` has
 * no `phase_started` of its own - it announces itself with `verify_started` -
 * and belongs to the code cycle.
 */
export const CYCLE_OF: Readonly<Record<string, CycleKind>> = {
  planning: 'plan',
  critique: 'plan',
  implementing: 'code',
  review: 'review',
};

/** What the heartbeat measured. Every field is a field the record carried. */
export interface Beat {
  /** The loop's own measurement of this turn, in ms. */
  elapsedMs: number;
  activities: number;
  /** 'tool use' or 'event' - they do not count the same thing. */
  unit: string;
  tokens: number;
  promptTokens: number;
  /** Absent when the stream supplied none. Never "" and never a guess. */
  lastActivity: string | null;
  /** Absent until some turn under this model has reported one. */
  contextWindow: number | null;
  /** When this beat reached us. The liveness signal, on our clock. */
  at: number;
}

export interface Turn {
  id: number;
  role: string;
  kind: string;
  /** The archive's round, which is the one that names the artifact. Null when the frame carried none. */
  round: number | null;
  /** Our clock, re-anchored by every beat to the loop's own figure. */
  startedAt: number;
  endedAt: number | null;
  beat: Beat | null;
}

export interface PhaseGroup {
  id: number;
  phase: string;
  round: number | null;
  startedAt: number;
  turns: Turn[];
  /** Verification gates opened during this phase, by name, in order. */
  gates: string[];
}

export interface Cycle {
  kind: CycleKind;
  phases: PhaseGroup[];
}

/** A boundary the loop is holding at, waiting to be told what to do. */
export interface Gate {
  /** The id to answer. Allocated by the host, not by us. */
  askId: number;
  boundary: string;
  planRound: number;
  reviewRound: number;
  verifyRound: number;
}

/** One line for the output pane, at the density the terminal prints it. */
export interface OutputLine {
  n: number;
  level: Level;
  message: string;
  id: string | null;
}

export interface Run {
  cycles: readonly Cycle[];
  /** The question loop, nested inside cycle 1. Null until one opens. */
  questions: { total: number; blocking: number } | null;
  /** The turn with no `endedAt`, if any. */
  running: Turn | null;
  gate: Gate | null;
  output: readonly OutputLine[];
  /** Set when the run ended, with how. Null while it is going. */
  ended: { how: 'approved' | 'stopped'; detail: string } | null;
  /**
   * Why the command is ending, in the core's own words (#162).
   *
   * **Told, never picked.** `run_failed` and `run_escalated` are narration ids
   * the core emits at the two places `execute` gives up, so this is the sentence
   * the CLI prints under `Failed` or `Stopped for input` - not the most recent
   * alarming-looking line in the output pane. Selecting by level would find the
   * wrong one: an escalation narrates at `warn`, and a healthy run is full of
   * warnings that are not the ending.
   *
   * `code` is what that site says its exit code will be, which is not the same
   * fact as `completed.exit` - the process may still fail on the way out - so
   * the two are kept apart rather than reconciled.
   */
  reason: { code: number | null; message: string } | null;
  /**
   * The exit code the command returned, once it has.
   *
   * Separate from `ended`, and the two are different facts. `ended` is what the
   * LOOP said about itself - review was clear, a host stopped it - and arrives
   * before the command has finished writing artifacts and printing a summary.
   * `completed` is the process being done with the request. Only the second one
   * means another run may be started.
   */
  completed: { exit: number } | null;
  /** The protocol version the host stated, or null before `ready`. */
  protocol: number | null;
  /**
   * The next identity to hand out, carried in the run rather than in a module
   * variable.
   *
   * That is what keeps `reduce` genuinely pure: a module-level counter would
   * make the same frames produce different output depending on what had been
   * reduced earlier in the process, which is exactly the property a test needs
   * and a second window would violate.
   */
  seq: number;
}

export function emptyRun(): Run {
  return {
    cycles: [],
    questions: null,
    running: null,
    gate: null,
    output: [],
    ended: null,
    reason: null,
    completed: null,
    protocol: null,
    seq: 0,
  };
}

/**
 * Start a new run, keeping what belongs to the host rather than to the run.
 *
 * The protocol version came from `ready` and describes the process, not the
 * work. Everything else goes: a second run appending to the first one's cycles
 * would draw one column out of two runs, which is the wrong answer in a way
 * nobody would question on screen.
 */
export function nextRun(previous: Run): Run {
  return { ...emptyRun(), protocol: previous.protocol, seq: previous.seq };
}

/** How many output lines are kept. A run narrates thousands; a pane shows a tail. */
export const OUTPUT_KEEP = 500;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** Read a heartbeat's record. Every absent field stays absent. */
function readBeat(data: Record<string, unknown>, at: number): Beat | null {
  const elapsedMs = num(data['elapsedMs']);
  const activities = num(data['activities']);
  const unit = str(data['unit']);
  if (elapsedMs === null || activities === null || unit === null) return null;
  return {
    elapsedMs,
    activities,
    unit,
    tokens: num(data['tokens']) ?? 0,
    promptTokens: num(data['promptTokens']) ?? 0,
    // `heartbeatData` omits these rather than sending a zero, and the omission
    // is the fact: `lastActivity: null` is "nothing observed", not "nothing
    // happened", and an unmeasured window is not a window of zero.
    lastActivity: str(data['lastActivity']),
    contextWindow: num(data['contextWindow']),
    at,
  };
}

/** Append to a cycle, creating it in the order the phases arrived. */
function withPhase(cycles: readonly Cycle[], kind: CycleKind, phase: PhaseGroup): Cycle[] {
  const existing = cycles.find((c) => c.kind === kind);
  if (existing === undefined) return [...cycles, { kind, phases: [phase] }];
  return cycles.map((c) => (c === existing ? { ...c, phases: [...c.phases, phase] } : c));
}

/**
 * Apply `f` to the most recently opened phase, wherever it sits.
 *
 * By `id` rather than by array position: cycles are stored in the order they
 * first appeared, so the newest phase is not necessarily in the last cycle - the
 * review cycle re-opens verify, which lives in the code cycle.
 */
function mapLastPhase(cycles: readonly Cycle[], f: (p: PhaseGroup) => PhaseGroup): Cycle[] {
  let newest = -1;
  for (const cycle of cycles) {
    for (const phase of cycle.phases) if (phase.id > newest) newest = phase.id;
  }
  if (newest === -1) return [...cycles];
  return cycles.map((cycle) => ({
    ...cycle,
    phases: cycle.phases.map((p) => (p.id === newest ? f(p) : p)),
  }));
}

/** Close the running turn, if there is one. */
function endRunning(run: Run, at: number): Run {
  if (run.running === null) return run;
  const id = run.running.id;
  return {
    ...run,
    running: null,
    cycles: run.cycles.map((cycle) => ({
      ...cycle,
      phases: cycle.phases.map((phase) => ({
        ...phase,
        turns: phase.turns.map((t) => (t.id === id ? { ...t, endedAt: at } : t)),
      })),
    })),
  };
}

/**
 * Fold one frame into the run.
 *
 * `at` is when the frame reached us, injected rather than read from a clock so
 * this stays pure and testable. It is the only place our own clock enters the
 * model, and what it measures is stated at every use.
 */
export function reduce(run: Run, frame: Frame, at: number): Run {
  if (frame.type === 'ready') return { ...run, protocol: frame.protocol };

  if (frame.type === 'ask') {
    return {
      ...run,
      gate: {
        askId: frame.id,
        boundary: frame.context.boundary,
        planRound: frame.context.planRound,
        reviewRound: frame.context.reviewRound,
        verifyRound: frame.context.verifyRound,
      },
    };
  }

  if (frame.type === 'result') {
    // The command returned. Whatever was running is not any more, whether it
    // finished or the process gave up on it.
    return { ...endRunning(run, at), gate: null, completed: { exit: frame.exit } };
  }

  if (frame.type !== 'narration') return run;

  // Every identity this frame hands out comes from here, and `seq` is written
  // back once at the bottom - so a branch that allocates two and a branch that
  // allocates none both leave the run consistent, without either remembering to
  // say so.
  let seq = run.seq;
  const id = (): number => (seq += 1);

  const line: OutputLine = { n: id(), level: frame.level, message: frame.message, id: frame.id };
  const output = [...run.output, line].slice(-OUTPUT_KEEP);
  const next: Run = { ...run, output };
  const data = frame.data ?? {};

  const folded = ((): Run => {
    switch (frame.id) {
      case 'phase_started': {
        const phase = str(data['phase']);
        if (phase === null) return next;
        const kind = CYCLE_OF[phase];
        // A phase this version does not place in a cycle is left out of the
        // column rather than guessed into one. It is still in the output pane,
        // which is where an unrecognised thing belongs.
        if (kind === undefined) return next;
        // A new phase closes whatever turn was still open. The loop does not
        // narrate a turn ending, so the next thing starting is the signal - and
        // it is a true one, because turns within a run never overlap.
        const closed = endRunning(next, at);
        return {
          ...closed,
          cycles: withPhase(closed.cycles, kind, {
            id: id(),
            phase,
            round: num(data['round']),
            startedAt: at,
            turns: [],
            gates: [],
          }),
        };
      }

      case 'turn_started': {
        const role = str(data['role']);
        const kind = str(data['kind']);
        if (role === null || kind === null) return next;
        const turn: Turn = {
          id: id(),
          role,
          kind,
          round: num(data['round']),
          startedAt: at,
          endedAt: null,
          beat: null,
        };
        const closed = endRunning(next, at);
        return {
          ...closed,
          running: turn,
          cycles: mapLastPhase(closed.cycles, (p) => ({ ...p, turns: [...p.turns, turn] })),
        };
      }

      case 'heartbeat': {
        const beat = readBeat(data, at);
        // A heartbeat with no turn open is dropped from the column. It cannot be
        // attributed, and a measurement that cannot be attributed is not recorded.
        if (beat === null || next.running === null) return next;
        // Re-anchored to the loop's own measurement. See the header: our clock
        // ticks between beats, the loop's clock wins whenever it speaks.
        const turnId = next.running.id;
        const startedAt = at - beat.elapsedMs;
        const patch = (t: Turn): Turn => (t.id === turnId ? { ...t, beat, startedAt } : t);
        return {
          ...next,
          running: patch(next.running),
          cycles: next.cycles.map((cycle) => ({
            ...cycle,
            phases: cycle.phases.map((p) => ({ ...p, turns: p.turns.map(patch) })),
          })),
        };
      }

      case 'verify_started': {
        const gate = str(data['gate']);
        if (gate === null) return next;
        return {
          ...next,
          cycles: mapLastPhase(next.cycles, (p) => ({ ...p, gates: [...p.gates, gate] })),
        };
      }

      case 'questions_opened':
        return {
          ...next,
          questions: { total: num(data['total']) ?? 0, blocking: num(data['blocking']) ?? 0 },
        };

      case 'gate_released':
        return { ...next, gate: null };

      case 'gate_stopped':
        return {
          ...endRunning(next, at),
          gate: null,
          ended: { how: 'stopped', detail: str(data['reason']) ?? frame.message },
        };

      case 'review_approved':
        return { ...next, ended: { how: 'approved', detail: frame.message } };

      case 'run_escalated':
      case 'run_failed':
        // Deliberately not `endRunning`. This says why the run is ending; it is
        // not itself the end. The command still writes artifacts and a summary,
        // and `result` closes the open turn when it actually returns - which is
        // the same rule every other ending here follows.
        return {
          ...next,
          reason: {
            code: num(data['code']),
            // `run_failed` prints a stack and carries the sentence, so the two
            // are not interchangeable. `gate_stopped` reads its data the same
            // way, for the same reason.
            message: str(data['reason']) ?? frame.message,
          },
        };

      default:
        // Prose with no id, or an id from a newer core. Both reach the output
        // pane and neither moves the column - which is what makes adding a
        // narration id to the loop a safe change for an older app.
        return next;
    }
  })();

  return { ...folded, seq };
}

/**
 * What the running row can say, and what it cannot.
 *
 * Two of `6a`'s six lines have no source on the wire and are reported as absent
 * with the issue that would supply them. Drawing a zero or a blank for either
 * would be the invented denominator that element has failed on three times.
 */
export interface RunningRow {
  elapsedMs: number;
  activities: { count: number; unit: string } | null;
  lastActivity: string | null;
  /** Time since the last heartbeat. Null before the first one. */
  quietMs: number | null;
  /**
   * Turn spend so far, or null at zero.
   *
   * **Null at zero on purpose**, and it is the formatter's own rule:
   * `formatHeartbeat` drops the `tok` segment below one, so the terminal already
   * shows nothing here. Codex is why - it reports no usage at all until
   * `turn.completed`, so its heartbeat carries a literal `tokens: 0` throughout
   * a turn that is spending the whole time. Rendering that as `0 tok` would be
   * the one thing this repo never does: an absence drawn as a measurement.
   */
  tokens: number | null;
  /**
   * `promptTokens` over `contextWindow`, or null.
   *
   * **Both halves have to be real**, which is the same condition
   * `formatHeartbeat` puts on printing the `ctx N%` segment. A known window with
   * a prompt size of zero would draw a bar at 0% - and a bar at 0% and a bar
   * that cannot be measured look identical while meaning opposite things, which
   * is the reason this is the only bar in the app in the first place.
   */
  context: { used: number; window: number } | null;
  /** Why the diffstat line is missing. Always set until #136 lands. */
  diffstat: string;
  /** Why the comparable-turns line is missing. Always set until #114 lands. */
  comparable: string;
}

export function runningRow(turn: Turn, now: number): RunningRow {
  const beat = turn.beat;
  return {
    elapsedMs: Math.max(0, now - turn.startedAt),
    activities: beat === null ? null : { count: beat.activities, unit: beat.unit },
    lastActivity: beat?.lastActivity ?? null,
    quietMs: beat === null ? null : Math.max(0, now - beat.at),
    tokens: beat === null || beat.tokens <= 0 ? null : beat.tokens,
    context:
      beat === null || beat.contextWindow === null || beat.promptTokens <= 0
        ? null
        : { used: beat.promptTokens, window: beat.contextWindow },
    diffstat: 'no diffstat yet — the loop reports no file counts (#136)',
    comparable: 'no comparable turns — nothing reads the run archive yet (#114)',
  };
}
