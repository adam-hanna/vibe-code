import path from 'node:path';
import { resolveBin } from '@src/proc.js';

/**
 * Conventional install locations for toolchain binaries.
 *
 * A safety net for the case this module exists for: a PATH broken badly enough
 * that even vibe's own lookup comes back empty. Consulted only after normal
 * resolution fails.
 */
const TOOL_FALLBACKS: Readonly<Record<string, readonly string[]>> = {
  node: [
    'C:/Program Files/nodejs/node.exe',
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/bin/node',
  ],
  npm: [
    'C:/Program Files/nodejs/npm.cmd',
    '/usr/local/bin/npm',
    '/opt/homebrew/bin/npm',
    '/usr/bin/npm',
  ],
  git: ['C:/Program Files/Git/cmd/git.exe', '/usr/local/bin/git', '/usr/bin/git'],
};

/**
 * Where vibe's own process finds a tool.
 *
 * This is the one place vibe's environment is legitimately authoritative: it
 * locates a binary on disk, rather than predicting what an agent can see.
 * Used both as the source of a PATH repair and, when an agent cannot run a
 * tool that plainly exists here, as evidence that the cause is access rather
 * than absence.
 */
export function hostExecutableFor(tool: string): string | null {
  try {
    const fallbacks = TOOL_FALLBACKS[tool];
    return resolveBin(tool, fallbacks === undefined ? {} : { fallbacks });
  } catch {
    return null;
  }
}

export function hostDirectoryFor(tool: string): string | null {
  const executable = hostExecutableFor(tool);
  return executable === null ? null : path.dirname(executable);
}
