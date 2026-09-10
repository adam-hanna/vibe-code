import { useCallback, useEffect, useState } from 'react';
import { LivenessDot } from '../design';
import * as host from '../host';
import { rail } from './squares';
import type { ArchiveRun } from '../host';

/**
 * The left rail (hi-fi 1 and hi-fi 5, and every frame that shows the window).
 *
 * A collapsed vertical strip on the far left: one square per workstream with a
 * liveness dot on the running one, and three controls pinned at its foot — `＋`
 * for a new one, `⌘K` for the switcher, `⚙` for settings. It was the single
 * largest structural divergence in `design/AUDIT.md`: the app had no rail at all,
 * and everything it carries had been pushed into the tab bar, which is why that
 * bar had twelve tabs where the design has seven.
 *
 * ## A square navigates; it does not reopen
 *
 * This is the one place the built rail is narrower than the drawn one, and it is
 * deliberate. `serve.ts` runs **one run at a time**, so there is never a second
 * live workstream to switch *to* — the design's rail is a switcher between
 * running things and there is only ever one. What is left is navigation, and a
 * square that silently reopened a run would be a second definition of what
 * reopening costs: `1b` states the lock's verdict, and forcing one back off a
 * dead holder confirms first and says what it is overruling. That decision has
 * one home and this is not it.
 *
 * So a square takes you to `1b` with the archive in front of you. The dot, the
 * selection and the ordering are the design's; the action is the honest one for a
 * host that drives a single run.
 *
 * ## It reads the archive and classifies nothing
 *
 * `listRuns` decides what an archive entry *is*. Entries it refused — a symlink
 * (#53), something `lstat` could not classify — are filtered out in `rail.ts`
 * rather than drawn as squares, because a square is an invitation to open
 * something and those are exactly the entries nothing should open.
 */
export function Rail({
  dir,
  currentId,
  onNew,
  onSwitch,
  onSettings,
  onRuns,
}: {
  dir: string;
  /** The run this window is showing, so its square reads as selected. */
  currentId: string | null;
  onNew: () => void;
  onSwitch: () => void;
  onSettings: () => void;
  onRuns: () => void;
}) {
  const [runs, setRuns] = useState<readonly ArchiveRun[]>([]);
  /** Why there are no squares, when the reason is not "there are none". */
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(() => {
    if (dir.trim() === '' || !host.inShell()) return;
    void host
      .archive(dir)
      .then((next) => {
        setRuns(next);
        setFailure(null);
      })
      // Kept rather than blanked: an empty rail and an unreadable one are
      // different facts, and the second one is the one worth saying.
      .catch((err: unknown) => {
        setRuns([]);
        setFailure(err instanceof Error ? err.message : String(err));
      });
  }, [dir]);

  // Re-read when the repository changes and when this window starts or picks up
  // a run — those are the two moments the archive is known to have changed. It
  // is deliberately not polled: nothing else writes to it while this window is
  // the one running, and a timer would be a request per interval for a strip
  // that changes a few times an hour.
  useEffect(load, [load, currentId]);

  const squares = rail(runs, currentId);

  return (
    <nav className="v-rail" aria-label="workstreams">
      <button className="v-rail__all" onClick={onRuns} title="every run in this repository">
        RUNS
      </button>

      <div className="v-rail__list">
        {squares.map((r) => (
          <button
            key={r.id}
            className={`v-rail__square${r.current ? ' v-rail__square--on' : ''}`}
            onClick={onRuns}
            title={`${r.task} — ${r.status}`}
            aria-current={r.current ? 'true' : undefined}
          >
            <span className="v-rail__mark">{r.mark}</span>
            {/* `4e`: the needs-you signal lives on the rail. Only the archive's
                own verdict puts it there — a dot this component decided would
                be a second classifier. */}
            {r.live && (
              <span className="v-rail__dot">
                <LivenessDot state="live" />
              </span>
            )}
          </button>
        ))}
        {squares.length === 0 && failure === null && (
          <span className="v-rail__none" title="no runs in this repository yet">
            ··
          </span>
        )}
        {failure !== null && (
          <span className="v-rail__none" title={`the archive could not be read: ${failure}`}>
            !
          </span>
        )}
      </div>

      <div className="v-rail__foot">
        <button className="v-rail__control" onClick={onNew} title="new workstream" aria-label="new workstream">
          ＋
        </button>
        <button className="v-rail__control" onClick={onSwitch} title="switch run (Ctrl+K)" aria-label="switch run">
          ⌘K
        </button>
        <button className="v-rail__control" onClick={onSettings} title="project settings" aria-label="project settings">
          ⚙
        </button>
      </div>
    </nav>
  );
}
