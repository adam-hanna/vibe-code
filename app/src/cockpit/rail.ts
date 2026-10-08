import { boundary } from './format';
import type { Attempt, CycleKind, GateRun, Run, Turn } from './model';

/**
 * What the run rail says, decided here so it can be tested (#248).
 *
 * The app has no jsdom, so a decision left inside `RunRail` is a decision
 * nothing checks - and the one this file exists for was wrong for five of the
 * loop's ten turn kinds without anything noticing.
 *
 * ## A turn's group is where the reducer put it, not a kind table
 *
 * The rail used to map a turn's `kind` to its group through a four-entry table:
 * `plan`, `critique`, `implement`, `review`. The loop has more kinds than that -
 * `revise`, `answer`, `verify-fix`, `review-fix`, `final-fix` - and every one of
 * them fell through to *Ready for the next turn · The run is between turns*,
 * drawn directly above a `Current activity` card showing that same turn's tool
 * calls. In the #169 run that was a verify-fix turn, and the window called it
 * idle for the whole of it.
 *
 * `reduce` already answered the question: `turn_started` appends the turn to
 * the phase that is open, and a phase belongs to exactly one group. So the group
 * is read off that structure - one answer, told by the frames, covering every
 * kind the loop has or will have - and the table is gone rather than extended.
 */

/** Which state a rail element is in. Four states, four tokens in `RunRail`. */
export type RailState = 'upcoming' | 'complete' | 'running' | 'waiting';

export const RAIL_TITLE: Readonly<Record<CycleKind, string>> = {
  plan: 'Plan',
  critique: 'Plan critique',
  code: 'Code',
  review: 'Code review',
};

export function roleName(role: string): string {
  return role.length === 0 ? 'Agent' : `${role.slice(0, 1).toUpperCase()}${role.slice(1)}`;
}

export function findTurn(run: Run, id: number | null): Turn | null {
  if (id === null) return null;
  for (const cycle of run.cycles) {
    for (const phase of cycle.phases) {
      const turn = phase.turns.find((candidate) => candidate.id === id);
      if (turn !== undefined) return turn;
    }
  }
  return null;
}

/**
 * The group whose phases hold this turn, or null when no phase does - a turn
 * started before any phase was announced, which a resume can produce.
 */
export function turnGroup(run: Run, id: number | null): CycleKind | null {
  if (id === null) return null;
  for (const cycle of run.cycles) {
    for (const phase of cycle.phases) {
      if (phase.turns.some((candidate) => candidate.id === id)) return cycle.kind;
    }
  }
  return null;
}

/**
 * What a fix turn is doing, so a fix round reads as one rather than as more
 * coding. Closed and small: any kind not here is `is working`, never null and
 * never idle.
 */
const FIX_WORK: Readonly<Record<string, string>> = {
  'verify-fix': 'is fixing the verification failure',
  'review-fix': 'is fixing review findings',
  'final-fix': 'is fixing review findings',
};

export function turnDetail(turn: Pick<Turn, 'role' | 'kind'>): string {
  return `${roleName(turn.role)} ${FIX_WORK[turn.kind] ?? 'is working'}`;
}

export interface NowStatus {
  title: string;
  detail: string;
  tone: RailState;
}

/**
 * The `now` card, in one sentence.
 *
 * **While `run.running` is set this never says the run is idle or between
 * turns.** A turn in no group still reads as running, titled by its role; the
 * fall-through at the bottom is reachable only when nothing is open.
 */
