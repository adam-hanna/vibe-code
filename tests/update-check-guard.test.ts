import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * The network request in `src/` stays in one file (#323).
 *
 * The core made every external call as a child process until #323, and the
 * owner's decision there reversed that for exactly one unauthenticated GET in
 * `src/updatecheck.ts`. This is what keeps it exactly one: any other `fetch(`,
 * or any import of a network module, anywhere else in `src/` fails here by file
 * and line - the equivalent, for the core, of `app/src/pilot/keys.test.ts`
 * keeping the app's network code in `app/`.
 *
 * And the host never reaches it: only the terminal's entry, `src/main.ts`,
 * imports the module, so no frame `serve.ts` writes can carry the line.
 *
 * Reads `src/` as source, like `prompt-blocks.test.ts`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(here, '..', '..', 'src');
const ALLOWED = 'updatecheck.ts';

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// `fetch(` as a call, and any import or require of Node's network modules or
// the HTTP client Node's fetch is built on.
const FETCH = /\bfetch\s*\(/;
const NET_MODULE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:node:)?(?:http|https|http2|net|tls|dgram|undici)['"]/;

const files = sources(srcDir);

test('the guard reads the real tree', () => {
  // Fail closed: a path that stopped resolving must not pass with nothing scanned.
  assert.ok(files.length > 50, `found only ${files.length} files under ${srcDir}`);
  assert.ok(files.some((f) => path.basename(f) === ALLOWED), 'src/updatecheck.ts is where the exception lives');
  // And the patterns match what they are meant to.
  assert.ok(FETCH.test("await fetch('https://x')"));
  assert.ok(NET_MODULE.test("import https from 'node:https';"));
  assert.ok(NET_MODULE.test("import { connect } from 'net';"));
  assert.ok(NET_MODULE.test("await import('node:http')"));
  assert.ok(!NET_MODULE.test("import { spawn } from 'node:child_process';"));
});

test('no file in src/ but updatecheck.ts calls fetch or imports a network module', () => {
  const found: string[] = [];
  for (const file of files) {
    if (path.relative(srcDir, file) === ALLOWED) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (FETCH.test(line) || NET_MODULE.test(line)) {
        found.push(`src/${path.relative(srcDir, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    found,
    [],
    'The only network request in src/ is src/updatecheck.ts (#323, AGENTS.md). Anything else is a ' +
      'child process or it lives in app/.',
  );
});

test('updatecheck.ts imports no network module either: it uses the global fetch', () => {
  const body = readFileSync(path.join(srcDir, ALLOWED), 'utf8');
  assert.equal(NET_MODULE.test(body), false);
});

test('only the terminal entry imports the update check, so the host never runs it', () => {
  const importers = files
    .filter((f) => /from\s+['"]@src\/updatecheck\.js['"]/.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(srcDir, f));
  assert.deepEqual(importers, ['main.ts']);
  // And nothing imports the terminal entry: it is a bin, so the host's
  // `hostmain.ts` -> `serve.ts` -> `cli.ts` chain cannot reach the check.
  const ofMain = files
    .filter((f) => /from\s+['"]@src\/main\.js['"]/.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(srcDir, f));
  assert.deepEqual(ofMain, []);
});
