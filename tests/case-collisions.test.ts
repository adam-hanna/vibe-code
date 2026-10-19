import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * No two files in the repository may differ only in case.
 *
 * macOS and Windows build on filesystems that ignore case, and Linux - this
 * machine, CI's gates and the Linux release build - does not. So a pair like
 * `app/src/phone/Pair.tsx` and `pair.ts` passes every gate here and breaks the
 * other two platforms: `import { Pair } from './Pair'` opens `pair.ts`, which
 * has no `Pair`. That is how v1.7.0-rc.2's Windows, macOS and iPhone builds
 * failed with `TS1149: ... differs from already included file name ... only in
 * casing`, while the Linux and Android builds, from the same commit, passed.
 *
 * Two rules, because an import names a module rather than a file:
 * - **paths** may not collide ignoring case, for every file;
 * - **modules** may not either: a script or TypeScript file with its extension
 *   taken off, since `./Pair` resolves `Pair.tsx` and `pair.ts` alike.
 *
 * It walks the tree rather than naming directories, so a new one is covered
 * without anybody extending a list. It reads names and nothing else.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// From dist/tests back to the repository root.
const root = path.join(here, '..', '..');

/** Generated, installed or private trees: none of them is the repository's own source. */
const SKIP = new Set(['.git', 'node_modules', 'dist', 'target', 'gen', '.worktrees', '.vibe', 'cache', '.vitepress-dist']);
const SCRIPT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function walk(dir: string, rel: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), next, out);
    else if (entry.isFile()) out.push(next);
  }
}

function collisions(names: string[]): string[] {
  const seen = new Map<string, string>();
  const found: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    const before = seen.get(key);
    if (before !== undefined && before !== name) found.push(`${before} <-> ${name}`);
    else seen.set(key, name);
  }
  return found;
}

const files: string[] = [];
walk(root, '', files);

test('the walk found the sources it is meant to guard', () => {
  // A walk that silently found nothing would pass every case below.
  for (const known of ['src/cli.ts', 'app/src/cockpit/model.ts', 'app/src/phone/Pair.tsx']) {
    assert.ok(files.includes(known), `the walk did not find ${known}`);
  }
});

test('no two files differ only in case', () => {
  assert.deepEqual(collisions(files), []);
});

test('no two modules differ only in case, extensions aside', () => {
  const modules = [...new Set(files.filter((f) => SCRIPT.test(f)).map((f) => f.replace(SCRIPT, '')))];
  assert.deepEqual(collisions(modules), []);
});
