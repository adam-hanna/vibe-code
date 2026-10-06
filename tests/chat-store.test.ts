import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chatDir, listChats, saveChat } from '@src/chatstore.js';
import { decode } from '@src/protocol.js';

/**
 * The pilot's conversations as files (#223). They were the webview's
 * localStorage, which a 5.24 MB store had outgrown, and every save after that
 * failed silently - *"Have I lost my pilot chats?!"*
 */

const KEY = 'vibe.chat./home/me/repo::20261005-132228-run';

test('a conversation round-trips, and a removal removes it', () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'vibe-chats-')), 'chats');
  saveChat(dir, KEY, '{"messages":[1]}');
  saveChat(dir, 'vibe.chat./other::none', '{"messages":[2]}');
  assert.deepEqual(
    listChats(dir).sort((a, b) => a.key.localeCompare(b.key)),
    [
      { key: 'vibe.chat./home/me/repo::20261005-132228-run', value: '{"messages":[1]}' },
      { key: 'vibe.chat./other::none', value: '{"messages":[2]}' },
    ],
  );
  saveChat(dir, KEY, null);
  assert.deepEqual(listChats(dir).map((c) => c.key), ['vibe.chat./other::none']);
});

test('there is no size ceiling in the way, which was the whole defect', () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'vibe-chats-')), 'chats');
  const big = 'x'.repeat(12_000_000);
  saveChat(dir, KEY, big);
  assert.equal(listChats(dir)[0]?.value.length, big.length);
});

test('a key never becomes a path, and no temporary file is left behind', () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'vibe-chats-')), 'chats');
  saveChat(dir, 'vibe.chat.../../escape::none', 'v');
  const names = readdirSync(dir);
  assert.equal(names.length, 1);
  assert.match(names[0] ?? '', /^[0-9a-f]{64}\.json$/);
});

test('one unreadable file does not hide the others', () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'vibe-chats-')), 'chats');
  saveChat(dir, KEY, 'kept');
  writeFileSync(path.join(dir, 'broken.json'), '{not json', 'utf8');
  assert.deepEqual(listChats(dir), [{ key: KEY, value: 'kept' }]);
  assert.deepEqual(listChats(path.join(dir, 'missing')), []);
});

test('the directory is the app data one the shell names, and nothing is guessed without it', () => {
  assert.equal(chatDir({ VIBE_APP_DATA: '/data/app' }), path.join('/data/app', 'chats'));
  assert.equal(chatDir({}), null);
});

test('a save must name a conversation key and say null to remove', () => {
  const line = (v: unknown): string => JSON.stringify(v);
  assert.equal(decode(line({ type: 'chat_save', id: 1, key: KEY, value: 'v' })).ok, true);
  assert.equal(decode(line({ type: 'chat_save', id: 1, key: KEY, value: null })).ok, true);
  assert.equal(decode(line({ type: 'chat_save', id: 1, key: KEY })).ok, false, 'a missing value is not a removal');
  assert.equal(decode(line({ type: 'chat_save', id: 1, key: 'vibe.repo', value: 'x' })).ok, false);
  assert.equal(decode(line({ type: 'chats', id: 2 })).ok, true);
});

test('the host takes a conversation larger than the old 1 MB line ceiling', async () => {
  // A 1.1 MB chat was dropped at the line reader, the window waited out its
  // timeout, and the move out of localStorage stopped there.
  const { createSession } = await import('@src/serve.js');
  const base = mkdtempSync(path.join(tmpdir(), 'vibe-chats-host-'));
  const before = process.env['VIBE_APP_DATA'];
  process.env['VIBE_APP_DATA'] = base;
  try {
    const sent: { type: string; id?: unknown }[] = [];
    const session = createSession((m) => void sent.push(m as { type: string }), {
      invoke: () => Promise.resolve(0),
    });
    session.write(`${JSON.stringify({ type: 'chat_save', id: 9, key: KEY, value: 'y'.repeat(3_000_000) })}\n`);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(sent.some((m) => m.type === 'chat_saved' && m.id === 9), JSON.stringify(sent.slice(0, 2)));
    assert.equal(listChats(path.join(base, 'chats'))[0]?.value.length, 3_000_000);
  } finally {
    if (before === undefined) delete process.env['VIBE_APP_DATA'];
    else process.env['VIBE_APP_DATA'] = before;
  }
});
