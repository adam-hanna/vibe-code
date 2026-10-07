import { within } from '../cockpit/projects';
import type { Effect } from './tools';

/**
 * Which of the pilot's proposals run without a card (#223).
 *
 * Pure, for `model.ts`'s reason: the app has no jsdom, so a decision living in
 * an effect is a decision nothing tests — and this one decides whether a person
 * sees a command before it runs.
 *
 * **The window decides whether to draw a card; it does not widen what runs.** An
 * auto-run command goes down exactly the road a pressed one does — a `command`
 * frame to the host, `commands.ts`, no shell — so the safe list changes who
 * presses, never what is possible. The settings themselves come from the host
 * (`ConfigFrame.pilot`), resolved from the settings for all projects.
 *
 * Two things never run without a press, YOLO or not: starting a run and
 * answering a gate. Those are not commands, and a run is the most expensive
 * thing in the product.
 */

/**
 * What the pilot may do without asking, as the host resolved it from the
 * settings for all projects. `src/pilotaccess.ts` is the core's definition and
 * this is its shape on the wire, with every directory already absolute.
 */
export interface PilotAccess {
  yolo: boolean;
  safeCommands: readonly string[];
  dirs: readonly string[];
  /** How long one pilot turn may take, in ms (`pilot.timeoutMs`). */
  timeoutMs: number;
  /** How each vendor is reached: its CLI on the subscription, or the API (#223). */
  anthropic: 'subscription' | 'api';
  openai: 'subscription' | 'api';
}

/**
 * The narrowest answer, for before the settings are read: nothing runs unasked,
 * and both vendors are on the subscription, which is the default.
 */
export const NO_ACCESS: PilotAccess = {
  yolo: false,
  safeCommands: [],
  dirs: [],
  // The core's default; the host enforces whatever is set, and this is only
  // ever drawn before the settings have been read.
  timeoutMs: 30 * 60_000,
  anthropic: 'subscription',
  openai: 'subscription',
};

/** An absolute path, on either platform's spelling. */
function absolute(arg: string): boolean {
  return arg.startsWith('/') || arg.startsWith('~') || /^[A-Za-z]:[\\/]/.test(arg) || arg.startsWith('\\\\');
}

/** Whether a directory is one the pilot may work in: the project, or one of `dirs`. */
export function allowedDir(target: string, dir: string, access: PilotAccess): boolean {
  if (access.yolo) return true;
  return [dir, ...access.dirs].some((root) => root.trim() !== '' && within(root, target));
}

/**
 * The program's own name, or null when it was named by path.
 *
 * A path is never matched: a script in the repository called `git` would
 * otherwise inherit `git`'s place on the list.
 */
function programName(program: string): string | null {
  const p = program.trim();
  if (p.includes('/') || p.includes('\\')) return null;
  return p.toLowerCase().replace(/\.exe$/, '');
}

/**
 * The safe-list pattern a command matches, or null.
 *
 * A pattern is a program and its leading arguments, matched as a prefix, so
 * `git commit` covers `git commit -m "fix"`. Global options before the
 * subcommand do not match — `git -C /elsewhere status` is not `git status` —
 * which is the right direction to fail in.
 *
 * Two more refusals, both about where it reaches rather than what it is: any
 * argument naming a path outside the allowed directories, and any `..`
 * segment, falls back to a card. `git diff --no-index /etc/passwd` is `git
 * diff` by name and a read of somebody else's file by effect.
 */
export function safeMatch(
  program: string,
  args: readonly string[],
  where: string,
  dir: string,
  access: PilotAccess,
): string | null {
  const name = programName(program);
  if (name === null) return null;
  if (!allowedDir(where, dir, access)) return null;
  for (const arg of args) {
    // `--output=/x` names a path too, so the part after `=` is read as well.
    for (const part of [arg, arg.slice(arg.indexOf('=') + 1)]) {
      if (/(^|[\\/])\.\.([\\/]|$)/.test(part)) return null;
      // Nothing under `.git` (#223): `cp evil.sh .git/hooks/pre-commit` and
      // then a safe-listed `git commit` would run code nobody approved.
      if (/(^|[\\/])\.git([\\/]|$)/i.test(part)) return null;
      if (absolute(part) && !allowedDir(part, dir, access)) return null;
    }
  }
  for (const pattern of access.safeCommands) {
    const [head, ...rest] = pattern.trim().split(/\s+/);
    if (head === undefined || head.toLowerCase() !== name) continue;
    if (rest.length > args.length) continue;
    if (rest.every((word, i) => args[i] === word)) return pattern;
  }
  return null;
}

/**
 * Why this proposal runs without a card, or null when it needs a person.
 *
 * The reason is the sentence the model is told in place of *"the user accepted
 * this"*, because that would be false: nobody pressed anything.
 */
export function autoRun(effect: Effect, dir: string, access: PilotAccess): string | null {
  if (effect.kind === 'invoke' || effect.kind === 'answer') return null;
  if (access.yolo) return 'YOLO mode is on, so this ran without asking.';
  if (effect.kind !== 'command') return null;
  const pattern = safeMatch(effect.program, effect.args, effect.dir, dir, access);
  return pattern === null ? null : `"${pattern}" is on the user's safe list, so this ran without asking.`;
}
