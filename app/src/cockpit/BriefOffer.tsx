import { Button } from '@/ui/button';

/**
 * The way into a run from the loop column: a sentence and `Customize this run`.
 *
 * **Two moments, two sentences** (#410). With no run on screen the column is four
 * not-started groups, and *waiting for the brief* is true of it - that is the
 * wording `HANDOFF.md` gives the empty column. Once a run has ended the same
 * offer is made again, because `serve.ts` takes a second invoke as soon as the
 * first settles (#304). It used to be made in the empty column's words, at the
 * top, above the run that had just finished, so a completed run read as one that
 * had not started - two inches from a rail correctly saying *Run complete*.
 *
 * So `after` changes the words, and the caller puts the after-a-run offer after
 * that run: the run you just watched is what the column is about, and the next
 * one comes second.
 */
export function BriefOffer({
  after,
  onCustomize,
  disabled,
}: {
  /** A run is on screen and has ended, so this offers the next one. */
  after: boolean;
  onCustomize: () => void;
  disabled: boolean;
}) {
  return (
    <>
      <div className="mx-4 mb-2 rounded-md border border-rule-card bg-card px-4 py-3.5">
        <span className="text-body-sm font-medium text-primary">
          {after ? 'Next run' : 'waiting for the brief'}
        </span>
        <p className="mt-1.5 mb-0 text-body-sm leading-relaxed text-secondary">
          {after
            ? 'This run has ended. Describe the next piece of work to your pilot, then approve its proposal to begin.'
            : 'Describe the work to your pilot. Review the brief, then approve its proposal to begin.'}
        </p>
      </div>
      {/* `4a`, for the one moment somebody is deciding how THIS run should
          differ from the project's defaults. */}
      <Button
        variant="secondary"
        size="sm"
        className="mx-4 mb-3 self-start"
        onClick={onCustomize}
        disabled={disabled}
      >
        Customize this run
      </Button>
    </>
  );
}
