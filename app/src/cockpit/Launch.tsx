import { useState } from 'react';
import { Button } from '../design';
import { launchArgv } from './argv';

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
}: {
  onLaunch: (argv: readonly string[]) => void;
  busy: boolean;
}) {
  const [task, setTask] = useState('');
  const [dir, setDir] = useState('');
  const [planOnly, setPlanOnly] = useState(true);

  const ready = task.trim() !== '' && dir.trim() !== '';

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
      <input
        id="dir"
        className="v-launch__dir"
        value={dir}
        placeholder="an absolute path to a git worktree"
        onChange={(e) => setDir(e.target.value)}
      />

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
