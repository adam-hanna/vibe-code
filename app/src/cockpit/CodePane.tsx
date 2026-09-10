import { useEffect, useState } from 'react';
import { MetaChip, StateKicker } from '../design';
import { DiffPane } from './DiffPane';
import { Section } from './Disclosure';
import { work as describeWork } from './format';
import { committed } from './rounds';
import type { Run } from './model';

/**
 * What each round of implementation changed (`1d`, #223).
 *
 * **The Diff tab showed one diff and it was the whole run's.** That is the right
 * answer to *"what has this changed"* and the wrong answer to *"what did the fix
 * round do"* — and the second is the question somebody has at a review boundary,
 * where a reviewer has just objected and a fix round has just run. A single
 * cumulative diff cannot answer it: every round's work is in there, and the
 * round you care about is the part you cannot pick out.
 *
 * ## A round is a section, and its range is measured
 *
 * `round_committed` reads HEAD before it commits, so each round carries the pair
 * of shas that bound it. Nothing here pairs consecutive commits to reconstruct a
 * range — that derivation is correct right up until a run is resumed, at which
 * point the earlier commits were narrated to a process that has exited and round
 * 3's card silently shows a cumulative diff labelled as one round.
 *
 * ## The three ways a round leaves nothing, and none of them is a failure
 *
 * A round that changed nothing, a run with `git.commitEachRound` off, and a
 * directory that is not a repository all produce no commit. The pane says the
 * honest common part — there is nothing in the history for this round — rather
 * than picking one of the three reasons it was not told.
 */

export function CodePane({
  run,
  dir,
  openAt,
}: {
  run: Run;
  dir: string;
  /**
   * A round to open, sent by whatever navigated here.
   *
   * The archive's round, which both sides of that link already hold: the card
   * carries it and the section is keyed by it.
   */
  openAt?: number | null;
}) {
  const rounds = committed(run);
  // `whole` is a section like any other, and it is first because it is the
  // question `1d` was built for. It is not the default: a person opening this
  // tab during a fix round wants that round, and the newest section is it.
  const WHOLE = 'whole';
  const [open, setOpen] = useState<string>(WHOLE);

  useEffect(() => {
    if (rounds.length === 0) return;
    const wanted =
      openAt === null || openAt === undefined
        ? null
        : rounds.find((r) => r.round === openAt);
    const last = rounds[rounds.length - 1];
    setOpen((wanted ?? last)?.commit.sha ?? WHOLE);
    // Keyed on the commits rather than on `rounds`, which is rebuilt every
    // render. `run.commits` is the array `reduce` appends to and is stable
    // between frames.
  }, [run.commits, openAt]);

  if (dir.trim() === '') {
    return (
      <div className="v-doc v-doc--empty">
        <StateKicker tone="quiet">no repository</StateKicker>
        <p>A diff is read with git, in a repository, and this window is not pointed at one.</p>
      </div>
    );
  }

  return (
    <div className="v-doc">
      <Section
        open={open === WHOLE}
        onToggle={() => { setOpen((cur) => (cur === WHOLE ? '' : WHOLE)); }}
        title="everything since the base"
        meta={
          run.baseSha === null ? (
            <MetaChip>no base</MetaChip>
          ) : (
            <code className="v-doc__file">{run.baseSha.slice(0, 7)}..HEAD</code>
          )
        }
      >
        <DiffPane dir={dir} baseSha={run.baseSha} />
      </Section>

      {rounds.length === 0 && (
        <p className="v-doc__note">
          <StateKicker tone="quiet">no rounds in the history</StateKicker> Nothing has been
          committed under this run yet. A round that changed no files, a project with{' '}
          <code>git.commitEachRound</code> switched off and a directory that is not a repository
          all look the same from here — the run says which in the output.
        </p>
      )}

      {rounds.map((card) => (
        <Section
          key={card.commit.sha}
          id={card.round === null ? undefined : `code-round-${String(card.round)}`}
          reveal={openAt !== null && openAt !== undefined && card.round === openAt}
          open={open === card.commit.sha}
          onToggle={() => {
            setOpen((cur) => (cur === card.commit.sha ? '' : card.commit.sha));
          }}
          title={
            card.round === null
              ? (card.commit.message ?? 'a round')
              : `code · round ${String(card.round)}`
          }
          meta={
            <>
              {/* The message names what the round was - `vibe: address review
                  round 2` - which is the loop's own sentence and not one
                  composed here from the phase. */}
              {card.commit.message !== null && <MetaChip>{card.commit.message}</MetaChip>}
              <code className="v-doc__file">
                {card.commit.since === null ? '(no parent)' : card.commit.since.slice(0, 7)}..
                {card.commit.sha.slice(0, 7)}
              </code>
              {/* What the loop measured of the tree during that round, in
                  `src/work.ts`'s own words. Absent when no reading arrived. */}
              {card.work !== null && <MetaChip>{describeWork(card.work)}</MetaChip>}
            </>
          }
        >
          {card.commit.since === null ? (
            // The greenfield case: a first commit in a repository that had none
            // has no left-hand end, so there is no range to ask for. Named with
            // its reason rather than answered with the whole history, which
            // would be a different diff wearing this round's label.
            <p className="v-doc__note">
              This is the first commit in the repository, so there is no earlier state to compare
              it against. <strong>Everything since the base</strong> above is the whole of it.
            </p>
          ) : (
            <DiffPane dir={dir} baseSha={card.commit.since} headSha={card.commit.sha} />
          )}
        </Section>
      ))}
    </div>
  );
}
