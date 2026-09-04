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
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

const built = path.join(repo, 'dist', 'src');
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

const triple = hostTriple();
const ext = process.platform === 'win32' ? '.exe' : '';
const binaries = path.join(tauri, 'binaries');
mkdirSync(binaries, { recursive: true });
const node = path.join(binaries, `node-${triple}${ext}`);
// The runtime running this script is the runtime that gets shipped. It is the
// one the core is tested against on this machine, which is a better claim than
// whatever a download would have been.
cpSync(process.execPath, node);

console.log(`node    ${process.version} -> ${path.relative(tauri, node)}  (${mb(statSync(node).size)})`);
console.log(`core    ${path.relative(tauri, host)}  (${mb(bytes(host))})`);
console.log(`triple  ${triple}`);
