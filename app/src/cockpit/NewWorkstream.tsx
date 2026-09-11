import { useEffect, useState } from 'react';
import { Button, MetaChip, Modal, StateKicker } from '../design';
import * as host from '../host';
import { launchArgv } from './argv';
import { pickDirectory } from './pick';
import type { Overrides } from './argv';
import type { ConfigFrame } from '../host';

/**
 * The new-workstream modal (`4a`, #223).
 *
 * **The only modal in the product**, and it earns that by being the one moment
 * somebody is thinking about how this particular run should differ from the
 * project's defaults. The design's intent is stated plainly: everything has a
 * project default, so the honest path is type → create → keep talking, and the
 * overrides block exists to make divergence visible at the one moment it is
 * being decided.
 *
 * ## What it can express, and why that is the boundary
 *
 * Every control here is a flag `parseArgs` already takes — `--gate`, `--role`,
 * `--max-tokens`, `--p1-tolerance`. That is not a limitation to work around, it
 * is the rule the whole app is built on: the GUI's job is a form to an argv, so
 * the set of legal invocations still has exactly one definition and it is the
 * CLI's. A control with no flag behind it would be a promise this app cannot
 * keep.
 *
 * ## Three things `4a` draws that are named absent rather than faked
 *
 * - **The name / branch / worktree row.** The design has a name deriving
 *   `vibe/<name>` and a worktree path, both shown as computed monospace. `vibe`
 *   names its own branch after the **run id** it allocates, and the CLI takes no
 *   name and no branch — so a field here would be typed into and ignored.
 * - **The base-branch picker with fetch freshness.** No flag, and no frame that
 *   would report freshness.
 * - **The setup preview.** Worktree scripts do not exist (#208): vibe cannot
 *   create the worktree it insists you already have, so there is nothing to
 *   preview and no `create the worktree but hold` to offer.
 *
 * Each is stated on the frame rather than left out, because a modal that showed
 * only what it had would read as the whole of what a run can be configured to
 * do.
 */

/** The gate modes, in the order `src/gates.ts` lists them. Filled from the wire. */
type Gates = Readonly<Record<string, string>>;

