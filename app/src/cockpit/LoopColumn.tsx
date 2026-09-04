import { MetaChip } from '../design';
import { elapsed } from './format';
import { RunningRow } from './RunningRow';
import type { Cycle, CycleKind, PhaseGroup, Run, Turn } from './model';

/**
 * The centre column from `3a`, at the width the design fixes it at.
 *
 * Three cycle groups, because the loop is **not linear**: it is three nested
 * convergence cycles, each iterating over versions of an artifact until the
 * adversary stops objecting. A cycle header must never read *closed* - cycle 2
 * re-opens on every review fix, and saying otherwise would be describing a
 * pipeline the code does not have.
 *
 * Round lists grow unboundedly, which is why the column collapses by cycle.
 */

const TITLE: Readonly<Record<CycleKind, string>> = {
  plan: 'CYCLE 1 · PLAN',
  code: 'CYCLE 2 · CODE',
  review: 'CYCLE 3 · REVIEW',
};

/**
 * What a cycle header says about itself.
 *
 * Counted from what arrived, never from a cap: the caps are configurable and
 * this slice is not given them, so `2 rounds` is a fact and `2/5` would be two
 * thirds of one.
 */
function status(cycle: Cycle): string {
  const rounds = cycle.phases.length;
  const noun = rounds === 1 ? 'round' : 'rounds';
  if (cycle.kind === 'code') return `${rounds} ${noun} · re-runs on every fix`;
  return `${rounds} ${noun}`;
}

function Version({ turn, running, now }: { turn: Turn; running: boolean; now: number }) {
  if (running) return <RunningRow turn={turn} now={now} />;
  return (
    <div className="v-version">
      <span className="v-version__who">
        {turn.role} · {turn.kind}
      </span>
      {turn.round !== null && <MetaChip>round {turn.round}</MetaChip>}
      {turn.endedAt !== null && (
        <span className="v-version__took">{elapsed(turn.endedAt - turn.startedAt)}</span>
      )}
    </div>
  );
}

/**
 * The answerer's turns, which belong in the nested question group rather than
 * beside the planner's.
 *
 * `7a`: the question loop is drawn nested inside cycle 1, *"nesting rather than
 * a fourth peer group, because that is what it is - iterating a plan before
 * anyone critiques it."* The frames arrive flat, so the split happens here.
 */
const isAnswerer = (turn: Turn): boolean => turn.role === 'answerer';

function Phase({ phase, runningId, now }: { phase: PhaseGroup; runningId: number | null; now: number }) {
  const turns = phase.turns.filter((t) => !isAnswerer(t));
  return (
    <div className="v-phase">
      <div className="v-phase__head">
        <span className="v-phase__name">{phase.phase}</span>
        {/* The archive's round, which is the number that names the artifact
            behind it. The heading in the terminal says "round 1"; the file is
            `plan-critique-0.json`, and a card has to agree with the file. */}
        {phase.round !== null && <MetaChip kind="checkable">round {phase.round}</MetaChip>}
      </div>
      {phase.gates.map((gate, i) => (
        <div className="v-phase__gate" key={`${gate}-${String(i)}`}>
          verify · {gate}
        </div>
      ))}
      {turns.map((turn) => (
        <Version key={turn.id} turn={turn} running={turn.id === runningId} now={now} />
      ))}
      {turns.length === 0 && phase.gates.length === 0 && (
        // The implementing phase is the one that reaches this: it has never had
        // a `log.step` of its own, so `phase_started` IS its announcement (#152).
        <div className="v-phase__silent">announced by the phase, with no turn line of its own</div>
      )}
    </div>
  );
}

export function LoopColumn({ run, now }: { run: Run; now: number }) {
  const runningId = run.running?.id ?? null;

  return (
    <section className="v-loop" aria-label="loop">
      {run.cycles.length === 0 && (
        <div className="v-loop__empty">nothing has run yet</div>
      )}

      {run.cycles.map((cycle) => (
        <div className="v-cycle" key={cycle.kind}>
          <div className="v-cycle__head">
            <span className="v-cycle__title">{TITLE[cycle.kind]}</span>
            <span className="v-cycle__status">{status(cycle)}</span>
          </div>
          {cycle.phases.map((phase) => (
            <Phase key={phase.id} phase={phase} runningId={runningId} now={now} />
          ))}

          {/* `7a` — the question loop is drawn NESTED inside cycle 1, indented
              with a left rule, because that is what it is: iterating a plan
              before anyone critiques it. A fourth peer group would say it was
              something else. */}
          {cycle.kind === 'plan' && run.questions !== null && (
            <div className="v-questions">
              <div className="v-questions__head">QUESTIONS · answerer</div>
              <div className="v-questions__body">
                {run.questions.total} raised · {run.questions.blocking} blocking
              </div>
              {cycle.phases
                .flatMap((p) => p.turns.filter(isAnswerer))
                .map((turn) => (
                  <Version key={turn.id} turn={turn} running={turn.id === runningId} now={now} />
                ))}
              {/* The explicit panel `7a` asks for. Two full turns of legitimate
                  work run and the outer counter correctly does not move, which
                  without saying so is indistinguishable from a stall. */}
              <div className="v-questions__note">
                A question round produces no critique, so it cannot advance the plan round. This is
                where that time is accounted for.
              </div>
            </div>
          )}
        </div>
      ))}

      {/* Three cycles are always the shape of a run, so the ones that have not
          started are named rather than absent - at reduced weight, because a
          missing group reads as a loop with fewer stages than it has. */}
      {(['plan', 'code', 'review'] as const)
        .filter((kind) => !run.cycles.some((c) => c.kind === kind))
        .map((kind) => (
          <div className="v-cycle v-cycle--idle" key={kind}>
            <div className="v-cycle__head">
              <span className="v-cycle__title">{TITLE[kind]}</span>
              <span className="v-cycle__status">not started</span>
            </div>
          </div>
        ))}
    </section>
  );
}
