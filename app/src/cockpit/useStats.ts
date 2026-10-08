import { useEffect, useState } from 'react';
import * as host from '../host';
import type { ArchiveStats } from '../host';

/**
 * The archive's scorecard for the repository on screen (#114).
 *
 * Asked for when the window points at a project and again whenever `epoch`
 * moves - `statsEpoch` in `model.ts`, which moves when a run ends - so the
 * comparable-turns line never quotes an archive missing the run that just
 * finished. **No timer**: the archive only changes when a run ends, so polling
 * would re-read every state.json to learn nothing.
 *
 * A fetch and a cache, like `useArtifacts`: what the numbers mean is decided in
 * `model.ts`, which is pure and tested.
 */
export function useStats(dir: string, epoch: string): { scorecard: ArchiveStats | null; failure: string | null } {
  const [scorecard, setScorecard] = useState<ArchiveStats | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (dir.trim() === '' || !host.inShell()) {
      setScorecard(null);
      setFailure(null);
      return;
    }
    let cancelled = false;
    void host
      .stats(dir)
      .then((got) => {
        if (cancelled) return;
        setScorecard(got);
        setFailure(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Cleared rather than kept: another repository's distributions under
        // this one's turn would be a comparison with the wrong archive.
        setScorecard(null);
        setFailure(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [dir, epoch]);

  return { scorecard, failure };
}
