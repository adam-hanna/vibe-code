import { useState } from 'react';
import { Button } from '../design';
import { launchArgv } from './argv';
import { pickDirectory } from './pick';

/**
 * The minimum needed to have anything to watch.
 *
 * **This is not `4a` and must not grow into it.** The new-workstream modal has
 * project defaults, a branch picker with fetch freshness, a gate matrix, per-role
 * overrides and a setup preview - and every one of those needs a source of
 * project configuration that does not exist yet. A form that cannot express any
 * of it should not wear its name.
 *
 * What it produces is **argv**, because that is what the host takes and what the
 * CLI defines. The GUI's job here is a form to an argv, which is a pure function
 * - so the set of legal invocations still has exactly one definition and it is
 * `parseArgs`.
 */
export function Launch({
  onLaunch,
  busy,
  dir,
  onDir,
}: {
  onLaunch: (argv: readonly string[]) => void;
  busy: boolean;
  /**
   * The repository, owned by the cockpit rather than by this form (#223).
   *
   * Lifted because a second screen needs it: `1b` and ⌘K read the archive of a
   * repository, and both are reachable **before** anything is launched — which
   * is the moment they are most useful, since triage after a night of
   * unattended work happens before you start the next thing. A path that lived
   * in this component would exist only while the form was mounted, and the form
   * unmounts the moment a run starts.
   */
  dir: string;
  onDir: (dir: string) => void;
}) {
  const [task, setTask] = useState('');
  const [planOnly, setPlanOnly] = useState(true);
  const [pickFailed, setPickFailed] = useState<string | null>(null);

  const ready = task.trim() !== '' && dir.trim() !== '';

  // A chooser that could not open is said out loud rather than swallowed: the
  // field still works, so the failure is recoverable, and a button that does
  // nothing twice is how somebody concludes the app is broken.
  //
  // Both a choice and a cancel clear a previous failure, because either one
  // means the dialog opened - and a cancel changes nothing else, which is why
  // `null` cannot be allowed to reach `setDir`.
  const choose = () => {
    void pickDirectory()
      .then((chosen) => {
        setPickFailed(null);
        if (chosen !== null) onDir(chosen);
      })
      .catch((err: unknown) => setPickFailed(err instanceof Error ? err.message : String(err)));
  };

  return (
    <form
      className="v-launch"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || busy) return;
        // Building the argv the CLI would have been given is what keeps the two
        // front ends over one definition. `launchArgv` rather than a literal
        // here, because the pilot's `start_run` proposes the same thing and two
        // spellings of it would drift (#144).
        onLaunch(launchArgv(task, dir, planOnly));
      }}
    >
      <label className="v-launch__label" htmlFor="task">
        what are we doing
      </label>
      <textarea
        id="task"
        className="v-launch__task"
        rows={4}
        value={task}
        placeholder="the brief, in full — the runs that converge state the decisions already made"
        onChange={(e) => setTask(e.target.value)}
      />

      <label className="v-launch__label" htmlFor="dir">
        repository
      </label>
      {/* The field stays. A pasted path is a legitimate way to fill this in,
          and anybody who came here from a terminal will paste. */}
      <div className="v-launch__row">
        <input
          id="dir"
          className="v-launch__dir"
          value={dir}
          placeholder="an absolute path to a git worktree"
          onChange={(e) => onDir(e.target.value)}
        />
        <Button type="button" onClick={choose} disabled={busy}>
          choose…
        </Button>
      </div>
      {pickFailed !== null && (
        <p className="v-launch__note">the chooser did not open: {pickFailed} — type or paste instead</p>
      )}

      <label className="v-launch__toggle">
        <input type="checkbox" checked={planOnly} onChange={(e) => setPlanOnly(e.target.checked)} />
        <span>
          plan only — stop after the plan clears critique.{' '}
          <strong>Leave this on until you mean it:</strong> the other path writes code and commits.
        </span>
      </label>

      <Button level="primary" type="submit" disabled={!ready || busy}>
        {planOnly ? 'plan' : 'run'}
      </Button>
    </form>
  );
}
