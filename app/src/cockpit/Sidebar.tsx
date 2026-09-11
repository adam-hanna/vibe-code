import { useCallback, useEffect, useState } from 'react';
import { LivenessDot, StateKicker } from '../design';
import * as host from '../host';
import { Confirm } from './Confirm';
import { rail } from './squares';
import { pickDirectory } from './pick';
import {
  NAMES_KEY,
  PINNED_KEY,
  PROJECTS_KEY,
  addProject,
  findProject,
  forgetNames,
  forgetProjectPins,
  isPinned,
  nameOf,
  projectName,
  readNames,
  readPins,
  readProjects,
  removeProject,
  renameRun,
  samePin,
  togglePin,
  visible,
} from './projects';
import type { Pin, RunName } from './projects';
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
 * still always on screen, as a strip, which is what they were.
 *
 * ## A project is a repository, a session is a run
 *
 * The shape is borrowed deliberately: actions, then **Pinned**, then **Projects**
 * with their sessions nested and a `Show more` where the list is long. What it is
 * *not* is a second definition of anything the core owns — `archive` answers per
 * directory, `listRuns` decides what a run is, and `rail()` decides which entries
 * may be drawn at all. The window's contribution is which directories you have
 * open, which runs you pinned and what you have renamed them to, none of which is
 * a fact about any run.
 *
 * ## An archive is read when a project opens, not on a timer
 *
 * One read per project, when its section is first expanded, again when the run in
 * the window changes, and again when a run is deleted — the three moments the
 * archive is known to differ. The same rule the artifact panes follow, for the
 * same reason: nothing else writes to these directories while this window is the
 * one running.
 *
 * ## A row OPENS a run. It does not start one.
 *
 * The first cut resumed on click, and the report was immediate: *"clicking on a
 * run within a project on the left bar automatically kicks off the pre-flight. I
 * don't want that."* It is the sharper version of the narrowing `Rail.tsx`
 * already made — that one said a square must not silently *force* a lock, and
 * this says a click must not silently **spend**. A resume probes both CLIs, takes
 * the lock and starts a turn; putting that behind a row in a list makes browsing
 * the archive cost money, which is the one thing browsing must not do.
 *
 * So a row reads: it points the window at that run and every pane that reads a
 * run's own directory follows it.
 *
 * ## The four controls on a row, and which of them touch a disk
 *
 * Exactly one does. **Pin** and **rename** are this window's own memory and are
 * `localStorage`; they change nothing in any repository, which is why neither
 * confirms. **New run** in a project opens the composer with that project's
 * directory already settled — that is the whole of what *"In this window, I
 * shouldn't have to select the project folder, it's already known"* asked for,
 * and it is also one fewer place a path can be mistyped. **Delete** is the one
 * that removes a directory, so it is the one that confirms, and the confirmation
 * says what survives it: the run's branch and every commit on it are in git, not
 * in `.vibe/runs`, and this does not touch them.
 *
 * Removing a **project** is deliberately not the same act and the dialog says so
 * in as many words. It takes a row out of this list; the repository is untouched,
 * every run in it is untouched, and adding it again brings all of them back. Two
 * controls a pixel apart, one of which deletes files and one of which does not,
 * is exactly the pair a confirmation exists to keep separate.
 */

/** One project's archive, fetched when it opens. */
interface Loaded {
  runs: readonly RailRun[];
  failure: string | null;
  loading: boolean;
}

function useArchive(
  dir: string,
  open: boolean,
  currentId: string | null,
  /** Bumped when a run is deleted, so the list it was drawn from is re-read. */
  beat: number,
): Loaded {
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
  }, [dir, open, currentId, beat]);

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
      className={`v-nav__act${on ? ' v-nav__act--on' : ''}`}
      onClick={(e) => {
        // The row underneath opens a run. A pin is a note to yourself about one
        // and must never be the click that navigates.
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

/**
 * The rename box, as its own component so its seed is always current.
 *
 * Mounted only while a row is being renamed, which is what makes `useState(title)`
 * correct rather than a first-render snapshot: a `typed` held on the row itself
 * would be seeded once, and the second time somebody opened the box it would
 * offer the name from before the first rename.
 */
function RenameRow({ title, onDone }: { title: string; onDone: (name: string | null) => void }) {
  const [typed, setTyped] = useState(title);
  return (
    <form
      className="v-nav__row v-nav__row--rename"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(typed);
      }}
    >
      <input
        className="v-nav__field"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          // Escape abandons. A box that could only be left by saving would turn
          // an accidental click into a forced decision.
          if (e.key === 'Escape') onDone(null);
        }}
        aria-label="name for this run"
        autoFocus
      />
      <button className="v-nav__act" type="submit" title="Save this name">
        ✓
      </button>
      <button className="v-nav__act" type="button" onClick={() => onDone(null)} title="Cancel">
        ✕
      </button>
    </form>
  );
}

