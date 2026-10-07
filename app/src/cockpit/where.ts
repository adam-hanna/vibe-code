/**
 * Where the window was pointed, kept between launches (#223), and how it was
 * arranged.
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
 * **The panels are here too, and that reverses an earlier line.** `SidePanel`
 * said a collapse was *"a gesture for the next few minutes"* and kept only the
 * widths. With real drag handles between every region (the UI rework), an
 * arrangement is something a person sets up and expects to find again, so the
 * sizes and which panels are shut are both kept. A record from a build older
 * than the field comes back with every panel open at its default size.
 *
 * Pure, for `model.ts`'s reason: the app has no jsdom, so a read that lived in
 * an effect would be a read nothing tests.
 */

export const WHERE_KEY = 'vibe.where';

/**
 * The tabs of the main pane. Output and Commands are not among them: they are
 * the bottom panel's, below. A tab missing here comes back as the pilot.
 */
export const TABS = ['pilot', 'plans', 'critique', 'review', 'code', 'verify', 'spend', 'questions', 'runs', 'settings'] as const;

export type Tab = (typeof TABS)[number];

/** The bottom panel's two tabs: the terminal-shaped panes. */
export const BOTTOM_TABS = ['output', 'commands'] as const;

export type BottomTab = (typeof BOTTOM_TABS)[number];

export interface Viewing {
  dir: string;
  runId: string;
  task: string;
}

/** One resizable group's sizes, as `react-resizable-panels` reports them: percent per panel id. */
export type Sizes = Readonly<Record<string, number>>;

export interface Panels {
  sidebar: boolean;
  loop: boolean;
  bottom: boolean;
  /** Keyed by group id. A group not here takes its defaults. */
  sizes: Readonly<Record<string, Sizes>>;
}

export interface Where {
  tab: Tab;
  viewing: Viewing | null;
  /** A draft row that was open. Checked against the drafts by the caller. */
  draftId: string | null;
  /** Which tab the bottom panel shows when it is open. */
  bottom: BottomTab;
  panels: Panels;
}

export const OPEN_PANELS: Panels = { sidebar: true, loop: true, bottom: false, sizes: {} };

/** Where a fresh window lands, and where an unreadable record lands too. */
export const NOWHERE: Where = { tab: 'pilot', viewing: null, draftId: null, bottom: 'output', panels: OPEN_PANELS };

function isTab(v: unknown): v is Tab {
  return typeof v === 'string' && (TABS as readonly string[]).includes(v);
}

function isBottomTab(v: unknown): v is BottomTab {
  return typeof v === 'string' && (BOTTOM_TABS as readonly string[]).includes(v);
}

function viewingOf(v: unknown): Viewing | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const { dir, runId, task } = r;
  if (typeof dir !== 'string' || dir === '' || typeof runId !== 'string' || runId === '') return null;
  return { dir, runId, task: typeof task === 'string' ? task : '' };
}

/** A group's sizes: every value a finite percentage, or the group is dropped. */
function sizesOf(v: unknown): Sizes | null {
  if (typeof v !== 'object' || v === null) return null;
  const out: Record<string, number> = {};
  for (const [id, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100) return null;
    out[id] = n;
  }
  return out;
}

function panelsOf(v: unknown): Panels {
  if (typeof v !== 'object' || v === null) return OPEN_PANELS;
  const r = v as Record<string, unknown>;
  const flag = (k: 'sidebar' | 'loop' | 'bottom'): boolean => (typeof r[k] === 'boolean' ? r[k] : OPEN_PANELS[k]);
  const sizes: Record<string, Sizes> = {};
  if (typeof r['sizes'] === 'object' && r['sizes'] !== null) {
    for (const [group, s] of Object.entries(r['sizes'] as Record<string, unknown>)) {
      const got = sizesOf(s);
      if (got !== null) sizes[group] = got;
    }
  }
  return { sidebar: flag('sidebar'), loop: flag('loop'), bottom: flag('bottom'), sizes };
}

/**
 * Read it back. Each field fails on its own: a tab this build no longer has
 * should not cost the run that was open, and a malformed run should not cost
 * the tab.
 *
 * A record from before the bottom panel may say `tab: 'output'` or
 * `'commands'`. Those panes moved, so the record is read as the pilot with the
 * bottom panel open on that pane - the same screen, in the new arrangement.
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
  const panels = panelsOf(r['panels']);
  const legacyBottom = isBottomTab(r['tab']) ? r['tab'] : null;
  return {
    tab: isTab(r['tab']) ? r['tab'] : NOWHERE.tab,
    viewing: viewingOf(r['viewing']),
    draftId: typeof r['draftId'] === 'string' && r['draftId'] !== '' ? r['draftId'] : null,
    bottom: legacyBottom ?? (isBottomTab(r['bottom']) ? r['bottom'] : NOWHERE.bottom),
    panels: legacyBottom === null ? panels : { ...panels, bottom: true },
  };
}

export function writableWhere(where: Where): string {
  return JSON.stringify(where);
}
