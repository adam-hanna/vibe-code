import { useEffect, useState } from 'react';
import { Modal } from '../design';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import * as host from '../host';
import { briefFor } from './argv';
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
 * - **The setup preview.** This was *"worktree scripts do not exist (#208):
 *   vibe cannot create the worktree it insists you already have"*, and half of
 *   that stopped being true in #223 - `git.worktree` and `git.worktreeCommand`
 *   are settings now, and the loop makes the worktree itself. What is still
 *   absent is a **preview**, and deliberately: the script is a line somebody
 *   wrote in `vibe.config.json` and rendering what it would do means running it,
 *   which is the one thing a modal must not do before anybody has pressed
 *   anything. The settings screen is where that line is read and edited.
 *
 * Each is stated on the frame rather than left out, because a modal that showed
 * only what it had would read as the whole of what a run can be configured to
 * do.
 */

/** A field in the composer. */
const FIELD = 'w-full rounded-sm border border-rule-control bg-panel px-3 py-2.5 font-sans text-body text-primary outline-none placeholder:text-tertiary focus-visible:ring-1 focus-visible:ring-accent-border';
/** A label over a field: small caps, the form's one visual rhythm. */
const LABEL = 'text-body-sm font-medium text-secondary';
/** A sentence under a control. */
const NOTE = 'm-0 text-body-sm leading-relaxed text-secondary';

/** The gate modes, in the order `src/gates.ts` lists them. Filled from the wire. */
type Gates = Readonly<Record<string, string>>;

