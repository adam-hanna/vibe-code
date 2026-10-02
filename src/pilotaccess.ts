import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { expandHome } from '@src/proc.js';

/**
 * What the pilot may do without asking, and where it may look (#223).
 *
 * ## What changed
 *
 * Every command the pilot proposed was a card somebody had to press, including
 * `git status`. Asked for as *"It's completely safe for it to run 'ls', 'cat',
 * 'echo', 'git add|commit', etc"*, with a YOLO switch beside it, and with the
 * directories the pilot may read made a setting rather than fixed at the
 * repository.
 *
 * Three settings, and this module is the core's half of all three:
 *
 * - **`safeCommands`** - command lines that run as soon as the pilot asks. A
 *   pattern is a program and its leading arguments, matched as a prefix:
 *   `git commit` covers `git commit -m "x"`. They run through `commands.ts`
 *   like any other command, so **there is still no shell**, which is what makes
 *   the list mean the same thing on Windows, Linux and macOS.
 * - **`dirs`** - directories beyond the repository the pilot may read and run a
 *   command in. The subscription pilot gets each as an `--add-dir`, and the
 *   `fs` read frame answers inside them and nowhere else.
 * - **`yolo`** - every command runs without a card, and every disk is readable.
 *   Starting a run and answering a gate still take a press: those are not
 *   commands, and a run is the most expensive thing in the product.
 *
 * ## Why `ls` and `cat` are not on the default list
 *
 * They are not programs on Windows - they are shell built-ins, and there is no
 * shell here - so a default naming them would be a default that works on two
 * platforms out of three. Reading is what they are for, and reading has its own
 * tools on both backends (`list_dir`, `read_file`, and on the subscription
 * `Read`/`Glob`/`Grep`), which work the same everywhere. A person on Linux can
 * still add `ls` to their own list, and it runs wherever it resolves.
 *
 * ## Why this lives only in the settings for all projects
 *
 * **A project's `vibe.config.json` cannot set any of it, and is refused by name
 * if it tries.** That file is committed, so a repository you clone would
 * otherwise be able to put `rm` on its own pilot's safe list or switch YOLO on
 * for itself. A setting that widens what a model may do unasked is a decision
 * about the machine, and the machine's file is the only place it can be made.
 *
 * It is also deliberately **not part of `Config`**: a run's `state.json` stores
 * its config, and `ledger.test.ts` pins that `src/types.ts` says nothing about
 * the pilot. A conversation's permissions are not a fact about any run.
 */

/**
 * How the pilot reaches one vendor (#223): on the CLI you are logged into, or
 * over the API with a key from the keychain. Chosen per vendor in Settings; the
 * conversation then only picks the vendor.
 */
export type Route = 'subscription' | 'api';

export interface PilotAccess {
  yolo: boolean;
  safeCommands: readonly string[];
  dirs: readonly string[];
  /** Anthropic: `claude -p` on the subscription, or the API. */
  anthropic: Route;
  /** OpenAI: `codex exec` on the subscription, or the API. */
  openai: Route;
}

/**
 * The default safe list: git that reads, plus staging and committing.
 *
 * `add` and `commit` because they were asked for by name, and with the cost
 * said rather than hidden: **`git commit` runs the repository's own hooks**,
 * which can be any code at all. That is acceptable in a repository you trust and
 * is the reason a cloned one cannot extend this list (see above).
 *
 * `git branch` appears only in its two listing forms, because a prefix of plain
 * `git branch` would also cover `git branch -D`.
 */
export const DEFAULT_SAFE_COMMANDS: readonly string[] = [
  'git status',
  'git diff',
  'git log',
  'git show',
  'git add',
  'git commit',
  'git branch --list',
  'git branch --show-current',
  'git rev-parse',
  'git ls-files',
];

/**
 * Subscription for both: it is the one that works with nothing entered, and a
 * default that needed a key would be a pilot that does nothing until you buy one.
 */
export const PILOT_ACCESS_DEFAULTS: PilotAccess = {
  yolo: false,
  safeCommands: DEFAULT_SAFE_COMMANDS,
  dirs: [],
  anthropic: 'subscription',
  openai: 'subscription',
};

