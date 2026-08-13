import { run, resolveBin } from '@src/proc.js';
import { detail, warn } from '@src/log.js';

let cachedBin: string | null = null;

export function gitBin(): string {
  cachedBin ??= resolveBin('git', { envVar: 'VIBE_GIT_BIN' });
  return cachedBin;
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

async function git(
  cwd: string,
  args: readonly string[],
  options: { allowFail?: boolean } = {},
): Promise<GitResult> {
  const { code, stdout, stderr } = await run(gitBin(), args, { cwd });
  if (code !== 0 && !options.allowFail) {
    throw new Error(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`);
  }
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function isRepo(cwd: string): Promise<boolean> {
  const { code } = await git(cwd, ['rev-parse', '--git-dir'], { allowFail: true });
  return code === 0;
}

export async function currentBranch(cwd: string): Promise<string | null> {
  const { stdout } = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true });
  return stdout || null;
}

export async function hasCommits(cwd: string): Promise<boolean> {
  const { code } = await git(cwd, ['rev-parse', 'HEAD'], { allowFail: true });
  return code === 0;
}

export async function isDirty(cwd: string): Promise<boolean> {
  const { stdout } = await git(cwd, ['status', '--porcelain']);
  return stdout.length > 0;
}

export async function createBranch(cwd: string, name: string): Promise<void> {
  await git(cwd, ['checkout', '-b', name]);
  detail(`on branch ${name}`);
}

/** Diff marker for the implementation. Null in a repo with no commits yet. */
export async function markBase(cwd: string): Promise<string | null> {
  if (!(await hasCommits(cwd))) return null;
  const { stdout } = await git(cwd, ['rev-parse', 'HEAD']);
  return stdout;
}

export async function commitAll(cwd: string, message: string): Promise<string | null> {
  // Exclude vibe's own run directory. It lives inside the target repo so the
  // artifacts sit next to the work they describe, but `add -A` would otherwise
  // commit plans, schemas and Codex transcripts into the user's history as
  // part of "implement approved plan".
  await git(cwd, ['add', '-A', '--', '.', ':(exclude).vibe', ':(exclude).vibe/**']);
  // Ask what is *staged*, not what is dirty. `.vibe` stays permanently
  // untracked by design, so a working-tree check would always report pending
  // work and every no-op round would attempt an empty commit.
  const { stdout: staged } = await git(cwd, ['diff', '--cached', '--name-only']);
  if (!staged) {
    detail('nothing to commit');
    return null;
  }
  const { code, stderr } = await git(cwd, ['commit', '-m', message], { allowFail: true });
  if (code !== 0) {
    warn(`commit failed: ${stderr}`);
    return null;
  }
  const { stdout: sha } = await git(cwd, ['rev-parse', '--short', 'HEAD']);
  return sha;
}

/**
 * The diff handed to the reviewer. Falls back to staged-everything in a repo
 * with no baseline commit, so a greenfield run still gets reviewed.
 */
export async function diffSince(
  cwd: string,
  baseSha: string | null,
  options: { maxChars?: number } = {},
): Promise<string> {
  const maxChars = options.maxChars ?? 400_000;
  let out: string;

  if (baseSha) {
    ({ stdout: out } = await git(cwd, ['diff', `${baseSha}..HEAD`]));
    if (!out) ({ stdout: out } = await git(cwd, ['diff', 'HEAD']));
  } else {
    await git(cwd, ['add', '-A'], { allowFail: true });
    ({ stdout: out } = await git(cwd, ['diff', '--cached']));
  }

  if (out.length > maxChars) {
    return (
      out.slice(0, maxChars) +
      `\n\n[... diff truncated at ${maxChars} chars - review the working tree directly ...]`
    );
  }
  return out;
}

export async function changedFiles(cwd: string, baseSha: string | null): Promise<string[]> {
  const args = baseSha
    ? ['diff', '--name-only', `${baseSha}..HEAD`]
    : ['diff', '--cached', '--name-only'];
  const { stdout } = await git(cwd, args, { allowFail: true });
  return stdout ? stdout.split(/\r?\n/).filter(Boolean) : [];
}
