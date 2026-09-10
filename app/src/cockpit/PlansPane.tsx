import { useEffect, useRef, useState } from 'react';
import { MetaChip, StateKicker } from '../design';
import { Section } from './Disclosure';
import { ofKind, planText } from './artifacts';
import { useArtifact, useArtifacts, noText } from './useArtifacts';
import type { Classified } from './artifacts';

/**
 * Every version of the plan, one section per round (hi-fi 3, #223).
 *
 * **The screen the tab bar has been admitting it could not build.** `Versions`
 * sat in the bar dashed out, with *"this window cannot read a run's artifacts"*
 * on its tooltip, because that was true: nothing in the app had a filesystem.
 * The plan is the run's central artifact — it is what the critic judges, what the
 * implementer builds and what a person is deciding to approve — and it was the
 * one thing you could not read without leaving the window.
 *
 * ## A round is a section, and the round numbers are the file's own
 *
 * `plan-0.json` is the planner's first draft and `plan-critique-0.json` beside it
 * is the critique of exactly that draft. The numbering here is that numbering,
 * read off the filenames the listing returned rather than composed from the
 * loop column's rounds — so a section and the file behind it cannot disagree.
 *
 * `PLAN.md` is last and has no round, which is not a gap: it is written once,
 * after the plan is approved, and it is the version everything downstream builds
 * from. It says so instead of being numbered.
 *
 * ## Nothing is fetched until a section opens
 *
 * A long run holds a dozen plan versions and each is a full document. The
 * listing costs one read; a body costs one more, when somebody asks for it.
 */

/** The newest section, which is the one a reader almost always wants. */
function newest(plans: readonly Classified[]): string | null {
  const last = plans[plans.length - 1];
  return last?.name ?? null;
}

function PlanBody({
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
    return <p className="v-doc__note">reading {name}…</p>;
  }
  if (missing !== null) {
    return (
      <p className="v-doc__note">
        <StateKicker tone="quiet">no text</StateKicker> {missing}
      </p>
    );
  }
  if (read === null || read.kind !== 'text') return null;

  const body = planText(name, read.text);
  // `<pre>`, not a markdown renderer. The plan IS markdown and rendering it
  // would mean shipping a parser to make prose prettier - and the thing a person
  // reads a plan version for is what it says, in the exact words the critic was
  // shown. A heading that lost its `##` is a heading somebody has to guess at.
  return (
    <>
      <pre className="v-doc__text">{body}</pre>
      {body.trim() === '' && (
        <p className="v-doc__note">
          This file is empty. That is what is on disk, not a failure to read it.
        </p>
      )}
    </>
  );
}

export function PlansPane({
  dir,
  runId,
  openAt,
  revision = 0,
}: {
  dir: string;
  runId: string | null;
  /**
   * How many artifacts the run has said it wrote (#223).
   *
   * What makes an open pane live. Everything here is read from disk, and the
   * only thing that knows the disk changed is the run.
   */
  revision?: number;
  /**
   * A round to open, sent by whatever navigated here (#223).
   *
   * A round number rather than a filename: both sides of that link know the
   * round - the card carries it and the file is named by it - and a filename
   * would put the loop's naming convention in a third place.
   */
  openAt?: number | null;
}) {
  const { entries, failure, loading, reload } = useArtifacts(dir, runId, revision);
  const plans = ofKind(entries, 'plan');
  const [open, setOpen] = useState<string | null>(null);
  /**
   * Whether the reader has opened or shut anything themselves.
   *
   * **The pane follows the run until you touch it, and then it stops.** A live
   * run writes a new plan version every round, and a pane that always jumped to
   * the newest would move the document out from under somebody reading round 0.
   * A pane that never moved would be the stale one this revision exists to fix.
   * A navigation from another surface still wins: that is somebody asking for a
   * particular round, which is the same act as clicking a section here.
   */
  const touched = useRef(false);

  // The newest version, or the one somebody navigated to. Re-run when the
  // listing or the request changes, and deliberately not a `useState`
  // initialiser: the listing arrives after the first render, so an initialiser
  // would settle on `null` and stay there.
  useEffect(() => {
    if (plans.length === 0) return;
    const wanted =
      openAt === null || openAt === undefined
        ? null
        : (plans.find((p) => p.round === openAt)?.name ?? null);
    if (wanted === null && touched.current) return;
    setOpen(wanted ?? newest(plans));
    // `plans` is rebuilt on every render, so the effect keys on what it is made
    // of. `entries` is the fetched array and is stable between reads.
  }, [entries, openAt]);

  if (runId === null) {
    return (
      <div className="v-doc v-doc--empty">
        <StateKicker tone="quiet">no run</StateKicker>
        <p>
          Plans are read out of a run’s own directory, so there has to be a run. Start one and its
          first plan lands here as soon as the planner’s turn ends.
        </p>
      </div>
    );
  }

  if (failure !== null) {
    return (
      <div className="v-doc v-doc--empty">
        <StateKicker tone="alarm">no plans</StateKicker>
        <p>{failure}</p>
        <button className="v-doc__again" onClick={reload}>
          try again
        </button>
      </div>
    );
  }

  if (plans.length === 0) {
    return (
      <div className="v-doc v-doc--empty">
        <StateKicker tone="quiet">{loading ? 'reading' : 'no plans yet'}</StateKicker>
        <p>
          {loading
            ? 'asking the host what this run has written…'
            : 'The planner writes plan-0.json when its first turn ends, and PLAN.md once the plan is approved. Neither is there yet.'}
        </p>
      </div>
    );
  }

  return (
    <div className="v-doc">
      <div className="v-doc__head">
        <span>
          {plans.length} version{plans.length === 1 ? '' : 's'} of the plan
        </span>
        <button className="v-doc__again" onClick={reload}>
          reread
        </button>
      </div>
      {plans.map((plan) => (
        <Section
          key={plan.name}
          id={plan.round === null ? undefined : `plan-round-${String(plan.round)}`}
          // Only the section a navigation named. A pane that scrolled to its own
          // default would yank the view every time somebody opened the tab.
          reveal={openAt !== null && openAt !== undefined && plan.round === openAt}
          open={open === plan.name}
          onToggle={() => {
            touched.current = true;
            setOpen((cur) => (cur === plan.name ? null : plan.name));
          }}
          title={
            plan.round === null ? 'the approved plan' : `plan · round ${String(plan.round)}`
          }
          meta={
            <>
              <code className="v-doc__file">{plan.name}</code>
              {/* Absent rather than `0 B` when the listing carried no size,
                  which is every entry that is not a plain file. */}
              {plan.bytes !== null && <MetaChip>{sizeOf(plan.bytes)}</MetaChip>}
            </>
          }
        >
          {/* Mounted only while open, which is what makes the fetch lazy: the
              body's hook does not exist until the section does. */}
          <PlanBody dir={dir} runId={runId} name={plan.name} revision={revision} />
        </Section>
      ))}
    </div>
  );
}

/**
 * A byte count, in the units a person reads.
 *
 * Measured, not estimated: this is the size the listing reported, and the only
 * judgement is where to put the decimal point.
 */
export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
