import { LivenessDot, MetaChip, StateKicker } from '../design';
import { clock, elapsed } from './format';
import { RunningRow } from './RunningRow';
import type {
  Cycle,
  CycleKind,
  PhaseGroup,
  Preflight,
  ResumedFrom,
  Run,
  Turn,
} from './model';

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

/**
 * How much of a turn to draw.
 *
 * `settled` is the turn a held gate is showing the result of (#202): the full
 * row, with its final numbers, and none of the live treatment. It exists because
 * the moment before somebody presses continue is exactly when they want to see
 * what the turn did - and because a card still counting while the loop waits for
 * a human reads as a hang.
 */
type Draw = 'live' | 'settled' | 'done';

const drawOf = (turn: Turn, runningId: number | null, settledId: number | null): Draw =>
  turn.id === runningId ? 'live' : turn.id === settledId ? 'settled' : 'done';

function Version({ turn, draw, now }: { turn: Turn; draw: Draw; now: number }) {
  if (draw !== 'done') return <RunningRow turn={turn} now={now} live={draw === 'live'} />;
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

function Phase({
  phase,
  runningId,
  settledId,
  now,
}: {
  phase: PhaseGroup;
  runningId: number | null;
  settledId: number | null;
  now: number;
}) {
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
        <Version key={turn.id} turn={turn} draw={drawOf(turn, runningId, settledId)} now={now} />
      ))}
      {turns.length === 0 && phase.gates.length === 0 && (
        // The implementing phase is the one that reaches this: it has never had
        // a `log.step` of its own, so `phase_started` IS its announcement (#152).
        <div className="v-phase__silent">announced by the phase, with no turn line of its own</div>
      )}
    </div>
  );
}

/**
 * The three things that have to happen before a phase can start (hi-fi 16).
 *
 * **This is what replaces a progress bar**, and the substitution is the whole
 * design: there is no denominator between pressing launch and the first phase -
 * no phase has started, no turn exists, and there is no total to be a fraction
 * of - so the honest drawing is a checklist of facts, two settled and one in
 * flight. Each carries the evidence for itself: a timestamp, a pid, an elapsed.
 *
 * `done` is not `pending` drawn differently. A step nothing has reported yet
 * says so; it never shows a zero or an empty value standing in for a fact.
 */
function Step({
  label,
  done,
  detail,
}: {
  label: string;
  done: boolean;
  detail: string;
}) {
  return (
    <li className={`v-starting__step${done ? ' v-starting__step--done' : ''}`}>
      <span className="v-starting__mark" aria-hidden="true">
        {done ? '✓' : '·'}
      </span>
      <span className="v-starting__what">{label}</span>
      <span className="v-starting__detail">{detail}</span>
    </li>
  );
}

/**
 * What this run did before this window was watching (#211).
 *
 * **The column below draws narration, and narration starts when the window
 * connects.** So a run resumed at review round 3 drew an empty column and a
 * `starting` checklist, exactly as though it were beginning - which is what
 * *"when I resume a past run, the pilot et al should be brought back to
 * wherever we're resuming from"* is about.
 *
 * It sits above the cycles rather than among them, and it is a **summary**
 * rather than reconstructed cards: the core reads it off `state.json`, and
 * re-emitting phases and turns for work that already finished would fill the
 * column at the price of drawing completed work as though it were running.
 *
 * Every figure is drawn only when it arrived. A round the frame did not carry
 * is left out rather than shown as 0, which on a resumed run would say the
 * opposite of what this row exists to say.
 */
function ResumedRow({ from }: { from: ResumedFrom }) {
  const rounds: string[] = [];
  if (from.planRound !== null) rounds.push(`plan ${String(from.planRound)}`);
  if (from.questionRound !== null && from.questionRound > 0) {
    rounds.push(`question ${String(from.questionRound)}`);
  }
  if (from.verifyRound !== null && from.verifyRound > 0) {
    rounds.push(`verify ${String(from.verifyRound)}`);
  }
  if (from.reviewRound !== null) rounds.push(`review ${String(from.reviewRound)}`);

  const open: string[] = [];
  if (from.pendingFindings !== null && from.pendingFindings > 0) {
    open.push(
      `${String(from.pendingFindings)} finding(s) outstanding` +
        (from.pendingFrom === null ? '' : ` from ${from.pendingFrom}`),
    );
  }
  if (from.carried !== null && from.carried > 0) {
    open.push(`${String(from.carried)} carried into implementation`);
  }

  return (
    <div className="v-resumed">
      <div className="v-resumed__head">
        <StateKicker tone="quiet">picked up</StateKicker>
        <span className="v-resumed__where">
          {from.phase === null ? 'from an earlier session' : `in ${from.phase}`}
          {from.status === null ? '' : `, which ended ${from.status}`}
        </span>
      </div>
      {rounds.length > 0 && <div className="v-resumed__line">{rounds.join(' · ')}</div>}
      {open.length > 0 && <div className="v-resumed__line">{open.join(' · ')}</div>}
      {/* Said out loud, because it is the thing most likely to be misread: the
          cards below are this session only, and the totals in the footer start
          from zero again. */}
      <div className="v-resumed__note">
        Everything below is this session. Earlier sessions spent{' '}
        {from.tokensUsed === null ? 'an unrecorded number of' : from.tokensUsed.toLocaleString()}{' '}
        tokens
        {from.codexTokens === null
          ? ''
          : ` (${from.codexTokens.toLocaleString()} of them Codex)`}
        , and are not counted again here.
      </div>
    </div>
  );
}

