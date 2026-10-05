/**
 * Projects and pins — the navigator's own state (#223).
 *
 * **A project is a repository, and that is the whole of the mapping.** The
 * sidebar borrows its shape from a product whose sidebar lists chats under
 * projects; here a project is a directory `vibe` has been pointed at and a
 * session is a **run** in that directory's `.vibe/runs`. Nothing is renamed in
 * the core: `listRuns` still decides what a run is, `archive` still answers per
 * directory, and this file only decides what the window remembers between
 * launches.
 *
 * ## Why this is allowed to be window state at all
 *
 * Everything else the cockpit draws comes from a frame, and that rule is not
 * bent here. **Which repositories you have open is not a fact about any run** —
 * no run knows about a sibling project, and `vibe.config.json` is a file meant
 * to be committed, so one machine's list of paths is the wrong thing to put in
 * it. `localStorage` already holds the repository and the pilot's spend ceiling
 * for exactly this reason. What is *in* a project still comes from the host.
 *
 * ## The pin carries the title, and that is not a cached measurement
 *
 * A pinned run is drawn whether or not its project is expanded, and the title
 * lives in that project's archive. Rather than read every project's archive on
 * every launch to render four pinned rows, a pin stores the task text with it.
 * That is safe because **a run's task never changes** — it is what the run was
 * started with, written once. It is not a number, nothing is computed from it,
 * and if a pin ever pointed at a run that has since gone the row says so rather
 * than inventing a state for it.
 */

/** Where the window's own lists live. Beside `vibe.repo`, which seeds them. */
export const PROJECTS_KEY = 'vibe.projects';
export const PINNED_KEY = 'vibe.pinned';
/** Names a person gave their runs. See `nameOf` for why this is not the task. */
export const NAMES_KEY = 'vibe.runnames';
/** What projects have been renamed to, by directory (#223). See `ProjectName`. */
export const PROJECT_NAMES_KEY = 'vibe.projectnames';

/**
 * How many runs a project shows before `Show more`.
 *
 * **A truncation, not a measurement**, which is what keeps it on the right side
 * of *never invent a number*: nothing is being estimated, the rest is one click
 * away, and the row that hides them says how many it is hiding. A project with
 * six runs shows six — the control only appears when it has something to reveal.
 */
export const SHOWN = 5;

/**
 * How much of a name a heading shows before it becomes a preview.
 *
 * A truncation, not a measurement — the same standing as `SHOWN` above, and on
 * the right side of *never invent a number* for the same reason: nothing is
 * estimated, nothing is lost, and the full text is drawn in the same dialog,
 * one row below the heading that previewed it.
 */
export const PREVIEW = 72;

/** The same, for a field, where a placeholder has a fraction of the room. */
export const PLACEHOLDER = 40;

export interface Pin {
  /** The project the run is in. A run id is only unique within one archive. */
  dir: string;
  runId: string;
  /** The task, copied when the pin was made. See the header on why that is safe. */
  task: string;
}

/**
 * A project's display name: the last segment of its path.
 *
 * Both separators, because a path typed on Windows may hold either and the one
 * the user typed is the one stored. A path that is nothing but separators, or
 * the empty string, has no name and says so rather than rendering blank.
 */
export function projectName(dir: string): string {
  const parts = dir.split(/[\\/]+/).filter((p) => p !== '');
  const last = parts[parts.length - 1];
  return last ?? dir.trim();
}

/**
 * The comparison key for a directory.
 *
 * Case-insensitive and separator-insensitive with any trailing separator
 * dropped, because `C:\Users\me\repo`, `C:/Users/me/repo/` and
 * `c:\users\me\repo` are one project on the platform this is developed on, and
 * adding the same repository three times because it was typed three ways is the
 * failure this prevents. **Only the comparison is normalised** — what is stored
 * and what is sent to the host is the string as it was given, because the host
 * has to open it.
 */
