/**
 * What the settings screen asks the host for, given the door it was opened
 * from and where the window is pointed (#385).
 *
 * An install that has never added a repository has `repoDir === ''`, and the
 * screen sent that as the `config` read's directory. The host refused it as
 * `config carried no dir`, and the screen drew the refusal verbatim with
 * nothing settable under it - on the screen a new install reaches for first,
 * to store a key or pair a phone. The settings for all projects never needed a
 * project, so that door asks with none. A project's own settings do need one,
 * and with none there is nothing to ask: that door says so in words a person
 * can act on rather than sending a read the host will refuse.
 *
 * Pure, because the app has no jsdom and a decision inside an effect is a
 * decision nothing tests.
 */

export type SettingsRead =
  /** Ask the host, for this project or, when null, for no project at all. */
  | { kind: 'read'; dir: string | null }
  /** Nothing to ask: the sentence to draw instead. */
  | { kind: 'none'; why: string };

export const ADD_A_PROJECT_FIRST =
  'There is no project yet. Add a project first by choosing its folder, and its settings are here.';

export function settingsRead(scope: 'project' | 'global', dir: string): SettingsRead {
  if (dir.trim() !== '') return { kind: 'read', dir };
  return scope === 'global' ? { kind: 'read', dir: null } : { kind: 'none', why: ADD_A_PROJECT_FIRST };
}
