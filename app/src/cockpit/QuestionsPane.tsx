import { Card, MetaChip, StateKicker } from '../design';
import type { Question } from './model';

/**
 * The open questions, with the adversary's draft beside each (`1f`, #223).
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
          <p>
            The adversary would not guess at this. {q.rationale ?? 'It gave no reason.'}
          </p>
          <p className="v-q__note">
            {q.blocking
              ? 'A blocking question it declined is what ends the run and writes NEEDS-INPUT.md — this is the one to answer.'
              : 'Advisory, so the loop went ahead on the planner’s own default rather than stopping.'}
          </p>
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
      <p className="v-q__note">
        Nothing here fires on a timer. The answerer takes its turn when the round opens, and a
        question it declines escalates immediately — there is no auto-submit to wait out and no
        grace period to interrupt.
      </p>
    </div>
  );
}
