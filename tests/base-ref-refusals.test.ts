import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRun } from '@src/run.js';
import { EXIT } from '@src/orchestrator.js';
import { runBranch } from '@src/git.js';
import {
  gitConfig,
  refusal,
  sh,
  shaOf,
  staleClone,
  twoCommits,
  untilFirstTurn,
} from './helpers/base-repo.js';
import type { Config, RunState } from '@src/types.js';

/**
 * Every way a `git.baseRef` cannot be honoured is a refusal by name, before
 * anything is spent (#249).
 *
 * The shape is the existing preflight refusal's: `EXIT.PREFLIGHT`, a
 * `preflight-failed` event, and no turn. None of them falls back to HEAD or to
 * a local copy, because a base nobody chose is the defect.
 */

async function refused(state: RunState, cfg: Config): Promise<string> {
  const { code } = await untilFirstTurn(state, cfg);
  assert.equal(code, EXIT.PREFLIGHT);
  assert.equal(state.status, 'error');
  assert.equal(state.tokensUsed, 0, 'nothing was spent');
  // `prepareGit` never ran: it is the loop's first act, and it is what sets these.
  assert.equal(state.branch, null);
  assert.equal(state.start, undefined);
  const said = refusal(state);
  assert.match(said, /git\.baseRef/);
  return said;
}

test('a git.baseRef that does not resolve is refused with the ref quoted', async () => {
  const { dir } = twoCommits();
  const said = await refused(createRun(dir, 'no such ref', true), gitConfig({ baseRef: 'nope/never' }));
  assert.match(said, /"nope\/never" does not resolve/);
});

test('a fetch that fails is refused, never answered from the local copy', async () => {
  const { clone, stale } = staleClone();
  // The tracking ref still resolves locally - to the stale commit - which is
  // exactly what a fallback would have used.
  sh(clone, 'remote', 'set-url', 'origin', path.join(clone, 'no-such-remote'));
  const state = createRun(clone, 'fetch fails', true);
  const said = await refused(state, gitConfig({ baseRef: 'origin/main' }));
  assert.match(said, /could not be fetched/);
  assert.match(said, /git fetch origin main/);
  assert.equal(sh(clone, 'branch', '--list', String(runBranch(gitConfig({}), state))), '');
  assert.equal(shaOf(clone, 'HEAD'), stale, 'nothing moved');
});

test('a remote-tracking ref with no remote to fetch it from is refused, not read locally', async () => {
  // A left-over tracking ref resolves locally and nothing can refresh it -
  // reading it would be exactly the stale fallback a failed fetch refuses.
  const { dir, first, second } = twoCommits();
  sh(dir, 'update-ref', 'refs/remotes/gone/main', first);
  const said = await refused(createRun(dir, 'no remote', true), gitConfig({ baseRef: 'gone/main' }));
  assert.match(said, /refs\/remotes\/gone\/main/);
  assert.match(said, /no configured remote/);
  assert.equal(shaOf(dir, 'HEAD'), second, 'nothing moved');
});

test('git.baseRef with branch isolation off is refused', async () => {
  const { dir } = twoCommits();
  const said = await refused(
    createRun(dir, 'no branch', true),
    gitConfig({ baseRef: 'base', useBranch: false }),
  );
  assert.match(said, /--no-branch/);
});

test('a dirty repository is refused when the base is a different commit', async () => {
  const { dir, second } = twoCommits();
  writeFileSync(path.join(dir, 'README.md'), 'edited, not committed\n', 'utf8');
  const said = await refused(createRun(dir, 'dirty', true), gitConfig({ baseRef: 'base' }));
  assert.match(said, /uncommitted changes/);
  assert.equal(shaOf(dir, 'HEAD'), second, 'the tree was not moved');
});

test('a dirty repository whose base IS HEAD runs as today: nothing would move', async () => {
  const { dir, second } = twoCommits();
  sh(dir, 'branch', 'here', second);
  writeFileSync(path.join(dir, 'README.md'), 'edited, not committed\n', 'utf8');
  const state = createRun(dir, 'dirty at head', true);
  const { code, lines } = await untilFirstTurn(state, gitConfig({ baseRef: 'here' }));
  assert.equal(code, EXIT.OK);
  assert.deepEqual(state.start, { sha: second, ref: 'here' });
  assert.ok(lines.some((l) => /swept into the first commit/.test(l)), 'the existing warning is kept');
});
