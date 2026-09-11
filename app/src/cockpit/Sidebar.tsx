import { useCallback, useEffect, useState } from 'react';
import { LivenessDot, StateKicker } from '../design';
import * as host from '../host';
import { rail } from './squares';
import {
  PINNED_KEY,
  PROJECTS_KEY,
  addProject,
  isPinned,
  projectName,
  readPins,
  readProjects,
  togglePin,
  visible,
} from './projects';
import type { Pin } from './projects';
import type { RailRun } from './squares';
import type { ArchiveRun } from '../host';

/**
 * The navigator: projects, their runs, and the ones you pinned (#223).
 *
 * **This replaces the rail and the runs panel, which were the same thing twice.**
 * The rail was a 54px strip with `RUNS` at the top and a square per run; beside
 * it sat a panel headed `Runs` listing the same archive. Reported immediately —
 * *"there are two Runs bars on the left now"* — and it was not a rendering
 * accident: two surfaces had been given one job, once by hi-fi 1 and once by the
 * column move, and nothing reconciled them.
 *
 * So there is one sidebar, and the rail becomes its **collapsed state**: the
 * three controls `＋ ⌘K ⚙` that `design/AUDIT.md` §1.1 says must have a home are
 * still always on screen, as a strip, which is what they were. Nothing the rail
 * carried is lost and the duplicate is gone.
 *
 * ## A project is a repository, a session is a run
 *
 * The shape is borrowed deliberately: actions, then **Pinned**, then **Projects**
 * with their sessions nested and a `Show more` where the list is long. What it is
 * *not* is a second definition of anything the core owns — `archive` answers per
 * directory, `listRuns` decides what a run is, and `rail()` decides which entries
 * may be drawn at all. The window's contribution is which directories you have
 * open and which runs you pinned, neither of which is a fact about any run.
 *
 * ## An archive is read when a project opens, not on a timer
 *
 * One read per project, when its section is first expanded, and again when the
 * run in the window changes — the two moments the archive is known to differ.
 * The same rule the artifact panes follow, for the same reason: nothing else
 * writes to these directories while this window is the one running.
 *
 * ## A row navigates and resumes; it never forces
 *
 * `Rail.tsx` made this its one deliberate narrowing and it survives the rewrite
 * intact. A run whose lock is held by a live process is drawn with the dot and
 * cannot be clicked into, and a run needing `--force` is not force-resumed from
 * here — `all runs` opens `1b`, which states the lock's verdict and confirms.
 * Two places that can overrule a lock is one too many.
 */

/** One project's archive, fetched when it opens. */
interface Loaded {
  runs: readonly RailRun[];
  failure: string | null;
  loading: boolean;
}

