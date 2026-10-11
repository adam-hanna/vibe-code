// Take the host-coupled graphics libraries back out of a built AppImage (#331).
//
//   node app/scripts/prune-appimage.mjs <path/to/App.AppImage>
//
// linuxdeploy copies every library the binary links unless it is on the
// AppImage excludelist. libwayland-* is not on it, so the AppImage carried the
// build machine's copy: Ubuntu 22.04's. The GL driver is never bundled - it
// cannot be, it has to match the kernel and the GPU - so WebKit ended up loading
// a 2022 libwayland next to the host's own Mesa. On Fedora 44 (Mesa 26) that
// pair could not create an EGL display, WebKit aborted, and the window stayed
// white. The process kept running, so nothing said it had failed.
//
// Deleting the client-side libraries (client, cursor, egl) from the AppDir fixed
// it, on the machine that reported it and on every distribution
// `smoke-appimage.sh` launches. They are safe to take from the host for two
// reasons. Every distribution that can run a GTK 3 app has them, because GTK 3
// links them. And libwayland's ABI only grows, so a newer host copy satisfies
// what Ubuntu 22.04's WebKit was linked against. The AppImage still refuses a
// host older than 22.04, through glibc.
//
// libwayland-server stays bundled, and that was measured, not assumed. It is
// not part of the clash: Fedora draws with the old copy kept. GTK 3 does not
// pull it in either. A first cut removed it, and the app then failed to start
// on Ubuntu 24.04 and Fedora images that had GTK 3 and Mesa installed but not
// it: `libwayland-server.so.0: cannot open shared object file`.
//
// Tauri runs linuxdeploy itself and offers no way to pass --exclude-library,
// so this works on the finished file instead:
//
//   1. Extract it with its own runtime (`--appimage-extract`).
//   2. Delete the libraries in PRUNE.
//   3. Repack with the appimagetool Tauri downloaded to build it, keeping the
//      original runtime bytes, so nothing about how it starts changes.
//   4. Re-sign it if a `.sig` sits beside it. That signature covers the old
//      bytes, and the updater would refuse the new ones.
//
// If the file holds none of the libraries, it is left exactly as it was.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What comes out of `usr/lib`, as file-name prefixes.
 *
 * Only libraries that must agree with the host's Mesa belong here. Every one
 * removed is one more library the host must provide.
 */
export const PRUNE = ['libwayland-client.so', 'libwayland-cursor.so', 'libwayland-egl.so'];

/** The entries of `usr/lib` this would delete. Pure, for the test. */
export function pruned(names) {
  return names.filter((n) => PRUNE.some((p) => n.startsWith(p))).sort();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(here, '..');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts });
}

/**
 * appimagetool, from the linuxdeploy plugin Tauri used to pack this file.
 *
 * The same tool keeps the repack the same as the original pack. If Tauri
 * stops caching it there, this says where it looked and APPIMAGETOOL can point
 * somewhere else.
 */
function appimagetool(scratch) {
  if (process.env.APPIMAGETOOL) return process.env.APPIMAGETOOL;
  const cache = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
  const plugin = path.join(cache, 'tauri', 'linuxdeploy-plugin-appimage.AppImage');
  if (!existsSync(plugin)) {
    throw new Error(`no appimagetool: ${plugin} does not exist (set APPIMAGETOOL to use another)`);
  }
  const dir = path.join(scratch, 'plugin');
  run(plugin, ['--appimage-extract'], { cwd: mkdirp(dir) });
  return path.join(dir, 'squashfs-root', 'usr', 'bin', 'appimagetool');
}

function mkdirp(dir) {
  execFileSync('mkdir', ['-p', dir]);
  return dir;
}

/** The runtime is the bytes before the squashfs; the runtime reports where that starts. */
function runtimeBytes(file) {
  const offset = Number(run(file, ['--appimage-offset']).trim());
  if (!Number.isInteger(offset) || offset <= 0) throw new Error(`${file} reported no squashfs offset`);
  const buf = Buffer.alloc(offset);
  const fd = openSync(file, 'r');
  try {
    if (readSync(fd, buf, 0, offset, 0) !== offset) throw new Error(`${file} is shorter than its own offset`);
  } finally {
    closeSync(fd);
  }
  return buf;
}

function sign(file) {
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
    // Leaving the old signature would publish an update every installed copy
    // rejects. Refuse instead.
    throw new Error(`${file}.sig exists but TAURI_SIGNING_PRIVATE_KEY is not set, so it cannot be re-signed`);
  }
  // `tauri signer sign` reads the key and its password from the environment
  // and writes <file>.sig. Nothing here sees either.
  run('npx', ['--no-install', 'tauri', 'signer', 'sign', file], { cwd: app, stdio: ['ignore', 'ignore', 'inherit'] });
}

export function prune(file) {
  file = path.resolve(file);
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'prune-appimage-'));
  try {
    const runtime = path.join(scratch, 'runtime');
    writeFileSync(runtime, runtimeBytes(file));

    run(file, ['--appimage-extract'], { cwd: scratch });
    const root = path.join(scratch, 'squashfs-root');
    const lib = path.join(root, 'usr', 'lib');
    const gone = pruned(readdirSync(lib));
    if (gone.length === 0) {
      console.log(`${path.basename(file)}: none of ${PRUNE.join(', ')} is bundled; left as it was.`);
      return [];
    }
    for (const name of gone) rmSync(path.join(lib, name));

    const tool = appimagetool(scratch);
    const out = `${file}.pruned`;
    run(tool, ['--no-appstream', '--comp', 'zstd', '--runtime-file', runtime, root, out], {
      cwd: scratch,
      env: { ...process.env, ARCH: 'x86_64', APPIMAGE_EXTRACT_AND_RUN: '1' },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    chmodSync(out, 0o755);
    renameSync(out, file);
    console.log(`${path.basename(file)}: removed ${gone.join(', ')}.`);

    if (existsSync(`${file}.sig`)) {
      sign(file);
      console.log(`${path.basename(file)}.sig: re-signed.`);
    }
    return gone;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: node app/scripts/prune-appimage.mjs <App.AppImage> ...');
    process.exit(64);
  }
  for (const f of files) prune(f);
}
