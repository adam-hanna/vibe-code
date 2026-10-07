import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createSession } from '@src/serve.js';
import { decode } from '@src/protocol.js';
import { isArtifactBasename, listRunArtifacts, readRunArtifact, RUNS_DIR } from '@src/run.js';
import { StoredStateError } from '@src/stored.js';
import { freshRun } from './helpers/loop-harness.js';
import { FILE_LINK_SKIP, linkFile } from './helpers/links.js';
import type { Outbound } from '@src/protocol.js';
import type { RunState } from '@src/types.js';

/**
 * Reading a run's artifacts from outside the process that wrote them (#223).
 *
 * **The fourth read frame, and the one that needed a containment story of its
 * own.** `archive`, `config` and `diff` each name a repository and nothing
 * finer; this one names a directory *inside* it and then a file inside that, so
 * two of its three arguments are attacker-shaped in a way the others are not.
 * `assertUsableRunId` closes the first and `isArtifactBasename` the second, and
 * both **refuse rather than repair** - a request naming a path this process will
 * not join is not a request to be interpreted into a nearby one.
 *
 * The claim that carries the most weight here is the last: *the listing is what
 * a caller reads names from*. Everything else on this wire is pushed, so a
 * window drawing a plan round's plan would otherwise have to compose
 * `plan-${round}.json` on the far side of a process boundary - a copy of the
 * loop's naming convention, in a process that cannot be kept in step with it.
 */

/** A run with a directory of its own, and the repository it lives in. */
function runWithFiles(files: Record<string, string>): {
  state: RunState;
  repo: string;
  id: string;
} {
  const state = freshRun({ prefix: 'vibe-artifact-read-', task: 'artifact read' });
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(path.join(state.dir, name), text, 'utf8');
  }
  return { state, repo: state.targetDir, id: state.id };
}

const named = (entries: readonly { name: string }[]): string[] => entries.map((e) => e.name);

// ---- the listing ------------------------------------------------------------

test('the listing names what is there, with the size of each file', () => {
  const { repo, id } = runWithFiles({
    'plan-0.json': '{"plan_md":"hello"}',
    'PLAN.md': '# a plan',
  });

  const entries = listRunArtifacts(repo, id);
  const plan = entries.find((e) => e.name === 'plan-0.json');
  assert.ok(plan !== undefined, `plan-0.json missing from ${named(entries).join(', ')}`);
  assert.equal(plan.kind, 'file');
  assert.equal(plan.bytes, '{"plan_md":"hello"}'.length);
  assert.ok(named(entries).includes('PLAN.md'));
  // `state.json` is in there too and is deliberately not filtered out. It is
  // inside the run's own directory, so reading it is not an escape - and a
  // listing that hid things would be a second answer to what a run contains.
  assert.ok(named(entries).includes('state.json'));
});

test('the listing is sorted, so two calls agree about the order', () => {
  const { repo, id } = runWithFiles({ 'b.json': '2', 'a.json': '1' });
  const names = named(listRunArtifacts(repo, id));
  assert.deepEqual([...names].sort(), names);
});

test('a directory in the run is listed as one, and carries no size', () => {
  // `gate-artifacts-<n>/` is a directory #111 writes. Filtering it out would
  // read as an artifact that was never produced; giving it a size would be a
  // number nobody measured.
  const { state, repo, id } = runWithFiles({});
  mkdirSync(path.join(state.dir, 'gate-artifacts-1'), { recursive: true });

  const entry = listRunArtifacts(repo, id).find((e) => e.name === 'gate-artifacts-1');
  assert.ok(entry !== undefined);
  assert.equal(entry.kind, 'directory');
  assert.equal(entry.bytes, null);
});

test('a run with no directory at all lists nothing rather than throwing', () => {
  // An unreadable archive is an empty one, exactly as `listRuns` decides for the
  // runs root above it. A caller on a read path must not have to catch this.
  const { repo } = runWithFiles({});
  assert.deepEqual(listRunArtifacts(repo, 'nosuchrun-20260101-000000'), []);
});

// ---- reading one ------------------------------------------------------------

