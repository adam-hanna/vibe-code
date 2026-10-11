import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * The macOS bundle's `node` may JIT, and the release checks that it can run.
 *
 * Tauri signs every binary in the .app with the hardened runtime, the sidecar
 * `node` included. Under that runtime V8 cannot map executable memory without
 * `com.apple.security.cs.allow-jit`, so the process dies with SIGTRAP (exit 133)
 * on its first line of JavaScript, printing nothing. `node --version` still
 * works, because it runs no JavaScript. v1.6.0 shipped that way: the service
 * host "ended without an exit code" 20ms after it started, and the window sat
 * on `connecting` with "no host service is running".
 *
 * Measured on the v1.6.0 binary: `node -e 'console.log(1+1)'` exits 133 as
 * shipped, and prints 2 once re-signed with `allow-jit` alone.
 *
 * It reads files and nothing else, like `download-names.test.ts`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// From dist/tests back to the repository root.
const root = path.join(here, '..', '..');
const read = (...parts: string[]): string => readFileSync(path.join(root, ...parts), 'utf8');

test('the macOS bundle is signed with an entitlements file that allows JIT', () => {
  const conf = JSON.parse(read('app', 'src-tauri', 'tauri.conf.json')) as {
    bundle?: { macOS?: { entitlements?: unknown } };
  };
  const entitlements = conf.bundle?.macOS?.entitlements;
  assert.equal(typeof entitlements, 'string', 'tauri.conf.json sets no bundle.macOS.entitlements');
  const plist = read('app', 'src-tauri', entitlements as string);
  assert.match(
    plist,
    /<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\/>/,
    `${String(entitlements)} does not grant com.apple.security.cs.allow-jit`,
  );
});

test('the release starts the host from the built macOS bundle', () => {
  const workflow = read('.github', 'workflows', 'release.yml');
  assert.match(workflow, /\/Resources\/host\/dist\/src\/hostmain\.js/);
  assert.match(workflow, /"type":"ready"/);
});