/** The characters `run_command` already refuses, and for the same reason. */
const SHELLISH = /[;&|><`$\n]/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The global file's `pilot` section, over the defaults, or a refusal naming the
 * field. Refuses, never repairs: a safe list that half-loaded is a list nobody
 * chose.
 */
export function readPilotAccess(globalRaw: Readonly<Record<string, unknown>>): PilotAccess {
  const section = globalRaw['pilot'];
  if (section === undefined) return PILOT_ACCESS_DEFAULTS;
  if (!isRecord(section)) throw new Error('pilot must be an object');
  const known = new Set(['yolo', 'safeCommands', 'dirs', 'anthropic', 'openai']);
  for (const key of Object.keys(section)) {
    // By name, for `mergeSection`'s silent-drop reason: a misspelt key is a
    // setting somebody believes is on.
    if (!known.has(key)) {
      throw new Error(`pilot.${key} is not a setting; they are ${[...known].join(', ')}`);
    }
  }
  const route = (vendor: 'anthropic' | 'openai'): Route => {
    const value = section[vendor] ?? PILOT_ACCESS_DEFAULTS[vendor];
    if (value !== 'subscription' && value !== 'api') {
      throw new Error(`pilot.${vendor} must be "subscription" or "api"`);
    }
    return value;
  };
  const yolo = section['yolo'] ?? PILOT_ACCESS_DEFAULTS.yolo;
  if (typeof yolo !== 'boolean') throw new Error('pilot.yolo must be true or false');

  const safe = section['safeCommands'] ?? PILOT_ACCESS_DEFAULTS.safeCommands;
  if (!Array.isArray(safe)) throw new Error('pilot.safeCommands must be a list of command lines');
  const safeCommands: string[] = [];
  for (const [i, entry] of safe.entries()) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`pilot.safeCommands[${String(i)}] must be a command line, such as "git status"`);
    }
    if (SHELLISH.test(entry)) {
      throw new Error(
        `pilot.safeCommands[${String(i)}] ("${entry}") holds shell syntax, and there is no shell: ` +
          'a pattern is one program and its leading arguments',
      );
    }
    safeCommands.push(words(entry).join(' '));
  }

  const rawDirs = section['dirs'] ?? PILOT_ACCESS_DEFAULTS.dirs;
  if (!Array.isArray(rawDirs)) throw new Error('pilot.dirs must be a list of directories');
  const dirs: string[] = [];
  for (const [i, entry] of rawDirs.entries()) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`pilot.dirs[${String(i)}] must be a directory`);
    }
    // Absolute, because a relative one would mean a different directory under
    // every project - which is the opposite of a setting for all of them.
    if (!path.isAbsolute(expandHome(entry.trim()))) {
      throw new Error(`pilot.dirs[${String(i)}] ("${entry}") must be an absolute path, or start with ~`);
    }
    dirs.push(entry.trim());
  }
  return { yolo, safeCommands, dirs, anthropic: route('anthropic'), openai: route('openai') };
}

/**
 * The same settings with every directory absolute, which is the form a window
 * needs: it has no home directory to expand `~` against, so a path it cannot
 * resolve is one it would always draw a card for.
 */
export function resolvedAccess(access: PilotAccess): PilotAccess {
  return { ...access, dirs: access.dirs.map((d) => path.resolve(expandHome(d))) };
}

/**
 * Refuse a project file that names `pilot` at all (see the module comment).
 * Thrown by `loadConfig` and by a project-scoped write, so the refusal is the
 * same sentence whichever road reached it.
 */
export function refuseProjectPilot(raw: Readonly<Record<string, unknown>>, label: string): void {
  if (raw['pilot'] === undefined) return;
  throw new Error(
    `${label} sets pilot, and only your settings for all projects can: this file is committed, ` +
      'so a repository you clone could otherwise widen what its own pilot may do without asking',
  );
}

function words(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean);
}

/**
 * The directories the pilot may read, in this order: the repository, then
 * `dirs`, then - in YOLO - the root of every disk.
 */
export function pilotRoots(
  dir: string,
  access: PilotAccess,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const out = [path.resolve(expandHome(dir)), ...access.dirs.map((d) => path.resolve(expandHome(d)))];
  if (access.yolo) out.push(...filesystemRoots(platform));
  return [...new Set(out)];
}

/**
 * The root of every disk. One on POSIX; on Windows, each drive letter that
 * exists, because there is no single root above `C:\` and `D:\`.
 */
export function filesystemRoots(platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return ['/'];
  const roots: string[] = [];
  for (let c = 'A'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c += 1) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (existsSync(root)) roots.push(root);
  }
  return roots;
}

/**
 * Whether `target` is one of `roots` or inside one.
 *
 * Both sides through `realpath` first, so a link inside the repository pointing
 * out of it is judged by where it lands - the same reason #53 refuses to read
 * through a link at all. A path that does not resolve is outside, which is the
 * fail-closed direction.
 */
export function insideRoots(target: string, roots: readonly string[]): boolean {
  let real: string;
  try {
    real = realpathSync(target);
  } catch {
    return false;
  }
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  return roots.some((root) => {
    let r: string;
    try {
      r = realpathSync(root);
    } catch {
      return false;
    }
    const rel = path.relative(fold(r), fold(real));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/**
 * How much of one file a read returns, and how many entries a listing does.
 *
 * **Display choices, allowed to be ones**, exactly as `OUTPUT_KEEP_BYTES` is in
 * `commands.ts`: they bound what goes into a model's context, nothing decides
 * anything from them, and the answer says when it was cut rather than presenting
 * a part as the whole.
 */
export const READ_KEEP_BYTES = 256 * 1024;
export const LIST_KEEP = 2000;

export interface DirEntry {
  name: string;
  kind: 'file' | 'dir' | 'link' | 'other';
  /** Null for anything that is not a regular file. */
  bytes: number | null;
}

export type FsAnswer =
  | { op: 'list'; path: string; entries: DirEntry[]; truncated: boolean }
  | { op: 'read'; path: string; text: string; bytes: number; truncated: boolean };

/**
 * Resolve a path the pilot named, against the repository, or say why not.
 * Relative paths are the repository's; `~` is the home directory.
 */
function resolveFor(dir: string, asked: string, roots: readonly string[]): string | { refused: string } {
  const named = expandHome(asked.trim() === '' ? '.' : asked.trim());
  const full = path.resolve(expandHome(dir), named);
  if (!existsSync(full)) return { refused: `there is nothing at ${full}.` };
  if (!insideRoots(full, roots)) {
    return {
      refused:
        `${full} is outside the directories the pilot may read: ${roots.join(', ')}. ` +
        'More can be added in Settings, under what the pilot may do.',
    };
  }
  return full;
}

/** List one directory, or read one text file. Never throws: a refusal is an answer. */
export function pilotFs(
  op: 'list' | 'read',
  dir: string,
  asked: string,
  roots: readonly string[],
): FsAnswer | { refused: string } {
  const full = resolveFor(dir, asked, roots);
  if (typeof full !== 'string') return full;
  try {
    if (op === 'list') {
      if (!statSync(full).isDirectory()) return { refused: `${full} is a file; read it with read_file.` };
      const names = readdirSync(full).sort();
      const entries: DirEntry[] = names.slice(0, LIST_KEEP).map((name) => {
        try {
          const st = lstatSync(path.join(full, name));
          return {
            name,
            kind: st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other',
            bytes: st.isFile() ? st.size : null,
          };
        } catch {
          return { name, kind: 'other', bytes: null };
        }
      });
      return { op, path: full, entries, truncated: names.length > LIST_KEEP };
    }
    const st = statSync(full);
    if (st.isDirectory()) return { refused: `${full} is a directory; list it with list_dir.` };
    const buf = readFileSync(full);
    // A NUL in the first stretch is what a binary file looks like, and handing
    // one to a model as text is a page of noise it then tries to explain.
    if (buf.subarray(0, 8192).includes(0)) {
      return { refused: `${full} looks like a binary file (${String(buf.length)} bytes), so it is not read as text.` };
    }
    const kept = buf.length > READ_KEEP_BYTES ? buf.subarray(0, READ_KEEP_BYTES) : buf;
    return { op, path: full, text: kept.toString('utf8'), bytes: buf.length, truncated: buf.length > READ_KEEP_BYTES };
  } catch (err: unknown) {
    return { refused: err instanceof Error ? err.message : String(err) };
  }
}
