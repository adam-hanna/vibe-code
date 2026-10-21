// Stage the two things the bundle needs that are not the webview: the compiled
// core, and a Node runtime to run it with.
//
// Tauri handles the two halves differently and it is worth knowing why:
//
//   - `node` goes in `binaries/` as an **externalBin**. Tauri appends the target
//     triple, picks the right one per platform, and - the part that matters off
//     Windows - marks it executable in the bundle. A resource would not be.
//   - `dist/src` goes in `host/` as a **resource**. It is not a binary, it is
//     data the binary reads, and it is the same bytes on every platform.
//
// The `package.json` written beside it is not decoration. The staged tree
// currently runs only because Node >= 22.7 detects module syntax by default;
// relying on a runtime default for whether our own ESM parses is the kind of
// thing that breaks on a machine we do not own. Stating `"type": "module"` makes
// it ours.
//
// A universal macOS build (#325) is the one case where the runtime running this
// script is not the one that ships: it is one architecture and the bundle needs
// both. See `stageUniversalNode` below.
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');
const repo = path.resolve(app, '..');
const tauri = path.join(app, 'src-tauri');

/**
 * The triple Tauri appends to an externalBin.
 *
 * Asked of the toolchain that will do the build rather than derived from
 * `process.platform` and `process.arch`. Those two would produce a plausible
 * triple that is wrong on any machine with more than one toolchain - and the
 * failure is a build that says `resource path binaries\node-<triple> doesn't
 * exist` about a file that is sitting right there under a different name.
 */
function hostTriple() {
  let out;
  try {
    out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  } catch (err) {
    if (err !== null && typeof err === 'object' && err.code === 'ENOENT') {
      console.error(
        'rustc is not on PATH, so the target triple cannot be read.\n' +
          'Install Rust from https://rustup.rs, or add ~/.cargo/bin to PATH in this shell.',
      );
      process.exit(1);
    }
    throw err;
  }
  const line = out.split('\n').find((l) => l.startsWith('host:'));
  if (line === undefined) throw new Error('rustc -vV named no host triple');
  return line.slice('host:'.length).trim();
}

function bytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? bytes(full) : statSync(full).size;
  }
  return total;
}

const mb = (n) => `${(n / 1_000_000).toFixed(1)} MB`;

/** The one target this script builds a two-architecture runtime for. */
export const UNIVERSAL = 'universal-apple-darwin';

/**
 * Whether this build is the universal macOS one, and so needs a fat `node`.
 *
 * `VIBE_SIDECAR_TARGET` is what release.yml sets, because it is ours and says
 * exactly one thing. `TAURI_ENV_TARGET_TRIPLE` is what the Tauri CLI hands its
 * `beforeBuildCommand`, so a local `npm run app:build -- --target
 * universal-apple-darwin` takes the same road without remembering a variable.
 * Anything else keeps the old road: copy the running node. Pure.
 */
export function wantsUniversal(env) {
  return env.VIBE_SIDECAR_TARGET === UNIVERSAL || env.TAURI_ENV_TARGET_TRIPLE === UNIVERSAL;
}

/**
 * The names the universal runtime is staged under.
 *
 * All three, because two different parts of Tauri look for it. The CLI builds a
 * universal app as two ordinary cargo builds and a `lipo`, and `tauri-build`
 * in each of those builds copies `binaries/node-<that build's triple>` and
 * fails when it is absent. The bundler then takes `node-universal-apple-darwin`
 * for the .app. A fat binary is a valid answer to all three, so it is the same
 * file under each name. Pure.
 */
export function universalSidecarNames() {
  return ['aarch64-apple-darwin', 'x86_64-apple-darwin', UNIVERSAL].map((t) => `node-${t}`);
}

/** The two official archives a universal runtime is made from, for one Node version (`v22.23.4`). Pure. */
export function nodeArchives(version) {
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error(`not a Node release version: ${version}`);
  return ['arm64', 'x64'].map((arch) => {
    const stem = `node-${version}-darwin-${arch}`;
    return { arch, file: `${stem}.tar.gz`, member: `${stem}/bin/node`, url: `https://nodejs.org/dist/${version}/${stem}.tar.gz` };
  });
}

/**
 * The SHA-256 that Node's `SHASUMS256.txt` gives one file, or `undefined`.
 *
 * Exactly one line must name the file. Two lines naming it is a list this
 * cannot choose from, and is treated as no answer rather than the first. Pure.
 */
export function expectedSha256(shasums, file) {
  const found = [];
  for (const line of shasums.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line.trim());
    if (m !== null && m[2] === file) found.push(m[1]);
  }
  return found.length === 1 ? found[0] : undefined;
}

