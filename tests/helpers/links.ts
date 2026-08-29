import { symlinkSync } from 'node:fs';

/**
 * Making the link shapes #53 and #62 are about, on either platform.
 *
 * Extracted from `linked-run-entry.test.ts` when `gate-artifacts.test.ts`
 * needed the same four shapes: the two files ask different questions - "is this
 * run entry followed" and "is this copied through" - of exactly one filesystem
 * fact, and a second copy of these helpers would be a second set of skip
 * conditions to keep in step.
 */

export const JUNCTION_SKIP = 'this platform refuses to create directory junctions (EPERM/EACCES)';
export const FILE_LINK_SKIP =
  'this platform refuses to create FILE symlinks (EPERM/EACCES) - a junction cannot stand in, ' +
  'since junctions point only at directories';

/**
 * A link, or `false` if this machine may not make one.
 *
 * Only a privilege refusal skips. Anything else is a real failure and is
 * rethrown: a silent pass on a machine that cannot make links looks exactly
 * like a passing test, which is the failure mode that matters here.
 */
export function tryLink(target: string, at: string, type: 'junction' | 'file'): boolean {
  try {
    symlinkSync(target, at, type);
    return true;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') return false;
    throw err;
  }
}

/**
 * A directory link. `'junction'` is a real junction on Windows - which needs
 * neither Administrator nor Developer Mode, as `mklink /J` from an ordinary
 * shell confirmed - and Node ignores the type argument on POSIX, giving an
 * ordinary symlink. One call, both platforms, no privilege.
 */
export const linkDir = (target: string, at: string): boolean => tryLink(target, at, 'junction');

/**
 * A FILE link. `'junction'` cannot stand in: NTFS junctions point only at
 * directories, so this needs a real symlink, which on Windows needs Developer
 * Mode or Administrator. Its own helper and its own skip reason, so that
 * "directory junctions work here" is never mistaken for "the state.json case
 * ran".
 */
export const linkFile = (target: string, at: string): boolean => tryLink(target, at, 'file');
