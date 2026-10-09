import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execute, REAL_GATE } from '@src/cli.js';
import { DEFAULTS } from '@src/config.js';
import { prepareGit } from '@src/orchestrator.js';
import type { ExitCode } from '@src/orchestrator.js';
import { workDirOf } from '@src/worktree.js';
import { config, initGit } from './loop-harness.js';
import type { Config, GitConfig, RunState } from '@src/types.js';

/**
 * Real repositories for `git.baseRef` (#249).
 *
 * Real git, for the reason `worktree.test.ts` gives: which commit a branch is at
 * is a thing git either did or did not do, and a fake answering "yes" would pin
 * our belief about git rather than git.
 */

/** `git <args>` in `dir`, trimmed. */
export function sh(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The full sha `rev` names in `dir`. */
export function shaOf(dir: string, rev: string): string {
  return sh(dir, 'rev-parse', '--verify', `${rev}^0`);
}

/** Commit one file, and return the new HEAD. */
export function commitFile(dir: string, name: string, body = `${name}\n`): string {
  writeFileSync(path.join(dir, name), body, 'utf8');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', name);
  return shaOf(dir, 'HEAD');
}

/**
 * A repository with two commits and a local branch `base` at the FIRST, so a
 * base that differs from HEAD is one config key away.
 */
export function twoCommits(): { dir: string; first: string; second: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-base-'));
  initGit(dir, { commit: true });
  const first = shaOf(dir, 'HEAD');
  sh(dir, 'branch', 'base', first);
  const second = commitFile(dir, 'second.txt');
  return { dir, first, second };
}

/**
 * A bare `origin`, a clone of it, and `origin` advanced from a second clone
 * afterwards - so the clone's `origin/main` is stale, and a run that did not
 * fetch would start from the old commit.
 */
export function staleClone(): { clone: string; stale: string; fresh: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'vibe-remote-'));
  const origin = path.join(root, 'origin.git');
  mkdirSync(origin);
  sh(origin, 'init', '-q', '--bare', '-b', 'main');
  const seed = path.join(root, 'seed');
  mkdirSync(seed);
  initGit(seed, { commit: true });
  sh(seed, 'remote', 'add', 'origin', origin);
  sh(seed, 'push', '-q', 'origin', 'main');
  const stale = shaOf(seed, 'HEAD');

  const clone = path.join(root, 'clone');
  execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'ignore' });
  sh(clone, 'config', 'user.email', 'vibe@example.invalid');
  sh(clone, 'config', 'user.name', 'vibe tests');
  sh(clone, 'config', 'commit.gpgsign', 'false');

  const fresh = commitFile(seed, 'advanced.txt');
  sh(seed, 'push', '-q', 'origin', 'main');
  return { clone, stale, fresh };
}

/** The harness config with `git` overridden. */
export function gitConfig(git: Partial<GitConfig>): Config {
  return config({}, { git: { ...DEFAULTS.git, commitEachRound: false, ...git } });
}

/** The branch-checkout script, in this platform's spelling. */
export const ON_BRANCH =
  process.platform === 'win32'
    ? 'git worktree add "%VIBE_WORKTREE%" "%VIBE_BRANCH%"'
    : 'git worktree add "$VIBE_WORKTREE" "$VIBE_BRANCH"';

/**
 * Run the real preflight gate (no probes) and then only `prepareGit`, which is
 * everything that happens before the first turn. `turns` stays empty because
 * nothing past `prepareGit` is reached - a case that sees it non-empty has
 * dispatched something.
 */
export async function untilFirstTurn(
  state: RunState,
  cfg: Config,
  resume = false,
): Promise<{ code: ExitCode; lines: string[] }> {
  const lines: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...parts: unknown[]): void => void lines.push(parts.map(String).join(' '));
  console.error = (...parts: unknown[]): void => void lines.push(parts.map(String).join(' '));
  try {
    const code = await execute(state, cfg, resume, true, REAL_GATE, (s, c, r) =>
      prepareGit(s, c, workDirOf(s), r),
    );
    return { code, lines };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

/** The message of the run's escalation event, or ''. */
export function escalation(state: RunState): string {
  const event = state.events.find((e) => e.type === 'escalation');
  return event === undefined ? '' : String(event['message']);
}

/** The reasons of the run's preflight refusal, joined, or ''. */
export function refusal(state: RunState): string {
  const event = state.events.find((e) => e.type === 'preflight-failed');
  return event === undefined ? '' : (event['reasons'] as string[]).join('\n');
}
