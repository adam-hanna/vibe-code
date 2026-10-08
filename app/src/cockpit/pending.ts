import { dirKey, preview, renameRun } from './projects';
import type { RunName } from './projects';

/**
 * A run that has been asked for and not started yet (#223).
 *
 * **Pressing start in `1b` is where a run begins, as far as the person is
 * concerned** — and as far as the core is concerned nothing exists until the
 * pilot's proposal is pressed and `createRun` allocates an id. Those two
 * moments are a conversation apart, and the window used to draw nothing in
 * between: the brief went to the pilot, the sidebar showed no row, and when the
 * run finally started it arrived as a new row while the conversation that
 * decided it vanished. Asked for in as many words: *"The run should appear on
 * the left, under the project directly after hitting start. Then, when the
 * agent actually starts the vibe run or vibe plan command, a new run shouldn't
 * appear, its already there. Also, the previous chat history shouldnt go away."*
 *
 * So a draft is **this window's memory**, the same standing as a pin or a name
 * in `projects.ts`: it is not a run, it has no directory under `.vibe/runs`, and
 * nothing the core owns learns about it. It holds the project, a title and,
 * once the run it proposed has started, that run's id — which is what lets the
 * sidebar draw one row that turns into the run rather than two.
 *
 * Its conversation is keyed by the draft id through `chatKey`, like any run's,
 * and is **adopted** by the run when it starts — the ordinary rule in
 * `saved.ts`, reached because leaving a draft for the run it launched is a
 * start rather than a click.
 */
export interface Draft {
  /** The project it is in. A run proposed from it starts here and nowhere else. */
  dir: string;
  /** `draft-…`, unique to this window. Never a run id, and never sent to the host. */
  id: string;
  /** The first line of the brief, as typed — what the row is called. */
  task: string;
  /** When the person pressed start. */
  createdAt: number;
  /** Set when the pilot's proposal is pressed, so the run it starts can claim it. */
  launched: boolean;
  /** The run this became, once it said so. Null until `run_started`. */
  runId: string | null;
  /**
   * The title the person gave it in the new-run dialog, or null (#262).
   *
   * Null is the ordinary case and means *name it from the brief*, which is what
   * every draft saved before the field reads as. A title somebody typed is
   * theirs: the row shows it instead of a preview, and it becomes the run's
   * rename when the draft becomes a run, so pressing the pilot's proposal does
   * not swap it for the brief the pilot wrote.
   */
  name: string | null;
}

/** What a draft's row is called: the title somebody gave it, or its brief. */
export function draftTitle(d: Pick<Draft, 'name' | 'task'>): string {
  return d.name ?? preview(d.task);
}

/**
 * The run names once a draft has become run `runId` (#262).
 *
 * A typed title is written as the run's **rename** - the same store the row's
 * own ✎ writes - and not into the run's task: a rename is a label and never a
 * write to the run's record, and the task is the brief the run was given. A
 * draft with no title leaves the names exactly as they were, so the row goes on
 * being named from the brief as it always was.
 */
export function namesAfterStart(names: readonly RunName[], draft: Draft, runId: string): readonly RunName[] {
  return draft.name === null ? names : renameRun(names, draft.dir, runId, draft.name);
}

export const DRAFTS_KEY = 'vibe.drafts';

/** The prefix that keeps a draft id from ever being mistaken for a run id. */
export const DRAFT_PREFIX = 'draft-';

/**
 * A new draft. The randomness is passed in rather than drawn here, so this file
 * stays pure — the same arrangement `emit.ts` has for its window origin.
 */
export function newDraft(
  dir: string,
  task: string,
  now: number,
  salt: string,
  /** The title typed in the dialog. Blank is no title: the row is named from the brief. */
  name: string | null = null,
): Draft {
  return {
    dir: dir.trim(),
    id: `${DRAFT_PREFIX}${now.toString(36)}-${salt}`,
    task: task.trim(),
    createdAt: now,
    launched: false,
    runId: null,
    name: name === null || name.trim() === '' ? null : name.trim(),
  };
}

export function isDraftId(id: string | null): boolean {
  return id !== null && id.startsWith(DRAFT_PREFIX);
}

/** Read the list back. Anything unreadable is dropped, never repaired. */
export function readDrafts(raw: string | null): readonly Draft[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((d: unknown): Draft[] => {
    if (typeof d !== 'object' || d === null) return [];
    const r = d as Record<string, unknown>;
    const { dir, id, task, createdAt, launched, runId, name } = r;
    if (typeof dir !== 'string' || typeof id !== 'string' || !isDraftId(id)) return [];
    if (typeof task !== 'string' || typeof createdAt !== 'number') return [];
    return [
      {
        dir,
        id,
        task,
        createdAt,
        launched: launched === true,
        runId: typeof runId === 'string' ? runId : null,
        // Absent on every draft saved before #262, and that is no title.
        name: typeof name === 'string' && name.trim() !== '' ? name : null,
      },
    ];
  });
}

export function addDraft(list: readonly Draft[], draft: Draft): readonly Draft[] {
  return [...list.filter((d) => d.id !== draft.id), draft];
}

export function removeDraft(list: readonly Draft[], id: string): readonly Draft[] {
  return list.filter((d) => d.id !== id);
}

/** Mark that this draft's proposal was pressed. Only one draft is ever waiting. */
export function markLaunched(list: readonly Draft[], id: string): readonly Draft[] {
  return list.map((d) =>
    d.id === id ? { ...d, launched: true } : d.launched && d.runId === null ? { ...d, launched: false } : d,
  );
}

/**
 * The run a launched draft became.
 *
 * Only a draft that was **launched and not yet claimed** can be bound, so a run
 * started some other way — a resume, a terminal — never swallows a draft that
 * happens to be open.
 */
export function bindDraft(list: readonly Draft[], id: string, runId: string): readonly Draft[] {
  return list.map((d) => (d.id === id && d.launched && d.runId === null ? { ...d, runId } : d));
}

/**
 * The drafts a project section draws: its own, minus any whose run the archive
 * already lists — that row is drawn by the archive, and drawing both is the
 * second row the report was about.
 */
export function draftsIn(
  list: readonly Draft[],
  dir: string,
  archived: readonly string[],
): readonly Draft[] {
  const key = dirKey(dir);
  return list.filter(
    (d) => dirKey(d.dir) === key && (d.runId === null || !archived.includes(d.runId)),
  );
}

/** The drafts whose run the archive now holds, which can be forgotten. */
export function settled(list: readonly Draft[], dir: string, archived: readonly string[]): readonly string[] {
  const key = dirKey(dir);
  return list
    .filter((d) => dirKey(d.dir) === key && d.runId !== null && archived.includes(d.runId))
    .map((d) => d.id);
}

/**
 * Whether a draft on screen leaves the run column with nothing to draw.
 *
 * A draft that has not been started has no run behind it, so the column beside
 * its conversation has nothing true to show. It drew the window's last live run
 * instead: `viewing` is null on a draft, and the column fell through to `run`,
 * so starting a new run and talking it through with the pilot left the column
 * on whichever run had been open before. Once the proposal is pressed the draft
 * is `launched`, and the live run IS the one it asked for: the starting card,
 * then the run, as it binds.
 */
export function draftHasNoRun(draft: Draft | null): boolean {
  return draft !== null && !draft.launched;
}