export function nowStatus(run: Run): NowStatus {
  const isEmpty = run.identity === null && run.preflight === null && run.cycles.length === 0;
  if (run.gate !== null) {
    return { title: 'Needs your decision', detail: `Waiting at ${boundary(run.gate.boundary)}`, tone: 'waiting' };
  }
  if (run.running !== null) {
    const group = turnGroup(run, run.running.id);
    return {
      title: group === null ? `${roleName(run.running.role)} is working` : RAIL_TITLE[group],
      detail: turnDetail(run.running),
      tone: 'running',
    };
  }
  if (run.preflight !== null && !run.preflight.passed) {
    return {
      title: 'Preflight',
      detail: run.preflight.probing === null ? 'Preparing checks' : `Checking ${run.preflight.probing}`,
      tone: 'running',
    };
  }
  if (run.reason !== null) return { title: 'Run ending', detail: run.reason.message, tone: 'waiting' };
  if (run.ended?.how === 'stopped') return { title: 'Run stopped', detail: run.ended.detail, tone: 'waiting' };
  if (run.completed?.exit === 0 || run.ended?.how === 'approved') {
    return { title: 'Run complete', detail: 'Review the results in the workspace', tone: 'complete' };
  }
  if (run.completed !== null) {
    return { title: 'Process finished', detail: `Exit ${run.completed.exit}`, tone: 'complete' };
  }
  if (isEmpty) return { title: 'Waiting for a brief', detail: 'Review the brief to begin', tone: 'upcoming' };
  return { title: 'Ready for the next turn', detail: 'The run is between turns', tone: 'waiting' };
}

export interface VerifyRow {
  /** One phrase per gate, in the order the pass ran them. */
  gates: readonly string[];
  /** Set while a verify-fix turn is open. */
  fixing: string | null;
}

/** One gate, from what its frames carried. `failed` and `runs` are told, never derived. */
function gatePhrase(gate: GateRun): string {
  switch (gate.status) {
    case 'running':
      return `running ${gate.name}`;
    case 'failed':
      return gate.failed === null ? `${gate.name} failed` : `${gate.name} failed ${gate.failed}/${gate.runs}`;
    case 'passed':
      return `${gate.name} passed`;
    case 'unavailable':
      return `${gate.name} did not run`;
    case 'disabled':
      return `${gate.name} disabled`;
  }
}

/**
 * The verification sub-row under the Code stage, or null before any pass.
 *
 * The most recent pass, and the **last** run of each gate within it: two passes
 * under one review round are one `VerifyPass` (`openGate` keys them by the round
 * the frames carried), so a verify-fix loop re-runs a gate inside the same pass
 * and the latest run is the one that describes now.
 */
export function verifyRow(run: Run): VerifyRow | null {
  const pass = run.verify[run.verify.length - 1];
  if (pass === undefined) return null;
  const latest = new Map<string, GateRun>();
  for (const gate of pass.gates) {
    latest.delete(gate.name);
    latest.set(gate.name, gate);
  }
  const running = run.running;
  const gates = [...latest.values()];
  // Whenever the open turn is a verify-fix, as the brief settles it. The loop
  // narrates no turn ending and `verify_started` does not close one, so the
  // re-run of the gate arrives with the fix turn still open: `running core →
  // fixing (round 1)` is then the pass answering that fix, which is the reading
  // a person needs. The turn closes when the next phase starts.
  const fixing =
    running !== null && running.kind === 'verify-fix'
      ? running.round === null
        ? '→ fixing'
        : `→ fixing (round ${running.round})`
      : null;
  return { gates: gates.map(gatePhrase), fixing };
}

export function verifyRowText(row: VerifyRow): string {
  const gates = row.gates.join(' · ');
  return row.fixing === null ? gates : `${gates} ${row.fixing}`;
}

/** What an attempt card in the Verify pane does. */
export type AttemptAction =
  | { kind: 'open'; name: string }
  | { kind: 'absent'; sentence: string }
  | { kind: 'none' };

/**
 * An attempt opens the log it was told about, and nothing else (#248).
 *
 * A failed gate whose attempt names no log was recorded by a build that kept
 * none, and says so; an attempt of a gate that passed every time never had one,
 * so no absence is claimed for it.
 */
export function attemptAction(gate: Pick<GateRun, 'status'>, attempt: Attempt): AttemptAction {
  if (attempt.log !== null) return { kind: 'open', name: attempt.log };
  if (gate.status === 'failed') return { kind: 'absent', sentence: 'this run recorded no log for this attempt' };
  return { kind: 'none' };
}
