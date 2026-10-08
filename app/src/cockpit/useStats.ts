import { useEffect, useState } from 'react';
import * as host from '../host';
import { archiveView } from './model';
import type { ArchiveView, HeldStats } from './model';

/**
 * The archive's scorecard for the repository on screen (#114).
 *
 * Asked for when the window points at a project and again whenever `epoch`
 * moves - `statsEpoch` in `model.ts`, which moves when a run ends - so the
 * comparable-turns line never quotes an archive missing the run that just
 * finished. **No timer**: the archive only changes when a run ends, so polling
 * would re-read every state.json to learn nothing.
 *
 * **An answer is only drawn for the request that asked it.** Each result is
 * held with the `dir` and `epoch` it was read for, and `archiveView` returns it
 * only while those are still current - so until the new answer arrives the line
 * says *not read yet* rather than quoting another repository's archive. Checked
 * at render rather than cleared in the effect, because an effect runs after the
 * render that would already have drawn the stale figure. A failed read keeps
 * the host's sentence, so the line can say why there is no figure.
 *
 * A fetch and a cache, like `useArtifacts`: the rule is `archiveView`, which is
 * pure and tested.
 */
export function useStats(dir: string, epoch: string): ArchiveView {
  const [held, setHeld] = useState<HeldStats | null>(null);

  useEffect(() => {
    if (dir.trim() === '' || !host.inShell()) return;
    let cancelled = false;
    void host
      .stats(dir)
      .then((scorecard) => {
        if (!cancelled) setHeld({ dir, epoch, scorecard, failure: null });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setHeld({ dir, epoch, scorecard: null, failure: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dir, epoch]);

  return archiveView(held, dir, epoch);
}