export function NewWorkstream({
  dir,
  onDir,
  onBrief,
  onClose,
  busy,
  locked = false,
}: {
  dir: string;
  onDir: (dir: string) => void;
  /**
   * Hand the brief to the pilot instead of starting a run (#223).
   *
   * **The only way out of this modal**, and the reason it exists: a run is long
   * and expensive and converges or stalls on the brief it was given, so the
   * useful thing to do with a freshly typed one is interrogate it. Asked for as
   * *"I don't want the run to start automatically. Rather, I want the user
   * message to be fed into the pilot chat."*
   *
   * It used to be one of two. `skip the pilot` built an argv here and started
   * the run, and was kept because the overrides block had no other road to a
   * run; it went at the owner's decision — *"There should only be one start
   * button and it should follow the 'talk it through' path"* — and the overrides
   * travel in the message instead, which `start_run` can now carry. See
   * `briefFor`.
   */
  /**
   * `message` is what the pilot is told; `task` is the brief alone, which is
   * what the sidebar's draft row is called until the run exists.
   */
  onBrief: (message: string, task: string) => void;
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

  const choose = () => {
    void pickDirectory()
      .then((chosen) => {
        setPickFailed(null);
        if (chosen !== null) onDir(chosen);
      })
      .catch((err: unknown) => setPickFailed(err instanceof Error ? err.message : String(err)));
  };

  return (
    <Modal width={680} onDismiss={onClose} label="New run">
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready || busy) return;
          // **Submit is the conversation, not the run.** Enter in the brief field
          // reaches here, and so does the one button. The settings go with the
          // brief, in the message, so the pilot can carry them on `start_run`.
          onBrief(briefFor(task, planOnly, overrides), task.trim());
          onClose();
        }}
      >
        <div>
          <p className="mt-0 mb-1.5 text-body-sm text-accent-muted">A new beginning</p>
          <h2 className="m-0 text-title font-semibold tracking-tight text-display">What should we work on?</h2>
        </div>

        <label className={LABEL} htmlFor="brief">
          Your brief
        </label>
        <textarea
          id="brief"
          className={cn(FIELD, 'resize-y')}
          rows={5}
          value={task}
          placeholder="Describe the idea, the problem, and what a good result looks like."
          onChange={(e) => setTask(e.target.value)}
        />

        <label className={LABEL} htmlFor={locked ? undefined : 'newdir'}>
          Repository
        </label>
        {locked ? (
          // Stated, not offered. The project answered this, and a field here
          // would be a second way to answer it. See `locked` above.
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 font-mono text-mono-sm text-primary [overflow-wrap:anywhere]">{dir}</code>
            <Badge>from the project</Badge>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <input
                id="newdir"
                className={cn(FIELD, "min-w-0 flex-1 font-mono text-mono-sm")}
                value={dir}
                placeholder="Path to your project repository"
                onChange={(e) => onDir(e.target.value)}
              />
              <Button variant="secondary" onClick={choose} disabled={busy}>
                Browse…
              </Button>
            </div>
            {pickFailed !== null && (
              <p className={NOTE}>the chooser did not open: {pickFailed} — type or paste</p>
            )}
          </>
        )}

        <details className="rounded-sm bg-chrome p-3.5 [&_summary]:flex [&_summary]:cursor-pointer [&_summary]:flex-wrap [&_summary]:items-center [&_summary]:gap-2 [&_summary]:text-body-sm [&_summary]:text-primary" open={differing.length > 0}>
          <summary>
            overrides
            {differing.length > 0 ? (
              <Badge variant="accent">{differing.length} differ from project</Badge>
            ) : (
              <Badge>none — everything is the project default</Badge>
            )}
            {differing.length > 0 && (
              <Button variant="quiet" size="sm" onClick={() => setGates({})}>
                reset
              </Button>
            )}
          </summary>

          {cfg === null ? (
            <p className={cn(NOTE, "mt-3")}>
              The project&apos;s configuration could not be read, so this cannot show what differs
              from it — only what you set. Anything left alone stays the project default.
            </p>
          ) : (
            <table className="mt-3 w-full border-collapse text-body-sm [&_td]:border-t [&_td]:border-rule-inner [&_td]:px-2 [&_td]:py-1.5 [&_td]:align-middle [&_code]:font-mono [&_code]:text-mono-sm [&_code]:text-primary [&_select]:rounded-sm [&_select]:border [&_select]:border-rule-control [&_select]:bg-card [&_select]:px-2 [&_select]:py-1 [&_select]:text-body-sm [&_select]:text-primary">
              <tbody>
                {cfg.gateable.map((boundary) => {
                  const current = gates[boundary] ?? defaults[boundary] ?? '';
                  const changed = defaults[boundary] !== undefined && current !== defaults[boundary];
                  return (
                    <tr key={boundary} className={changed ? 'bg-active' : ''}>
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
                          <Badge variant="accent">changed from {defaults[boundary]}</Badge>
                        ) : (
                          <span className="text-tertiary">project default</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className={LABEL} htmlFor="cap">
              token cap
            </label>
            <input
              id="cap"
              className={cn(FIELD, 'w-40 py-1.5 font-mono text-mono-sm')}
              value={maxTokens}
              placeholder="empty — the project default"
              onChange={(e) => setMaxTokens(e.target.value)}
            />
            <label className={LABEL} htmlFor="tol">
              P1 tolerance
            </label>
            <input
              id="tol"
              className={cn(FIELD, 'w-24 py-1.5 font-mono text-mono-sm')}
              value={tolerance}
              placeholder="empty"
              onChange={(e) => setTolerance(e.target.value)}
            />
          </div>
          {/* Empty is not zero, and here the difference is load-bearing in both
              fields: `--max-tokens 0` turns the ceiling OFF, and a tolerance of
              0 demands a spotless verdict. */}
          <p className={cn(NOTE, "mt-2")}>
            Both are left alone when empty. A cap of <code>0</code> turns the ceiling off, and a
            tolerance of <code>0</code> demands a spotless verdict — neither is the same as saying
            nothing.
          </p>
          {badNumber && (
            <p className="m-0 text-body-sm text-emphasis">
              One of those is not a number, so nothing will be sent for it. Clear it or fix it.
            </p>
          )}
        </details>

        {/* Branch naming is automatic and worktree setup belongs to project
            settings. Neither needs another control in the brief composer. */}
        <p className={NOTE}>
          Your pilot helps refine the brief. You review the proposed run before it starts.
        </p>

        <label className="flex items-start gap-3 rounded-sm border border-rule-card bg-active p-3 text-body-sm text-secondary [&_strong]:text-primary">
          <input type="checkbox" className="mt-1 accent-accent" checked={planOnly} onChange={(e) => setPlanOnly(e.target.checked)} />
          <span>
            <strong>Start with a plan</strong><br />
            Stop after planning and critique. Turn this off to include code changes and commits.
          </span>
        </label>

        {/* No argv here any more. The command is drawn on the pilot's
            proposal card, which is where it is pressed — an argv in this modal
            would describe a command nothing on this screen runs. */}
        <div className="flex justify-end gap-2 border-t border-rule-inner pt-4">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!ready || busy}>
            Discuss with pilot
          </Button>
        </div>
      </form>
    </Modal>
  );
}