function RunRow({
  title,
  live,
  current,
  pinned,
  renaming,
  onOpen,
  onPin,
  onRename,
  onRenamed,
  onDelete,
}: {
  title: string;
  live: boolean;
  current: boolean;
  pinned: boolean;
  /** Whether this row is the one being renamed. At most one is, sidebar-wide. */
  renaming: boolean;
  /** Show this run. Reading takes no lock, so there is no state that refuses. */
  onOpen: () => void;
  onPin: () => void;
  /** Start renaming, or stop. Null closes the box without writing anything. */
  onRename: () => void;
  onRenamed: (name: string | null) => void;
  /** Ask to delete. Never deletes — it opens the confirmation. */
  onDelete: () => void;
}) {
  // The box is seeded with what is on screen, so clearing it and pressing enter
  // is how a name is removed — `renameRun` reads an empty string as *give me the
  // task back*, which is the same intention and must not be a second control.
  if (renaming) return <RenameRow title={title} onDone={onRenamed} />;

  return (
    <div className={`v-nav__row${current ? ' v-nav__row--on' : ''}`}>
      <button className="v-nav__open" onClick={onOpen} title={title}>
        {/* The archive's verdict, never one derived here. A run this window is
            showing gets the dot too, because it is the running one. */}
        {live ? <LivenessDot state="live" /> : <span className="v-nav__bullet">·</span>}
        <span className="v-nav__title">{title}</span>
      </button>
      <PinButton on={pinned} onToggle={onPin} />
      <button className="v-nav__act" onClick={onRename} title="Rename this run">
        ✎
      </button>
      {/* The only control in this row that reaches a disk. It opens a dialog. */}
      <button className="v-nav__act v-nav__act--danger" onClick={onDelete} title="Delete this run">
        −
      </button>
    </div>
  );
}

