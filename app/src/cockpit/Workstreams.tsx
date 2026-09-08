import { useCallback, useEffect, useState } from 'react';
import { MetaChip, StateKicker, Table } from '../design';
import * as host from '../host';
import type { ArchiveRun } from '../host';

/**
 * Every run this repository holds (`1b`, #223).
 *
 * The screen addresses the stated pain directly: *"I don't have visibility into
 * my past workstreams and can't easily switch to them or start new ones."* It is
 * **triage after a night of unattended work** — a reading task, with sorting and
 * history, which is why the design resolved to build both this and the ⌘K
 * switcher rather than treating them as alternatives. A palette is bad at
 * reading.
 *
 * ## It shows what `vibe list` shows, and it does not classify anything itself
 *
 * `listRuns` is the one thing that decides what an archive entry *is*: a real
 * directory, a symlink it refused to follow (#53), something `lstat` could not
 * classify. This draws its answer. A second classifier on this side would
 * eventually disagree with `vibe list` about which runs exist, and the one that
 * disagreed would be the one on screen.
 *
 * ## What is drawn as absent
 *
 * The design's **rounds fingerprint** (`p2 v1 r2` — rounds spent in each cycle,
 * cheap to scan for runs that thrashed) is the column it most wants, and
 * `RunSummary` does not carry it. It is derivable from a run's `state.json`, and
 * reading one per row is a different request from this one; #114's archive
 * reader is where it belongs. The column is named and empty rather than dropped,
 * because a table that showed only what it had would read as the whole story.
 *
 * A cost of `null` is drawn as unknown and never as `$0.00`, which would assert
 * that an unreadable run cost nothing.
 */

/**
 * `done`, `needs-input`, `planned` — passed through verbatim, as the core does.
 *
 * The two refusals are drawn from their own fields rather than from `status`,
 * and that is the core's own distinction: `status` is read off disk and shown
 * verbatim, so a stored `"status": "linked"` would be a display coincidence
 * rather than a fact about the filesystem. Anything that must **act** on the
 * difference reads the field.
 */
function statusChip(run: ArchiveRun) {
  if (run.linked === true) {
    return <MetaChip kind="alarm">not followed — a link</MetaChip>;
  }
  if (run.unverified === true) {
    // The fail-closed half, and a different sentence on purpose. This one is not
    // "it is a link" — it is "we could not find out", which is why it is refused
    // rather than opened.
    return <MetaChip kind="alarm">could not be classified</MetaChip>;
  }
  return <MetaChip>{run.status}</MetaChip>;
}

/** Whether a row can be reopened at all. */
function openable(run: ArchiveRun): boolean {
  return run.linked !== true && run.unverified !== true && run.status !== 'unreadable';
}

export function Workstreams({ dir, onResume }: { dir: string; onResume: (runId: string) => void }) {
  const [runs, setRuns] = useState<readonly ArchiveRun[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!host.inShell()) {
      setFailure('the archive is read by the host, and there is no host in a browser');
      return;
    }
    setFailure(null);
    void host
      .archive(dir)
      .then(setRuns)
      .catch((err: unknown) => {
        // Never silently empty. An archive that could not be read and an archive
        // with nothing in it are opposite facts, and the second is the one a new
        // user sees.
        setRuns(null);
        setFailure(err instanceof Error ? err.message : String(err));
      });
  }, [dir]);

  useEffect(load, [load]);

  if (failure !== null) {
    return (
      <div className="v-ws v-ws--empty">
        <StateKicker tone="alarm">no archive</StateKicker>
        <p>{failure}</p>
        <button className="v-ws__again" onClick={load}>
          try again
        </button>
      </div>
    );
  }

  if (runs === null) {
    return (
      <div className="v-ws v-ws--empty">
        <StateKicker tone="quiet">reading</StateKicker>
        <p>asking the host what this repository holds…</p>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="v-ws v-ws--empty">
        <StateKicker tone="quiet">no runs yet</StateKicker>
        <p>
          Nothing has run in <code>{dir}</code>. A run leaves its record in{' '}
          <code>.vibe/runs/</code>, and this reads that.
        </p>
      </div>
    );
  }

  return (
    <div className="v-ws">
      <div className="v-ws__head">
        <span>
          {runs.length} run{runs.length === 1 ? '' : 's'} in <code>{dir}</code>
        </span>
        <button className="v-ws__again" onClick={load}>
          reread
        </button>
      </div>

      <Table
        columns={['run', 'status', 'task', 'cost', 'fingerprint', '']}
        rows={runs.map((run) => ({
          key: run.id,
          cells: [
            <code key="id">{run.id}</code>,
            statusChip(run),
            <span key="task" className="v-ws__task">
              {run.task}
            </span>,
            run.costUsd === null ? (
              // Absent with its reason, never zero.
              <span key="cost" className="v-ws__absent">
                unknown
              </span>
            ) : (
              <span key="cost">~${run.costUsd.toFixed(2)}</span>
            ),
            // The design's most-wanted column, named and empty. Deriving it
            // needs a read of each run's state.json, which is #114's request
            // rather than this one.
            <span key="fp" className="v-ws__absent" title="#114">
              not read
            </span>,
            !openable(run) ? (
              <span key="act" className="v-ws__absent">
                —
              </span>
            ) : (
              <button key="act" className="v-ws__again" onClick={() => onResume(run.id)}>
                reopen
              </button>
            ),
          ],
        }))}
      />

      <p className="v-ws__absent">
        The rounds fingerprint — <code>p2 v1 r2</code>, cheap to scan for runs that thrashed — is
        the column this table most wants and it needs a read of each run&apos;s state (#114).
        Cost is Claude-side only, as everywhere.
      </p>
    </div>
  );
}
