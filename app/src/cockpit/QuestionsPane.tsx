import { Card, MetaChip, StateKicker } from '../design';
import type { Question } from './model';

/**
 * The open questions, with the answerer's draft beside each (`1f`, #223).
 *
 * **The answerer, and on screen it is called that.** *Adversary* is the design
 * corpus's word for the judging half of any round, and it stays in the comments
 * here for that reason — but `roles.ts` names this seat the `answerer`, and a
 * user reading a card has the role table's vocabulary and not the design's. The
 * screen said *"The adversary would not guess at this"* about a role no
 * configuration of this product contains.
 *
 * The design's inbox, and it is drawn from `questions_opened` plus
 * `questions_answered` rather than from the `- [kind] text` lines the loop
 * prints underneath them - which would be the English-matching #133 exists to
 * prevent.
 *
 * ## The two things it must keep straight
 *
 * **A decline is not a missing answer.** The answerer refusing to guess at
 * product intent is an outcome, and it is the one that ends the run when the
 * question blocks: `escalateOnDefer` and `escalateOnLowConfidence` act on
 * exactly this. Drawing it as "no answer yet" would hide the reason a run
 * stopped, on the screen built to explain it.
 *
 * ## There is no countdown, and there is nothing to count down to
 *
 * This pane used to say the grace period before an auto-submit *"is shown in the
 * footer and only there"*, quoting `1f`'s reasoning about two live timers
 * drifting. **That sentence was false twice.** No countdown was built in the
 * footer — and there is no auto-submit anywhere in the core to have one: nothing
 * under `cfg.questions` fires on a timer, and `grep` finds no grace period in
 * `src/`.
 *
 * `1f` describes a capability the loop does not have. The fix is not to build a
 * timer — that would be inventing the feature *and* its number — it is to say
 * what the loop actually does: the answerer takes its turn, and a declined
 * blocking question escalates at once.
 *
 * ## What is not built
 *
 * The per-workstream **policy** controls — ask the adversary for a draft,
 * auto-answer non-blocking, escalate on low confidence — are `cfg.questions`.
 * Those four are real and readable through the `config` frame; a form for them
 * belongs beside the gate matrix in `1h` rather than here, where it would be a
 * second place to edit one file.
 */

/** `high` is a claim, `low` is a warning, and they should not look alike. */
function tone(confidence: string | null): 'alarm' | 'accent' | 'quiet' {
  if (confidence === 'low') return 'alarm';
  if (confidence === 'high') return 'quiet';
  return 'accent';
}

function One({ q }: { q: Question }) {
  return (
    <Card>
      <div className="v-q__head">
        <MetaChip>{q.kind}</MetaChip>
        {/* Blocking is what decides whether a decline ends the run, so it is
            stated on every question rather than only on the blocking ones. */}
        {q.blocking ? (
          <StateKicker tone="accent">blocking</StateKicker>
        ) : (
          <MetaChip>advisory</MetaChip>
        )}
      </div>
      <p className="v-q__question">{q.question}</p>

      {q.declined ? (
        <div className="v-q__answer v-q__answer--declined">
          <StateKicker tone="alarm">declined</StateKicker>
          {/* **The answerer's own words, and nothing in front of them.** This
              used to open every declined card with a fixed sentence — *"The
              adversary would not guess at this."* — and then print the
              rationale after it. Two defects in one line, and a manual pass
              caught the symptom before either cause: three questions declined
              for three different reasons read as three copies of one reason,
              because the only part that was identical was the part vibe wrote.

              It was also attributing that stance to a role that does not
              exist. `roles.ts` has planner, implementer, critic, answerer and
              reviewer; the adversary is the critic, and it is not who answers
              questions. */}
          {q.rationale === null ? (
            <p className="v-q__note">It declined without giving a reason.</p>
          ) : (
            <p>{q.rationale}</p>
          )}
        </div>
      ) : q.answer === null ? (
        <p className="v-q__note">No answer yet — the answerer has not taken its turn.</p>
      ) : (
        <div className="v-q__answer">
          <div className="v-q__conf">
            <StateKicker tone={tone(q.confidence)}>
              {q.confidence ?? 'confidence not stated'}
            </StateKicker>
          </div>
          <p>{q.answer}</p>
          {q.rationale !== null && <p className="v-q__note">{q.rationale}</p>}
        </div>
      )}
    </Card>
  );
}

export function QuestionsPane({
  questions,
}: {
  questions: { total: number; blocking: number; open: readonly Question[] } | null;
}) {
  if (questions === null) {
    return (
      <div className="v-q v-q--empty">
        <StateKicker tone="quiet">no questions</StateKicker>
        <p>
          The planner raises these when it cannot settle something from the brief. None has come up
          in this run.
        </p>
      </div>
    );
  }

  // Counted from the questions this build could read, which is why the line it
  // feeds is drawn only when it is non-zero: `questions.total` is the loop's
  // count and may be larger, and a "0 declined" over a list this pane admits is
  // incomplete would be a claim it cannot make.
  const declined = questions.open.filter((q) => q.declined).length;

  return (
    <div className="v-q">
      <p className="v-q__summary">
        {questions.total} question{questions.total === 1 ? '' : 's'} · {questions.blocking}{' '}
        blocking
      </p>
      {questions.open.map((q) => (
        <One key={q.question} q={q} />
      ))}
      {/* The counts are the loop's and are what the round acted on. If the list
          is shorter, the pane admits it rather than letting the list read as
          the whole of what was asked. */}
      {questions.open.length < questions.total && (
        <p className="v-q__note">
          The count above is the loop&apos;s; this build could not read every question behind it.
        </p>
      )}
      {/* What is actually true, replacing a sentence that was false twice over.
          See the header. */}
      {/* **What a decline costs, said once.** This used to sit inside every
          declined card, identical on each — and since it is a function of
          `blocking` alone, which is already a chip at the top of the card, it
          was a third copy of something the card said twice. Repeating a
          consequence next to three different reasons is what made three
          different reasons look like one. */}
      {declined > 0 && (
        <p className="v-q__note">
          {declined} declined. A declined <strong>blocking</strong> question ends the run and
          writes NEEDS-INPUT.md; a declined <strong>advisory</strong> one leaves the planner’s own
          fallback in place and the loop carries on.
        </p>
      )}
      <p className="v-q__note">
        Nothing here fires on a timer. The answerer takes its turn when the round opens, and a
        question it declines escalates immediately — there is no auto-submit to wait out and no
        grace period to interrupt.
      </p>
    </div>
  );
}
