import { useEffect, useMemo, useRef, useState } from 'react';
import { MetaChip } from '../design';
import * as host from '../host';
import type { ArchiveRun } from '../host';

/**
 * ⌘K (`5f`, #223).
 *
 * **A switcher, not a screen.** It answers *"take me to
 * `fix-ratelimit-wait`"* and nothing else. The design resolved this explicitly:
 * ⌘K and `1b` are two different features rather than alternatives, because
 * triage after a night of unattended work is a reading task with sorting and
 * history, and a palette is bad at it. So this has no columns, no sort and no
 * cost — one line per run and a filter.
 *
 * It reads the archive once, when it opens. That is the honest cadence for a
 * thing that is on screen for two seconds, and it means the list cannot be stale
 * in a way that matters: a run that finished while the palette was open is one
 * keystroke from being right again.
 */

/** Runs that cannot be opened are not offered, and are not hidden either. */
function openable(run: ArchiveRun): boolean {
  return run.linked !== true && run.unverified !== true && run.status !== 'unreadable';
}

export function Switcher({
  dir,
  onPick,
  onClose,
}: {
  dir: string;
  onPick: (runId: string) => void;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<readonly ArchiveRun[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    if (!host.inShell()) {
      setFailure('there is no host in a browser, so there is no archive to read');
      return;
    }
    void host
      .archive(dir)
      .then(setRuns)
      .catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)));
  }, [dir]);

  const shown = useMemo(() => {
    const all = runs ?? [];
    const needle = q.trim().toLowerCase();
    // Substring on the id and the task, and nothing cleverer. A fuzzy matcher
    // that reordered results would make the same keystrokes select a different
    // run on a different day, which is the one thing a switcher must not do.
    const matched =
      needle === ''
        ? all
        : all.filter(
            (r) =>
              r.id.toLowerCase().includes(needle) || r.task.toLowerCase().includes(needle),
          );
    // Runs needing a human first, which is `4e`'s rail rule: the tray badge and
    // the sort both count only things needing somebody.
    return [...matched].sort((a, b) => {
      const wants = (r: ArchiveRun): number => (r.status === 'needs-input' ? 0 : 1);
      return wants(a) - wants(b);
    });
  }, [runs, q]);

  useEffect(() => setCursor(0), [q]);

  const pick = (run: ArchiveRun | undefined): void => {
    if (run === undefined || !openable(run)) return;
    onPick(run.id);
    onClose();
  };

  return (
    <div
      className="v-switch__scrim"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setCursor((c) => Math.min(c + 1, shown.length - 1));
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setCursor((c) => Math.max(c - 1, 0));
        }
        if (e.key === 'Enter') pick(shown[cursor]);
      }}
    >
      <div className="v-switch" role="dialog" aria-modal="true" aria-label="switch run">
        <input
          ref={input}
          className="v-switch__q"
          placeholder="go to a run…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />

        {failure !== null && <p className="v-switch__note">{failure}</p>}
        {failure === null && runs === null && <p className="v-switch__note">reading the archive…</p>}
        {runs !== null && shown.length === 0 && (
          <p className="v-switch__note">
            {runs.length === 0 ? 'no runs in this repository yet' : `nothing matches “${q}”`}
          </p>
        )}

        <ul className="v-switch__list">
          {shown.map((run, i) => (
            <li key={run.id}>
              <button
                className={`v-switch__row ${i === cursor ? 'is-on' : ''}`}
                onClick={() => pick(run)}
                onMouseEnter={() => setCursor(i)}
                disabled={!openable(run)}
              >
                <code className="v-switch__id">{run.id}</code>
                <span className="v-switch__task">{run.task}</span>
                {/* One collapsed verdict chip, never four. The design's density
                    rule: four chips wherever a gate decision is being made, one
                    everywhere it is a status — and here it is a status. */}
                {run.linked === true ? (
                  <MetaChip kind="alarm">a link</MetaChip>
                ) : run.unverified === true ? (
                  <MetaChip kind="alarm">unclassified</MetaChip>
                ) : (
                  <MetaChip>{run.status}</MetaChip>
                )}
              </button>
            </li>
          ))}
        </ul>

        <div className="v-switch__foot">
          <span>↑↓ to move · ⏎ to open · esc to close</span>
        </div>
      </div>
    </div>
  );
}