/** Throws unless `bytes` hash to what `shasums` says for `file`. Fails closed: an unlisted file is a failure. */
export function verifySha256(bytes, shasums, file) {
  const want = expectedSha256(shasums, file);
  if (want === undefined) throw new Error(`SHASUMS256.txt has no single line for ${file}; refusing to ship it unverified`);
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== want) throw new Error(`${file} hashes to ${got}, and SHASUMS256.txt says ${want}`);
  return got;
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * A universal `node` for the universal macOS bundle (#325), at `out`.
 *
 * The runtime running this script is one architecture, so it cannot be copied
 * as it is on every other build. Instead: the official darwin-arm64 and
 * darwin-x64 builds of **the same version as this runtime**, so the shipped
 * Node is still the one CI's `setup-node` installed and the core was tested
 * against; each checked against that release's `SHASUMS256.txt` before it is
 * unpacked; and `lipo -create` over the two. The result is checked for both
 * slices and run once, so a fat file that does not start fails here and not on
 * somebody's Mac. Tauri re-signs it with the hardened runtime and `allow-jit`
 * exactly as it did the thin one.
 */
export async function stageUniversalNode(version, out) {
  const base = `https://nodejs.org/dist/${version}`;
  const shasums = (await download(`${base}/SHASUMS256.txt`)).toString('utf8');
  const work = mkdtempSync(path.join(tmpdir(), 'vibe-node-universal-'));
  try {
    const slices = [];
    for (const archive of nodeArchives(version)) {
      const bytes = await download(archive.url);
      const sum = verifySha256(bytes, shasums, archive.file);
      console.log(`fetched ${archive.file}  sha256 ${sum}  (matches SHASUMS256.txt)`);
      const tarball = path.join(work, archive.file);
      writeFileSync(tarball, bytes);
      const dir = path.join(work, archive.arch);
      mkdirSync(dir);
      execFileSync('tar', ['-xzf', tarball, '-C', dir, archive.member], { stdio: 'inherit' });
      slices.push(path.join(dir, archive.member));
    }
    execFileSync('lipo', ['-create', '-output', out, ...slices], { stdio: 'inherit' });
    const archs = execFileSync('lipo', ['-archs', out], { encoding: 'utf8' }).trim().split(/\s+/).sort();
    if (archs.join(' ') !== 'arm64 x86_64') throw new Error(`lipo made a node with ${archs.join(', ')}; expected arm64 and x86_64`);
    const ran = execFileSync(out, ['--version'], { encoding: 'utf8' }).trim();
    if (ran !== version) throw new Error(`the universal node says ${ran}, not ${version}`);
    console.log(`lipo    ${archs.join(' + ')} -> ${path.basename(out)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const built = path.join(repo, 'dist', 'src');
  // Compiled here, every time, rather than copied as found. `beforeBuildCommand`
  // runs the APP's `npm run build`, which is the webview, so nothing in the bundle
  // build ever compiled the core: `dist/src` was whatever the last root build or
  // `npm test` happened to leave, and a host-side fix could be committed, pass its
  // tests and still not be in the app. Found on 2026-10-06 checking why an opened
  // run's Code tab still said "No base yet" after the replay learned to carry the
  // base. A shell, because `npm` is `npm.cmd` on Windows and only a shell runs it.
  execSync('npm run build', { cwd: repo, stdio: 'inherit' });
  if (!existsSync(path.join(built, 'hostmain.js'))) {
    console.error(`No built core at ${built}. Run \`npm run build\` in the repo root first.`);
    process.exit(1);
  }

  // Cleared rather than merged. A stale module from a previous build that no
  // longer exists in `dist/src` would still be resolvable in the bundle, and the
  // one thing worse than a missing file is an old one.
  const host = path.join(tauri, 'host');
  rmSync(host, { recursive: true, force: true });
  mkdirSync(host, { recursive: true });
  cpSync(built, path.join(host, 'dist', 'src'), { recursive: true });
  writeFileSync(
    path.join(host, 'package.json'),
    `${JSON.stringify(
      {
        name: 'vibe-host',
        private: true,
        // See the header. Not inherited from anywhere - this tree is copied out of
        // the repo and has no parent package.json in the bundle.
        type: 'module',
      },
      null,
      2,
    )}\n`,
  );

  // The build stamp, read by `src-tauri/build.rs` (#201).
  //
  // Written from here rather than exported as an env var because this runs in a
  // child of `beforeBuildCommand` and anything it exports dies with the process.
  // A file also gives cargo an accurate `rerun-if-changed`: cargo rebuilds when
  // *Rust* changes, and the thing that usually changes is the webview, which it
  // cannot see. The timestamp is fresh every run, so the file always differs and
  // the binary is always re-stamped by a real bundle build.
  //
  // The commit is asked of git here, where the repository is, rather than from
  // inside `src-tauri`. A tree with no git writes an empty first line, and the
  // Rust side reports the absence rather than inventing a hash.
  function commit() {
    try {
      return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
        cwd: repo,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return '';
    }
  }
  const stamped = commit();
  writeFileSync(path.join(tauri, '.build-stamp'), `${stamped}\n${String(Date.now())}\n`);
  console.log(`stamp   ${stamped === '' ? 'no commit - this tree has no git' : stamped}`);

  const binaries = path.join(tauri, 'binaries');
  mkdirSync(binaries, { recursive: true });

  if (wantsUniversal(process.env)) {
    if (process.platform !== 'darwin') {
      console.error(`A ${UNIVERSAL} sidecar needs lipo, which only macOS has.`);
      process.exit(1);
    }
    const [first, ...rest] = universalSidecarNames().map((n) => path.join(binaries, n));
    await stageUniversalNode(process.version, first);
    for (const other of rest) copyFileSync(first, other);
    console.log(`node    ${process.version} (universal) -> ${universalSidecarNames().join(', ')}  (${mb(statSync(first).size)})`);
    console.log(`core    ${path.relative(tauri, host)}  (${mb(bytes(host))})`);
    console.log(`triple  ${UNIVERSAL}`);
    return;
  }

  const triple = hostTriple();
  const ext = process.platform === 'win32' ? '.exe' : '';
  const node = path.join(binaries, `node-${triple}${ext}`);
  // The runtime running this script is the runtime that gets shipped. It is the
  // one the core is tested against on this machine, which is a better claim than
  // whatever a download would have been.
  cpSync(process.execPath, node);

  console.log(`node    ${process.version} -> ${path.relative(tauri, node)}  (${mb(statSync(node).size)})`);
  console.log(`core    ${path.relative(tauri, host)}  (${mb(bytes(host))})`);
  console.log(`triple  ${triple}`);
}

// Imported by tests for the pure parts above; run as a script by `npm run stage:sidecar`.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
