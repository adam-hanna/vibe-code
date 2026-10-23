import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '@src/config.js';
import { PILOT_PROMPT_BLOCKS, promptBlockNames } from '@src/prompts.js';

/**
 * The pilot's editable blocks share the core's `prompts` table (#420).
 *
 * The pilot's prompt is built in the webview, so its texts live in
 * `app/src/pilot/brief.ts`; the core holds only their names, because its
 * validator refuses a name this build does not have. Two lists of one set of
 * names is the shape `promptBlockNames()` was derived to avoid, and the two
 * packages cannot import each other, so this file is what keeps them equal.
 */

function repoWith(config: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-pilot-prompt-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify(config), 'utf8');
  return dir;
}

function repoRoot(): string {
  let at = path.dirname(fileURLToPath(import.meta.url));
  while (!existsSync(path.join(at, 'src', 'prompts.ts')) && path.dirname(at) !== at) {
    at = path.dirname(at);
  }
  return at;
}

test('a pilot block loads as a setting like any core block', () => {
  const dir = repoWith({ prompts: { 'pilot: intake': 'Branches are named feat/<issue>-<slug>.' } });
  assert.equal(loadConfig(dir).prompts['pilot: intake'], 'Branches are named feat/<issue>-<slug>.');
});

test('a misspelt pilot block is refused by name, and the refusal names the real ones', () => {
  const dir = repoWith({ prompts: { 'pilot: intak': 'typo' } });
  assert.throws(
    () => loadConfig(dir),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /pilot: intak"/);
      assert.match(err.message, /"pilot: intake"/);
      return true;
    },
  );
});

test('the pilot names say whose they are and cannot collide with a core block', () => {
  const core = new Set(promptBlockNames());
  assert.ok(PILOT_PROMPT_BLOCKS.length > 0);
  for (const name of PILOT_PROMPT_BLOCKS) {
    assert.match(name, /^pilot: /);
    assert.ok(!core.has(name), `${name} is also a core block`);
  }
  for (const name of core) assert.doesNotMatch(name, /^pilot: /);
});

test('the core accepts exactly the names the app builds the pilot prompt from', () => {
  // Read as source: `PILOT_BLOCK` in brief.ts is the app's one spelling of
  // them. A name the app has and the core refuses is an edit that cannot be
  // adopted; one the core accepts and the app lacks silently does nothing.
  const brief = readFileSync(path.join(repoRoot(), 'app', 'src', 'pilot', 'brief.ts'), 'utf8');
  const table = /export const PILOT_BLOCK = \{([\s\S]*?)\} as const;/.exec(brief);
  assert.ok(table !== null, 'PILOT_BLOCK moved - this test is reading the wrong thing');
  const app = [...(table[1] ?? '').matchAll(/'(pilot: [^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...app].sort(), [...PILOT_PROMPT_BLOCKS].sort());
});
