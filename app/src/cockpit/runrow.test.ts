import { describe, expect, test } from 'vitest';
import cockpit from './Cockpit.tsx?raw';
import sidebar from './Sidebar.tsx?raw';
import newWorkstream from './NewWorkstream.tsx?raw';
import surfaces from '../design/Surfaces.tsx?raw';
import {
  forgetNames,
  forgetProjectPins,
  nameOf,
  readNames,
  renameRun,
} from './projects';
import type { Pin, RunName } from './projects';

/**
 * What a person can do to a run from the sidebar (#223).
 *
 * Five reports, and the thread running through them is that the sidebar had
 * grown into the navigator without growing any of the verbs a navigator needs:
 * *"I should be able to add a new run directly to a project"*, *"I should be
 * able to delete a run, and a project"*, *"I can't type in the 'What are we
 * doing' window"*, *"there is nothing under the plan and critiques tabs"* and
 * *"I should also be able to re-name runs so they aren't just my initial
 * prompt"*.
 *
 * They are in one file because they are one surface and because two of them
 * constrain each other: exactly one control in a run's row reaches a disk, so
 * exactly one confirms, and a test that checked the confirmation without
 * checking which controls have one would pass a build where pinning asked.
 */

describe('a run can be renamed, and the run’s own task is not touched', () => {
  const names: readonly RunName[] = [
    { dir: 'C:\\Users\\me\\repo', runId: 'r1', name: 'the todo app' },
  ];

  test('the name wins, and the task is what there is without one', () => {
    expect(nameOf(names, 'C:\\Users\\me\\repo', 'r1', 'build a todo app with…')).toBe(
      'the todo app',
    );
    expect(nameOf(names, 'C:\\Users\\me\\repo', 'r2', 'another brief')).toBe('another brief');
    expect(nameOf([], 'C:\\Users\\me\\repo', 'r1', 'a brief')).toBe('a brief');
  });

  test('one repository typed two ways is one run', () => {
    // The same normalising a pin and a saved conversation use, for the same
    // reason: a name that vanished because a path was typed with a trailing
    // slash would look exactly like a name that was lost.
    expect(nameOf(names, 'c:/users/me/repo/', 'r1', 'a brief')).toBe('the todo app');
  });

  test('a run id is only unique inside one archive, so the project is part of the key', () => {
    expect(nameOf(names, 'C:\\Users\\me\\other', 'r1', 'a brief')).toBe('a brief');
  });

  test('renaming replaces rather than appends', () => {
    const once = renameRun(names, 'C:\\Users\\me\\repo', 'r1', 'todos, take two');
    expect(once).toHaveLength(1);
    expect(nameOf(once, 'C:\\Users\\me\\repo', 'r1', 'a brief')).toBe('todos, take two');
  });

  test('an empty name clears it rather than storing a blank', () => {
    // The two are one intention — somebody who deletes a name wants the run's
    // own brief back — and a stored empty string would draw a row with no title
    // at all. It is also what keeps the list from growing an entry per run
    // somebody opened the box on and thought better of.
    for (const blank of ['', '   ']) {
      const cleared = renameRun(names, 'C:\\Users\\me\\repo', 'r1', blank);
      expect(cleared).toHaveLength(0);
      expect(nameOf(cleared, 'C:\\Users\\me\\repo', 'r1', 'a brief')).toBe('a brief');
    }
  });

  test('the name is trimmed, because a padded one is not a different name', () => {
    expect(renameRun([], '/p', 'r1', '  todos  ')[0]?.name).toBe('todos');
  });

  test('a run that is gone takes its name with it', () => {
    expect(forgetNames(names, 'c:/users/me/repo', 'r1')).toHaveLength(0);
    expect(forgetNames(names, 'C:\\Users\\me\\repo', 'r2')).toHaveLength(1);
  });

  test('a project that is no longer listed takes its pins with it', () => {
    // A pinned row drawn under Pinned for a project that is not in the list is a
    // run with no way back to its own archive.
    const pins: readonly Pin[] = [
      { dir: 'C:\\Users\\me\\repo', runId: 'r1', task: 'a' },
      { dir: 'C:\\Users\\me\\other', runId: 'r2', task: 'b' },
    ];
    const left = forgetProjectPins(pins, 'c:/users/me/repo/');
    expect(left).toHaveLength(1);
    expect(left[0]?.runId).toBe('r2');
  });

  test('a rename is window memory and never a write to the run’s record', () => {
    // `projects.ts`'s header says a pin may carry its task *because a run's task
    // never changes*, and every pin rests on that sentence. A rename that wrote
    // the new text into `state.json` would falsify it — and would make the run's
    // record report a brief the planner was never given.
    expect(sidebar).toMatch(/NAMES_KEY/);
    expect(sidebar).not.toMatch(/host\.\w+\([^)]*\bname\b/);
  });
});

