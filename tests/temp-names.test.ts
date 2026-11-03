import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * `scripts/temp-names.mjs` decides which new `vibe-*` entries in the machine's
 * temp directory fail `npm test`: the ones this repo's code can name (#510).
 * Anything else is another process's, reported and not counted, so a prefix
 * the scan missed would be a real leak waved through as foreign. These cases
 * pin the scan against the source it reads: every literal handed to `mkdtemp`
 * or joined onto `tmpdir()`, found here by a second, independent pattern, has
 * to come out counted.
 *
 * Reads the repository's own `src/`, `tests/` and `scripts/` as source, like
 * `update-check-guard.test.ts`.
 */

interface Scan {
  prefixes: string[];
  bare: boolean;
  unresolved: string[];
  files: number;
}
interface Sorted {
  leaked: string[];
  ignored: { name: string; why: string }[];
  foreign: string[];
  strict: boolean;
}
interface TempNames {
  scanTempNames(cwd: string): Scan;
  classify(names: string[], scan: Scan): Sorted;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..');
const load = async (): Promise<TempNames> =>
  (await import(pathToFileURL(path.join(repo, 'scripts', 'temp-names.mjs')).href)) as TempNames;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'fixtures' && entry.name !== 'node_modules') sources(full, out);
    } else if (/\.(?:ts|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// What mkdtemp would append to a prefix: six letters or digits.
const SUFFIX = 'Ab12Cd';

const CHECKER = new Set(['scripts/test.mjs', 'scripts/temp-names.mjs']);

/** Every literal temp name in the source, by the shapes the fixtures use. */
function literalTempNames(): Map<string, string> {
  const shapes = [
    // mkdtempSync(path.join(tmpdir(), '…')), join(os.tmpdir(), '…'), and the same under mkdtemp.
    /join\(\s*(?:os\.)?tmpdir\(\)\s*,\s*['"`]([^'"`$]+)['"`]/g,
    // A helper that takes the prefix: loop-harness's `prefix: '…'` and its `?? '…'` default.
    /prefix(?:\s*:|\s*\?\?)\s*['"`]([^'"`$]+)['"`]/g,
  ];
  const found = new Map<string, string>();
  for (const root of ['src', 'tests', 'scripts']) {
    for (const file of sources(path.join(repo, root))) {
      // The checker is not scanned: its one temp name is the run's own root,
      // excluded by name, and its comments quote shapes rather than names.
      if (CHECKER.has(path.relative(repo, file).split(path.sep).join('/'))) continue;
      const text = readFileSync(file, 'utf8');
      for (const shape of shapes) {
        for (const match of text.matchAll(shape)) {
          const name = match[1];
          if (name !== undefined && name.startsWith('vibe')) found.set(name, path.relative(repo, file));
        }
      }
    }
  }
  return found;
}

test('every temp name the source hands to tmpdir() is one a leak would be counted for', async () => {
  const { scanTempNames, classify } = await load();
  const scan = scanTempNames(repo);
  const names = literalTempNames();
  // Not vacuous: the suite has hundreds of these.
  assert.ok(names.size > 200, `found only ${names.size} temp names in the source`);

  const missed: string[] = [];
  for (const [name, file] of names) {
    // mkdtemp's shape and the name used as it stands.
    for (const made of [name + SUFFIX, name]) {
      const sorted = classify([made], scan);
      if (sorted.leaked.length === 1) continue;
      // The one exception, in the one shape the app makes it.
      if (sorted.ignored.length === 1 && made === `vibe-pilot-${SUFFIX}`) continue;
      missed.push(`${made} (${file})`);
    }
  }
  assert.deepEqual(missed, [], 'names the code makes that the scan would let through as foreign');
});

test('the scan reads this repository and resolves every name in it', async () => {
  // An unresolved name puts the whole check back to counting every entry,
  // which is #510 again for everybody running beside another worktree.
  const { scanTempNames } = await load();
  const scan = scanTempNames(repo);
  assert.ok(scan.files > 300, `read only ${scan.files} files`);
  assert.deepEqual(scan.unresolved, [], 'give these a fixed prefix rather than a bare one and a value');
});

test("the names vibe runs in sibling worktrees wrote on 2026-11-03 are not this repo's", async () => {
  // Built at runtime: the scan reads this file, and a literal would make the
  // name one of ours.
  const ns = 'vibe';
  const seen = ['edit-stored.py', 'edit-cli.py', 'edit-docs.py', '484-test3.log', '484-docs-ci.log'].map(
    (rest) => `${ns}-${rest}`,
  );
  const { scanTempNames, classify } = await load();
  const sorted = classify(seen, scanTempNames(repo));
  assert.deepEqual(sorted.foreign, seen);
  assert.deepEqual(sorted.leaked, []);
  assert.equal(sorted.strict, false);
});

test('a scan that finds no code counts every entry rather than none', async () => {
  // Fail closed: nothing read is not the same as nothing found.
  const { classify } = await load();
  const sorted = classify(['vibe-anything'], { prefixes: [], bare: false, unresolved: [], files: 0 });
  assert.deepEqual(sorted.leaked, ['vibe-anything']);
  assert.equal(sorted.strict, true);
});

test("a bare prefix counts only mkdtemp's shape of it", async () => {
  // A bare one in the code could be handed to mkdtemp, which appends six
  // letters or digits; it does not make every name in the namespace ours.
  const { classify } = await load();
  const ns = 'vibe';
  const scan = { prefixes: [], bare: true, unresolved: [], files: 1 };
  const sorted = classify([`${ns}-${SUFFIX}`, `${ns}-edit-x.py`], scan);
  assert.deepEqual(sorted.leaked, [`${ns}-${SUFFIX}`]);
  assert.deepEqual(sorted.foreign, [`${ns}-edit-x.py`]);
});
