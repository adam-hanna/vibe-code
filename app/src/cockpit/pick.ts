import { open } from '@tauri-apps/plugin-dialog';

/**
 * The one place the window opens a native chooser (#189).
 *
 * A repository is the single input that decides what the agents are allowed to
 * edit, and it is absolute, platform-shaped, and typed by hand. A typo does not
 * fail at the field - it fails at preflight, minutes later, in a run that had to
 * start to find out.
 *
 * **What comes back is a string and nothing more.** The window does not decide
 * whether it is a git worktree; `consistency.ts` and the preflight are the
 * definition of a usable repository and a second one in the webview is the
 * re-derivation the whole app is written against. A chosen directory that turns
 * out not to be a repo gets the host's answer, which is the same answer a typed
 * one gets.
 *
 * Wrapped rather than imported at the call site for the reason `keys.ts` is:
 * one module holds the boundary, so the set of things the window may ask the OS
 * for can be read in one place rather than grepped for.
 */
export async function pickDirectory(): Promise<string | null> {
  // `multiple: false` gives `string | null` rather than an array, and the null
  // is a cancel. A cancel must change nothing - not clear the field, not clear
  // an error - so every caller has to be able to tell it from a choice.
  const chosen = await open({ directory: true, multiple: false, title: 'choose a repository' });
  return typeof chosen === 'string' ? chosen : null;
}