/**
 * What preflight is doing, before there is a phase to draw (#205, hi-fi 16).
 *
 * The seconds between pressing launch and the first phase used to have nothing
 * true to say in them: preflight spawns a probe turn against each agent and
 * narrated nothing while it did. This is the fix's visible half, and every part
 * of it is a fact the loop sent.
 *
 * **Preflight takes the live card while it runs** - accent border, pulsing dot,
 * elapsed - because it *is* a real turn against a real CLI. That is what makes
 * this "the cockpit with one card in it" rather than a launching screen with its
 * own vocabulary, and it is why there is no spinner: a spinner would say the
 * same thing while measuring nothing.
 *
 * **No bar, no percentage, no ETA.** `2 of 2` is a position in a list the loop
 * named, not a fraction of the run - and it is omitted entirely when the list
 * did not arrive, rather than being counted from the agent in hand.
 */
function PreflightRow({ preflight, now }: { preflight: Preflight; now: number }) {
  const at = preflight.probing === null ? -1 : preflight.agents.indexOf(preflight.probing);
  const position = at < 0 ? '' : ` · ${String(at + 1)} of ${String(preflight.agents.length)}`;

  const state = preflight.passed
    ? 'toolchain contract satisfied'
    : preflight.probing !== null
      ? `probing ${preflight.probing}${position}`
      : 'checking that both agents can run what this run needs';

  return (
    <div className={`v-preflight${preflight.passed ? ' v-preflight--done' : ' v-preflight--live'}`}>
      {!preflight.passed && <LivenessDot state="live" />}
      <span className="v-preflight__label">PREFLIGHT</span>
      <span className="v-preflight__state">{state}</span>
      {/* The elapsed a spinner would have replaced. Measured from the frame that
          announced preflight, so it is this step's duration and not the run's. */}
      {!preflight.passed && (
        <span className="v-preflight__elapsed">{elapsed(Math.max(0, now - preflight.at))}</span>
      )}
    </div>
  );
}

/**
 * The launching state: three checkboxes, and what nothing has reported yet.
 *
 * Hi-fi 16, and the table it is built from is a list of substitutions - a
 * progress bar becomes three checkboxes, an ETA becomes a claim about the past,
 * a spinner becomes the liveness dot plus an elapsed, a skeleton becomes dashed
 * cycle rows, and a zero becomes a named absence.
 *
 * **The ETA is the one that is not built, and its absence is the point.** The
 * design's wording is *"preflight usually clears in under a minute"*, which is a
 * claim about past runs; nothing in this app has read a past run, because that
 * is #114. Shipping the sentence anyway would make it the same kind of invention
 * as `claude 38%` and `step 9/14` - the two the design itself struck. So the row
 * says what it cannot say and names the issue that would supply it, exactly as
 * `6a`'s comparable-turns line already does.
 */
function Starting({
  run,
  hostPid,
  now,
}: {
  run: Run;
  hostPid: number | null;
  now: number;
}) {
  return (
    <div className="v-starting">
      <ol className="v-starting__steps">
        <Step
          label="task reached the core"
          done={run.identity !== null}
          detail={
            run.identity === null
              ? 'sent — the core has not answered yet'
              : clock(run.identity.at)
          }
        />
        <Step
          label="host alive"
          done={hostPid !== null}
          detail={hostPid === null ? 'no host is running' : `pid ${hostPid}`}
        />
        <Step
          label="preflight probing"
          done={run.preflight?.passed === true}
          detail={
            run.preflight === null
              ? 'not started'
              : run.preflight.passed
                ? 'both agents can run what this run needs'
                : elapsed(Math.max(0, now - run.preflight.at))
          }
        />
      </ol>

      {/* Named and attributed rather than left blank. Without this the next
          reader assumes four numbers were forgotten. */}
      <p className="v-starting__unknown">
        phase, round, elapsed total and spend — the first turn has not reported
      </p>
      <p className="v-starting__unknown">
        how long this usually takes — no frame carries a past run's timings (#114)
      </p>
    </div>
  );
}

export function LoopColumn({
  run,
  now,
  hostPid = null,
}: {
  run: Run;
  now: number;
  /** A fact about this window's process, not about the run. Hi-fi 16 draws it. */
  hostPid?: number | null;
}) {
  const runningId = run.running?.id ?? null;
  // Told, not worked out. `reduce` names the turn a gate opened after, so the
  // column does not have to decide that "the last one" is the right turn (#202).
  const settledId = run.gate?.turnId ?? null;

  return (
    <section className="v-loop" aria-label="loop">
      {run.from !== null && <ResumedRow from={run.from} />}
      {run.preflight !== null && <PreflightRow preflight={run.preflight} now={now} />}

      {/* Everything before the first phase. The checklist goes once a run has
          been asked for - which the identity or a live preflight both prove -
          and disappears the moment there is a real phase to look at instead. */}
      {run.cycles.length === 0 && (run.identity !== null || run.preflight !== null) && (
        <Starting run={run} hostPid={hostPid} now={now} />
      )}

      {/* Only when there is genuinely nothing to say. A run that has been asked
          for IS something happening, and two lines claiming the opposite of each
          other is the disagreement #202 was about. */}
      {run.cycles.length === 0 && run.preflight === null && run.identity === null && (
        <div className="v-loop__empty">nothing has run yet</div>
      )}

      {run.cycles.map((cycle) => (
        <div className="v-cycle" key={cycle.kind}>
          <div className="v-cycle__head">
            <span className="v-cycle__title">{TITLE[cycle.kind]}</span>
            <span className="v-cycle__status">{status(cycle)}</span>
          </div>
          {cycle.phases.map((phase) => (
            <Phase
              key={phase.id}
              phase={phase}
              runningId={runningId}
              settledId={settledId}
              now={now}
            />
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
                  <Version
                    key={turn.id}
                    turn={turn}
                    draw={drawOf(turn, runningId, settledId)}
                    now={now}
                  />
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
