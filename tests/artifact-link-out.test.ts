import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { commitFork, planFork } from '@src/fork.js';
import { orchestrate } from '@src/orchestrator.js';
import {
  artifact,
  artifactText,
  linkedArtifactReason,
  listCheckpoints,
  readArtifact,
  saveState,
} from '@src/run.js';
import {
  agents,
  committing,
  config,
  freshRun,
  planFixture,
  report,
  reviewingRun,
  verifying,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import { FILE_LINK_SKIP, JUNCTION_SKIP, linkDir, linkFile } from './helpers/links.js';
import type { RunState } from '@src/types.js';

/**
 * An artifact that is a link out of the archive (#129).
 *
 * The two sites #102 named when it closed the checkpoint and deliberately left:
 * `artifactText`, which hands an artifact's bytes to a prompt, and
 * `commitFork`'s report copy, which carries one into a child run under a new
 * identity. Both sit on the hot path of a *live* run rather than at fork time,
 * which is why they were their own issue.
 *
 * What makes this one different from #53 and #102 is what is on the other side
 * of the read. A run entry and a checkpoint both go through `loadRun`'s
 * validators before anything acts on them; an artifact's bytes go **straight to
 * a model**, with nothing in between. So the claim these cases hold is not
 * "vibe noticed" but "the target's bytes are nowhere they could have reached".
 *
 * Two link shapes, because they need different privileges and prove different
 * halves:
 *
 * - A **junction** needs no privilege anywhere, so the refusal itself is always
 *   under test. It points at a directory, so a read through one would fail
 *   anyway - which is exactly why it cannot carry the bytes half.
 * - A **file symlink** needs Developer Mode or Administrator on Windows, so it
 *   skips with `FILE_LINK_SKIP` where it must - but it is the only shape that
 *   can put recognisable bytes on the other side of the link and then assert
 *   they went nowhere.
 */

const SECRET = 'BYTES-FROM-OUTSIDE-THE-ARCHIVE';

/** A file outside any run archive, with contents nothing may quote back. */
function outsideFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-outside-'));
  const file = path.join(dir, 'SECRET.txt');
  writeFileSync(file, SECRET, 'utf8');
  return file;
}

/** A directory outside any run archive, for the shape that needs no privilege. */
function outsideDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'vibe-outside-dir-'));
}

const plain = (task: string): RunState =>
  freshRun({ prefix: 'vibe-artifact-link-', task, planOnly: true, git: false });

// ---- the predicate ----------------------------------------------------------

test('an ordinary artifact is not a link, and neither is a name that is not there', () => {
  const state = plain('ordinary');
  artifact(state, 'implementation-report.md', 'a real file');

  assert.equal(linkedArtifactReason(state.dir, 'implementation-report.md'), null);
  // Missing is not linked. The two are different findings and the reader is
  // told different things about them; collapsing them would report a link
  // nobody measured.
  assert.equal(linkedArtifactReason(state.dir, 'never-written.md'), null);
});

test('a junction at an artifact name is refused, and the reason names the file', (t) => {
  const state = plain('junction');
  if (!linkDir(outsideDir(), path.join(state.dir, 'implementation-report.md'))) {
    t.skip(JUNCTION_SKIP);
    return;
  }

  const reason = linkedArtifactReason(state.dir, 'implementation-report.md');
  assert.ok(reason !== null);
  assert.match(reason, /implementation-report\.md/);
  assert.match(reason, /points outside the run archive/);
  // The sentence #53 drew and #102 kept: not "could not be read".
  assert.match(reason, /Nothing was read from it/);
});

test('a file symlink at an artifact name is refused too - one predicate, both shapes', (t) => {
  const state = plain('file symlink');
  if (!linkFile(outsideFile(), path.join(state.dir, 'implementation-report.md'))) {
    t.skip(FILE_LINK_SKIP);
    return;
  }

  assert.notEqual(linkedArtifactReason(state.dir, 'implementation-report.md'), null);
});

// ---- what a caller is told --------------------------------------------------

test('readArtifact tells a link apart from a file it could not read', (t) => {
  const state = plain('three answers');
  artifact(state, 'implementation-report.md', 'a real file');

  assert.deepEqual(readArtifact(state, 'implementation-report.md'), {
    kind: 'text',
    text: 'a real file',
  });
  assert.deepEqual(readArtifact(state, 'never-written.md'), { kind: 'absent' });

  if (!linkDir(outsideDir(), path.join(state.dir, 'fix-report-1.md'))) {
    t.skip(JUNCTION_SKIP);
    return;
  }
  const read = readArtifact(state, 'fix-report-1.md');
  assert.equal(read.kind, 'linked', 'never "absent" - vibe did not look inside it');
});

