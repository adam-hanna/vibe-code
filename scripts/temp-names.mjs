// Which `vibe-*` names in the machine's temp directory this repo's code can
// have made, so `scripts/test.mjs` fails a run only on those (#510).
//
// The check that leans on this exists for #234: a test that writes to a
// hard-coded `/tmp`, or spawns a child with a hand-built environment whose
// `os.tmpdir()` answers the real `/tmp`, would bring the inode leak back
// silently. Until #510 the check was "a new `vibe-*` name appeared", not "the
// suite made it", so anything else on the machine that wrote a `vibe-*` file
// failed a green run. On 2026-11-03 that was every run of #507 and #508: vibe
// runs in sibling worktrees wrote scratch files there every thirty seconds or
// so, and parallel worktrees are how this repo is worked on. A real leak always
// has a name the code can produce, because the code is what names it, so the
// names are read from the code.
//
// **Read from the code at the start of every run, not kept as a list.** A list
// kept by hand is how the leak came back the first time: it is right until the
// next helper forgets it. The scan costs a few milliseconds and cannot fall
// behind.
//
// **Every `vibe-` string in the code, not only the ones passed to `mkdtemp`.**
// Most fixtures call `mkdtempSync(path.join(tmpdir(), 'vibe-…'))`, but a good
// many go through a helper that takes the prefix as an argument -
// `loop-harness.ts`'s `options.prefix`, `mcp-scope.test.ts`'s `tmp(prefix)`,
// `run-origin.test.ts`'s `targetDir(prefix)` - and the literal is at a call
// site in another file. Following those is a parser's job, not a regex's, so
// the scan takes the superset: any string or template that starts `vibe-`, or
// a path segment after `/` or `\` (a `/tmp/vibe-…` literal). That counts some
// names that never reach a temp directory, which can only make the check
// stricter. Template strings give their head: `vibe-print-${name}.mjs` is
// `vibe-print-`.
//
// **A bare `vibe-` is the shape `mkdtemp` would give it.** A string that is
// `vibe-` and nothing else names no file of its own, but handed to `mkdtemp` it
// makes `vibe-` and six letters or digits, so names of exactly that shape count.
// Foreign scratch (`vibe-edit-stored.py`) does not have it. `vibe-*`, with a
// `*`, is a glob in prose and names nothing.
//
// **A name built from a bare `vibe-` and a value is not resolvable, and it
// makes the check stricter.** `'vibe-' + id` or `vibe-${id}` can produce any
// name, so while one is in the code every new `vibe-*` entry counts, as before
// #510, and the run says which line did it.
//
// The checker itself is not scanned: `scripts/test.mjs` filters the directory
// on a bare `'vibe-'`, which is a namespace, not a name, and its one temp name
// (`vibe-test-run-`) is excluded on its own. Recorded data under
// `tests/fixtures/` is not code and is not scanned either.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/** Where code that a test run can execute lives, relative to the project. */
export const SCANNED = ['src', 'tests', 'scripts', 'dist'];

/** Not code: recorded CLI output and stored states, written by other programs. */
const SKIPPED_DIRS = new Set(['node_modules', 'fixtures']);

/** The checker, which names the namespace rather than anything in it. */
const SELF = new Set(['scripts/test.mjs', 'scripts/temp-names.mjs']);

const CODE = /\.(?:[cm]?[jt]s)$/;

// A `vibe-` that starts a string, a template, or a path segment.
const TOKEN = /(?<=['"`/\\])vibe-[A-Za-z0-9._-]*/g;

/**
 * Names the desktop app makes in the real temp directory while it is open,
 * which the suite did not make even though the code can (#234, #510).
 *
 * `vibe-pilot-` is `pilotCodex`'s scratch directory (`src/pilotcodex.ts`): a
 * pilot turn on the Codex road writes its instructions file there. The app
 * runs the core as a sidecar with its own environment, so a developer with
 * the app open beside `npm test` gets real `vibe-pilot-*` entries that no test
 * made. Under #510's rule it would count, because the code produces it - so it
 * is the one known name that is set aside, and it is still reported.
 *
 * Matched by the exact shape `mkdtemp` gives it, the prefix and six letters or
 * digits, rather than as a prefix: `pilot-prompt-names.test.ts` makes
 * `vibe-pilot-prompt-*` fixtures, and a bare prefix would hide that test's
 * leak behind the app's.
 */
export const IGNORED = [
  {
    pattern: /^vibe-pilot-[A-Za-z0-9]{6}$/,
    why: "the desktop app's pilot makes these while it is open",
  },
];

function walk(dir, rel, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const at = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) walk(full, at, out);
    } else if (entry.isFile() && CODE.test(entry.name) && !SELF.has(at)) {
      out.push({ full, rel: at });
    }
  }
}

/**
 * Read every temp name the code under `cwd` can produce.
 *
 * `prefixes` are the names, each standing for itself and anything after it.
 * `bare` says a bare `vibe-` is in the code, so `mkdtemp`'s shape of it counts.
 * `unresolved` lists the places a name is built from a bare `vibe-` and a
 * value, by file and line. `files` is how many files were read: none means
 * there was nothing to scan, which is not the same as nothing to find.
 */
export function scanTempNames(cwd) {
  const files = [];
  for (const root of SCANNED) walk(path.join(cwd, root), root, files);
  const prefixes = new Set();
  const unresolved = [];
  let bare = false;
  let read = 0;
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file.full, 'utf8');
    } catch {
      continue;
    }
    read += 1;
    for (const match of text.matchAll(TOKEN)) {
      const name = match[0];
      if (name !== 'vibe-') {
        prefixes.add(name);
        continue;
      }
      const after = text.slice(match.index + name.length, match.index + name.length + 40);
      if (after.startsWith('*')) continue;
      if (after.startsWith('${') || /^['"`]\s*\+/.test(after)) {
        const line = text.slice(0, match.index).split('\n').length;
        unresolved.push(`${file.rel}:${line}`);
      } else {
        bare = true;
      }
    }
  }
  return { prefixes: [...prefixes].sort(), bare, unresolved, files: read };
}

const MKDTEMP_OF_BARE = /^vibe-[A-Za-z0-9]{6}$/;

function ours(name, scan) {
  if (scan.bare && MKDTEMP_OF_BARE.test(name)) return true;
  return scan.prefixes.some((prefix) => name.startsWith(prefix));
}

/**
 * Sort the entries that appeared during a run into the ones the suite can have
 * made (`leaked`), the ones a known exception made (`ignored`, with the reason)
 * and the ones nothing here names (`foreign`).
 *
 * Fails closed: when the scan read no file, or found a name it could not
 * resolve, there is no telling a foreign name from one of ours, so every
 * entry that is not ignored counts.
 */
export function classify(names, scan) {
  const strict = scan.files === 0 || scan.unresolved.length > 0;
  const leaked = [];
  const ignored = [];
  const foreign = [];
  for (const name of names) {
    const exception = IGNORED.find((rule) => rule.pattern.test(name));
    if (exception) ignored.push({ name, why: exception.why });
    else if (strict || ours(name, scan)) leaked.push(name);
    else foreign.push(name);
  }
  return { leaked, ignored, foreign, strict };
}
