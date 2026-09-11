import { describe, expect, test } from 'vitest';
import cockpit from './Cockpit.tsx?raw';
import {
  SHOWN,
  addProject,
  dirKey,
  isPinned,
  projectName,
  readPins,
  readProjects,
  removeProject,
  togglePin,
  visible,
} from './projects';

/**
 * The navigator's own state (#223).
 *
 * **The sidebar is the one surface in the cockpit that remembers something**, so
 * it is the one that needs this file: which repositories you have open and which
 * runs you pinned are not facts about any run, and no frame carries them. What
 * is *in* a project still comes from the host, and `rail()` still decides which
 * of its entries may be drawn.
 */

describe('a project is a repository, named by its last segment', () => {
  test('both separators, because a path is stored as it was typed', () => {
    expect(projectName('C:\\Users\\me\\vibe-code')).toBe('vibe-code');
    expect(projectName('/home/me/vibe-code')).toBe('vibe-code');
    expect(projectName('C:/Users/me/vibe-code/')).toBe('vibe-code');
  });

  test('a path with no segments falls back to itself rather than to blank', () => {
    // A row with no text in it reads as a rendering failure. Whatever the user
    // typed is at least a thing they can recognise.
    expect(projectName('/')).toBe('/');
    expect(projectName('repo')).toBe('repo');
  });
});

describe('one repository is one project, however it was typed', () => {
  test('case, separators and a trailing slash do not make a second project', () => {
    // The failure this prevents is a sidebar listing the same repository three
    // times because it was added from three places.
    let list = addProject([], 'C:\\Users\\me\\repo');
    list = addProject(list, 'C:/Users/me/repo/');
    list = addProject(list, 'c:\\users\\me\\repo');
    expect(list).toEqual(['C:\\Users\\me\\repo']);
  });

  test('the first spelling is kept, and the list is not reordered', () => {
    // A project that jumped around the sidebar because somebody typed it again
    // with a trailing slash would be motion with no meaning behind it.
    const list = addProject(addProject([], 'a/one'), 'b/two');
    expect(addProject(list, 'b/two/')).toEqual(['a/one', 'b/two']);
  });

  test('an empty path is not a project', () => {
    expect(addProject([], '   ')).toEqual([]);
  });

  test('removing takes the one that matches however it was spelled', () => {
    expect(removeProject(['C:\\me\\repo', 'C:\\me\\other'], 'c:/me/repo/')).toEqual([
      'C:\\me\\other',
    ]);
  });

  test('the key normalises for comparison only', () => {
    expect(dirKey('C:\\Me\\Repo\\')).toBe(dirKey('c:/me/repo'));
    expect(dirKey('a/one')).not.toBe(dirKey('a/two'));
  });
});

describe('a pin is a run in a project, and both halves matter', () => {
  const a = { dir: '/p/one', runId: 'r1', task: 'build a todo app' };
  const b = { dir: '/p/two', runId: 'r1', task: 'something else' };

  test('the same run id in two projects is two pins', () => {
    // A run id is only unique within one archive, so pinning by id alone would
    // make two different runs one row.
    const pins = togglePin(togglePin([], a), b);
    expect(pins).toHaveLength(2);
    expect(isPinned(pins, a)).toBe(true);
    expect(isPinned(pins, b)).toBe(true);
  });

  test('pinning twice unpins, and the directory is matched loosely', () => {
    const pins = togglePin([], a);
    expect(togglePin(pins, { ...a, dir: '/p/one/' })).toEqual([]);
  });
});

describe('what a project shows before Show more', () => {
  const runs = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

  test('a short list is shown whole, and the control does not appear', () => {
    // The control exists to reveal something. A `Show 0 more` is a button that
    // does nothing, which teaches you to stop reading the ones that do.
    const { shown, hidden } = visible(runs(SHOWN), false);
    expect(shown).toHaveLength(SHOWN);
    expect(hidden).toBe(0);
  });

  test('a long list is cut, and says how many it is holding back', () => {
    const { shown, hidden } = visible(runs(SHOWN + 12), false);
    expect(shown).toHaveLength(SHOWN);
    // A count of rows, not a summary of them: the reader knows the size of what
    // is behind the click before spending it.
    expect(hidden).toBe(12);
  });

  test('expanded shows everything', () => {
    expect(visible(runs(40), true).shown).toHaveLength(40);
    expect(visible(runs(40), true).hidden).toBe(0);
  });
});

describe('stored lists are read defensively, because storage is shared', () => {
  test('nothing stored is an empty list, not a failure', () => {
    expect(readProjects(null)).toEqual([]);
    expect(readPins(null)).toEqual([]);
  });

  test('a value somebody else wrote is ignored rather than thrown on', () => {
    // `localStorage` is one namespace for the whole origin. A key that is not
    // ours must not be able to stop the window rendering.
    expect(readProjects('not json')).toEqual([]);
    expect(readProjects('{"nope":1}')).toEqual([]);
    expect(readPins('12')).toEqual([]);
  });

  test('one unreadable entry is dropped, and the rest survive', () => {
    // Per-entry rather than whole-list: losing one malformed pin is better than
    // losing the other nine with it.
    expect(readProjects('["a", 3, "", "b"]')).toEqual(['a', 'b']);
    expect(
      readPins('[{"dir":"/p","runId":"r1","task":"t"},{"dir":"/p"},{"runId":"r2"}]'),
    ).toEqual([{ dir: '/p', runId: 'r1', task: 't' }]);
  });

  test('a pin with no task is drawn by its id rather than dropped', () => {
    // The identity is the pair; the title is a convenience. A pin that still
    // points somewhere is worth keeping.
    expect(readPins('[{"dir":"/p","runId":"r1"}]')).toEqual([
      { dir: '/p', runId: 'r1', task: 'r1' },
    ]);
  });
});

describe('the sidebar is the navigator, and 1b is where a lock is overruled', () => {
  // Source-read, because the claim is about wiring rather than about pixels.
  test('there is one sidebar, and no rail beside it', () => {
    // The defect: a 54px rail headed `RUNS` next to a panel headed `Runs`, both
    // drawing the same archive. Reported as *"there are two Runs bars"*.
    expect(cockpit).toMatch(/<Sidebar/);
    expect(cockpit).not.toMatch(/<Rail\b/);
  });

  test('the rail’s three controls survive the collapse', () => {
    // §1.1 of `design/AUDIT.md` was never "there should be a strip" — it was
    // that `＋ ⌘K ⚙` had nowhere to live and ended up in the tab bar. A panel
    // that shut them away would put the finding straight back.
    const from = cockpit.indexOf('shut={');
    const strip = from < 0 ? '' : cockpit.slice(from, cockpit.indexOf('<Sidebar', from));
    expect(strip).toMatch(/＋/);
    expect(strip).toMatch(/⌘K/);
    expect(strip).toMatch(/⚙/);
  });

  test('1b is still reachable, and still has no tab of its own', () => {
    // The same arrangement `settings` has: reached from the sidebar, absent from
    // the bar. Two places able to force a lock is one too many, and a tab for it
    // is how the bar got to twelve.
    expect(cockpit).toMatch(/tab === 'runs' &&/);
    expect(cockpit).toMatch(/<Workstreams/);
    const from = cockpit.indexOf('<div className="v-cockpit__tabs">');
    const to = cockpit.indexOf("{tab === 'pilot' && ", from);
    const bar = from < 0 ? '' : cockpit.slice(from, to < 0 ? cockpit.length : to);
    expect(bar).not.toMatch(/>\s*Runs\b/);
  });
});
