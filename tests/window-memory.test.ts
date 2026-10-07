import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listEntries, memoryDir } from '@src/chatstore.js';
import { decode } from '@src/protocol.js';

/**
 * The window's memory as files (#223): the projects, pins, names, drafts, type
 * scale, the pilot's books and where the window was pointed. They followed the
 * chats out of `localStorage` because WebKit refuses an origin's whole storage
 * once the sqlite FILE passes its 5 MiB quota, and deleting the migrated chat
 * keys left that file at 5,267,456 bytes holding 29 KB - the app came up
 * looking factory-reset with every key still on disk.
 */

const line = (v: unknown): string => JSON.stringify(v);

test('the directory is the app data one, beside the chats and not inside them', () => {
  assert.equal(memoryDir({ VIBE_APP_DATA: '/data/app' }), path.join('/data/app', 'memory'));
  assert.equal(memoryDir({}), null);
});

test('a save names a window key, never a conversation, and says null to remove', () => {
  assert.equal(decode(line({ type: 'memory_save', id: 1, key: 'vibe.projects', value: '[]' })).ok, true);
  assert.equal(decode(line({ type: 'memory_save', id: 1, key: 'vibe.where', value: null })).ok, true);
  assert.equal(decode(line({ type: 'memory_save', id: 1, key: 'vibe.where' })).ok, false, 'a missing value is not a removal');
  // A conversation has its own frame and its own directory; one key reachable
  // by both roads would be two files disagreeing about one chat.
  assert.equal(decode(line({ type: 'memory_save', id: 1, key: 'vibe.chat./r::none', value: 'x' })).ok, false);
  assert.equal(decode(line({ type: 'memory_save', id: 1, key: 'other', value: 'x' })).ok, false);
  assert.equal(decode(line({ type: 'memory', id: 2 })).ok, true);
});

test('the host stores and lists an entry in its own directory, and the chats never see it', async () => {
  const { createSession } = await import('@src/serve.js');
  const base = mkdtempSync(path.join(tmpdir(), 'vibe-memory-host-'));
  const before = process.env['VIBE_APP_DATA'];
  process.env['VIBE_APP_DATA'] = base;
  try {
    const sent: { type: string; id?: unknown; entries?: unknown; chats?: unknown }[] = [];
    const session = createSession((m) => void sent.push(m as { type: string }), {
      invoke: () => Promise.resolve(0),
    });
    session.write(`${line({ type: 'memory_save', id: 3, key: 'vibe.projects', value: '["/r"]' })}\n`);
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(sent.some((m) => m.type === 'memory_saved' && m.id === 3), JSON.stringify(sent));
    assert.deepEqual(listEntries(path.join(base, 'memory')), [{ key: 'vibe.projects', value: '["/r"]' }]);
    assert.equal(existsSync(path.join(base, 'chats')), false);

    session.write(`${line({ type: 'memory', id: 4 })}\n`);
    session.write(`${line({ type: 'chats', id: 5 })}\n`);
    await new Promise((r) => setTimeout(r, 20));
    const memory = sent.find((m) => m.type === 'memory' && m.id === 4);
    assert.deepEqual(memory?.entries, [{ key: 'vibe.projects', value: '["/r"]' }]);
    const chats = sent.find((m) => m.type === 'chats' && m.id === 5);
    assert.deepEqual(chats?.chats, []);

    session.write(`${line({ type: 'memory_save', id: 6, key: 'vibe.projects', value: null })}\n`);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(listEntries(path.join(base, 'memory')), []);
  } finally {
    if (before === undefined) delete process.env['VIBE_APP_DATA'];
    else process.env['VIBE_APP_DATA'] = before;
  }
});

test('without the data directory the host refuses rather than picking one', async () => {
  const { createSession } = await import('@src/serve.js');
  const before = process.env['VIBE_APP_DATA'];
  delete process.env['VIBE_APP_DATA'];
  try {
    const sent: { type: string; id?: unknown; message?: unknown }[] = [];
    const session = createSession((m) => void sent.push(m as { type: string }), {
      invoke: () => Promise.resolve(0),
    });
    session.write(`${line({ type: 'memory', id: 7 })}\n`);
    await new Promise((r) => setTimeout(r, 20));
    const err = sent.find((m) => m.type === 'error' && m.id === 7);
    assert.match(String(err?.message), /VIBE_APP_DATA/);
  } finally {
    if (before !== undefined) process.env['VIBE_APP_DATA'] = before;
  }
});
