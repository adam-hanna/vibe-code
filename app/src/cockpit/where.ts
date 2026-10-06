/**
 * Where the window was pointed, kept between launches (#223).
 *
 * Every relaunch landed on the pilot with no run open, so somebody who closed
 * the app while reading round 3's critique came back to the front door and had
 * to find the run again in the sidebar. Asked for in the inventory of what was
 * still only in memory: *"the run you had open and the tab are enough."*
 *
 * **Which run is open, never what it holds.** `viewing` is a pointer - a
 * directory and an id - and opening it is a read, so restoring it costs what a
 * click on the sidebar costs and starts nothing. The column is rebuilt from the
 * run's own files exactly as it is on a click. The task is kept beside it for
 * the reason a pin carries one: a run's task never changes.
 *
 * Collapsed panels are deliberately not here, for the reason `Cockpit` gives -
 * a collapse is a gesture for the next few minutes. Pure, for `model.ts`'s
 * reason: the app has no jsdom, so a read that lived in an effect would be a
 * read nothing tests.
 */

export const WHERE_KEY = 'vibe.where';

/** The tabs a launch may come back to. A tab missing here comes back as the pilot. */
export const TABS = [
  'output',
  'pilot',
  'plans',
  'critique',
  'review',
  'code',
  'verify',
  'spend',
  'questions',
  'runs',
  'commands',
  'settings',
] as const;

export type Tab = (typeof TABS)[number];

export interface Viewing {
  dir: string;
  runId: string;
  task: string;
}

export interface Where {
  tab: Tab;
  viewing: Viewing | null;
  /** A draft row that was open. Checked against the drafts by the caller. */
  draftId: string | null;
}

/** Where a fresh window lands, and where an unreadable record lands too. */
export const NOWHERE: Where = { tab: 'pilot', viewing: null, draftId: null };

function isTab(v: unknown): v is Tab {
  return typeof v === 'string' && (TABS as readonly string[]).includes(v);
}

function viewingOf(v: unknown): Viewing | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const { dir, runId, task } = r;
  if (typeof dir !== 'string' || dir === '' || typeof runId !== 'string' || runId === '') return null;
  return { dir, runId, task: typeof task === 'string' ? task : '' };
}

/**
 * Read it back. Each field fails on its own: a tab this build no longer has
 * should not cost the run that was open, and a malformed run should not cost
 * the tab.
 */
export function readWhere(raw: string | null): Where {
  if (raw === null) return NOWHERE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return NOWHERE;
  }
  if (typeof parsed !== 'object' || parsed === null) return NOWHERE;
  const r = parsed as Record<string, unknown>;
  return {
    tab: isTab(r['tab']) ? r['tab'] : NOWHERE.tab,
    viewing: viewingOf(r['viewing']),
    draftId: typeof r['draftId'] === 'string' && r['draftId'] !== '' ? r['draftId'] : null,
  };
}

export function writableWhere(where: Where): string {
  return JSON.stringify(where);
}