test('an artifact comes back as its text', () => {
  const { repo, id } = runWithFiles({ 'PLAN.md': '# a plan\n\nwith a body.\n' });
  const read = readRunArtifact(repo, id, 'PLAN.md');
  assert.equal(read.kind, 'text');
  assert.equal(read.kind === 'text' ? read.text : null, '# a plan\n\nwith a body.\n');
});

test('a missing artifact is absent, which is not the answer a link gets', () => {
  // The distinction #53 drew and #129 kept. `absent` says a file was opened and
  // could not be used; `linked` says vibe never looked inside it. A reader must
  // never be told a file was unreadable when it was never read.
  const { repo, id } = runWithFiles({});
  assert.equal(readRunArtifact(repo, id, 'never-written.json').kind, 'absent');
});

test('a linked artifact is refused with the reason, and nothing is read from it', (t) => {
  const { state, repo, id } = runWithFiles({});
  const outside = path.join(state.targetDir, 'outside.md');
  writeFileSync(outside, 'not a run artifact', 'utf8');
  if (!linkFile(outside, path.join(state.dir, 'PLAN.md'))) {
    t.skip(FILE_LINK_SKIP);
    return;
  }

  const read = readRunArtifact(repo, id, 'PLAN.md');
  assert.equal(read.kind, 'linked');
  assert.match(read.kind === 'linked' ? read.reason : '', /symlink or a junction/);
  // And the listing says the same thing about it, so a caller never offers a
  // row whose only possible outcome is a refusal one click later.
  const entry = listRunArtifacts(repo, id).find((e) => e.name === 'PLAN.md');
  assert.equal(entry?.kind, 'link');
});

// ---- what will not be joined onto a path ------------------------------------

test('a name that is not a basename is refused, and nothing is read', () => {
  const { repo, id } = runWithFiles({});
  for (const name of [
    '../state.json',
    '..\\state.json',
    'sub/plan.json',
    'C:\\Windows\\win.ini',
    '..',
    'plan.json.',
    'plan.json ',
  ]) {
    assert.equal(isArtifactBasename(name), false, `${name} must not be a basename`);
    assert.throws(
      () => readRunArtifact(repo, id, name),
      StoredStateError,
      `${name} reached the filesystem`,
    );
  }
});

test('a run id that would escape the runs root is refused', () => {
  const { repo } = runWithFiles({});
  for (const bad of ['../..', 'a/b', 'run.']) {
    assert.throws(() => listRunArtifacts(repo, bad), StoredStateError, `${bad} was joined`);
    assert.throws(() => readRunArtifact(repo, bad, 'PLAN.md'), StoredStateError);
  }
});

test('the ordinary names a run writes are all basenames', () => {
  // The whitelist is a character class rather than a list of the loop's own
  // shapes - a reader holding that list would go stale the release after this
  // one - so what is worth pinning is that it accepts everything the loop
  // actually produces.
  for (const name of [
    'PLAN.md',
    'FOLLOW-UPS.md',
    'NEEDS-INPUT.md',
    'REPHRASED.md',
    'state.json',
    'plan-0.json',
    'plan-critique-0.json',
    'code-review-12.json',
    'answers-1.json',
    'checkpoint-3.json',
    'implementation-report.md',
    'transcript.log',
  ]) {
    assert.equal(isArtifactBasename(name), true, `${name} must be readable`);
  }
});

// ---- over the wire ----------------------------------------------------------

/** A session whose frames are collected, with nothing answering them. */
function collecting(): { sent: Outbound[]; session: ReturnType<typeof createSession> } {
  const sent: Outbound[] = [];
  return {
    sent,
    session: createSession((m) => void sent.push(m), { invoke: () => Promise.resolve(0) }),
  };
}

test('a listing request is answered while nothing is running', () => {
  const { repo, id } = runWithFiles({ 'PLAN.md': '# a plan' });
  const { sent, session } = collecting();
  session.receive(JSON.stringify({ type: 'artifacts', id: 1, dir: repo, runId: id }));

  const frame = sent[0];
  assert.equal(frame?.type, 'artifacts');
  assert.equal(frame.type === 'artifacts' ? frame.runId : null, id);
  assert.ok(
    frame.type === 'artifacts' && frame.entries.some((e) => e.name === 'PLAN.md'),
    'the listing did not carry the artifact',
  );
});