export function NewWorkstream({
  dir,
  onDir,
  onLaunch,
  onClose,
  busy,
  locked = false,
}: {
  dir: string;
  onDir: (dir: string) => void;
  onLaunch: (argv: readonly string[]) => void;
  onClose: () => void;
  busy: boolean;
  /**
   * Whether the repository is already settled, because a project chose it (#223).
   *
   * **Opened from a project's `＋`, there is nothing left to ask.** Reported in
   * as many words — *"In this window, I shouldn't have to select the project
   * folder, it's already known"* — and it is the same rule that took the
   * repository field out of the pilot last commit: a project **is** a
   * repository, so a second control setting `repoDir` is the third spelling
   * #211 warns about, and the one to keep is the one with a list beside it.
   *
   * The path is still **shown**, because which repository a run will write to is
   * the one fact about it that cannot be taken back later. It is stated rather
   * than offered.
   */
  locked?: boolean;
}) {
  const [task, setTask] = useState('');
  const [planOnly, setPlanOnly] = useState(true);
  const [cfg, setCfg] = useState<ConfigFrame | null>(null);
  const [gates, setGates] = useState<Gates>({});
  const [maxTokens, setMaxTokens] = useState('');
  const [tolerance, setTolerance] = useState('');
  const [pickFailed, setPickFailed] = useState<string | null>(null);

  // The project's defaults, so the block can show only what DIFFERS from them.
  // Without this the overrides block would be a second gate matrix rather than a
  // diff, and a diff is the whole point of it.
  useEffect(() => {
    if (dir.trim() === '' || !host.inShell()) return;
    void host
      .config(dir)
      .then(setCfg)
      // Silent, and the block says so below. A modal that refused to open
      // because the config could not be read would block the one action a new
      // user knows how to take.
      .catch(() => setCfg(null));
  }, [dir]);

  const defaults = (cfg?.effective as { gates?: Gates } | undefined)?.gates ?? {};
  const differing = Object.entries(gates).filter(([b, m]) => defaults[b] !== m);

  const overrides: Overrides = {
    gates: Object.fromEntries(differing),
    maxTokens: maxTokens.trim() === '' ? null : Number(maxTokens),
    p1Tolerance: tolerance.trim() === '' ? null : Number(tolerance),
  };

  // A number field that is not a number is refused rather than coerced. `Number('')`
  // is 0 and `Number('x')` is NaN, and both would reach the argv as a ceiling
  // nobody typed — `--max-tokens 0` turns the ceiling off, which is the opposite
  // of leaving it alone.
  const badNumber =
    (maxTokens.trim() !== '' && !Number.isFinite(Number(maxTokens))) ||
    (tolerance.trim() !== '' && !Number.isFinite(Number(tolerance)));

  const ready = task.trim() !== '' && dir.trim() !== '' && !badNumber;
  const argv = launchArgv(task, dir, planOnly, overrides);

  const choose = () => {
    void pickDirectory()
      .then((chosen) => {
        setPickFailed(null);
        if (chosen !== null) onDir(chosen);
      })
      .catch((err: unknown) => setPickFailed(err instanceof Error ? err.message : String(err)));
  };

  return (
    <Modal width={680} onDismiss={onClose}>
      <form
        className="v-new"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready || busy) return;
          onLaunch(argv);
          onClose();
        }}
      >
        <div className="v-new__head">
          <StateKicker tone="accent">new workstream</StateKicker>
        </div>

        <label className="v-new__label" htmlFor="brief">
          what are we doing
        </label>
        <textarea
          id="brief"
          className="v-new__task"
          rows={5}
          value={task}
          placeholder="the brief, in full — the runs that converge state the decisions already made and say not to re-derive them"
          onChange={(e) => setTask(e.target.value)}
        />

        <label className="v-new__label" htmlFor={locked ? undefined : 'newdir'}>
          repository
        </label>
        {locked ? (
          // Stated, not offered. The project answered this, and a field here
          // would be a second way to answer it. See `locked` above.
          <div className="v-new__row">
            <code className="v-new__fixed">{dir}</code>
            <MetaChip>from the project</MetaChip>
          </div>
        ) : (
          <>
            <div className="v-new__row">
              <input
                id="newdir"
                className="v-new__dir"
                value={dir}
                placeholder="an absolute path to a git worktree"
                onChange={(e) => onDir(e.target.value)}
              />
              <Button type="button" onClick={choose} disabled={busy}>
                choose…
              </Button>
            </div>
            {pickFailed !== null && (
              <p className="v-new__note">the chooser did not open: {pickFailed} — type or paste</p>
            )}
          </>
        )}

        <details className="v-new__over" open={differing.length > 0}>
          <summary>
            overrides
            {differing.length > 0 ? (
              <MetaChip>{differing.length} differ from project</MetaChip>
            ) : (
              <MetaChip>none — everything is the project default</MetaChip>
            )}
            {differing.length > 0 && (
              <button type="button" className="v-new__reset" onClick={() => setGates({})}>
                reset
              </button>
            )}
          </summary>

          {cfg === null ? (
            <p className="v-new__note">
              The project&apos;s configuration could not be read, so this cannot show what differs
              from it — only what you set. Anything left alone stays the project default.
            </p>
          ) : (
            <table className="v-new__gates">
              <tbody>
                {cfg.gateable.map((boundary) => {
                  const current = gates[boundary] ?? defaults[boundary] ?? '';
                  const changed = defaults[boundary] !== undefined && current !== defaults[boundary];
                  return (
                    <tr key={boundary} className={changed ? 'is-changed' : ''}>
                      <td>
                        <code>{boundary}</code>
                      </td>
                      <td>
                        <select
                          value={current}
                          onChange={(e) =>
                            setGates((g) => ({ ...g, [boundary]: e.target.value }))
                          }
                        >
                          {cfg.modes.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        {changed ? (
                          <MetaChip>changed from {defaults[boundary]}</MetaChip>
                        ) : (
                          <span className="v-new__dim">project default</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <div className="v-new__row">
            <label className="v-new__label" htmlFor="cap">
              token cap
            </label>
            <input
              id="cap"
              className="v-new__num"
              value={maxTokens}
              placeholder="empty — the project default"
              onChange={(e) => setMaxTokens(e.target.value)}
            />
            <label className="v-new__label" htmlFor="tol">
              P1 tolerance
            </label>
            <input
              id="tol"
              className="v-new__num"
              value={tolerance}
              placeholder="empty"
              onChange={(e) => setTolerance(e.target.value)}
            />
          </div>
          {/* Empty is not zero, and here the difference is load-bearing in both
              fields: `--max-tokens 0` turns the ceiling OFF, and a tolerance of
              0 demands a spotless verdict. */}
          <p className="v-new__note">
            Both are left alone when empty. A cap of <code>0</code> turns the ceiling off, and a
            tolerance of <code>0</code> demands a spotless verdict — neither is the same as saying
            nothing.
          </p>
          {badNumber && (
            <p className="v-new__bad">
              One of those is not a number, so nothing will be sent for it. Clear it or fix it.
            </p>
          )}
        </details>

        {/* Named rather than omitted. A modal showing only what it had would
            read as the whole of what a run can be configured to do. */}
        <p className="v-new__note">
          No name, branch or worktree field: <code>vibe</code> names its own branch after the run
          id it allocates, and the CLI takes neither. No setup preview and no{' '}
          <em>create the worktree but hold</em>, because vibe cannot create a worktree yet — this
          runs in one you already have.
        </p>

        <label className="v-new__toggle">
          <input type="checkbox" checked={planOnly} onChange={(e) => setPlanOnly(e.target.checked)} />
          <span>
            plan only — stop after the plan clears critique.{' '}
            <strong>Leave this on until you mean it:</strong> the other path writes code and
            commits.
          </span>
        </label>

        {/* The exact command, because it is the one thing that is definitely
            true about what pressing this will do. */}
        <pre className="v-new__argv">vibe {argv.join(' ')}</pre>

        <div className="v-new__foot">
          <Button type="button" onClick={onClose}>
            cancel
          </Button>
          <Button level="primary" type="submit" disabled={!ready || busy}>
            {planOnly ? 'create & plan' : 'create & run'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
