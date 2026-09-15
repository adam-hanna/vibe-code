import { useEffect, useState } from 'react';
import { Button, Card, MetaChip, StateKicker } from '../design';
import * as host from '../host';
import { Section } from './Disclosure';
import { ofKind, readAnswers } from './artifacts';
import { useArtifact, useArtifacts, noText } from './useArtifacts';
import type { RecordedAnswer } from './artifacts';
import type { Question, Run } from './model';

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
 * ## One section per round, and the earlier ones come off disk
 *
 * This used to be a flat list of the round in flight, and every round before it
 * was gone — including on a resume, where *every* round is an earlier one and the
 * pane opened empty on a run that had asked nine questions. A question round
 * writes `answers-<n>.json`, so the earlier rounds were on disk the whole time
 * and nothing could read them.
 *
 * **The live round is drawn from the wire and the settled ones from their
 * files**, and both go through one `One` card: a round read from disk must not
 * be drawable in a way a live one is not, or the two will drift and the drift
 * will be invisible on whichever half nobody is looking at.
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

/**
 * One question, live or recorded.
 *
 * `kind` and `blocking` come off the wire and are absent on a recorded round —
 * `answers-<n>.json` holds the answerer's reply, not the planner's tagging of
 * the question. They are omitted rather than defaulted: an advisory question
 * drawn as blocking because a file did not say is the fail-closed direction on
 * the live path and a fabrication on this one, since nothing here acts on it.
 */
