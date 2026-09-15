/**
 * Saved prompt drafts — the window's own library (#223).
 *
 * *"We need to be able to edit the prompts. The user should be able to save the
 * edits and select either a saved prompt or the default."* That is three things
 * and they live in three places, which is the same split the settings screen
 * already draws:
 *
 * - **The default** is a constant in `src/prompts.ts`. It is the product's
 *   behaviour and nothing here can change it; the frame sends it as `fallback`
 *   beside whatever renders, so a screen can offer *revert* without holding a
 *   second copy of a constant it does not own.
 * - **The one in force** is `prompts.<block>` in `vibe.config.json`, because the
 *   loop has to read it. It is the project's, committed with the project, and
 *   named on the run's config diff — which is what keeps *"two runs of the same
 *   version cannot be compared"* a visible cost rather than a silent one.
 * - **The library** is this file. A draft you saved and have not adopted is not
 *   a fact about any run and has no business in a file the whole team commits;
 *   it is the same reasoning `projects.ts` gives for the project list.
 *
 * So saving adds to the library and changes nothing about the loop. **Adopting**
 * is the separate act that writes the config, and it is the only one that
 * changes what a turn is told.
 */

/** Where the library lives. Beside `vibe.projects` and `vibe.typescale`. */
export const DRAFTS_KEY = 'vibe.promptdrafts';

/**
 * One saved version of one block.
 *
 * Keyed by `(block, name)` rather than by text: two drafts may say the same
 * thing while one is the one you meant, and a library that de-duplicated by
 * content would silently merge them.
 */
export interface Draft {
  /** The block this is a version of, by the name the core reports. */
  block: string;
  /** What the person called it. Never empty — an unnamed draft cannot be picked. */
  name: string;
  text: string;
}

/** The drafts saved for one block, oldest first, as they were added. */
export function draftsFor(drafts: readonly Draft[], block: string): readonly Draft[] {
  return drafts.filter((d) => d.block === block);
}

export function findDraft(
  drafts: readonly Draft[],
  block: string,
  name: string,
): Draft | null {
  const key = name.trim();
  return drafts.find((d) => d.block === block && d.name === key) ?? null;
}

/**
 * Save a draft, replacing one of the same name for the same block.
 *
 * **Replacing rather than appending**, because saving twice under one name is
 * somebody revising a draft, not collecting two. An empty name or empty text is
 * refused by returning the list unchanged: a draft with no name cannot be
 * picked out of a list, and one with no text is a deletion wearing a save's
 * clothes — `removeDraft` is how a draft goes.
 */
export function saveDraft(drafts: readonly Draft[], draft: Draft): readonly Draft[] {
  const name = draft.name.trim();
  if (name === '' || draft.text.trim() === '') return drafts;
  const rest = drafts.filter((d) => !(d.block === draft.block && d.name === name));
  return [...rest, { block: draft.block, name, text: draft.text }];
}

export function removeDraft(
  drafts: readonly Draft[],
  block: string,
  name: string,
): readonly Draft[] {
  return drafts.filter((d) => !(d.block === block && d.name === name.trim()));
}

/**
 * Read the library, or an empty one.
 *
 * Whole-list-or-nothing on the shape, per entry on the content — the rule
 * `readPins` and `readNames` follow, for the reason they give: `localStorage` is
 * one namespace for the whole origin, and losing one malformed draft is better
 * than losing the other nine with it.
 */
export function readDrafts(raw: string | null): readonly Draft[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: Draft[] = [];
  for (const item of parsed as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const block = row['block'];
    const name = row['name'];
    const text = row['text'];
    if (typeof block !== 'string' || block === '') continue;
    if (typeof name !== 'string' || name.trim() === '') continue;
    // An empty draft cannot be adopted — `block()` in the core ignores a blank
    // override and renders the default — so it is dropped rather than offered.
    if (typeof text !== 'string' || text.trim() === '') continue;
    out.push({ block, name, text });
  }
  return out;
}
