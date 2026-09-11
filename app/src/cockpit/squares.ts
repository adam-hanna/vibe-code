import type { ArchiveRun } from '../host';

/**
 * What the navigator may draw, and the two letters that stand for a run
 * (hi-fi 1, hi-fi 5, #223).
 *
 * The pure half, here rather than in the component for the reason `model.ts` is
 * pure: a label derived from a string is the kind of thing that is wrong in one
 * unusual case and invisible in every other, and a component cannot be tested.
 *
 * **The rail it was written for is gone and this is not.** `Rail.tsx` and the
 * runs panel beside it were the same archive drawn twice — *"there are two Runs
 * bars on the left now"* — so they became one `Sidebar`, and the rail survives
 * as its collapsed strip. What that rewrite must not lose is the *filtering*:
 * `rail()` is still the one place deciding which archive entries may be drawn at
 * all, and it is now the sidebar that asks it.
 *
 * `initials` moved with it rather than being kept for a rainy day: a sidebar row
 * has room for the whole task, and the **collapsed** strip has room for two
 * letters, so it is the mark on the shut panel. That is the rail's own idea in
 * the one place it is still needed — the strip says which run you are in, which
 * is the one fact a 54px column can carry.
 */

/**
 * `VC`, `TS` — two letters standing for a workstream.
 *
 * **A label, not a measurement.** Nothing is being counted or estimated here;
 * the full task travels with it as the square's title, so the abbreviation
 * cannot be the only thing a reader has. That is what keeps it on the right side
 * of *never invent a number* — an initial that reads oddly costs a glance, and
 * the whole string is one hover away.
 *
 * Words rather than characters, so `build-a-todo-app` gives `BT` and not `BU`.
 * A task with one word takes its first two letters; a task with nothing legible
 * in it at all gets `··`, which is the same "no value" mark the loop column uses
 * rather than a letter picked out of an id.
 */
export function initials(task: string): string {
  const words = task
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '')
    // Articles and prepositions carry no identity, and a rail full of `AT` and
    // `TH` would abbreviate every workstream to the same two letters.
    .filter((w) => !['a', 'an', 'the', 'of', 'to', 'in', 'for'].includes(w.toLowerCase()));
  const first = words[0];
  if (first === undefined) return '··';
  const second = words[1];
  const mark =
    second === undefined
      ? first.slice(0, 2).padEnd(2, first[0] ?? '')
      : (first[0] ?? '') + (second[0] ?? '');
  // Upper case here rather than in CSS: `text-transform` would leave the string
  // this function returns disagreeing with the string on screen, and this is
  // the value a test can see.
  return mark.toUpperCase();
}

/** One square on the rail. */
export interface RailRun {
  id: string;
  mark: string;
  task: string;
  status: string;
  /** True only when the archive said this run's lock is held by a live process. */
  live: boolean;
  /** True when this is the run the window is currently showing. */
  current: boolean;
}

/**
 * The rail, from the archive and the run in front of you.
 *
 * **`live` is the archive's verdict and never one derived here.** `livenessOf`
 * reads the lock, probes the pid and reads the ending stamp; a rail deciding for
 * itself that a run "looks running" would be a second classifier, and the one on
 * screen would be the one that disagreed with `vibe list`.
 *
 * Runs the archive refused - a symlink it would not follow, an entry `lstat`
 * could not classify - are left off entirely. A square is an invitation to open
 * something, and those are precisely the entries nothing should open.
 */
export function rail(runs: readonly ArchiveRun[], currentId: string | null): readonly RailRun[] {
  return runs
    .filter((r) => r.linked !== true && r.unverified !== true)
    .map((r) => ({
      id: r.id,
      mark: initials(r.task),
      task: r.task,
      status: r.status,
      live: r.liveness === 'running',
      current: currentId !== null && r.id === currentId,
    }));
}