test('artifactText is null for a link, so a caller that never heard of this reads none', (t) => {
  // The fail-closed direction. `settlePendingOutstanding` asks "does this file
  // say what I wrote", which a file vibe refused to open does not, and any
  // future caller gets the same answer without having to know why.
  const state = plain('fail closed');
  if (!linkFile(outsideFile(), path.join(state.dir, 'OUTSTANDING.md'))) {
    t.skip(FILE_LINK_SKIP);
    return;
  }

  assert.equal(artifactText(state, 'OUTSTANDING.md'), null);
});

test("the target's bytes are not what artifactText returns", (t) => {
  const state = plain('no bytes');
  if (!linkFile(outsideFile(), path.join(state.dir, 'implementation-report.md'))) {
    t.skip(FILE_LINK_SKIP);
    return;
  }

  // The claim that matters, asserted rather than inferred from the verdict: a
  // read through the link would have returned exactly this string.
  assert.equal(readFileSync(path.join(state.dir, 'implementation-report.md'), 'utf8'), SECRET);
  assert.equal(artifactText(state, 'implementation-report.md'), null);
});

// ---- through a live run -----------------------------------------------------

const NOTICE = '**No report was recorded for the most recent write turn.**';

/** Every review turn's prompt, by label, with a clean report back. */
function reviewPrompts(into: Map<string, string>): NonNullable<Handlers['codex']> {
  return (label, options) => {
    if (label.startsWith('review-')) into.set(label, options.prompt);
    return report([]);
  };
}

test('a linked report reaches no prompt, and the run finishes anyway', async (t) => {
  const state = reviewingRun({ prefix: 'vibe-artifact-link-run-', task: 'linked report' });
  if (!linkDir(outsideDir(), path.join(state.dir, 'implementation-report.md'))) {
    t.skip(JUNCTION_SKIP);
    return;
  }
  state.lastReport = 'implementation-report.md';
  saveState(state);

  const prompts = new Map<string, string>();
  await orchestrate(state, config(), true, agents({ codex: reviewPrompts(prompts) }, []));

  // Degraded, not fatal - option 2 of the three the issue offers. The reviewer
  // is told there is no report, in the same words a missing one produces,
  // because the two differ in what went wrong and not in what the reviewer
  // should do.
  assert.ok(prompts.get('review-0')?.includes(NOTICE));
  assert.equal(state.phase, 'complete', 'one refused artifact does not end a healthy run');
});

test('the run says the report was a link, and never that it was unreadable', async (t) => {
  const state = reviewingRun({ prefix: 'vibe-artifact-link-ev-', task: 'linked event' });
  if (!linkDir(outsideDir(), path.join(state.dir, 'implementation-report.md'))) {
    t.skip(JUNCTION_SKIP);
    return;
  }
  state.lastReport = 'implementation-report.md';
  saveState(state);

  await orchestrate(state, config(), true, agents({ codex: () => report([]) }, []));

  assert.ok(
    state.events.some((e) => e.type === 'report_linked' && e['name'] === 'implementation-report.md'),
    'the difference lives in the events, where someone debugging the run finds it',
  );
  // A reader must never be told a file was opened and could not be used when
  // vibe never looked inside it. That is #53's distinction, and it is the whole
  // reason `readArtifact` has three answers rather than two.
  assert.equal(
    state.events.some((e) => e.type === 'report_unreadable'),
    false,
  );
});

test('a run whose report is a real file records neither event', async () => {
  const state = reviewingRun({ prefix: 'vibe-artifact-link-ok-', task: 'ordinary report' });
  artifact(state, 'implementation-report.md', 'REPORT-implement');
  state.lastReport = 'implementation-report.md';
  saveState(state);

  const prompts = new Map<string, string>();
  await orchestrate(state, config(), true, agents({ codex: reviewPrompts(prompts) }, []));

  assert.ok(prompts.get('review-0')?.includes('REPORT-implement'), 'still handed the report');
  assert.equal(
    state.events.some((e) => e.type === 'report_linked' || e.type === 'report_unreadable'),
    false,
    'nothing about this run changed',
  );
});