function Project({
  dir,
  current,
  currentId,
  pins,
  names,
  beat,
  renaming,
  onShow,
  onPin,
  onRename,
  onRenamed,
  onDeleteRun,
  onAll,
  onNewIn,
  onForget,
}: {
  dir: string;
  /** Whether this is the project the window is pointed at. */
  current: boolean;
  currentId: string | null;
  pins: readonly Pin[];
  names: readonly RunName[];
  beat: number;
  renaming: { dir: string; runId: string } | null;
  onShow: (dir: string, runId: string, task: string) => void;
  onPin: (pin: Pin) => void;
  onRename: (dir: string, runId: string) => void;
  onRenamed: (name: string | null) => void;
  onDeleteRun: (dir: string, runId: string, title: string) => void;
  onAll: (dir: string) => void;
  /** Start a run in THIS project, with its directory already settled. */
  onNewIn: (dir: string) => void;
  onForget: (dir: string) => void;
}) {
  // The current project opens on its own, because it is the one whose runs the
  // window is about. Every other one is a click — a sidebar that read four
  // archives at launch would spend four reads on rows nobody asked for.
  const [open, setOpen] = useState(current);
  const [more, setMore] = useState(false);
  const { runs, failure, loading } = useArchive(dir, open, currentId, beat);
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
        {/* Right-justified, beside the project it starts a run in. The composer
            it opens has no repository field at all — the project is the answer,
            and offering it again would be the second spelling #211 warns about. */}
        <button
          className="v-nav__act"
          onClick={() => onNewIn(dir)}
          title={`New run in ${projectName(dir)}`}
        >
          ＋
        </button>
        <button
          className="v-nav__act v-nav__act--danger"
          onClick={() => onForget(dir)}
          title={`Remove ${projectName(dir)} from this list`}
        >
          −
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
          {shown.map((r) => {
            // The name if there is one, the task if there is not. Resolved once,
            // here, so the row, its tooltip and the confirmation that deletes it
            // cannot end up calling the same run two different things.
            const title = nameOf(names, dir, r.id, r.task);
            return (
              <RunRow
                key={r.id}
                title={title}
                live={r.live}
                current={r.current}
                pinned={isPinned(pins, { dir, runId: r.id, task: r.task })}
                renaming={renaming !== null && renaming.dir === dir && renaming.runId === r.id}
                // Every run opens, the live one included — reading a run's own
                // directory takes no lock and starts nothing, so there is no
                // reason to refuse the one that is going. Starting a run is
                // `1b`'s job, and that is where a held lock is a question.
                onOpen={() => onShow(dir, r.id, title)}
                onPin={() => onPin({ dir, runId: r.id, task: r.task })}
                onRename={() => onRename(dir, r.id)}
                onRenamed={onRenamed}
                onDelete={() => onDeleteRun(dir, r.id, title)}
              />
            );
          })}
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

/** What a confirmation is about. The two acts are kept apart all the way down. */
type Pending =
  | { kind: 'run'; dir: string; runId: string; title: string }
  | { kind: 'project'; dir: string };

export function Sidebar({
  dir,
  currentId,
  onNew,
  onNewIn,
  onSwitch,
  onSettings,
  onRuns,
  onShow,
  onProject,
  onDeleted,
}: {
  /** The repository the window is pointed at. Always one of the projects. */
  dir: string;
  currentId: string | null;
  onNew: () => void;
  /** Compose a run in one project, with the directory already settled (#223). */
  onNewIn: (dir: string) => void;
  onSwitch: () => void;
  onSettings: () => void;
  /** Open `1b` for a project, which is where a lock can be overruled. */
  onRuns: (dir: string) => void;
  onShow: (dir: string, runId: string, task: string) => void;
  /** Point the window at a project. */
  onProject: (dir: string) => void;
  /** A run that is gone, so panes pointed at it can stop reading it. */
  onDeleted: (dir: string, runId: string) => void;
}) {
  const [projects, setProjects] = useState<readonly string[]>([]);
  const [pins, setPins] = useState<readonly Pin[]>([]);
  const [names, setNames] = useState<readonly RunName[]>([]);
  const [adding, setAdding] = useState(false);
  const [typed, setTyped] = useState('');
  /** Which run has its rename box open, or null. At most one, sidebar-wide. */
  const [renaming, setRenaming] = useState<{ dir: string; runId: string } | null>(null);
  /** What a confirmation is about, or null. Nothing is destroyed until it says. */
  const [pending, setPending] = useState<Pending | null>(null);
  /** The core's own refusal, kept on the dialog rather than closing it. */
  const [refused, setRefused] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** Bumped after a delete, so every open project re-reads its archive. */
  const [beat, setBeat] = useState(0);
  /**
   * What went wrong adding a project, or null.
   *
   * **A duplicate is said out loud rather than absorbed.** `addProject` dedupes
   * silently, which is right for the seeding that happens on every render and
   * wrong for a person who pressed a button: a chooser that closes and adds no
   * row has ignored them, and the reasonable next thing to try is pressing it
   * again. It names the spelling already in the list, because that is what makes
   * the message actionable — somebody who chose `c:/users/me/repo` needs to be
   * shown `C:\Users\me\repo` to recognise which row is already theirs.
   */
  const [problem, setProblem] = useState<string | null>(null);

  // Read once. All three lists are this window's own memory, so there is nothing
  // to re-read them for — every write below goes through the setters.
  useEffect(() => {
    try {
      setProjects(readProjects(localStorage.getItem(PROJECTS_KEY)));
      setPins(readPins(localStorage.getItem(PINNED_KEY)));
      setNames(readNames(localStorage.getItem(NAMES_KEY)));
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

  /**
   * Add a project a person asked for, and say so when it is already there.
   *
   * The loud half of `add`. It resolves against the list through the setter
   * rather than closing over `projects`, so two adds in quick succession cannot
   * both decide the list was empty.
   */
  const addAndSay = useCallback(
    (next: string) => {
      const trimmed = next.trim();
      if (trimmed === '') return;
      setProjects((list) => {
        const already = findProject(list, trimmed);
        if (already !== null) {
          setProblem(
            already === trimmed
              ? `${projectName(already)} is already a project.`
              : `That is already a project, listed as ${already}.`,
          );
          return list;
        }
        const grown = addProject(list, trimmed);
        save(PROJECTS_KEY, grown);
        setProblem(null);
        // Pointed at straight away: adding a project is how you switch to one,
        // and a row that appeared in a list you then had to click would be two
        // actions for one intention.
        onProject(trimmed);
        return grown;
      });
      setTyped('');
      setAdding(false);
    },
    [save, onProject],
  );

  /**
   * The native chooser, which is what *Add a project* should have opened.
   *
   * `pickDirectory` is the one place this window asks the OS for anything, and a
   * repository is exactly what #189 added it for: an absolute, platform-shaped
   * path typed by hand fails at preflight rather than at the field. The typed
   * field stays as the **fallback** when the chooser will not open — a headless
   * or misconfigured shell must not leave the only way in unreachable.
   */
  const choose = useCallback(() => {
    void pickDirectory()
      .then((chosen) => {
        // A cancel changes nothing. Not the list, not the message, not the
        // field — every caller of this has to be able to tell it from a choice.
        if (chosen !== null) addAndSay(chosen);
      })
      .catch((err: unknown) => {
        setProblem(
          `the chooser did not open: ${err instanceof Error ? err.message : String(err)} — type a path instead`,
        );
        setAdding(true);
      });
  }, [addAndSay]);

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

  /**
   * Write a name, or clear it, and close the box either way.
   *
   * `null` is *abandon* and an empty string is *give me the task back* — two
   * different intentions that would otherwise collapse into one, and only one of
   * them writes.
   */
  const renamed = useCallback(
    (name: string | null) => {
      const at = renaming;
      setRenaming(null);
      if (at === null || name === null) return;
      setNames((list) => {
        const next = renameRun(list, at.dir, at.runId, name);
        save(NAMES_KEY, next);
        return next;
      });
    },
    [renaming, save],
  );

  /**
   * Do what the open confirmation says, and nothing else.
   *
   * The two branches are as different as the dialog claims they are: forgetting
   * a project touches `localStorage` and stops there, and deleting a run is a
   * host request that can be refused. The refusal stays on the dialog — a window
   * that closed on it would look exactly like one that had succeeded.
   */
  const act = useCallback(() => {
    const at = pending;
    if (at === null) return;
    if (at.kind === 'project') {
      setProjects((list) => {
        const next = removeProject(list, at.dir);
        save(PROJECTS_KEY, next);
        return next;
      });
      // The pins in it go too. A pinned row drawn under Pinned for a project
      // that is no longer listed is a run with no way back to its own archive.
      setPins((list) => {
        const next = forgetProjectPins(list, at.dir);
        save(PINNED_KEY, next);
        return next;
      });
      setPending(null);
      return;
    }
    setDeleting(true);
    setRefused(null);
    void host
      .deleteRun(at.dir, at.runId)
      .then(() => {
        // The window's own memory of a run that no longer exists goes with it,
        // rather than being left to accumulate against ids nothing can resolve.
        setPins((list) => {
          // `samePin` rather than an exact `dir` match, for the reason every
          // other comparison in this file normalises: a pin made when the path
          // was typed with a trailing slash would survive the run it points at.
          const next = list.filter((p) => !samePin(p, { dir: at.dir, runId: at.runId, task: '' }));
          save(PINNED_KEY, next);
          return next;
        });
        setNames((list) => {
          const next = forgetNames(list, at.dir, at.runId);
          save(NAMES_KEY, next);
          return next;
        });
        onDeleted(at.dir, at.runId);
        setBeat((n) => n + 1);
        setPending(null);
      })
      // The core's sentence, verbatim. *"It is running, stop it first"* and
      // *"vibe will not follow a link to delete"* are acted on differently, and
      // a paraphrase would answer neither.
      .catch((err: unknown) => setRefused(err instanceof Error ? err.message : String(err)))
      .finally(() => setDeleting(false));
  }, [pending, save, onDeleted]);

  return (
    <nav className="v-nav" aria-label="projects">
      {pending !== null && pending.kind === 'run' && (
        <Confirm
          kicker="deletes files"
          title={`Delete “${pending.title}”`}
          lead="The run's whole record goes: its plans, both reports, the answers, every checkpoint and its transcript. There is no undo."
          facts={[
            { label: 'run', value: pending.runId, mono: true },
            { label: 'from', value: pending.dir, mono: true },
            {
              label: 'survives this',
              value:
                'the branch it committed to and every commit on it — those are in git, not in .vibe/runs',
            },
            {
              label: 'refused if',
              value: 'the run is still going, or vibe cannot read its lock to find out',
            },
          ]}
          confirm={deleting ? 'Deleting…' : 'Delete this run'}
          busy={deleting}
          problem={refused}
          onConfirm={act}
          onCancel={() => {
            setPending(null);
            setRefused(null);
          }}
        />
      )}
      {pending !== null && pending.kind === 'project' && (
        <Confirm
          tone="quiet"
          kicker="deletes nothing"
          title={`Remove ${projectName(pending.dir)} from this list`}
          lead="This is a row in this window, not a directory. Nothing on disk is touched and nothing is deleted."
          facts={[
            { label: 'directory', value: pending.dir, mono: true },
            { label: 'what changes', value: 'this list, in this window, on this machine' },
            {
              label: 'what does not',
              value: 'the repository, every run in it, and every branch — add it again and they are all back',
            },
            { label: 'also removed', value: 'any pins you made on runs in this project' },
          ]}
          confirm="Remove it from the list"
          onConfirm={act}
          onCancel={() => setPending(null)}
        />
      )}

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
          {pins.map((p) => {
            const title = nameOf(names, p.dir, p.runId, p.task);
            return (
              <RunRow
                key={`${p.dir}:${p.runId}`}
                title={title}
                // A pin is drawn without reading its project's archive, so there
                // is no liveness to state and none is claimed. The row says what
                // it knows: this run, in this project, that you marked.
                live={false}
                current={p.runId === currentId}
                pinned
                renaming={renaming !== null && renaming.dir === p.dir && renaming.runId === p.runId}
                onOpen={() => onShow(p.dir, p.runId, title)}
                onPin={() => pin(p)}
                onRename={() => setRenaming({ dir: p.dir, runId: p.runId })}
                onRenamed={renamed}
                onDelete={() => {
                  setRefused(null);
                  setPending({ kind: 'run', dir: p.dir, runId: p.runId, title });
                }}
              />
            );
          })}
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
            names={names}
            beat={beat}
            renaming={renaming}
            onShow={onShow}
            onPin={pin}
            onRename={(d, runId) => setRenaming({ dir: d, runId })}
            onRenamed={renamed}
            onDeleteRun={(d, runId, title) => {
              setRefused(null);
              setPending({ kind: 'run', dir: d, runId, title });
            }}
            onAll={onRuns}
            onNewIn={onNewIn}
            onForget={(d) => setPending({ kind: 'project', dir: d })}
          />
        ))}

        {/* The chooser first, the field as the fallback. A path is absolute and
            platform-shaped, and a typo in one does not fail at the field — it
            fails at preflight, minutes later, in a run that had to start to find
            out (#189). */}
        <button className="v-nav__more" onClick={choose}>
          ＋ Add a project
        </button>
        {adding && (
          <form
            className="v-nav__add"
            onSubmit={(e) => {
              e.preventDefault();
              addAndSay(typed);
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
        )}
        {problem !== null && (
          <span className="v-nav__note v-nav__note--alarm" role="alert">
            {problem}{' '}
            <button className="v-nav__dismiss" onClick={() => setProblem(null)}>
              dismiss
            </button>
          </span>
        )}
      </section>

      {!host.inShell() && (
        <StateKicker tone="quiet">browser · the archive is read by the host</StateKicker>
      )}
    </nav>
  );
}