function One({
  q,
}: {
  q: {
    question: string;
    kind: string | null;
    blocking: boolean | null;
    answer: string | null;
    confidence: string | null;
    rationale: string | null;
    declined: boolean;
  };
}) {
  return (
    <Card>
      <div className="v-q__head">
        {q.kind !== null && <MetaChip>{q.kind}</MetaChip>}
        {/* Blocking is what decides whether a decline ends the run, so it is
            stated on every question rather than only on the blocking ones. */}
        {q.blocking === true && <StateKicker tone="accent">blocking</StateKicker>}
        {q.blocking === false && <MetaChip>advisory</MetaChip>}
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
              because the only part that was identical was the part vibe wrote. */}
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

/** A live question, widened to what `One` draws. */
const live = (q: Question): Parameters<typeof One>[0]['q'] => ({
  question: q.question,
  kind: q.kind,
  blocking: q.blocking,
  answer: q.answer,
  confidence: q.confidence,
  rationale: q.rationale,
  declined: q.declined,
});

/** A recorded question, widened the same way. The two must render identically. */
const recorded = (a: RecordedAnswer): Parameters<typeof One>[0]['q'] => ({
  question: a.question,
  kind: null,
  blocking: null,
  answer: a.answer,
  confidence: a.confidence,
  rationale: a.rationale,
  declined: a.declined,
});

/** An earlier round, read from its own file when its section opens. */
function RecordedRound({
  dir,
  runId,
  name,
  revision,
}: {
  dir: string;
  runId: string;
  name: string;
  revision: number;
}) {
  const { read, failure, loading } = useArtifact(dir, runId, name, revision);
  const missing = noText(read, failure);

  if (loading && read === null && missing === null) {
    return <p className="v-q__note">reading {name}…</p>;
  }
  if (missing !== null) {
    return (
      <p className="v-q__note">
        <StateKicker tone="quiet">no answers</StateKicker> {missing}
      </p>
    );
  }
  if (read === null || read.kind !== 'text') return null;

  const answers = readAnswers(read.text);
  if (answers === null) {
    return (
      <p className="v-q__note">
        <StateKicker tone="alarm">unreadable</StateKicker> {name} is not the shape this build
        understands, so nothing was drawn from it.
      </p>
    );
  }
  if (answers.length === 0) {
    return (
      <p className="v-q__note">
        The answerer returned nothing for this round. That is what ends a run when the question
        blocks, and it is on disk as an empty list rather than as a missing file.
      </p>
    );
  }
  return (
    <>
      {answers.map((a) => (
        <One key={a.question} q={recorded(a)} />
      ))}
    </>
  );
}

/**
 * Answering a halted run, on the page that is already showing the questions.
 *
 * **The window had every question on screen and no way to answer one.** The
 * halt banner said *"Answer the questions in NEEDS-INPUT.md, then resume"* —
 * the CLI's own instruction, correct in a terminal and absurd here: *"thats
 * crazy, I should answer directly in the app on the questions page."*
 *
 * What it does is fill in that same file and then resume, as two requests in
 * that order. It is not a shortcut past `NEEDS-INPUT.md`: the loop's parser,
 * the `answered-<n>.md` retirement and the raise blocks are all untouched, and
 * a person who prefers vim gets an identical run.
 *
 * **Saving does not spend anything.** The write and the resume are separate
 * buttons for that reason — somebody may answer two questions now and the third
 * after lunch, and a Save that started a run would make that impossible.
 */
function AnswerForm({
  dir,
  runId,
  open,
  busy,
  onResume,
}: {
  dir: string;
  runId: string;
  /** The questions still waiting. Answering is offered for exactly these. */
  open: readonly { question: string; blocking: boolean }[];
  busy: boolean;
  onResume: (runId: string, dir: string) => void;
}) {
  const [typed, setTyped] = useState<Readonly<Record<string, string>>>({});
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ filled: number; open: readonly string[] } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const answers = open
    .map((q) => ({ question: q.question, answer: typed[q.question] ?? '' }))
    .filter((a) => a.answer.trim() !== '');

  const save = (then?: () => void): void => {
    setSaving(true);
    setFailure(null);
    void host
      .answerQuestions(dir, runId, answers)
      .then((placed: { filled: number; open: readonly string[] }) => {
        setResult({ filled: placed.filled, open: placed.open });
        then?.();
      })
      // The core's own sentence. *"It is running, so it is not waiting for an
      // answer"* and *"it has no NEEDS-INPUT.md"* are acted on differently, and
      // a window that collapsed them into "could not save" would answer neither.
      .catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="v-q__answer">
      <div className="v-q__answerhead">
        <StateKicker tone="accent">your turn</StateKicker>
        <span>
          These go into the run&apos;s <code>NEEDS-INPUT.md</code> — the same file{' '}
          <code>vibe resume</code> reads, so answering here and answering in an editor are the
          same act.
        </span>
      </div>

      {open.map((q) => (
        <label className="v-q__field" key={q.question}>
          <span className="v-q__fieldq">{q.question}</span>
          {/* **What is on the wire, and nothing that is not.** The escalation
              file records what the planner would default to; `Question` on the
              wire does not carry it, so the form says whether an unanswered one
              ENDS the run rather than inventing the default it would take. */}
          <span className="v-q__fielddefault">
            {q.blocking
              ? 'blocking — left blank, this is what the run stops on again'
              : 'advisory — left blank, the planner keeps its own answer and the loop carries on'}
          </span>
          <textarea
            className="v-q__fieldbox"
            rows={3}
            value={typed[q.question] ?? ''}
            disabled={busy || saving}
            placeholder="in your own words"
            onChange={(e) => setTyped((cur) => ({ ...cur, [q.question]: e.target.value }))}
          />
        </label>
      ))}

      {failure !== null && (
        <p className="v-q__note v-q__note--alarm" role="alert">
          <StateKicker tone="alarm">refused</StateKicker> {failure}
        </p>
      )}
      {result !== null && failure === null && (
        <p className="v-q__note">
          {result.filled} written to <code>NEEDS-INPUT.md</code>.{' '}
          {result.open.length > 0 ? (
            <>
              <strong>{result.open.length} still blank</strong> — resuming now lets the planner
              take its own default for those.
            </>
          ) : (
            'Every question has an answer.'
          )}
        </p>
      )}

      <div className="v-q__actions">
        <Button
          level="secondary"
          disabled={busy || saving || answers.length === 0}
          onClick={() => save()}
        >
          {saving ? 'saving…' : `save ${String(answers.length)} answer(s)`}
        </Button>
        {/* The primary, because it is what somebody opened this pane to do. It
            saves first and resumes only on a write that succeeded — a resume
            over a refused save would spend a preflight to halt on the same
            question. */}
        <Button
          level="primary"
          disabled={busy || saving}
          onClick={() => save(() => onResume(runId, dir))}
        >
          ▶ save and resume
        </Button>
      </div>
    </div>
  );
}

