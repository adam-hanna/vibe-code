/**
 * How big the product is drawn, and nothing else about how it looks (#223).
 *
 * Reported in one line — *"add a section to change the look (e.g. font size,
 * etc.) the font is a little too small for me"* — and the honest read of it is
 * that 13px body text is a decision the build spec made for one pair of eyes.
 * This is the reader's own multiplier over that decision, not a second opinion
 * about the ramp: **every size moves together**, so the relationships the spec
 * chose survive being scaled and no two styles can drift apart.
 *
 * ## Why a type scale rather than browser zoom
 *
 * Zoom scales layout as well as type, and viewport units do not scale with it —
 * so `.v-modal`'s `max-height: calc(100vh - …)` would compute in zoomed pixels
 * and a dialog would be taller than the window at any zoom above 1, which is the
 * exact defect that bound was added to fix. A type scale touches type.
 *
 * ## Why this is window state
 *
 * The same rule `projects.ts` states for the project list: **how big you like
 * your text is not a fact about any run**, and `vibe.config.json` is a project
 * file meant to be committed, so one person's eyesight is the wrong thing to put
 * in it. `localStorage`, beside the repository and the pilot's spend ceiling.
 *
 * Pure, and applied by its one caller, so the clamp and the read are testable
 * without a DOM — the app has no jsdom, and a module that touched `document` at
 * import would not be loadable in a test at all.
 */

/** Where the scale is remembered. Beside `vibe.repo` and `vibe.projects`. */
export const SCALE_KEY = 'vibe.typescale';

/** The custom property `tokens.css` multiplies every `--size-*` by. */
export const SCALE_VAR = '--type-scale';

/**
 * The steps offered, and there are five rather than a slider.
 *
 * **Named steps, because a slider would need a minimum, a maximum and a
 * granularity and none of those has anything behind it.** These are the sizes
 * the ramp stays legible at: 0.9 is the build spec's own type one step down,
 * 1 is exactly what the product shipped as, and the three above it are the
 * answer to the report. Above 1.5 the condensed faces start breaking layout
 * that was measured at 1, which is a reason rather than a taste.
 */
export const STEPS: readonly { scale: number; label: string }[] = [
  { scale: 0.9, label: 'compact' },
  { scale: 1, label: 'as designed' },
  { scale: 1.15, label: 'larger' },
  { scale: 1.3, label: 'large' },
  { scale: 1.5, label: 'largest' },
];

/** The smallest and biggest `STEPS` offers. A stored value is clamped to them. */
export const MIN = 0.9;
export const MAX = 1.5;

/**
 * A stored scale, or 1.
 *
 * **Every failure is 1**, which is what the product looked like before this
 * existed: `localStorage` is one namespace for the whole origin, a value
 * somebody else wrote is not ours to interpret, and a window that would not
 * render because a string was not a number is a worse outcome than text at the
 * size it always was. A number outside the range is clamped rather than
 * refused — it is still somebody's intention, just further than this offers.
 */
export function readScale(raw: string | null): number {
  if (raw === null) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(MAX, Math.max(MIN, n));
}

/** How a scale is written. One place, so the reader and the writer agree. */
export function writable(scale: number): string {
  return String(readScale(String(scale)));
}