describe('reading stored names', () => {
  test('nothing stored, and values somebody else wrote, are an empty list', () => {
    // `localStorage` is one namespace for the whole origin, and a sidebar that
    // threw on a key that is not ours would take the window with it.
    for (const raw of [null, 'not json', '7', '"a string"', '{}']) {
      expect(readNames(raw)).toEqual([]);
    }
  });

  test('an entry that cannot be drawn is dropped, and the rest survive', () => {
    // Whole-list-or-nothing on the shape, per entry on the content — the same
    // rule `readPins` follows. An empty name is dropped rather than stored,
    // because it would hide a run's real title behind nothing.
    const read = readNames(
      JSON.stringify([
        { dir: '/p', runId: 'r1', name: 'kept' },
        { dir: '/p', runId: 'r2' },
        { dir: '/p', runId: 'r3', name: '   ' },
        { runId: 'r4', name: 'no dir' },
        'not an object',
      ]),
    );
    expect(read).toHaveLength(1);
    expect(read[0]?.name).toBe('kept');
  });
});

describe('the row’s controls, and which of them reach a disk', () => {
  test('a project starts a run in itself, with the directory already settled', () => {
    // *"There needs to be a plus icon right justified by products where I can
    // start a new run. In this window, I shouldn't have to select the project
    // folder, it's already known."*
    expect(sidebar).toMatch(/onNewIn\(dir\)/);
    expect(cockpit).toMatch(/setComposing\(\{ dir: next, locked: true \}\)/);
  });

  test('the locked composer states the repository and offers no way to change it', () => {
    // A project IS a repository, so a second control setting it is the third
    // spelling #211 warns about. The path is still shown, because which
    // repository a run writes to cannot be taken back later.
    const from = newWorkstream.indexOf('{locked ? (');
    expect(from).toBeGreaterThan(-1);
    const fixed = newWorkstream.slice(from, newWorkstream.indexOf(') : (', from));
    expect(fixed).toMatch(/v-new__fixed/);
    expect(fixed).not.toMatch(/<input/);
    expect(fixed).not.toMatch(/onClick=\{choose\}/);
  });

  test('deleting confirms; pinning and renaming do not', () => {
    // Exactly one control in the row reaches a disk, so exactly one confirms. A
    // pin and a name are this window's own memory and change nothing in any
    // repository.
    const row = sidebar.slice(
      sidebar.indexOf('function RunRow'),
      sidebar.indexOf('function Project'),
    );
    expect(row).not.toMatch(/host\.deleteRun/);
    expect(row).not.toMatch(/Confirm/);
    expect(sidebar).toMatch(/setPending\(\{ kind: 'run'/);
    expect(sidebar).toMatch(/setPending\(\{ kind: 'project'/);
  });

  test('the two dialogs say opposite things about what is destroyed', () => {
    // Two controls a pixel apart, one of which deletes files and one of which
    // does not. The confirmation is the only thing that can tell them apart.
    expect(sidebar).toMatch(/kicker="deletes files"/);
    expect(sidebar).toMatch(/kicker="deletes nothing"/);
    // And the delete says what survives it, because the commits do.
    expect(sidebar).toMatch(/those are in git, not in \.vibe\/runs/);
  });

  test('the core’s refusal stays on the dialog rather than closing it', () => {
    // A window that closed on *"it is still running"* would look exactly like
    // one that had succeeded — and those need opposite next actions.
    expect(sidebar).toMatch(/setRefused\(err instanceof Error \? err\.message : String\(err\)\)/);
    expect(sidebar).toMatch(/problem=\{refused\}/);
  });

  test('every guard that matters is the core’s, not the window’s', () => {
    // The window's half is the confirmation. A live lock, an unreadable one, an
    // id that escapes `.vibe/runs` and a linked run directory are all refused by
    // `deleteRun`, because the core is the process holding the filesystem.
    expect(sidebar).toMatch(/\.deleteRun\(at\.dir, at\.runId\)/);
    expect(sidebar).not.toMatch(/livenessOf|run\.lock/);
  });
});

describe('the window points at the run it is showing', () => {
  test('starting a run stops the panes reading whichever one was open', () => {
    // The report was all one defect: *"the planner is currently running plan 0,
    // but I see nothing in the output tab… there is nothing under the plan and
    // critiques tabs! No questions either, even though it says three raised."*
    // The Questions **tab** counts the live run and the **pane** was forced to
    // null by `past`, which is why the badge and the pane disagreed.
    const launch = cockpit.slice(cockpit.indexOf('const launch = useCallback'));
    expect(launch.slice(0, launch.indexOf('[send],'))).toMatch(/setViewing\(null\)/);
  });

  test('a live run’s artifacts are read in the run’s own repository', () => {
    // `repoDir` is where the WINDOW is pointed and the sidebar moves it, so a
    // live run's `.vibe/runs/<id>` was being looked for under whichever project
    // had most recently been clicked — and a pane that finds nothing says *no
    // plans yet*, which is indistinguishable from a planner still working.
    expect(cockpit).toMatch(
      /const shownDir = viewing\?\.dir \?\? run\.identity\?\.repo \?\? repoDir/,
    );
  });

  test('a deleted run is only dropped when it is the one on screen', () => {
    // The sidebar can delete any run in any project. Clearing `viewing` for one
    // nobody was looking at would throw away a reader's place for no reason.
    expect(cockpit).toMatch(/at\.runId === deletedRunId && at\.dir === deletedDir \? null : at/);
  });
});

describe('a modal does not take focus back on every render', () => {
  const modal = surfaces.slice(surfaces.indexOf('export function Modal'));

  test('the scrim is focused once, from a mount effect and not a callback ref', () => {
    // This was `ref={(el) => el?.focus()}`. An inline callback ref is a new
    // identity on every render, so React detaches and re-attaches it every time
    // — and the cockpit re-renders once a second off its own clock and again on
    // every keystroke, because a controlled field's `onChange` sets state in the
    // component above. Reported exactly: *"I can't type in the 'What are we
    // doing' window, it keeps going out of focus when I try typing in it."*
    //
    // Asserted on the JSX attribute rather than by searching the whole
    // component for the old line: the docblock above it **quotes** that line, on
    // purpose, and a test that matched it would fail on the explanation of its
    // own fix.
    expect(modal).toMatch(/\n\s*ref=\{scrim\}\n/);
    expect(modal).toMatch(/useEffect\(/);
    expect(modal).toMatch(/scrim\.current\?\.focus\(\)/);
    expect(modal).toMatch(/\}, \[\]\)/);
  });

  test('escape still leaves, from anywhere inside the dialog', () => {
    // Focusing the scrim at all is still right: a keydown from a field inside
    // bubbles up to it. A dialog whose every control is unreachable is a stuck
    // application, not a stuck dialog (#211).
    expect(modal).toMatch(/onKeyDown/);
    expect(modal).toMatch(/e\.key === 'Escape'\) onDismiss\(\)/);
  });
});