test('a read request is answered with the three-answer read, not a nullable string', () => {
  const { repo, id } = runWithFiles({ 'PLAN.md': '# a plan' });
  const { sent, session } = collecting();
  session.receive(
    JSON.stringify({ type: 'artifact', id: 2, dir: repo, runId: id, name: 'PLAN.md' }),
  );

  const frame = sent[0];
  assert.equal(frame?.type, 'artifact');
  assert.deepEqual(frame.type === 'artifact' ? frame.read : null, {
    kind: 'text',
    text: '# a plan',
  });
});

test('a refusal reaches the sender as an error naming what was refused', () => {
  // The throw IS the answer here. A refused run id or name that came back as an
  // empty read would look exactly like a file that is not there, and those need
  // opposite responses from whoever asked.
  const { repo } = runWithFiles({});
  const { sent, session } = collecting();
  session.receive(
    JSON.stringify({ type: 'artifact', id: 3, dir: repo, runId: '../..', name: 'PLAN.md' }),
  );

  const frame = sent[0];
  assert.equal(frame?.type, 'error');
  assert.equal(frame.type === 'error' ? frame.id : null, 3);
  assert.match(frame.type === 'error' ? frame.message : '', /is not a run id/);
});

test('the decoder refuses a request that names no run, and one that names no artifact', () => {
  // Refuse, never repair. An `artifacts` frame with no `dir` would resolve to
  // the host's own cwd, which under the app is wherever Rust spawned it - a
  // different repository's runs, answered as though they were this one.
  const refused = (msg: object): string => {
    const got = decode(JSON.stringify(msg));
    assert.equal(got.ok, false, `${JSON.stringify(msg)} was accepted`);
    return got.ok ? '' : got.reason;
  };

  assert.match(refused({ type: 'artifacts', id: 1, runId: 'r' }), /no dir/);
  assert.match(refused({ type: 'artifacts', id: 1, dir: 'd' }), /no runId/);
  assert.match(refused({ type: 'artifact', id: 1, dir: 'd', runId: 'r' }), /named no artifact/);
  // And the two are separate types precisely so that a missing name is a
  // refusal rather than a silently different answer.
  const listing = decode(JSON.stringify({ type: 'artifacts', id: 1, dir: 'd', runId: 'r' }));
  assert.equal(listing.ok && listing.message.type, 'artifacts');
});

test('a diff request may close its range, and refuses a head it cannot use', () => {
  // `headSha` is what makes a diff one round rather than the whole change, so a
  // value that is present and unusable is refused rather than dropped: dropping
  // it would answer a request for one round with the run's cumulative diff.
  const withHead = decode(
    JSON.stringify({ type: 'diff', id: 1, dir: 'd', baseSha: 'aaa', headSha: 'bbb' }),
  );
  assert.equal(withHead.ok && withHead.message.type === 'diff' && withHead.message.headSha, 'bbb');

  const without = decode(JSON.stringify({ type: 'diff', id: 1, dir: 'd', baseSha: 'aaa' }));
  assert.equal(without.ok && without.message.type === 'diff' && without.message.headSha, undefined);

  const bad = decode(
    JSON.stringify({ type: 'diff', id: 1, dir: 'd', baseSha: 'aaa', headSha: '' }),
  );
  assert.equal(bad.ok, false);
});

test('the runs root the id is checked against is the one the frame named', () => {
  // Not the host's cwd. A window pointed at a second checkout has to be shown
  // that checkout's runs, and the only thing that decides which is `dir`.
  const { repo, id } = runWithFiles({ 'PLAN.md': 'a' });
  assert.ok(listRunArtifacts(repo, id).length > 0);
  assert.deepEqual(listRunArtifacts(path.join(repo, 'nowhere'), id), []);
  assert.ok(path.join(repo, RUNS_DIR, id).startsWith(repo));
});