function useArchive(dir: string, open: boolean, currentId: string | null): Loaded {
  const [runs, setRuns] = useState<readonly ArchiveRun[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || dir.trim() === '' || !host.inShell()) return;
    let cancelled = false;
    setLoading(true);
    void host
      .archive(dir)
      .then((next) => {
        if (cancelled) return;
        setRuns(next);
        setFailure(null);
      })
      // Kept apart from empty. An archive that could not be read and one with
      // nothing in it need different sentences, and only one of them is a
      // problem.
      .catch((err: unknown) => {
        if (cancelled) return;
        setRuns([]);
        setFailure(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dir, open, currentId]);

  return { runs: rail(runs, currentId), failure, loading };
}

/**
 * The pin control, on every row that has one.
 *
 * `PinButton` rather than `Pin`, which is the type this file already imports —
 * a component and a type of one name is a duplicate identifier, and the two
 * would be arguing about which one a reader meant even if it compiled.
 */
function PinButton({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      className={`v-nav__pin${on ? ' v-nav__pin--on' : ''}`}
      onClick={(e) => {
        // The row underneath resumes a run. A pin is a note to yourself about
        // one, and must never be the click that spends tokens.
        e.stopPropagation();
        onToggle();
      }}
      title={on ? 'Unpin' : 'Pin'}
      aria-pressed={on}
    >
      ◆
    </button>
  );
}

function RunRow({
  title,
  live,
  current,
  pinned,
  onOpen,
  onPin,
}: {
  title: string;
  live: boolean;
  current: boolean;
  pinned: boolean;
  /** Null when there is nowhere to go — a run already running is one. */
  onOpen: (() => void) | null;
  onPin: () => void;
}) {
  return (
    <div className={`v-nav__row${current ? ' v-nav__row--on' : ''}`}>
      <button
        className="v-nav__open"
        onClick={onOpen ?? undefined}
        disabled={onOpen === null}
        title={onOpen === null ? `${title} — already running` : title}
      >
        {/* The archive's verdict, never one derived here. A run this window is
            showing gets the dot too, because it is the running one. */}
        {live ? <LivenessDot state="live" /> : <span className="v-nav__bullet">·</span>}
        <span className="v-nav__title">{title}</span>
      </button>
      <PinButton on={pinned} onToggle={onPin} />
    </div>
  );
}

function Project({
  dir,
  current,
  currentId,
  pins,
  onResume,
  onPin,
  onAll,
  onForget,
}: {
  dir: string;
  /** Whether this is the project the window is pointed at. */
  current: boolean;
  currentId: string | null;
  pins: readonly Pin[];
  onResume: (dir: string, runId: string) => void;
  onPin: (pin: Pin) => void;
  onAll: (dir: string) => void;
  onForget: (dir: string) => void;
}) {
  // The current project opens on its own, because it is the one whose runs the
  // window is about. Every other one is a click — a sidebar that read four
  // archives at launch would spend four reads on rows nobody asked for.
  const [open, setOpen] = useState(current);
  const [more, setMore] = useState(false);
  const { runs, failure, loading } = useArchive(dir, open, currentId);
  const { shown, hidden } = visible(runs, more);

  return (
    <div className="v-nav__project">
      <div className="v-nav__row v-nav__row--project">
        <button className="v-nav__open" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="v-nav__folder">{open ? '▾' : '▸'}</span>
          <span className={`v-nav__title${current ? ' v-nav__title--on' : ''}`}>
            {projectName(dir)}
          </span>
        </button>
        <button
          className="v-nav__pin"
          onClick={() => onForget(dir)}
          title={`Remove ${projectName(dir)} from this list — the directory is untouched`}
        >
          ×
        </button>
      </div>

      {open && (
        <div className="v-nav__runs">
          {failure !== null && <span className="v-nav__note">{failure}</span>}
          {failure === null && loading && runs.length === 0 && (
            <span className="v-nav__note">reading…</span>
          )}
          {failure === null && !loading && runs.length === 0 && (
            <span className="v-nav__note">no runs here yet</span>
          )}
          {shown.map((r) => (
            <RunRow
              key={r.id}
              title={r.task}
              live={r.live}
              current={r.current}
              pinned={isPinned(pins, { dir, runId: r.id, task: r.task })}
              // A run held by a live process is not something to reopen from a
              // sidebar. `1b` is where a lock is overruled, with a confirmation.
              onOpen={r.live ? null : () => onResume(dir, r.id)}
              onPin={() => onPin({ dir, runId: r.id, task: r.task })}
            />
          ))}
          {hidden > 0 && (
            <button className="v-nav__more" onClick={() => setMore(true)}>
              Show {hidden} more
            </button>
          )}
          {runs.length > 0 && (
            <button className="v-nav__more" onClick={() => onAll(dir)}>
              All runs, with status and cost
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Sidebar({
  dir,
  currentId,
  onNew,
  onSwitch,
  onSettings,
  onRuns,
  onResume,
  onProject,
}: {
  /** The repository the window is pointed at. Always one of the projects. */
  dir: string;
  currentId: string | null;
  onNew: () => void;
  onSwitch: () => void;
  onSettings: () => void;
  /** Open `1b` for a project, which is where a lock can be overruled. */
  onRuns: (dir: string) => void;
  onResume: (dir: string, runId: string) => void;
  /** Point the window at a project. */
  onProject: (dir: string) => void;
}) {
  const [projects, setProjects] = useState<readonly string[]>([]);
  const [pins, setPins] = useState<readonly Pin[]>([]);
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState('');

  // Read once. Both lists are this window's own memory, so there is nothing to
  // re-read them for — every write below goes through the setters.
  useEffect(() => {
    try {
      setProjects(readProjects(localStorage.getItem(PROJECTS_KEY)));
      setPins(readPins(localStorage.getItem(PINNED_KEY)));
    } catch {
      // Storage can be unavailable or full. An empty sidebar is a smaller
      // failure than a window that will not render.
    }
  }, []);

  const save = useCallback((key: string, value: unknown) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // The list still works for this session. See above.
    }
  }, []);

  const add = useCallback(
    (next: string) => {
      setProjects((list) => {
        const grown = addProject(list, next);
        save(PROJECTS_KEY, grown);
        return grown;
      });
    },
    [save],
  );

  // The repository the window is already pointed at is a project whether or not
  // anybody added it — it is where the next run will go. Seeded rather than
  // demanded, so an existing install finds its own repo in the list.
  useEffect(() => {
    if (dir.trim() !== '') add(dir);
  }, [dir, add]);

  const pin = useCallback(
    (p: Pin) => {
      setPins((list) => {
        const next = togglePin(list, p);
        save(PINNED_KEY, next);
        return next;
      });
    },
    [save],
  );

  const forget = useCallback(
    (d: string) => {
      setProjects((list) => {
        const next = list.filter((x) => x !== d);
        save(PROJECTS_KEY, next);
        return next;
      });
    },
    [save],
  );

  return (
    <nav className="v-nav" aria-label="projects">
      <div className="v-nav__actions">
        <button className="v-nav__action" onClick={onNew}>
          <span className="v-nav__glyph">＋</span> New run
        </button>
        <button className="v-nav__action" onClick={onSwitch}>
          <span className="v-nav__glyph">⌘K</span> Switch run
        </button>
        <button className="v-nav__action" onClick={onSettings}>
          <span className="v-nav__glyph">⚙</span> Settings
        </button>
      </div>

      {pins.length > 0 && (
        <section className="v-nav__section">
          <h3 className="v-nav__heading">Pinned</h3>
          {pins.map((p) => (
            <RunRow
              key={`${p.dir}:${p.runId}`}
              title={p.task}
              // A pin is drawn without reading its project's archive, so there
              // is no liveness to state and none is claimed. The row says what
              // it knows: this run, in this project, that you marked.
              live={false}
              current={p.runId === currentId}
              pinned
              onOpen={() => onResume(p.dir, p.runId)}
              onPin={() => pin(p)}
            />
          ))}
        </section>
      )}

      <section className="v-nav__section">
        <h3 className="v-nav__heading">Projects</h3>
        {projects.length === 0 && (
          <span className="v-nav__note">
            None yet. A project is a repository — add the one you want to work in.
          </span>
        )}
        {projects.map((p) => (
          <Project
            key={p}
            dir={p}
            current={p === dir}
            currentId={currentId}
            pins={pins}
            onResume={onResume}
            onPin={pin}
            onAll={onRuns}
            onForget={forget}
          />
        ))}

        {adding ? (
          <form
            className="v-nav__add"
            onSubmit={(e) => {
              e.preventDefault();
              const next = typed.trim();
              if (next === '') return;
              add(next);
              // Pointed at straight away: adding a project is how you switch to
              // one, and an entry that appeared in a list you then had to click
              // would be two actions for one intention.
              onProject(next);
              setTyped('');
              setAdding(false);
            }}
          >
            <input
              className="v-nav__field"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="path to a repository"
              aria-label="path to a repository"
              autoFocus
            />
          </form>
        ) : (
          <button className="v-nav__more" onClick={() => setAdding(true)}>
            ＋ Add a project
          </button>
        )}
      </section>

      {!host.inShell() && (
        <StateKicker tone="quiet">browser · the archive is read by the host</StateKicker>
      )}
    </nav>
  );
}