test("the linked target's bytes are in no prompt the reviewer was sent", async (t) => {
  const state = reviewingRun({ prefix: 'vibe-artifact-link-bytes-', task: 'no bytes in prompt' });
  if (!linkFile(outsideFile(), path.join(state.dir, 'implementation-report.md'))) {
    t.skip(FILE_LINK_SKIP);
    return;
  }
  state.lastReport = 'implementation-report.md';
  saveState(state);

  const prompts = new Map<string, string>();
  await orchestrate(state, config(), true, agents({ codex: reviewPrompts(prompts) }, []));

  const prompt = prompts.get('review-0') ?? '';
  assert.notEqual(prompt, '');
  assert.equal(prompt.includes(SECRET), false, 'not one byte of it');
});

// ---- and into a fork --------------------------------------------------------

/** A finished run with checkpoints and commits, in a real repo. */
async function parentRun(task: string): Promise<RunState> {
  const state = freshRun({
    prefix: 'vibe-artifact-link-fork-',
    task,
    planOnly: false,
    git: true,
    commit: true,
  });
  let round = 0;
  await orchestrate(
    state,
    config({}, { ...committing(), ...verifying(state) }),
    false,
    agents(
      {
        claude: (label) => {
          if (label === 'plan' || label.startsWith('revise')) return planFixture();
          round += 1;
          work(state, `work-${round}.txt`);
          return `did ${label}`;
        },
      },
      [],
    ),
  );
  return state;
}

/** The checkpoint with a commit, which is the one a branching fork can use. */
function committedPoint(state: RunState): number {
  const found = listCheckpoints(state.dir).find((c) => c.meta?.commit != null);
  assert.ok(found !== undefined, 'the parent recorded a checkpoint with a commit');
  return found.n;
}

test('a linked report is not copied into a fork, and the loss says why', async (t) => {
  const parent = await parentRun('linked fork report');
  const n = committedPoint(parent);
  const name = 'implementation-report.md';
  // Replace the real report with a link to somewhere else, which is the shape
  // the issue is about: the checkpoint still names it, so the copy is attempted.
  const at = path.join(parent.dir, name);
  rmSync(at);
  if (!linkDir(outsideDir(), at)) {
    t.skip(JUNCTION_SKIP);
    return;
  }

  const plan = await planFork(parent.targetDir, parent.id, n, {});
  const result = await commitFork(parent.targetDir, plan);

  // A loss, not a refusal: the fork's identity does not rest on the report, and
  // the two neighbouring branches have always made a report that cannot be
  // copied a loss rather than standing the fork down.
  assert.equal(result.state.lastReport, undefined, 'never a pointer to a file that is not there');
  assert.ok(result.losses.some((l) => l.includes(name) && l.includes('outside the run archive')));
  assert.equal(
    readdirSync(result.state.dir).includes(name),
    false,
    'nothing at that name in the child',
  );
});

test("a forked child holds no copy of the linked target's bytes", async (t) => {
  const parent = await parentRun('linked fork bytes');
  const n = committedPoint(parent);
  const at = path.join(parent.dir, 'implementation-report.md');
  rmSync(at);
  if (!linkFile(outsideFile(), at)) {
    t.skip(FILE_LINK_SKIP);
    return;
  }

  const plan = await planFork(parent.targetDir, parent.id, n, {});
  const result = await commitFork(parent.targetDir, plan);

  // The claim, over every file the child holds: a `copyFileSync` through the
  // link would have put SECRET under the child's identity, indistinguishable
  // from something the child produced.
  for (const entry of readdirSync(result.state.dir)) {
    const body = readFileSync(path.join(result.state.dir, entry), 'utf8');
    assert.equal(body.includes(SECRET), false, `${entry} carries the target's bytes`);
  }
});

test('a fork whose report is a real file still copies it', async () => {
  const parent = await parentRun('ordinary fork report');
  const n = committedPoint(parent);

  const plan = await planFork(parent.targetDir, parent.id, n, {});
  const result = await commitFork(parent.targetDir, plan);

  const copied = result.state.lastReport;
  assert.ok(copied !== undefined, 'the pointer survived');
  assert.equal(
    readFileSync(path.join(result.state.dir, copied), 'utf8'),
    readFileSync(path.join(parent.dir, copied), 'utf8'),
    'copied, not merely pointed at',
  );
});
