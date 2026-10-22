import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * The Mac build is one universal bundle, Apple Silicon and Intel (#325).
 *
 * Three things have to agree for an Intel Mac to get a working app, and for an
 * Apple Silicon install made before this to keep updating:
 *
 * - `stage-sidecar.mjs` stages a two-architecture `node`, built from the
 *   official darwin-arm64 and darwin-x64 archives of the running Node version,
 *   each refused unless `SHASUMS256.txt` vouches for it. Tested here through its
 *   pure parts; the download and the `lipo` need the network and macOS, and run
 *   in release.yml, whose host-start step checks the result.
 * - release.yml builds `--target universal-apple-darwin` with both Rust targets
 *   and starts the host under both architectures.
 * - latest.json serves the one update bundle under both `darwin-aarch64` and
 *   `darwin-x86_64`, because the updater asks for the key of the slice it is
 *   running.
 *
 * It reads files and imports one script; it touches no network.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// From dist/tests back to the repository root.
const root = path.join(here, '..', '..');
const read = (...parts: string[]): string => readFileSync(path.join(root, ...parts), 'utf8');
const workflow = read('.github', 'workflows', 'release.yml');

interface Archive {
  arch: string;
  file: string;
  member: string;
  url: string;
}
interface Stage {
  UNIVERSAL: string;
  wantsUniversal: (env: Record<string, string | undefined>) => boolean;
  universalSidecarNames: () => string[];
  nodeArchives: (version: string) => Archive[];
  expectedSha256: (shasums: string, file: string) => string | undefined;
  verifySha256: (bytes: Buffer, shasums: string, file: string) => string;
}

async function stage(): Promise<Stage> {
  const mod: unknown = await import(pathToFileURL(path.join(root, 'app', 'scripts', 'stage-sidecar.mjs')).href);
  assert.ok(mod !== null && typeof mod === 'object');
  for (const name of ['wantsUniversal', 'universalSidecarNames', 'nodeArchives', 'expectedSha256', 'verifySha256']) {
    assert.equal(typeof (mod as Record<string, unknown>)[name], 'function', `stage-sidecar.mjs exports no ${name}`);
  }
  return mod as Stage;
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

test('importing stage-sidecar runs nothing: the build only happens as a script', async () => {
  // If the import ran the staging it would rebuild the core and copy node
  // into app/src-tauri from inside the test suite.
  const s = await stage();
  assert.equal(s.UNIVERSAL, 'universal-apple-darwin');
});

test('the universal road is taken only when a build asks for it', async () => {
  const { wantsUniversal } = await stage();
  assert.equal(wantsUniversal({}), false);
  assert.equal(wantsUniversal({ VIBE_SIDECAR_TARGET: '' }), false);
  assert.equal(wantsUniversal({ TAURI_ENV_TARGET_TRIPLE: 'aarch64-apple-darwin' }), false);
  assert.equal(wantsUniversal({ VIBE_SIDECAR_TARGET: 'universal-apple-darwin' }), true);
  assert.equal(wantsUniversal({ TAURI_ENV_TARGET_TRIPLE: 'universal-apple-darwin' }), true);
});

test('the fat node is staged under each name Tauri looks for in a universal build', async () => {
  const { universalSidecarNames } = await stage();
  assert.deepEqual(universalSidecarNames().sort(), [
    'node-aarch64-apple-darwin',
    'node-universal-apple-darwin',
    'node-x86_64-apple-darwin',
  ]);
});

test('both slices come from nodejs.org, at the version given', async () => {
  const { nodeArchives } = await stage();
  assert.deepEqual(nodeArchives('v22.23.4'), [
    {
      arch: 'arm64',
      file: 'node-v22.23.4-darwin-arm64.tar.gz',
      member: 'node-v22.23.4-darwin-arm64/bin/node',
      url: 'https://nodejs.org/dist/v22.23.4/node-v22.23.4-darwin-arm64.tar.gz',
    },
    {
      arch: 'x64',
      file: 'node-v22.23.4-darwin-x64.tar.gz',
      member: 'node-v22.23.4-darwin-x64/bin/node',
      url: 'https://nodejs.org/dist/v22.23.4/node-v22.23.4-darwin-x64.tar.gz',
    },
  ]);
  // A version that is not a release would build a URL to nothing, or to
  // somewhere else.
  for (const bad of ['22.23.4', 'v22', 'v22.23.4/../x', '']) {
    assert.throws(() => nodeArchives(bad), /not a Node release version/);
  }
});

test('a checksum is read only from a single line naming exactly that file', async () => {
  const { expectedSha256 } = await stage();
  const a = sha('a');
  const b = sha('b');
  const list = [
    `${a}  node-v22.23.4-darwin-arm64.tar.gz`,
    `${b}  node-v22.23.4-darwin-arm64.tar.xz`,
    `${b} *node-v22.23.4-darwin-x64.tar.gz`,
    '',
  ].join('\n');
  assert.equal(expectedSha256(list, 'node-v22.23.4-darwin-arm64.tar.gz'), a);
  assert.equal(expectedSha256(list, 'node-v22.23.4-darwin-x64.tar.gz'), b, 'the binary-mode `*` is allowed');
  assert.equal(expectedSha256(list, 'node-v22.23.4-darwin-arm64.tar'), undefined, 'a prefix is not a match');
  assert.equal(expectedSha256(list, 'node-v22.23.4-linux-x64.tar.gz'), undefined);
  // Two lines for one file is a list this cannot choose from.
  assert.equal(expectedSha256(`${list}\n${b}  node-v22.23.4-darwin-arm64.tar.gz\n`, 'node-v22.23.4-darwin-arm64.tar.gz'), undefined);
});

test('an archive that does not match its checksum, or has none, is refused', async () => {
  const { verifySha256 } = await stage();
  const bytes = Buffer.from('the real archive');
  const list = `${sha('the real archive')}  node-v1.2.3-darwin-x64.tar.gz\n`;
  assert.equal(verifySha256(bytes, list, 'node-v1.2.3-darwin-x64.tar.gz'), sha('the real archive'));
  assert.throws(() => verifySha256(Buffer.from('something else'), list, 'node-v1.2.3-darwin-x64.tar.gz'), /hashes to/);
  assert.throws(() => verifySha256(bytes, list, 'node-v1.2.3-darwin-arm64.tar.gz'), /unverified/);
  assert.throws(() => verifySha256(bytes, '', 'node-v1.2.3-darwin-x64.tar.gz'), /unverified/);
});

/** The text of the build matrix's macOS entry: from its `- os: macos-` line to the next `- os:`. */
function macEntry(): string {
  const m = /^( +)- os: macos-[^\n]*\n(?:\1 [^\n]*\n|\s*#[^\n]*\n)*/m.exec(workflow.slice(workflow.indexOf('  build:')));
  assert.ok(m, 'the build matrix has no macOS entry');
  return m[0];
}

test('the macOS release build is the universal one, with both Rust targets', () => {
  const mac = macEntry();
  assert.match(mac, /build_args: --target universal-apple-darwin$/m);
  assert.match(mac, /sidecar_target: universal-apple-darwin$/m);
  assert.match(mac, /out: target\/universal-apple-darwin\/release$/m);
  const targets = /rust_targets: (\S+)$/m.exec(mac)?.[1]?.split(',').sort();
  assert.deepEqual(targets, ['aarch64-apple-darwin', 'x86_64-apple-darwin']);
  assert.match(workflow, /targets: \$\{\{ matrix\.rust_targets/);
  assert.match(workflow, /VIBE_SIDECAR_TARGET: \$\{\{ matrix\.sidecar_target/);
  assert.match(workflow, /npm run app:build -- \$\{BUILD_ARGS:-\}/);
});

test('every step that reads the bundles reads them where the build wrote them', () => {
  // A `--target` build writes under target/<triple>/release, not target/release.
  assert.match(workflow, /working-directory: app\/src-tauri\/\$\{\{ matrix\.out \}\}\/bundle\/macos/);
  assert.match(workflow, /working-directory: app\/src-tauri\/\$\{\{ matrix\.out \}\}$/m);
  assert.match(workflow, /p="app\/src-tauri\/\$OUT\/\$f"/);
});

test('the release runs the host from the bundle under both architectures', () => {
  assert.match(workflow, /lipo -archs/);
  assert.match(workflow, /for a in arm64 x86_64; do/);
  assert.match(workflow, /arch "-\$a" "\$contents\/MacOS\/node"/);
});

test('latest.json serves the macOS update bundle to both kinds of Mac', () => {
  // An Apple Silicon install made before #325 asks for darwin-aarch64, and an
  // Intel one for darwin-x86_64; dropping either strands that Mac.
  const line = workflow.split('\n').find((l) => l.trim().startsWith('*.app.tar.gz)'));
  assert.ok(line, 'latest.json maps no .app.tar.gz');
  assert.match(line, /add darwin-aarch64 "\$asset"/);
  assert.match(line, /add darwin-x86_64 "\$asset"/);
});

test('the bundle refuses the macOS versions its Intel node cannot run on', () => {
  // The official Node 22 darwin-x64 binary is linked for macOS 11.0
  // (LC_BUILD_VERSION minos, v22.23.4, read 2026-10-21). Tauri's default floor
  // is 10.13, which would let an older Intel Mac open a window whose host can
  // never start.
  const conf = JSON.parse(read('app', 'src-tauri', 'tauri.conf.json')) as {
    bundle?: { macOS?: { minimumSystemVersion?: unknown } };
  };
  assert.equal(conf.bundle?.macOS?.minimumSystemVersion, '11.0');
});
