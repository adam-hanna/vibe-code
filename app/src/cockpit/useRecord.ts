import { useEffect, useState } from 'react';
import * as host from '../host';
import type { RecordFrame } from '../host';

/**
 * Asking the host for an opened run's own record (#223).
 *
 * **The column's half of opening a run.** `useArtifacts` is the same shape for
 * the same reason and this is deliberately built beside it rather than folded
 * into it: a listing and a record are two reads answering two questions, and a
 * hook that fetched both would make every pane that wants one pay for the other.
 *
 * **Nothing here is logic about a run.** `model.ts` is the only file in the app
 * with any. This is a fetch, and what it fetches was shaped by the core.
 *
 * `revision` is how a run being resumed in this window reaches a record that is
 * already on screen: it counts what the run *said* it wrote, so a re-read
 * happens because something landed on disk and never on a timer.
 */
export interface Record {
  record: RecordFrame['record'] | null;
  /** Why there is no record, or null. Never conflated with a run that did little. */
  failure: string | null;
  /** True until the first answer, so the column can say *reading* rather than *none*. */
  loading: boolean;
}

export function useRecord(dir: string, runId: string | null, revision = 0): Record {
  const [record, setRecord] = useState<RecordFrame['record'] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (runId === null || dir.trim() === '') {
      setRecord(null);
      setFailure(null);
      setLoading(false);
      return;
    }
    if (!host.inShell()) {
      setRecord(null);
      setFailure('a run’s record is read by the host, and there is no host in a browser');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void host
      .record(dir, runId)
      .then((got) => {
        if (cancelled) return;
        setRecord(got);
        setFailure(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Cleared, not kept, for `useArtifacts`' reason: a record from the
        // previous run drawn under a failure message would be a column showing
        // one run while saying it could not read another.
        setRecord(null);
        setFailure(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dir, runId, revision]);

  return { record, failure, loading };
}
