import { useCallback, useEffect, useState } from 'react';
import * as host from '../host';
import type { ArtifactEntry, ArtifactRead } from '../host';

/**
 * Asking the host what a run wrote, and for one of them (#223).
 *
 * Two hooks rather than one call each in four panes, because the same three
 * failures have to be handled the same way in all of them and *"the host did not
 * answer"*, *"this window has no host"* and *"the file is not there"* are three
 * different sentences a person can act on differently.
 *
 * **Nothing here is logic about a run.** `model.ts` is the only file in the app
 * with any, and it stays that way: this is a fetch and a cache. What the bytes
 * mean is `artifacts.ts`, which is pure and tested.
 */

export interface Listing {
  entries: readonly ArtifactEntry[];
  /** Why there is no listing, or null. Never conflated with an empty one. */
  failure: string | null;
  /** True until the first answer, so a pane can say *reading* rather than *none*. */
  loading: boolean;
  reload: () => void;
}

/**
 * A run's directory listing, re-read when the run changes.
 *
 * `revision` is how a live run reaches a pane that is already open. Before it,
 * every one of these panes was a snapshot taken when the tab was mounted — a
 * critique round finishing while you watched the critique tab changed nothing on
 * screen, and the only way to see it was to navigate away and back. It is a
 * count of what the run *said* it wrote, so a re-read happens because a file
 * appeared and never on a timer.
 */
export function useArtifacts(dir: string, runId: string | null, revision = 0): Listing {
  const [entries, setEntries] = useState<readonly ArtifactEntry[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // A counter rather than calling the loader directly, so `reload` can be handed
  // to a button without the effect's cleanup racing a request already in flight.
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (runId === null || dir.trim() === '') {
      setEntries([]);
      setFailure(null);
      setLoading(false);
      return;
    }
    if (!host.inShell()) {
      setEntries([]);
      setFailure('a run’s artifacts are read by the host, and there is no host in a browser');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void host
      .artifacts(dir, runId)
      .then((got) => {
        if (cancelled) return;
        setEntries(got);
        setFailure(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Cleared, not kept. A listing from the previous run drawn under a
        // failure message would be a pane showing one run's artifacts while
        // saying it could not read another's.
        setEntries([]);
        setFailure(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dir, runId, attempt, revision]);

  return { entries, failure, loading, reload };
}

/**
 * What is in one artifact, or why there is nothing.
 *
 * `null` while nothing has been asked for — which is the shut state of every
 * section in these panes, and the reason a pane holding thirty rounds costs one
 * read rather than thirty: **an artifact is fetched when its section opens**.
 *
 * The three-answer `ArtifactRead` comes through whole. A caller has to be able
 * to tell *this was never written* from *vibe refused to look inside it*, and a
 * hook that reduced both to an empty string would decide that for it.
 */
export interface Loaded {
  read: ArtifactRead | null;
  failure: string | null;
  loading: boolean;
}

export function useArtifact(
  dir: string,
  runId: string | null,
  name: string | null,
  /**
   * Re-read on, for the reason `useArtifacts` takes one — and here it is the
   * *rewrite* that matters. A plan round that answers its own questions replaces
   * `plan-<n>.json` under the name it already had, so a section that fetched
   * once would go on showing the draft that raised the questions.
   */
  revision = 0,
): Loaded {
  const [read, setRead] = useState<ArtifactRead | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (runId === null || name === null || dir.trim() === '') {
      setRead(null);
      setFailure(null);
      setLoading(false);
      return;
    }
    if (!host.inShell()) {
      setRead(null);
      setFailure('a run’s artifacts are read by the host, and there is no host in a browser');
      return;
    }
    let cancelled = false;
    setLoading(true);
    void host
      .artifact(dir, runId, name)
      .then((got) => {
        if (cancelled) return;
        setRead(got);
        setFailure(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setRead(null);
        setFailure(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dir, runId, name, revision]);

  return { read, failure, loading };
}

/**
 * The sentence for a read that produced no text.
 *
 * One place, because the three answers are easy to collapse by accident and the
 * collapse is the bug #129 is about: a reader told a file was unreadable, when
 * vibe never opened it, will go looking for a corrupted file that is fine.
 */
export function noText(read: ArtifactRead | null, failure: string | null): string | null {
  if (failure !== null) return failure;
  if (read === null) return null;
  if (read.kind === 'text') return null;
  if (read.kind === 'linked') return read.reason;
  return 'This file is not in the run’s directory. Nothing was read.';
}
