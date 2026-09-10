import { LivenessDot, MetaChip, SeverityChip, StateKicker } from '../design';
import { clock, elapsed } from './format';
import { SEVERITIES } from './model';
import { rounds, roundTitle } from './rounds';
import { RunningRow } from './RunningRow';
import type { Severity } from '../design';
import type { RoundCard } from './rounds';
import type { CycleKind, Preflight, ResumedFrom, Run, Turn } from './model';

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
 *
 * **A round, not a phase, is the unit inside a cycle.** The column used to draw
 * one row per phase group, which made a plan round arrive as two rows, made the
 * cycle header count two plan rounds as three, and filed the planner's next
 * revision under the critique that caused it. `rounds()` is the grouping and it
 * is shared with the pilot's log, so the two surfaces cannot disagree about what
 * one round was.
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
function status(kind: CycleKind, count: number): string {
  const noun = count === 1 ? 'round' : 'rounds';
  if (kind === 'code') return `${count} ${noun} · re-runs on every fix`;
  return `${count} ${noun}`;
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

/** A severity this build knows how to weight, or null for the zero variant. */
const weight = (severity: string): Severity | null =>
  (SEVERITIES as readonly string[]).includes(severity) ? (severity as Severity) : null;

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

/**
 * One round of a cycle: the producer, the judge, and what the gate made of it.
 *
 * **A round is the pair**, which is what `CYCLE_OF` has said since it was
 * written — *"a plan round IS the pair: the planner produces a version, the
 * critic judges it"* — and what nothing drew. The column grouped by **phase**,
 * so a plan round arrived as two rows, the cycle header counted two plan rounds
 * as three, and the planner turn that produces the next version sat under the
 * critique that caused it.
 *
 * The critique is therefore not a peer group beside `PLAN`. It is the second
 * half of every plan round, named on its own turn row, where it is visible on
 * each round rather than once at the top. Making it a peer would say the loop is
 * a four-stage pipeline, and this column exists to say it is not — it is three
 * nested convergence cycles. It also would not generalise: cycle 2's judge is
 * the verification gate and cycle 3's producer is the fix turn, so a peer group
 * for the critique earns one for each of those and the answer is six boxes in a
 * row.
 *
 * The grouping is `rounds()`, shared with the pilot's log, so the two surfaces
 * cannot disagree about what one round was.
 */
function Round({
  card,
  answerers,
  runningId,
  settledId,
  now,
}: {
  card: RoundCard;
  /** The answerer's turns, which belong in the nested question group instead. */
  answerers: ReadonlySet<number>;
  runningId: number | null;
  settledId: number | null;
  now: number;
}) {
  const turns = card.turns.filter((t) => !answerers.has(t.id));
  const census = card.census;
  return (
    <div className="v-phase">
      <div className="v-phase__head">
        <span className="v-phase__name">{roundTitle(card)}</span>
        {/* The archive's round, which is the number that names the artifact
            behind it. The heading in the terminal says "round 1"; the file is
            `plan-critique-0.json`, and a card has to agree with the file. */}
        {card.round !== null && <MetaChip kind="checkable">round {card.round}</MetaChip>}
      </div>
      {/*
        Hi-fi 2 draws the four counts on the round card in the loop column, not
        only in the findings pane — *"severity carries the screen"*, and the
        point is the peripheral scan: a run in trouble should look different
        from across the room, before any text is read.

        Zeros included, because a gate decision is being made and an absence is
        information. The tolerance is not repeated here: the pane and the pilot's
        round card both state it, and a 364px column is where a third copy would
        cost the counts their weight.
      */}
      {census !== null && (
        <div className="v-phase__counts">
          {SEVERITIES.map((s) => {
            const n = census.counts[s] ?? 0;
            return (
              <SeverityChip
                key={s}
                severity={n === 0 ? null : weight(s)}
                label={s}
                count={n}
              />
            );
          })}
        </div>
      )}
      {card.gates.map((gate, i) => (
        <div className="v-phase__gate" key={`${gate}-${String(i)}`}>
          verify · {gate}
        </div>
      ))}
      {/* Both halves of the round, in order: the producer, then the judge. The
          critique is this second row — named on every round, where it is
          legible as the thing that objected to the version above it. */}
      {turns.map((turn) => (
        <Version key={turn.id} turn={turn} draw={drawOf(turn, runningId, settledId)} now={now} />
      ))}
      {turns.length === 0 && card.gates.length === 0 && (
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

/**
 * Who this column is about (hi-fi 1, §1.5 of `design/AUDIT.md`).
 *
 * Three lines above the cycles: the workstream, the branch, the repository. The
 * column started at the cycles, so once the titlebar had scrolled past there was
 * nothing on screen naming which repository you were looking at — and a window
 * that can be pointed at any checkout on the machine has to say.
 *
 * **Every line is one the core stated.** The task and the repository ride on
 * `run_started` and the branch on `run_branch`; none of the three is derived
 * from the run id, which would mean re-deriving `vibe/<run-id>` from a prefix
 * `git.branchPrefix` can change and `--no-branch` can remove.
 *
 * A field a frame did not carry is drawn as absent with its reason rather than
 * omitted, because a header with a line missing reads as a header that forgot
 * one — and the two cases here are genuinely different: *nothing said* is an
 * older core, and *no branch* is a run that has one for a stated reason.
 */
function Identity({ run }: { run: Run }) {
  const identity = run.identity;
  if (identity === null) return null;
  const branch = run.branch;
  return (
    <header className="v-ident">
      <div className="v-ident__name">{identity.task ?? identity.runId}</div>
      <div className="v-ident__line">
        {branch === null ? (
          <span className="v-ident__absent">branch — nothing has said</span>
        ) : branch.name === null ? (
          <span className="v-ident__absent">no branch — {branch.why ?? 'no reason given'}</span>
        ) : (
          branch.name
        )}
      </div>
      <div className="v-ident__line">
        {identity.repo === null ? (
          <span className="v-ident__absent">repository — this core did not say which</span>
        ) : (
          identity.repo
        )}
      </div>
    </header>
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
  // The one grouping, shared with the pilot's log. A second answer here to what
  // a round is - or to which census belongs to which - is how the two surfaces
  // come to describe the same round differently.
  const cards = rounds(run);
  const byCycle = new Map<CycleKind, RoundCard[]>();
  for (const card of cards) {
    const list = byCycle.get(card.cycle);
    if (list === undefined) byCycle.set(card.cycle, [card]);
    else list.push(card);
  }
  // The answerer's turns, by id, so a round can leave them to the question group
  // below without re-deciding which they are.
  const answerers = new Set(
    run.cycles.flatMap((c) => c.phases).flatMap((p) => p.turns.filter(isAnswerer).map((t) => t.id)),
  );

  return (
    <section className="v-loop" aria-label="loop">
      <Identity run={run} />
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
            {/* Rounds, not phase groups. Counting the latter called two plan
                rounds three, because a plan round is announced as two phases. */}
            <span className="v-cycle__status">
              {status(cycle.kind, (byCycle.get(cycle.kind) ?? []).length)}
            </span>
          </div>
          {(byCycle.get(cycle.kind) ?? []).map((card) => (
            <Round
              key={card.key}
              card={card}
              answerers={answerers}
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
              <div className="v-questions__head">
                QUESTIONS · answerer
                {/* Hi-fi 14's own counter, nested inside the plan round's.
                    Against the cap where one arrived, because `round 3/3` is
                    the state the escalation is about and `round 3` is a number.
                    Absent rather than guessed on a core that sent neither. */}
                {run.questions.round !== null && (
                  <MetaChip kind="checkable">
                    round {run.questions.round}
                    {run.questions.cap !== null && ` of ${run.questions.cap}`}
                  </MetaChip>
                )}
              </div>
              <div className="v-questions__body">
                {run.questions.total} raised · {run.questions.blocking} blocking
              </div>

              {/* Hi-fi 14: *"the checkbox from the settings vocabulary is doing
                  the answered/unanswered work"* — no new component, and the
                  list is what makes a motionless column legible as waiting
                  rather than stuck. Answered is the answerer having said
                  something, and a decline counts: it is an answer that ends the
                  run, not a question still open. */}
              <ul className="v-questions__list">
                {run.questions.open.map((q) => {
                  const settled = q.answer !== null || q.declined;
                  return (
                    <li
                      key={q.question}
                      className={`v-questions__q${settled ? ' v-questions__q--done' : ''}`}
                    >
                      <span className="v-questions__mark" aria-hidden="true">
                        {settled ? '✓' : '·'}
                      </span>
                      <span className="v-questions__text">{q.question}</span>
                      {q.declined && <StateKicker tone="quiet">declined</StateKicker>}
                    </li>
                  );
                })}
              </ul>

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
              {/* Hi-fi 14: *"waiting on you is not stalled, and the column says
                  so."* The failure mode it names is exact — a user seeing a
                  motionless column and assuming the run died. Drawn only while
                  something is genuinely outstanding, so it cannot become a
                  permanent reassurance nobody reads. */}
              {run.questions.open.some((q) => q.answer === null && !q.declined) && (
                <div className="v-questions__waiting">
                  <StateKicker tone="quiet">waiting on an answer · not stalled</StateKicker>
                  <span>Answers already given are in the draft and are not lost.</span>
                </div>
              )}
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
