import { execFileSync } from 'node:child_process';
import { existsSync, symlinkSync } from 'node:fs';

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
export const DIR_SYMLINK_SKIP =
  'this platform refuses to create DIRECTORY symlinks (EPERM/EACCES) - which on Windows is a ' +
  'different privilege from a junction, so the two are asked for separately';
export const MKLINK_SKIP =
  'mklink /J is a Windows shell builtin; a Node junction is the same reparse point everywhere else';

export function tryLink(target: string, at: string, type: 'junction' | 'file' | 'dir'): boolean {
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

/**
 * A directory SYMLINK, which on Windows is a different object from a junction
 * and needs a different privilege - Developer Mode or Administrator, where a
 * junction needs neither. Asked for separately so "junctions work here" is never
 * mistaken for "the directory-symlink shape ran". On POSIX it is the same
 * ordinary symlink `linkDir` produces, which is the point: one predicate has to
 * cover both.
 */
export const linkDirSymlink = (target: string, at: string): boolean => tryLink(target, at, 'dir');

/**
 * A junction made by `mklink /J` rather than by Node.
 *
 * Node's `'junction'` and the shell's `mklink /J` were measured to produce the
 * same reparse point - `lstat(...).isSymbolicLink()` is true of both, `statSync`
 * sees through both, and `cpSync` follows both - but that IS the measurement
 * behind #53 and #62, so the shape the user actually types is created by the
 * command the user actually types rather than assumed equivalent.
 *
 * Windows only: there is no such command elsewhere, and `linkDir` already covers
 * the POSIX shape.
 */
export function mklinkJunction(target: string, at: string): boolean {
  if (process.platform !== 'win32') return false;
  try {
    execFileSync('cmd', ['/d', '/c', 'mklink', '/J', at, target], { stdio: 'ignore' });
    return existsSync(at);
  } catch {
    // Only a refusal to create it, like `tryLink`: nothing else about this call
    // can fail in a way a test should pass over.
    return false;
  }
}
