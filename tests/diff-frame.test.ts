import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from '@src/protocol.js';
import { createSession } from '@src/serve.js';
import type { Outbound } from '@src/protocol.js';

/**
 * The diff, over the wire (#223, `1d`).
 *
 * **A read that must stay one.** `diffSince` has two paths and only one of them
 * is safe here: given a base it runs `git diff <base>..HEAD`, and given none it
 * runs `git add -A` first, which stages the user's whole working tree. So the
 * base is required at the decoder, and a request that cannot name one is refused
 * rather than falling into the staging path - a read frame that modified the
 * index would be the worst kind of surprise.
 *
 * The other claim worth pinning is `truncated`. It is a **flag**, not a marker
 * in the text, because the design's truncation band is a judgement about what
 * the reviewer actually READ - and a window matching English to find that out
 * would break on the next wording change, at the moment somebody is deciding
 * whether a review was thorough.
 */

const line = (v: unknown): string => JSON.stringify(v);
const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

test('a diff frame requires a base, and there is no safe default', () => {
  assert.equal(decode(line({ type: 'diff', id: 1, dir: 'C:/r', baseSha: 'abc123' })).ok, true);

  // Every way of not naming one. `diffSince(cwd, null)` stages the whole
  // working tree before it reads anything, so none of these may become that.
  for (const bad of [undefined, null, '', 7]) {
    const got = decode(line({ type: 'diff', id: 1, dir: 'C:/r', baseSha: bad }));
    assert.equal(got.ok, false, `baseSha ${String(bad)} was accepted`);
    assert.match(got.ok === false ? got.reason : '', /baseSha/);
  }
  assert.equal(decode(line({ type: 'diff', id: 1, baseSha: 'abc' })).ok, false);
});

test('the patch comes back with the truncation flag the host measured', async () => {
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => Promise.resolve(0),
    diff: () => Promise.resolve({ patch: 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b\n', truncated: true }),
  });
  session.receive(line({ type: 'diff', id: 4, dir: 'C:/r', baseSha: 'abc123' }));
  await settle();

  const reply = sent[0];
  assert.equal(reply?.type, 'diff');
  if (reply?.type !== 'diff') throw new Error('unreachable');
  assert.equal(reply.dir, 'C:/r');
  assert.equal(reply.truncated, true);
  assert.match(reply.patch, /^diff --git/);
});

test('the base asked for is the base read', async () => {
  let asked: string | null = null;
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => Promise.resolve(0),
    diff: (_dir, baseSha) => {
      asked = baseSha;
      return Promise.resolve({ patch: '', truncated: false });
    },
  });
  session.receive(line({ type: 'diff', id: 1, dir: 'C:/r', baseSha: 'deadbeef' }));
  await settle();
  assert.equal(asked, 'deadbeef');
});

test('it is answered beside a run, like every other read on this wire', async () => {
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => new Promise<number>(() => undefined),
    diff: () => Promise.resolve({ patch: '', truncated: false }),
  });

  session.receive(line({ type: 'invoke', id: 1, argv: ['run', 'x'] }));
  session.receive(line({ type: 'diff', id: 2, dir: 'C:/r', baseSha: 'abc' }));
  await settle();

  assert.equal(sent.some((m) => m.type === 'error'), false, 'the diff was refused during a run');
  assert.equal(sent.some((m) => m.type === 'diff'), true);
});

test('a git failure is an error frame, never silence', async () => {
  // A window that asked and got nothing would sit on a spinner for ever.
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => Promise.resolve(0),
    diff: () => Promise.reject(new Error('not a git repository')),
  });
  session.receive(line({ type: 'diff', id: 9, dir: 'C:/r', baseSha: 'abc' }));
  await settle();

  assert.deepEqual(sent, [{ type: 'error', id: 9, message: 'not a git repository' }]);
});

test('an empty diff is an answer, not a failure', async () => {
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => Promise.resolve(0),
    diff: () => Promise.resolve({ patch: '', truncated: false }),
  });
  session.receive(line({ type: 'diff', id: 1, dir: 'C:/r', baseSha: 'abc' }));
  await settle();

  const reply = sent[0];
  assert.equal(reply?.type === 'diff' ? reply.patch : null, '');
  assert.equal(reply?.type === 'diff' ? reply.truncated : null, false);
});
