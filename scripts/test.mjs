// `npm test`, run inside a sandbox the suite cannot leave litter outside of.
//
// Two things about the environment are decided here rather than by each test.
//
// The global settings layer is switched off (#223). `loadConfig` reads
// `~/.config/vibe/config.json` (or `%APPDATA%\vibe`) under a project's
// `vibe.config.json`, and a suite that read the developer's own settings would
// pass or fail according to whose machine it ran on. An empty
// `VIBE_GLOBAL_CONFIG` turns the layer off.
//
// Every temporary directory lands under one root this script owns (#234). The
// suite makes about 1,600 of them a run, 411 holding a real git repository, and
// for a long time removed none: about 30,000 inodes and 170 MB a run, which on a
// tmpfs of a million inodes filled `/tmp` in about thirty runs and then failed
// 673 tests with ENOSPC — a full disk that looked like a broken suite. Fixing
// that at 225 `mkdtempSync` sites would hold only until the next helper forgot,
// so the fix is where the directory comes from instead: `TMPDIR`, `TMP` and
// `TEMP` point into the root, so `os.tmpdir()` answers the root in every test
// file and in every child they spawn, and the root goes when the run ends.
//
// Three things travel with it:
//
// - **An empty git template.** `git init` copies the sample hooks, `info/` and
//   `description` into every repository — 27 inodes where 9 are needed, so
//   two-thirds of what a fixture repository costs is files no test reads.
//   `GIT_TEMPLATE_DIR` names an empty directory, which is git's own way to say
//   "copy nothing".
// - **A run killed part-way is swept by the next one.** Ctrl-C reaches this
//   process too and is waited out, but a SIGKILL or a closed terminal runs no
//   code here at all, so each root holds the pid that made it and a root whose
//   pid is gone is removed at the start of the next run.
// - **Anything that reaches the real temp directory fails the run, by name.** A
//   fixture that hard-codes `/tmp`, or a child spawned with a hand-built
//   environment, would otherwise bring the leak back silently. `vibe-pilot-` is
//   excluded: it is the product's own scratch, and the app may be making one
//   while this runs.
//
// `VIBE_KEEP_TEST_TMP=1` keeps the root and prints where it is, for reading
// what a failing case left behind. A script rather than `VAR= node ...` in
// package.json, because that syntax is a POSIX shell's and this repo is
// developed on Windows too.
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ROOT_PREFIX = 'vibe-test-run-';
const PID_FILE = 'pid';
const IGNORED = ['vibe-pilot-'];

const realTmp = tmpdir();

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM is a live process owned by somebody else, which is not ours to sweep.
    return err.code === 'EPERM';
  }
}

// A fixture may leave a directory at mode 0 — `gate-artifacts.test.ts` makes
// one on purpose — and a recursive remove cannot descend into it. Open up
// whatever refused, then try again.
function removeTree(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch {
    // fall through
  }
  const open = (at) => {
    try {
      chmodSync(at, 0o700);
    } catch {
      return;
    }
    let entries = [];
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) if (entry.isDirectory()) open(path.join(at, entry.name));
  };
  open(dir);
  rmSync(dir, { recursive: true, force: true });
}

function vibeEntries() {
  try {
    return new Set(readdirSync(realTmp).filter((name) => name.startsWith('vibe-')));
  } catch {
    return new Set();
  }
}

function sweepAbandoned() {
  for (const name of vibeEntries()) {
    if (!name.startsWith(ROOT_PREFIX)) continue;
    const dir = path.join(realTmp, name);
    let pid = NaN;
    try {
      pid = Number(readFileSync(path.join(dir, PID_FILE), 'utf8'));
    } catch {
      // A root with no readable pid is one whose run died before writing it, or
      // one being made right now. Only the first is ours to take, and they
      // cannot be told apart, so leave it.
      continue;
    }
    if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) continue;
    try {
      removeTree(dir);
      process.stderr.write(`test: removed ${name}, left by a run that did not finish\n`);
    } catch (err) {
      process.stderr.write(`test: could not remove ${name}: ${err.message}\n`);
    }
  }
}

sweepAbandoned();

const root = mkdtempSync(path.join(realTmp, ROOT_PREFIX));
writeFileSync(path.join(root, PID_FILE), String(process.pid), 'utf8');
const sandbox = path.join(root, 'tmp');
const template = path.join(root, 'git-template');
mkdirSync(sandbox);
mkdirSync(template);

const before = vibeEntries();

const child = spawn(
  process.execPath,
  ['--test', 'dist/tests/**/*.test.js', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      VIBE_GLOBAL_CONFIG: '',
      TMPDIR: sandbox,
      TMP: sandbox,
      TEMP: sandbox,
      GIT_TEMPLATE_DIR: template,
    },
  },
);

// Ctrl-C reaches the runner and this process together; staying alive until the
// runner has gone is what lets the root be removed afterwards. A signal sent to
// this process alone is passed on.
process.on('SIGINT', () => {});
process.on('SIGTERM', () => child.kill('SIGTERM'));

const status = await new Promise((resolve) => {
  child.on('exit', (code) => resolve(code ?? 1));
  child.on('error', (err) => {
    process.stderr.write(`test: could not start the runner: ${err.message}\n`);
    resolve(1);
  });
});

const escaped = [...vibeEntries()]
  .filter((name) => !before.has(name))
  .filter((name) => !name.startsWith(ROOT_PREFIX))
  .filter((name) => !IGNORED.some((prefix) => name.startsWith(prefix)))
  .sort();

if (process.env['VIBE_KEEP_TEST_TMP']) {
  process.stderr.write(`test: kept ${root}\n`);
} else {
  try {
    removeTree(root);
  } catch (err) {
    process.stderr.write(`test: could not remove ${root}: ${err.message}\n`);
  }
}

if (escaped.length > 0) {
  process.stderr.write(
    `test: ${escaped.length} entr${escaped.length === 1 ? 'y' : 'ies'} appeared in ${realTmp} ` +
      `outside the run's own directory, so something is not using os.tmpdir() ` +
      `or is spawning a child without the suite's environment:\n` +
      escaped.map((name) => `  ${name}\n`).join(''),
  );
  process.exit(status === 0 ? 1 : status);
}
process.exit(status);