export function QuestionsPane({
  questions,
  dir,
  runId,
  revision = 0,
  halted = false,
  busy = false,
  onResume,
}: {
  questions: Run['questions'];
  dir: string;
  runId: string | null;
  /**
   * Whether the run STOPPED on these questions (#223).
   *
   * The form appears on a halt and never beside a live round: a run that is
   * still going has no `NEEDS-INPUT.md` to write into, and offering a box that
   * would be refused is worse than not offering one. Told by the exit code the
   * run reported, never inferred from the questions themselves - an advisory
   * question the answerer handled leaves open questions on a run nobody is
   * waiting on.
   */
  halted?: boolean;
  busy?: boolean;
  onResume?: ((runId: string, dir: string) => void) | undefined;
  /** How many artifacts the run has written, so a settled round appears (#223). */
  revision?: number;
}) {
  const { entries } = useArtifacts(dir, runId, revision);
  // Every settled round, minus the one the wire is still describing: the loop
  // writes `answers-<n>.json` the moment the answerer's turn ends, so the live
  // round appears here too and drawing both would be one round twice.
  const settled = ofKind(entries, 'answers').filter((a) => a.round !== questions?.round);
  const liveKey = 'live';
  const [open, setOpen] = useState<string>(liveKey);

  useEffect(() => {
    // The round in flight, or the newest settled one. The question somebody has
    // when they open this tab is almost always about the round that is holding
    // them up.
    if (questions !== null) {
      setOpen(liveKey);
      return;
    }
    const last = settled[settled.length - 1];
    if (last !== undefined) setOpen(last.name);
    // Keyed on the fetched array and on the live round, both of which change
    // only when something actually arrived.
  }, [entries, questions?.round]);

  if (questions === null && settled.length === 0) {
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

  const outstanding =
    questions === null ? 0 : questions.open.filter((q) => q.answer === null && !q.declined).length;
  const declined = questions === null ? 0 : questions.open.filter((q) => q.declined).length;
  // The ones a person can still answer: unanswered, and not ones the answerer
  // declined on their behalf. A declined question already has the planner's own
  // fallback behind it and is not what the run is waiting on.
  const waiting =
    questions === null
      ? []
      : questions.open
          .filter((q) => q.answer === null && !q.declined)
          .map((q) => ({ question: q.question, blocking: q.blocking }));

  return (
    <div className="v-q">
      {settled.map((round) => (
        <Section
          key={round.name}
          id={round.round === null ? undefined : `question-round-${String(round.round)}`}
          open={open === round.name}
          onToggle={() => { setOpen((cur) => (cur === round.name ? '' : round.name)); }}
          title={round.round === null ? 'a question round' : `round ${String(round.round)}`}
          meta={<code className="v-doc__file">{round.name}</code>}
        >
          <RecordedRound dir={dir} runId={runId ?? ''} name={round.name} revision={revision} />
        </Section>
      ))}

      {questions !== null && (
        <Section
          open={open === liveKey}
          onToggle={() => { setOpen((cur) => (cur === liveKey ? '' : liveKey)); }}
          title={
            questions.round === null
              ? 'this round'
              : `round ${String(questions.round)}${questions.cap === null ? '' : ` of ${String(questions.cap)}`}`
          }
          meta={
            <>
              <MetaChip>{questions.total} raised</MetaChip>
              <MetaChip kind={questions.blocking > 0 ? 'alarm' : 'default'}>
                {questions.blocking} blocking
              </MetaChip>
              {outstanding > 0 && <StateKicker tone="accent">waiting</StateKicker>}
            </>
          }
        >
          {questions.open.map((q) => (
            <One key={q.question} q={live(q)} />
          ))}
          {/* Only on a halt, and only for the questions still waiting. See
              `halted` above for why it is told rather than worked out. */}
          {halted && runId !== null && onResume !== undefined && waiting.length > 0 && (
            <AnswerForm
              dir={dir}
              runId={runId}
              open={waiting}
              busy={busy}
              onResume={onResume}
            />
          )}
          {/* The counts are the loop's and are what the round acted on. If the
              list is shorter, the pane admits it rather than letting the list
              read as the whole of what was asked. */}
          {questions.open.length < questions.total && (
            <p className="v-q__note">
              The count above is the loop&apos;s; this build could not read every question behind
              it.
            </p>
          )}
          {/* **What a decline costs, said once.** This used to sit inside every
              declined card, identical on each — and since it is a function of
              `blocking` alone, which is already a chip at the top of the card,
              it was a third copy of something the card said twice. */}
          {declined > 0 && (
            <p className="v-q__note">
              {declined} declined. A declined <strong>blocking</strong> question ends the run and
              writes NEEDS-INPUT.md; a declined <strong>advisory</strong> one leaves the planner’s
              own fallback in place and the loop carries on.
            </p>
          )}
        </Section>
      )}

      {/* What is actually true, replacing a sentence that was false twice over.
          See the header. Once, under the whole pane, because it is a fact about
          the loop rather than about any one round. */}
      <p className="v-q__note">
        Nothing here fires on a timer. The answerer takes its turn when the round opens, and a
        question it declines escalates immediately — there is no auto-submit to wait out and no
        grace period to interrupt.
      </p>
    </div>
  );
}
