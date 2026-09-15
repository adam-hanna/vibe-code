import { MetaChip, StateKicker } from '../design/Chips';
import { recorded, tokens as fmtTokens } from './format';
import { preview } from './projects';
import type { RecordFrame } from '../host';

/**
 * What the column shows when the window is pointed at a run it is not narrating
 * (#223).
 *
 * **Reported as a gap, not as a preference:** *"when I click on an existing run,
 * I don't see the right nav update."* Six panes followed the opened run, because
 * each reads a file that run wrote. The column beside them stayed with the live
 * run and said so in a strip — which was honest, and was still the wrong answer,
 * because it stayed for a reason nobody outside this repository can see: it had
 * nothing to follow with. `reduce` builds a `Run` out of narration and a
 * finished run's narration went to a process that has exited.
 *
 * So this is **not that column with the clocks stopped**. It is a different
 * drawing of a different thing: a record, read off `state.json` by the core, of
 * a run that is over. Three rules follow from that and each is visible on
 * screen.
 *
 * **Every time is absolute.** Hi-fi 17's rule, at its strongest here: `6s ago`
 * is a claim that has to keep being true, and on a record that has not moved
 * since Tuesday it is a lie by construction. `recorded` carries the date too,
 * because a bare `15:33` on a week-old run reads as this afternoon.
 *
 * **Nothing pulses and there is no live card.** *Exactly one element on screen
 * pulses*, and a record is the one surface where the count should be zero — a
 * dot on a run that ended on Tuesday would be the stall the indicator exists to
 * avoid claiming.
 *
 * **A count the run never recorded is drawn as absent**, never as a zero. That
 * is why `spend.codexTokens` and `spend.costUsd` are nullable on the wire: a run
 * that never took a Codex turn has not measured a Codex total, and `0 tok` would
 * say it had.
 */
export function RecordColumn({
  record,
  failure,
  loading,
  task,
  onResume,
  onBack,
}: {
  record: RecordFrame['record'] | null;
  failure: string | null;
  loading: boolean;
  /** What the sidebar called it, for the moment before the record arrives. */
  task: string;
  onResume: () => void;
  onBack: () => void;
}) {
  return (
    <div className="v-rec">
      <div className="v-rec__head">
        <StateKicker tone="quiet">reading</StateKicker>
        <span className="v-rec__task">{preview(record?.task ?? task)}</span>
      </div>

      {loading && record === null && failure === null && (
        <p className="v-rec__note">Reading this run’s record…</p>
      )}

      {failure !== null && (
        /* The core's own sentence, verbatim. A run whose id will not join onto a
           path, a directory vibe refuses to follow (#53) and a `state.json` the
           validators reject are three different findings needing three different
           responses, and *"could not read the run"* answers none of them. */
        <p className="v-rec__failure">{failure}</p>
      )}

      {record !== null && (
        <>
          <div className="v-rec__ident">
            <code className="v-rec__id">{record.id}</code>
            <MetaChip>{record.status}</MetaChip>
            {/* The lock's own verdict, not one derived from `status`. A
                `running` status on a dead pid is the wreck #131 exists to tell
                apart, and a column that read the status alone would hide it. */}
            {record.liveness !== 'not-running' && <MetaChip>{record.liveness}</MetaChip>}
            {record.planOnly && <MetaChip>plan only</MetaChip>}
          </div>

          <dl className="v-rec__facts">
            <dt>started</dt>
            <dd>{recorded(record.createdAt)}</dd>
            <dt>last activity</dt>
            <dd>{recorded(record.lastActivityAt)}</dd>
            <dt>branch</dt>
            {/* Two kinds of none, and they are different facts: `--no-branch`
                and a repository the run never got as far as branching in. The
                record carries null for both, so this says the honest common
                part rather than picking one. */}
            <dd>{record.branch ?? 'none recorded'}</dd>
          </dl>

          <h4 className="v-rec__h">rounds it recorded</h4>
          {/* Counts the loop wrote down, drawn as four numbers and not as
              progress: there is no denominator here, so there is no bar. A
              question round is its own number rather than folded into the plan
              rounds, because a revision answering the planner's own answers is
              not the producer's side of a round — nothing judged anything. */}
          <ul className="v-rec__rounds">
            <li>
              <span>plan</span>
              <strong>{record.rounds.plan}</strong>
            </li>
            <li>
              <span>questions</span>
              <strong>{record.rounds.question}</strong>
            </li>
            <li>
              <span>review</span>
              <strong>{record.rounds.review}</strong>
            </li>
            <li>
              <span>verify</span>
              <strong>{record.rounds.verify}</strong>
            </li>
          </ul>

          <h4 className="v-rec__h">what it ended holding</h4>
          {/* Counts, and the findings themselves are behind the Code review tab,
              which reads the round's own artifact. A frame carrying every
              finding in full would put a review's whole report on the wire to
              draw four numbers. */}
          <ul className="v-rec__rounds">
            <li>
              <span>carried P1s</span>
              <strong>{record.findings.carried}</strong>
            </li>
            <li>
              <span>declined</span>
              <strong>{record.findings.declined}</strong>
            </li>
            <li>
              <span>outstanding</span>
              <strong>{record.findings.outstanding}</strong>
            </li>
            <li>
              <span>deferred</span>
              <strong>{record.findings.deferred}</strong>
            </li>
          </ul>

          <h4 className="v-rec__h">what it spent</h4>
          <p className="v-rec__spend">
            {/* Absent rather than zero. A run that charged nothing has not spent
                zero — it has not been measured, which is the same distinction
                every other spend readout in this product draws. */}
            {record.spend.tokens === 0 ? (
              'nothing charged'
            ) : (
              <>
                {fmtTokens(record.spend.tokens)} tok
                {record.spend.codexTokens !== null && (
                  <> · codex {fmtTokens(record.spend.codexTokens)}</>
                )}
                {/* Claude's API-equivalent only. Codex bills nothing at all on a
                    subscription, so a dollar figure for it has no quantity to be
                    an estimate of — the settled rule, not an omission. */}
                {record.spend.costUsd !== null && <> · ~${record.spend.costUsd.toFixed(2)}</>}
              </>
            )}
          </p>

          {record.ended !== null && (
            <>
              <h4 className="v-rec__h">how it ended</h4>
              {/* The event the core recorded where it gave up, selected by type
                  and never by reading the transcript for an alarming sentence —
                  which is the English-matching #133 exists to prevent, and which
                  picks the wrong line, because a healthy run is full of warnings
                  that are not the ending. */}
              <p className="v-rec__ended">
                {record.ended.message === '' ? record.ended.type : record.ended.message}
              </p>
            </>
          )}

          {!record.hasPlan && (
            <p className="v-rec__note">
              This run stored no plan of record. The Plans tab reads the same directory and will
              say the same thing.
            </p>
          )}
        </>
      )}

      <p className="v-rec__note">
        Turn by turn, this run is in the Output tab, which reads its transcript. The column’s
        live cards belong to the run this window is narrating.
      </p>

      <div className="v-rec__acts">
        {/* `1b`, which is the only place a run is started — a control here would
            be a second way to spend, and two places able to start a run is the
            same mistake as two able to force a lock. */}
        <button className="v-doc__again" onClick={onResume}>
          resume it…
        </button>
        <button className="v-doc__again" onClick={onBack}>
          back to the live run
        </button>
      </div>
    </div>
  );
}