export function dirKey(dir: string): string {
  return dir.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

/**
 * The spelling this list already holds for a directory, or null.
 *
 * **Separate from `addProject` because adding and being told are two different
 * needs.** Seeding the current repository on every render must be silent — it
 * happens whether or not anybody did anything — while a person pressing *Add a
 * project* and getting nothing has been ignored by the window. The caller that
 * wants to say so asks first; the caller that does not, does not.
 *
 * It returns the **existing** spelling rather than `true`, because that is what
 * makes the message worth reading: somebody who typed `c:/users/me/repo` needs
 * to be shown `C:\Users\me\repo` to recognise which row is already theirs.
 */
export function findProject(list: readonly string[], dir: string): string | null {
  const key = dirKey(dir);
  return list.find((d) => dirKey(d) === key) ?? null;
}

/** Add a project, keeping the list unique and the newest first. */
export function addProject(list: readonly string[], dir: string): readonly string[] {
  const trimmed = dir.trim();
  if (trimmed === '') return list;
  // The existing spelling wins on a re-add: the list is not reordered and the
  // path is not rewritten, so a project does not jump around the sidebar
  // because somebody typed it again with a trailing slash.
  if (findProject(list, trimmed) !== null) return list;
  return [...list, trimmed];
}

/** A project, and the projects that live inside its directory. */
export interface ProjectNode {
  dir: string;
  children: readonly ProjectNode[];
}

/**
 * The project list as a tree: a directory inside another project is drawn under it (#223).
 *
 * **A worktree is a directory inside the repository it was made from**, and a run
 * started in one moves the window there — so `rememberRepo` added it to this list
 * as a project of its own, a top-level row named after a branch nobody added.
 * Reported as *"when I start a run via the 'talk it through' path, it doesn't
 * show up as a run under one of my projects"*: the run was there, filed under a
 * project the person had never seen.
 *
 * Nothing is merged and nothing is moved. A nested project keeps its own row and
 * its own archive, because `.vibe/runs` lives in the directory the run was given
 * and a parent that read its children's archives would be a second answer to
 * which runs a directory holds. It is only **drawn** where it lives.
 *
 * The parent is the **nearest** containing project, so a worktree inside a repo
 * inside a workspace lands under the repo. Containment is `dirKey`'s, so the
 * comparison has the same case and separator rules as every other one in this
 * file. Order is the list's own, at every level.
 */
export function nestProjects(list: readonly string[]): readonly ProjectNode[] {
  const keys = list.map(dirKey);
  const parentOf = keys.map((key, i) => {
    let best = -1;
    keys.forEach((other, j) => {
      if (j === i || other === key || !key.startsWith(`${other}/`)) return;
      if (best === -1 || other.length > (keys[best] ?? '').length) best = j;
    });
    return best;
  });
  const build = (parent: number): ProjectNode[] =>
    list.flatMap((dir, i) =>
      parentOf[i] === parent ? [{ dir, children: build(i) }] : [],
    );
  return build(-1);
}

/** Whether `dir` is `root` or anywhere inside it. */
export function within(root: string, dir: string): boolean {
  const r = dirKey(root);
  const d = dirKey(dir);
  return d === r || d.startsWith(`${r}/`);
}

/**
 * How a nested project is named under its parent: its path below the parent's,
 * as stored, so `.worktrees/gh-236` rather than a bare branch-shaped folder name.
 * Falls back to the folder name when the spellings do not line up character for
 * character, which `dirKey`'s case folding allows — a label is not worth
 * guessing a slice for.
 */
export function relativeTo(parent: string, dir: string): string {
  const head = parent.trim().replace(/[\\/]+$/, '');
  const body = dir.trim();
  if (body.length > head.length && dirKey(body.slice(0, head.length)) === dirKey(head)) {
    const rest = body.slice(head.length).replace(/^[\\/]+/, '').replace(/[\\/]+$/, '');
    if (rest !== '') return rest;
  }
  return projectName(dir);
}

export function removeProject(list: readonly string[], dir: string): readonly string[] {
  const key = dirKey(dir);
  return list.filter((d) => dirKey(d) !== key);
}

/** Whether two pins are the same run in the same project. */
export function samePin(a: Pin, b: Pin): boolean {
  return a.runId === b.runId && dirKey(a.dir) === dirKey(b.dir);
}

export function isPinned(pins: readonly Pin[], pin: Pin): boolean {
  return pins.some((p) => samePin(p, pin));
}

/** Pin it, or unpin it if it is already there. Newest pins last, as added. */
export function togglePin(pins: readonly Pin[], pin: Pin): readonly Pin[] {
  return isPinned(pins, pin) ? pins.filter((p) => !samePin(p, pin)) : [...pins, pin];
}

/**
 * What a project shows, and how many it is holding back.
 *
 * `hidden` is a count of rows, not a summary of them — the control it feeds says
 * `Show 12 more`, so a reader knows the size of what is behind it before
 * spending a click.
 */
export function visible<T>(
  runs: readonly T[],
  expanded: boolean,
): { shown: readonly T[]; hidden: number } {
  if (expanded || runs.length <= SHOWN) return { shown: runs, hidden: 0 };
  return { shown: runs.slice(0, SHOWN), hidden: runs.length - SHOWN };
}

/**
 * Read a stored list, or an empty one.
 *
 * **Whole-list-or-nothing on the shape, per entry on the content.** A stored
 * value that is not an array at all is a key somebody else wrote and is ignored;
 * an entry inside it that this build cannot read is dropped, because losing one
 * malformed pin is better than losing the other nine with it.
 */
export function readProjects(raw: string | null): readonly string[] {
  const parsed = parse(raw);
  if (parsed === null) return [];
  const out: string[] = [];
  for (const item of parsed) if (typeof item === 'string' && item.trim() !== '') out.push(item);
  return out;
}

export function readPins(raw: string | null): readonly Pin[] {
  const parsed = parse(raw);
  if (parsed === null) return [];
  const out: Pin[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const dir = row['dir'];
    const runId = row['runId'];
    if (typeof dir !== 'string' || typeof runId !== 'string') continue;
    // A pin with no task is readable and is drawn by its id. The title is a
    // convenience; the identity is the pair.
    out.push({ dir, runId, task: typeof row['task'] === 'string' ? row['task'] : runId });
  }
  return out;
}

// ---- names -----------------------------------------------------------------

/**
 * A name somebody gave a run, keyed the way a pin is (#223).
 *
 * **A label the window remembers, and deliberately not the run's task.** The
 * complaint was *"I should also be able to re-name runs so they aren't just my
 * initial prompt"*, and the obvious implementation — write the new text into
 * `state.json` — is the one thing that must not happen. `projects.ts`'s own
 * header says a pin may carry its task *because a run's task never changes: it
 * is what the run was started with, written once*, and a rename that rewrote it
 * would falsify that sentence and every pin resting on it. The brief is also the
 * thing the planner was actually given; a record of a run that reported a
 * different one would be a record of a run that did not happen.
 *
 * So the task stays exactly as the run recorded it and this sits in front of it
 * for display. Clearing a name brings the task back rather than leaving a blank,
 * which is why `nameOf` takes the fallback rather than returning null.
 */
export interface RunName {
  dir: string;
  runId: string;
  /** What to show instead of the task. Never empty — an empty name is no name. */
  name: string;
}

/** The name for a run, or the task it was started with. */
export function nameOf(
  names: readonly RunName[],
  dir: string,
  runId: string,
  task: string,
): string {
  const key = dirKey(dir);
  const found = names.find((n) => n.runId === runId && dirKey(n.dir) === key);
  return found?.name ?? task;
}

/**
 * The first line of a name, shortened to fit a heading (#223).
 *
 * **A run's name is its brief until somebody renames it, and a brief is a
 * document.** The delete confirmation put one straight into its own title and
 * the dialog grew past the bottom of the screen, taking its own Cancel button
 * with it: *"This screen pops up and I cant click out of it. Why does the
 * entire prompt show up?"*
 *
 * Every other surface that draws a task was already bounded — `.v-nav__title`
 * and `.v-switch__task` by an ellipsis, `.v-ident__name` by a two-line clamp —
 * so this is the one case CSS could not cover, because the string *is* the
 * heading. The layout half of the bound is still CSS's job and is still done
 * there; this is the text half, and the two are not alternatives: a modal that
 * cannot outgrow the viewport is what stops the next long string breaking it,
 * and a heading that is a preview is what makes the dialog readable.
 *
 * It **only ever shortens**. A name already short enough comes back
 * byte-identical, with no ellipsis to suggest something was left out — which
 * matters because a renamed run's name is usually already a name.
 */
export function preview(text: string, limit = PREVIEW): string {
  // The first non-empty line. A brief opens with its subject and the rest is
  // the specification, which is what makes a first line a *preview* rather than
  // an arbitrary prefix.
  const first = text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  const flat = first.trim().replace(/\s+/g, ' ');
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  // A word boundary, but only one that keeps most of the budget: a line whose
  // only space is at character three would otherwise be cut to a single word,
  // which is a worse preview than a hard cut mid-word.
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * Set a run's name, or clear it when the text is empty.
 *
 * **Empty clears rather than storing a blank**, because the two are the same
 * intention — somebody who deletes a name wants the run's own brief back, and a
 * stored empty string would draw a row with no title at all. It is also what
 * keeps the list from growing an entry per run somebody opened the rename box on
 * and thought better of.
 */
export function renameRun(
  names: readonly RunName[],
  dir: string,
  runId: string,
  name: string,
): readonly RunName[] {
  const key = dirKey(dir);
  const rest = names.filter((n) => !(n.runId === runId && dirKey(n.dir) === key));
  const trimmed = name.trim();
  return trimmed === '' ? rest : [...rest, { dir, runId, name: trimmed }];
}

export function readNames(raw: string | null): readonly RunName[] {
  const parsed = parse(raw);
  if (parsed === null) return [];
  const out: RunName[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const dir = row['dir'];
    const runId = row['runId'];
    const name = row['name'];
    // All three required, and the name must have something in it: an entry that
    // cannot be drawn is one that would hide a run's real title behind nothing.
    if (typeof dir !== 'string' || typeof runId !== 'string') continue;
    if (typeof name !== 'string' || name.trim() === '') continue;
    out.push({ dir, runId, name });
  }
  return out;
}

/**
 * A project's name, when somebody gave it one (#223): *"I'd like to be able to
 * rename projects and runs"*.
 *
 * **A label in this window, never a rename on disk**, for the run name's reason
 * one level up. A project *is* its repository, and every request this window
 * sends names the directory — so the directory stays exactly what it is, and
 * this sits in front of the folder name for display. Keyed through `dirKey`
 * like a pin, so one repository typed two ways has one name; clearing it brings
 * the folder name back.
 */
export interface ProjectName {
  dir: string;
  name: string;
}

/** The name for a project, or `fallback` — its folder, or its path under a parent. */
export function projectLabel(names: readonly ProjectName[], dir: string, fallback: string): string {
  const key = dirKey(dir);
  return names.find((n) => dirKey(n.dir) === key)?.name ?? fallback;
}

/** Set a project's name, or clear it when the text is empty — `renameRun`'s rule. */
export function renameProject(
  names: readonly ProjectName[],
  dir: string,
  name: string,
): readonly ProjectName[] {
  const key = dirKey(dir);
  const rest = names.filter((n) => dirKey(n.dir) !== key);
  const trimmed = name.trim();
  return trimmed === '' ? rest : [...rest, { dir, name: trimmed }];
}

/** Drop a project's name, for one this window is no longer listing. */
export function forgetProjectName(names: readonly ProjectName[], dir: string): readonly ProjectName[] {
  const key = dirKey(dir);
  return names.filter((n) => dirKey(n.dir) !== key);
}

export function readProjectNames(raw: string | null): readonly ProjectName[] {
  const parsed = parse(raw);
  if (parsed === null) return [];
  const out: ProjectName[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const dir = row['dir'];
    const name = row['name'];
    if (typeof dir !== 'string' || typeof name !== 'string' || name.trim() === '') continue;
    out.push({ dir, name });
  }
  return out;
}

/**
 * Point a project at another directory (#223): *"We need to be able to edit the
 * project root dir in the project settings."*
 *
 * The case it is for is a project added one level off — `~/apps/erm` when the
 * repository is `~/apps/erm/erm` — and a repository that moved. So everything
 * this window remembers *about* the project follows it: its place in the list,
 * its name, its pins and its runs' names. Nothing on disk moves, and nothing is
 * copied: the settings shown afterwards are the new directory's own
 * `vibe.config.json`, and its runs are whatever its own `.vibe/runs` holds.
 *
 * Refused, with the sentence to show, when the new directory is empty or is
 * already a project — merging two rows' memories is not what anybody asked for,
 * and doing it silently would be the duplicate `addAndSay` exists to say out loud.
 */
export interface Remembered {
  projects: readonly string[];
  pins: readonly Pin[];
  names: readonly RunName[];
  projectNames: readonly ProjectName[];
}

export function moveProject(
  from: string,
  to: string,
  held: Remembered,
): { ok: true; held: Remembered } | { ok: false; why: string } {
  const next = to.trim();
  if (next === '') return { ok: false, why: 'give the directory the project should point at' };
  if (dirKey(next) === dirKey(from)) return { ok: false, why: 'that is already where this project points' };
  const already = findProject(held.projects, next);
  if (already !== null) return { ok: false, why: `${already} is already a project` };
  const key = dirKey(from);
  const here = (dir: string): boolean => dirKey(dir) === key;
  return {
    ok: true,
    held: {
      projects: held.projects.map((d) => (here(d) ? next : d)),
      pins: held.pins.map((p) => (here(p.dir) ? { ...p, dir: next } : p)),
      names: held.names.map((n) => (here(n.dir) ? { ...n, dir: next } : n)),
      projectNames: held.projectNames.map((n) => (here(n.dir) ? { ...n, dir: next } : n)),
    },
  };
}


/** Drop every name for a run that is gone, so the list does not grow for ever. */
export function forgetNames(
  names: readonly RunName[],
  dir: string,
  runId: string,
): readonly RunName[] {
  const key = dirKey(dir);
  return names.filter((n) => !(n.runId === runId && dirKey(n.dir) === key));
}

/** The same, for every run in a project this window is no longer listing. */
export function forgetProjectPins(pins: readonly Pin[], dir: string): readonly Pin[] {
  const key = dirKey(dir);
  return pins.filter((p) => dirKey(p.dir) !== key);
}

function parse(raw: string | null): unknown[] | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}
