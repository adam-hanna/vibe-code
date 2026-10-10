/**
 * What the window decides about an update, and nothing it could get wrong (#299).
 *
 * The check, the comparison, the install type and the install itself are all
 * Rust's (`src-tauri/src/update.rs`): the window is told whether a newer version
 * exists and what this install does with it, and it decides only what to draw
 * and what it remembers. Pure, for `model.ts`'s reason - the app has no jsdom,
 * so a rule in a component is a rule nothing tests.
 */

/** The version a person skipped. This window's memory, never a project's. */
export const SKIP_KEY = 'vibe.update.skipped';

/** Whether to check at all: `'off'` or absent/anything else (on). */
export const CHECK_KEY = 'vibe.update.check';

/**
 * How often to check after the one at launch.
 *
 * **Six hours is a choice, not a measurement.** Nothing here measured how often
 * a release ships or how long a window stays open; it is often enough that a
 * window left open for a day learns of a release the same day, and rare enough
 * that the request is noise on nobody's network.
 */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** What `update_check` answers with: the popover's needs and nothing else. */
export interface UpdateInfo {
  version: string;
  notes: string | null;
  /** RFC 3339, as the manifest wrote it. */
  date: string | null;
  /** `download` is a `.deb` or an install this build cannot identify. */
  action: 'install' | 'download';
}

/** One `app://update-progress` frame. `total` is null when no length was sent. */
export type UpdateProgress =
  | { stage: 'downloading'; downloaded: number; total: number | null }
  | { stage: 'installing' };

/** What `update_install` did. `confirm` means runs are going and nothing happened yet. */
export type Outcome = 'confirm' | 'opened';

/**
 * Whether the ⬆ tool is drawn.
 *
 * A skip names one version, so a newer one is a different string and shows
 * again without the window comparing versions - Rust only ever reports one
 * newer than the running build, by the plugin's own comparison.
 */
export function shown(info: UpdateInfo | null, skipped: string | null): info is UpdateInfo {
  return info !== null && info.version !== skipped;
}

/** On unless somebody turned it off. */
export function checkEnabled(raw: string | null): boolean {
  return raw !== 'off';
}

/**
 * The first lines of the release notes. A truncation, said as one by `cut`;
 * the whole of them is on the release page.
 */
export function excerpt(notes: string | null, maxLines = 6): { text: string; cut: boolean } {
  const lines = (notes ?? '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '');
  return { text: lines.slice(0, maxLines).join('\n'), cut: lines.length > maxLines };
}

function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * What the popover says while it works. **A ratio only with a denominator**:
 * without a `Content-Length` there is no total to divide by, so the line is a
 * count and no bar is drawn.
 */
export function progress(p: UpdateProgress): { text: string; ratio: number | null } {
  if (p.stage === 'installing') return { text: 'Installing…', ratio: null };
  if (p.total === null || p.total <= 0) {
    return { text: `Downloading… ${mb(p.downloaded)} so far`, ratio: null };
  }
  return {
    text: `Downloading… ${mb(p.downloaded)} of ${mb(p.total)}`,
    ratio: Math.min(1, p.downloaded / p.total),
  };
}
