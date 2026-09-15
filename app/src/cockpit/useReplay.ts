import { useEffect, useState } from 'react';
import * as host from '../host';
import { emptyRun, reduce } from './model';
import type { Run } from './model';

/**
 * Asking the host for a finished run, and folding it into the one it was (#223).
 *
 * **The whole of this hook's job is to add no logic.** The steps it fetches are
 * narration, and they go through the **same** `reduce` a live run's frames go
 * through — so the column, the round cards and the log are the same components
 * rendering the same `Run`, and *"the right panel looks just as it would have if
 * I had run it myself"* is true by construction rather than by resemblance.
 *
 * That is the correction to the first attempt, which built a *summary*: a second
 * shape, drawn by a second component, that could drift from the live one on any
 * change to either. There is no second builder here.
 *
 * Each step carries its own `at`, and that is what is passed to `reduce` rather
 * than the arrival clock. A replay stamped with `Date.now()` would date a
 * week-old run to this afternoon and give every turn a duration of nothing.
 */
export interface Replayed {
  /** The run as it happened, or null before the first answer. */
  run: Run | null;
  /** Why there is no run, or null. Never conflated with a run that did little. */
  failure: string | null;
  /** True until the first answer, so the column can say *reading* rather than *none*. */
  loading: boolean;
}

export function useReplay(dir: string, runId: string | null, revision = 0): Replayed {
  const [run, setRun] = useState<Run | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (runId === null || dir.trim() === '') {
      setRun(null);
      setFailure(null);
      setLoading(false);
      return;
    }
    if (!host.inShell()) {
      setRun(null);
      setFailure('a finished run is read by the host, and there is no host in a browser');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void host
      .replay(dir, runId)
      .then((got) => {
        if (cancelled) return;
        let built = emptyRun();
        for (const step of got.steps) {
          built = reduce(built, { type: 'narration', ...step.narration }, step.at);
        }
        // The ending, applied as the frame it is. A `result` closes whatever
        // turn was open and sets `completed`, which is what makes the footer
        // draw this run's ending rather than nothing — and it is why nothing is
        // left running when the fold finishes.
        if (got.exit !== null) {
          const last = got.steps[got.steps.length - 1]?.at ?? Date.now();
          built = reduce(built, { type: 'result', id: 0, exit: got.exit }, last);
        }
        setRun(built);
        setFailure(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Cleared, not kept, for `useArtifacts`' reason: a run from the previous
        // selection drawn under a failure message would be a column showing one
        // run while saying it could not read another.
        setRun(null);
        setFailure(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dir, runId, revision]);

  return { run, failure, loading };
}
