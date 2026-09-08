import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from '@src/protocol.js';
import { createSession } from '@src/serve.js';
import type { Outbound } from '@src/protocol.js';
import type { RunSummary } from '@src/types.js';

/**
 * The archive, over the wire (#223, `1b`).
 *
 * **The only inbound frame that changes nothing**, and that is what makes it
 * answerable while a run is going: `listRuns` is documented as never throwing
 * and never writing. It has to be answerable then, because `1b`'s subject is
 * triage after a night of unattended work, which is exactly when a run is still
 * going.
 *
 * The claim worth the most is the one about *who classifies*. `listRuns` is the
 * one thing that decides what an archive entry is - a real directory, a symlink
 * it refused to follow (#53), something `lstat` could not classify - and this
 * frame carries its answer through untouched. A second classifier on either end
 * would eventually disagree with `vibe list` about which runs exist, and the one
 * that disagreed would be the one on screen.
 */

const line = (v: unknown): string => JSON.stringify(v);
const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

const summary = (over: Partial<RunSummary> = {}): RunSummary => ({
  id: '20260907-120000-implement',
  status: 'done',
  task: 'do a thing',
  costUsd: 1.25,
  ...over,
});

function withArchive(read: (dir: string) => RunSummary[]): {
  sent: Outbound[];
  session: ReturnType<typeof createSession>;
} {
  const sent: Outbound[] = [];
  return {
    sent,
    session: createSession((m) => void sent.push(m), {
      invoke: () => Promise.resolve(0),
      archive: read,
    }),
  };
}

test('an archive frame decodes, and a missing dir is refused rather than defaulted', async () => {
  const ok = decode(line({ type: 'archive', id: 1, dir: 'C:/repo' }));
  assert.equal(ok.ok, true);

  // The worst possible way for this to fail is to succeed: an empty `dir` would
  // resolve to the host's own cwd, which is a DIFFERENT repository's archive
  // presented as this one's.
  for (const bad of ['', undefined, 7]) {
    const read = decode(line({ type: 'archive', id: 1, dir: bad }));
    assert.equal(read.ok, false, `dir ${String(bad)} was accepted`);
  }
  await Promise.resolve();
});

test('the runs come back exactly as listRuns returned them', async () => {
  // Verbatim, including the fields that say what could NOT be read. `linked` is
  // an entry vibe refused to follow and never looked inside; `costUsd: null` is
  // a cost that is unknown rather than zero, because `$0.00` would assert that
  // an unreadable run cost nothing.
  const runs = [
    summary(),
    summary({ id: 'linked-one', status: 'linked', costUsd: null, linked: true }),
    // Two different failures, and the core keeps them apart on purpose:
    // `unreadable` is a state.json that WAS opened and could not be used, while
    // `unverified` is an `lstat` that threw, so whether the entry is a link
    // could not be established at all.
    summary({ id: 'bad-one', status: 'unreadable', costUsd: null }),
    summary({ id: 'odd-one', status: 'unknown', costUsd: null, unverified: true }),
  ];
  const { sent, session } = withArchive(() => runs);
  session.receive(line({ type: 'archive', id: 3, dir: 'C:/repo' }));
  await settle();

  assert.deepEqual(sent, [{ type: 'archive', id: 3, dir: 'C:/repo', runs }]);
});

test('the dir asked for is the dir read, and it comes back on the answer', async () => {
  // Sent rather than assumed: the host's cwd is where it was spawned, and a
  // window pointed at a different checkout would otherwise be shown the wrong
  // archive with no way to tell.
  let asked: string | null = null;
  const { sent, session } = withArchive((dir) => {
    asked = dir;
    return [];
  });
  session.receive(line({ type: 'archive', id: 1, dir: 'D:/other' }));
  await settle();

  assert.equal(asked, 'D:/other');
  const reply = sent[0];
  assert.equal(reply?.type === 'archive' ? reply.dir : null, 'D:/other');
});

test('it is answered while a run is going, and does not take the run’s slot', async () => {
  // The claim this frame exists for. It changes nothing, so the one-at-a-time
  // rule - which is about runs interleaving their narration - does not apply.
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => new Promise<number>(() => undefined),
    archive: () => [summary()],
  });

  session.receive(line({ type: 'invoke', id: 1, argv: ['run', 'x'] }));
  session.receive(line({ type: 'archive', id: 2, dir: 'C:/repo' }));
  await settle();

  assert.equal(
    sent.some((m) => m.type === 'error'),
    false,
    'the archive was refused while a run was going',
  );
  assert.equal(
    sent.some((m) => m.type === 'archive'),
    true,
  );

  // And a second invoke is still refused, which is what keeps the exemption
  // honest rather than a hole.
  session.receive(line({ type: 'invoke', id: 3, argv: ['run', 'y'] }));
  await settle();
  assert.equal(
    sent.some((m) => m.type === 'error' && m.id === 3),
    true,
  );
});

test('a reader that threw becomes an error, never silence', async () => {
  // `listRuns` promises not to throw and this is the belt on that promise. A
  // window that asked and got silence would sit on a spinner for ever; an
  // `error` frame carries the id and can be acted on.
  const { sent, session } = withArchive(() => {
    throw new Error('the runs root could not be read');
  });
  session.receive(line({ type: 'archive', id: 5, dir: 'C:/repo' }));
  await settle();

  assert.deepEqual(sent, [
    { type: 'error', id: 5, message: 'the runs root could not be read' },
  ]);
});

test('an empty archive is an answer, not a failure', async () => {
  // "Nothing has run here" and "the archive could not be read" are opposite
  // facts, and the first is what a new user sees.
  const { sent, session } = withArchive(() => []);
  session.receive(line({ type: 'archive', id: 1, dir: 'C:/repo' }));
  await settle();

  const reply = sent[0];
  assert.equal(reply?.type, 'archive');
  assert.deepEqual(reply?.type === 'archive' ? reply.runs : null, []);
});
