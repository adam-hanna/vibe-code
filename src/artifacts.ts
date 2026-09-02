import {
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { refuseArtifactPath } from '@src/config.js';
import * as log from '@src/log.js';
import { entryKind, linkageOf } from '@src/run.js';
import type { ArtifactEntryOutcome, GateArtifacts, RunState } from '@src/types.js';

/**
 * Copying what a failing gate produced into the run record (#62).
 *
 * This is the only code in the repository that copies files it did not write,
 * which is why it is its own module - the same reason `src/evidence.ts` and
 * `src/questions.ts` are.
 *
 * **Why a copy and not a recorded path.** `loop.maxVerifyRounds` is 3, a commit
 * runs between rounds, and a test reporter rewrites its output directory every
 * time it runs. A path recorded in round 1 therefore points at round 3's content
 * by the time anyone opens it: not a missing answer, a *wrong* one that looks
 * authoritative.
 *
 * **Why every link is refused rather than resolved.** Measured on this machine
 * (node v24.18.0, win32) against a fixture holding a POSIX symlink, a directory
 * symlink, a Node `'junction'` and an `mklink /J` junction at once: `cpSync`
 * preserves symlinks *as symlinks* - pointers out of the archive that outlive
 * the copy - and silently FOLLOWS both junction shapes, writing the target's
 * bytes into the run directory. A file outside the tree landed inside it.
 * `dereference: true` and `verbatimSymlinks: true` behave identically; only
 * `filter` refuses anything. Resolve-and-recheck is therefore not available
 * through cpSync's options at all, and hand-walking to implement it would put a
 * second containment rule in the component with the most edge cases. So: refuse,
 * which is also what #53 chose for run entries. One rule, not two.
 *
 * **Why the destination may be inside the user's repository.** `probe-62-git.mjs`,
 * against a real repo doing what a run does: `ensureVibeIgnored` writes
 * `.vibe/.gitignore` containing `*`, `git status --short` never lists the copied
 * tree, `git check-ignore` names that line, and `git ls-files -- .vibe` is empty
 * after a `commitAll`. A gate artifact can never reach `vibe: fix verification
 * failure`.
 *
 * **What is NOT defended against.** A component classified as a plain directory
 * and then swapped for a link before `cpSync` reaches it. Closing that needs
 * handle-relative APIs (`openat`) which Node does not expose without a native
 * dependency, and this repo has none. Every reachable check is applied instead:
 * every component of the source path, every component of the destination, and
 * every entry inside the tree.
 */

export type { ArtifactEntryOutcome, GateArtifacts } from '@src/types.js';

/** Where a round's evidence lives, relative to the run directory. POSIX separators. */
function roundDir(gate: string, round: number): string {
  // The gate name is validated kebab-case and unique by #47, which is what makes
  // it safe as a path component with no escaping here.
  return `artifacts/${gate}/round-${round}`;
}

/**
 * #53's predicate, reused rather than re-implemented.
 *
 * `linkageOf` is `lstat(...).isSymbolicLink()`, which that issue measured to be
 * true for a POSIX symlink, a Node `'junction'` and an `mklink /J` junction
 * alike, while `statSync` sees through all three. `unknown` - an lstat that
 * threw - fails closed: an entry that cannot be classified cannot be ruled out
 * as a link.
 */
function componentOf(p: string): 'ok' | 'missing' | 'refused' {
  const linkage = linkageOf(p);
  if (linkage === 'missing') return 'missing';
  return linkage === 'plain' ? 'ok' : 'refused';
}

/**
 * Whether a path the walk reached is still inside the tree it started from, or
 * why it is not.
 *
 * The belt behind the lexical rule and the component walk, and it asks the
 * filesystem rather than the string: `realpath` applies the host's own
 * canonicalization, which is the step a lexical check cannot reproduce - Windows
 * strips trailing dots and spaces from every component, so a path that reads as
 * inside can resolve outside. Anything that cannot be resolved is refused: an
 * entry whose location cannot be established cannot be shown to be contained.
 *
 * Case-insensitive on win32, where two spellings of one directory are one
 * directory, and case-sensitive elsewhere, where they are two.
 */
function outsideOf(base: string, candidate: string): string | null {
  let realBase: string;
  let realCandidate: string;
  try {
    realBase = realpathSync.native(base);
    realCandidate = realpathSync.native(candidate);
  } catch (err: unknown) {
    return `could not be resolved (${reason(err)})`;
  }
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p);
  const root = fold(realBase);
  const at = fold(realCandidate);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (at === root || at.startsWith(prefix)) return null;
  return `resolves to ${realCandidate}, which is outside ${realBase}`;
}

/**
 * Where a descent got to.
 *
 * Three outcomes and not two, because "a component is a link" and "a component
 * is not there" are different facts that become different statuses - and a
 * caller that told them apart by reading the reason string would be parsing
 * prose it also wrote.
 */
type Descent =
  | { kind: 'reached'; path: string }
  | { kind: 'absent'; path: string; reason: string }
  | { kind: 'refused'; reason: string };

/**
 * Walk from `base` through each segment of `rel`, lstat-ing EVERY component.
 *
 * A lexical containment check cannot see a linked parent. If `reports` is a
 * junction to somewhere outside the repository, then `reports/output.json` is an
 * ordinary file to `lstat` and an ordinary file to `cpSync` - which copies the
 * outside content in. The only way to see it is to classify each component on
 * the way down, which is what `runEntryLinkage` already does for run entries.
 */
function safeDescend(base: string, rel: string): Descent {
  const segments = rel.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  let at = base;
  for (const [i, segment] of segments.entries()) {
    at = path.join(at, segment);
    const which = segments.slice(0, i + 1).join('/');
    const verdict = componentOf(at);
    if (verdict === 'refused') {
      return {
        kind: 'refused',
        reason: `"${which}" is a link, or could not be classified; nothing is copied through it`,
      };
    }
    if (verdict === 'missing') {
      // Absent at any depth is absent - the command did not produce this. The
      // path is still returned so a caller can say where it stopped.
      return { kind: 'absent', path: at, reason: `"${which}" was not produced` };
    }
  }
  return { kind: 'reached', path: at };
}

/** `mkdir` one level, refusing to build through anything that is not a plain directory. */
function ensureDirectory(p: string): void {
  const kind = entryKind(p);
  if (kind === 'missing') {
    // Non-recursive on purpose: `mkdirSync(p, {recursive: true})` would create
    // every ancestor without classifying any of them, which is precisely the
    // hole a junction planted at `artifacts` would use.
    mkdirSync(p);
    return;
  }
  if (kind !== 'directory') {
    throw new Error(`${p} is a ${kind === 'link' ? 'link' : kind}, not a directory`);
  }
}

/** `<run>/artifacts/<gate>`, with every component classified on the way down. */
function prepareGateDir(state: RunState, gate: string): string {
  let at = state.dir;
  for (const segment of ['artifacts', gate]) {
    at = path.join(at, segment);
    ensureDirectory(at);
  }
  return at;
}

interface Measurement {
  files: number;
  bytes: number;
  /** Entry-relative POSIX paths of everything the copy filter will refuse. */
  links: string[];
}

/**
 * What this entry would actually contribute, excluding what the filter refuses.
 *
 * The root is classified FIRST: a configured path may be a single file, and a
 * `readdir` walk over one throws ENOTDIR. Anything that is neither a regular
 * file nor a directory - fifo, socket, device - fails closed rather than being
 * measured as zero and copied as who-knows-what.
 */
function measure(root: string): Measurement {
  const st = lstatSync(root);
  if (st.isFile()) return { files: 1, bytes: st.size, links: [] };
  if (!st.isDirectory()) {
    throw new Error('is neither a regular file nor a directory');
  }

  const found: Measurement = { files: 0, bytes: 0, links: [] };
  const walk = (dir: string, prefix: string): void => {
    for (const child of readdirSync(dir, { withFileTypes: true })) {
      const at = path.join(dir, child.name);
      const rel = prefix === '' ? child.name : `${prefix}/${child.name}`;
      if (componentOf(at) !== 'ok') {
        found.links.push(rel);
        continue;
      }
      const childStat = lstatSync(at);
      if (childStat.isDirectory()) {
        walk(at, rel);
        continue;
      }
      if (childStat.isFile()) {
        found.files += 1;
        found.bytes += childStat.size;
      }
      // Anything else in the tree is left out of the count rather than guessed
      // at; the copy's filter passes it through only if cpSync can handle it.
    }
  };
  walk(root, '');
  return found;
}

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Best-effort delete of something this module created. Never throws; says
 * whether the thing is gone, so a caller that has to report leftovers can.
 */
function discard(p: string): boolean {
  try {
    rmSync(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

const SUPERSEDED = '.superseded-';
const STAGING = '.staging-';

/**
 * What a scratch entry is, finer than `entryKind` and only where it matters.
 *
 * `entryKind` answers "is this a directory", so a regular file and a fifo are
 * both `not-a-directory` - which is the right answer for a run entry and the
 * wrong one here. This module creates scratch of BOTH shapes: the staging tree
 * is a directory, and `.partial-<i>` is whatever `cpSync` made of the source, so
 * a configured entry that is a single file produces a scratch FILE. Deleting on
 * `not-a-directory` would also delete a socket or a device node this module
 * never wrote; refusing to delete anything but a directory leaves those partial
 * files on disk for ever, which is half of #111.
 *
 * So: the two shapes this module actually creates are removable, everything else
 * is named and left. Links are `other` and are never removed - #53's rule, and
 * `linkageOf` is its predicate.
 */
function scratchKind(p: string): 'directory' | 'file' | 'missing' | 'other' {
  try {
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (st === undefined) return 'missing';
    if (st.isSymbolicLink()) return 'other';
    if (st.isDirectory()) return 'directory';
    return st.isFile() ? 'file' : 'other';
  } catch {
    return 'other';
  }
}

/** Removable only if this module could have created it. Never follows a link. */
function removeScratch(at: string): boolean {
  const kind = scratchKind(at);
  if (kind === 'missing') return true;
  if (kind !== 'directory' && kind !== 'file') return false;
  return discard(at);
}

/**
 * Finish a swap that a kill interrupted, before anything else touches the round.
 *
 * `state.verifyRound` is incremented only AFTER `runGate` returns, so a process
 * killed between the copy and the state write resumes onto the same round
 * number and lands back here. The install below renames the old round aside
 * before installing the new one, so the signature of a kill inside that window
 * is: no `round-N`, and one `round-N.superseded-*` holding the only copy of the
 * previous evidence. Renaming it back is the only way that evidence survives.
 *
 * More than one backup means more than one interrupted attempt and no fact about
 * which is current, so the RESTORE is not guessed at - both stay on disk under
 * names that say what they are, and the caller names them in the record rather
 * than leaving a reader to find them.
 *
 * Deleting is a different question from restoring and is answered separately:
 * once `round-N` is installed it is authoritative, so every backup beside it is
 * stale whatever their number, and they all go. That is deterministic on the
 * next attempt rather than accumulating.
 */
function recoverInterrupted(gateDir: string, round: number): string[] {
  const target = path.join(gateDir, `round-${round}`);
  const prefix = `round-${round}${SUPERSEDED}`;
  const matching = readdirSync(gateDir, { withFileTypes: true })
    .filter((e) => e.name.startsWith(prefix))
    .map((e) => path.join(gateDir, e.name));
  const backups = matching.filter((p) => entryKind(p) === 'directory');
  // Named, not silently filtered: a matching entry that is a link or that lstat
  // could not classify is exactly the thing a reader has to be told about,
  // since nothing here will touch it and nothing else will explain it.
  const unclassifiable = matching.filter((p) => entryKind(p) !== 'directory');

  const installed = entryKind(target);
  if (installed === 'missing' && backups.length === 1 && backups[0] !== undefined) {
    renameSync(backups[0], target);
    log.warn(`recovered an interrupted artifact swap: restored ${path.basename(backups[0])}`);
    return unclassifiable.map((p) => path.basename(p));
  }

  const left = [...unclassifiable];
  if (installed === 'directory') {
    for (const backup of backups) {
      if (!discard(backup)) left.push(backup);
    }
  } else if (backups.length > 1) {
    // The round is missing and there is more than one candidate. Restoring one
    // would fabricate the fact that it is the current one.
    left.push(...backups);
  }
  return left.map((p) => path.basename(p));
}

/**
 * Remove staging directories a previous attempt left behind, naming any that
 * will not go.
 */
function clearStaging(gateDir: string, round: number): string[] {
  // The trailing hyphen matters: without it, round 1's sweep would also match
  // `round-10`'s staging.
  const prefix = `${STAGING}round-${round}-`;
  const left: string[] = [];
  for (const child of readdirSync(gateDir, { withFileTypes: true })) {
    if (!child.name.startsWith(prefix)) continue;
    // Only what this module could have written is removed - a directory or a
    // regular file. Anything else there was not written by this module, and this
    // module deletes nothing it did not create; it is still a leftover, and the
    // record says so. `scratchKind` rather than `entryKind` so the `.partial-<i>`
    // FILE a single-file entry produces is swept rather than kept for ever
    // (#111), and so the sweep at run start cannot drift from this one.
    if (!removeScratch(path.join(gateDir, child.name))) left.push(child.name);
  }
  return left;
}

/** One thing the sweep would not remove, and why a reader is being told. */
interface KeptEntry {
  /** Run-relative, POSIX, so it is a path a reader can act on. */
  at: string;
  why: string;
}

export interface ArtifactSweep {
  removed: string[];
  kept: KeptEntry[];
}

/**
 * Remove the scratch a killed preservation left behind, anywhere in the run
 * (#111).
 *
 * `recoverInterrupted` and `clearStaging` only run inside `preserveGateArtifacts`,
 * and only for the gate and round it was called for. A run killed during a
 * preserve that then resumes and never fails that gate again - or that never
 * resumes at all - keeps its staging tree for ever. That litter is not small: it
 * is a copy of what the gate produced, the motivating example is a Playwright
 * report, and `verify.artifactMaxBytes` is `null` by default so there is no
 * ceiling on it. The stamp is `state.events.length`, so two kills leave two.
 *
 * **This is option 1 of the two the issue named, and it is knowingly partial.**
 * It fixes the run that resumes. It cannot fix the run that never resumes again,
 * because that run never executes anything - only a pass over `.vibe/runs`
 * would, and archive-wide retention is a bigger question that #62 ruled out of
 * scope and that applies to every artifact rather than to this one. Said here
 * rather than implied: the never-resumed case is not covered.
 *
 * **Never throws.** It runs at the top of a pass, and failing to tidy must not
 * stop a run - the same rule `preserveGateArtifacts` itself follows.
 *
 * **Deletes nothing it cannot classify.** This runs inside `.vibe/runs`, which
 * #53 established is a directory whose entries cannot be assumed to be what they
 * look like. A `.staging-` entry that is a link, or that `lstat` could not read,
 * is named and left.
 */
export function sweepGateArtifacts(state: RunState): ArtifactSweep {
  const sweep: ArtifactSweep = { removed: [], kept: [] };
  const artifactsDir = path.join(state.dir, 'artifacts');
  if (entryKind(artifactsDir) === 'missing') return sweep;
  if (entryKind(artifactsDir) !== 'directory') {
    sweep.kept.push({ at: 'artifacts', why: 'is not a plain directory; nothing was swept' });
    return sweep;
  }

  let gates: string[];
  try {
    gates = readdirSync(artifactsDir, { withFileTypes: true }).map((e) => e.name);
  } catch (err: unknown) {
    sweep.kept.push({ at: 'artifacts', why: `could not be read (${reason(err)})` });
    return sweep;
  }

  for (const gate of gates) {
    const gateDir = path.join(artifactsDir, gate);
    if (entryKind(gateDir) !== 'directory') {
      sweep.kept.push({ at: `artifacts/${gate}`, why: 'is not a plain directory' });
      continue;
    }
    let names: string[];
    try {
      names = readdirSync(gateDir, { withFileTypes: true }).map((e) => e.name);
    } catch (err: unknown) {
      sweep.kept.push({ at: `artifacts/${gate}`, why: `could not be read (${reason(err)})` });
      continue;
    }

    for (const name of names) {
      const rel = `artifacts/${gate}/${name}`;
      const at = path.join(gateDir, name);

      if (name.startsWith(STAGING)) {
        if (removeScratch(at)) sweep.removed.push(rel);
        else sweep.kept.push({ at: rel, why: 'is a link, or could not be classified' });
        continue;
      }

      // `round-<n>.superseded-<stamp>`: the previous round, held while a swap
      // was in flight. It is deleted only once the round it backs up is
      // installed, which is the same rule `recoverInterrupted` applies and for
      // the same reason - with no `round-<n>` beside it, this may be the ONLY
      // copy of that evidence, and the ambiguity is not one a sweep may resolve.
      const backup = /^(round-\d+)\.superseded-/.exec(name);
      if (backup === null) continue;
      const installed = path.join(gateDir, backup[1] ?? '');
      if (entryKind(installed) !== 'directory') {
        sweep.kept.push({
          at: rel,
          why: `${backup[1] ?? ''} is not installed beside it, so this may be the only copy`,
        });
        continue;
      }
      if (removeScratch(at)) sweep.removed.push(rel);
      else sweep.kept.push({ at: rel, why: 'is a link, or could not be classified' });
    }
  }

  return sweep;
}

/**
 * Install the staged round: rename the old one aside, move the new one in, then
 * drop the backup.
 *
 * Never `rm` then `rename`. A kill in that window - or a rename that fails after
 * the delete - would leave the round's evidence existing nowhere while
 * `state.json` still named it. The old snapshot is one rename away until the new
 * one is in place, and `recoverInterrupted` finishes the job on the next attempt.
 *
 * A plain FILE at `round-N` refuses the install rather than being removed: this
 * module deletes nothing it did not create, and an unexpected file there is a
 * fact for a human.
 */
function install(staging: string, target: string, stamp: number): string[] {
  const existing = entryKind(target);
  if (existing === 'link' || existing === 'unknown') {
    throw new Error(`${path.basename(target)} is a link, or could not be classified`);
  }
  if (existing === 'not-a-directory') {
    throw new Error(
      `${path.basename(target)} exists and is not a directory; refusing to replace it`,
    );
  }
  if (existing === 'missing') {
    renameSync(staging, target);
    return [];
  }

  // A name nothing else holds: `recoverInterrupted` refuses to choose between
  // two backups, so creating a second one under a name already taken would
  // strand both.
  let backup = `${target}${SUPERSEDED}${stamp}`;
  for (let n = 1; entryKind(backup) !== 'missing'; n += 1) {
    backup = `${target}${SUPERSEDED}${stamp}-${n}`;
  }
  renameSync(target, backup);
  try {
    renameSync(staging, target);
  } catch (err: unknown) {
    try {
      renameSync(backup, target);
    } catch {
      throw new Error(
        `${reason(err)} - and the previous round could not be restored; it is on disk at ` +
          `${path.basename(backup)}`,
      );
    }
    throw err;
  }
  // Best effort, and deliberately AFTER the new round is installed and outside
  // the failure path above. The snapshot is already in place, so a cleanup that
  // fails has not cost anything: reporting the entries as failed here would make
  // state.json contradict a filesystem that holds exactly what was asked for.
  // What it does cost is a directory nobody can explain, so the name is returned
  // and ends up in the record - and the next attempt's `recoverInterrupted`
  // deletes it, since a round that is installed makes every backup beside it
  // stale.
  if (discard(backup)) return [];
  log.warn(`kept the superseded artifact round at ${path.basename(backup)}`);
  return [path.basename(backup)];
}

/** Every entry reported as failed for one shared reason. Used when nothing could run. */
function allFailed(dir: string, paths: readonly string[], why: string): GateArtifacts {
  return {
    dir,
    bytes: 0,
    entries: paths.map((p) => ({ path: p, status: 'failed' as const, reason: why })),
  };
}

/**
 * Preserve what a failing gate produced, and report exactly what happened.
 *
 * **Never throws.** A gate artifact is evidence *about* a failure; failing to
 * preserve it must not replace that failure with a different one, which is the
 * rule `markActivity` and the heartbeat's sinks already follow. Every error
 * becomes a `failed` status with its reason.
 *
 * **Never silent.** The measured size is reported whether or not a ceiling is
 * set, and every refused link is named. A record that quietly omits half a
 * report looks complete, and looking complete while being partial is the
 * fabrication AGENTS.md forbids.
 */
export function preserveGateArtifacts(
  state: RunState,
  cwd: string,
  gate: string,
  round: number,
  paths: readonly string[],
  maxBytes: number | null,
): GateArtifacts {
  const dir = roundDir(gate, round);
  const stamp = state.events.length;

  try {
    const gateDir = prepareGateDir(state, gate);
    const leftovers = [...recoverInterrupted(gateDir, round), ...clearStaging(gateDir, round)];

    const staging = path.join(gateDir, `${STAGING}round-${round}-${stamp}`);
    ensureDirectory(staging);

    const entries: ArtifactEntryOutcome[] = [];
    let bytes = 0;
    const root = path.resolve(cwd);

    paths.forEach((entry, index) => {
      // The scratch directory sits BESIDE the staging tree, not inside it: a
      // `.partial` whose best-effort removal failed would otherwise be renamed
      // into the round along with everything else, putting a half-copied tree
      // in the record under a name no entry claims. Beside it, it is swept by
      // `clearStaging`, which matches the same prefix.
      const partial = `${staging}.partial-${index}`;
      const outcome = copyOne(root, entry, partial, staging, maxBytes);
      entries.push(outcome);
      if (outcome.status === 'copied') bytes += outcome.bytes ?? 0;
    });

    try {
      leftovers.push(...install(staging, path.join(gateDir, `round-${round}`), stamp));
    } catch (err: unknown) {
      discard(staging);
      // Nothing landed, so nothing may be reported as landed - a `copied` entry
      // whose files are not on disk is the authoritative wrong answer again.
      return allFailed(dir, paths, `the artifacts could not be installed: ${reason(err)}`);
    }

    return {
      dir,
      entries,
      bytes,
      // Present only when something is actually there, so a reader can take its
      // absence as "the gate directory holds the rounds and nothing else".
      ...(leftovers.length > 0
        ? {
            unresolved:
              `left beside the round and not removed: ${leftovers.join(', ')} - the next ` +
              'preservation for this round clears what it can',
          }
        : {}),
    };
  } catch (err: unknown) {
    return allFailed(dir, paths, reason(err));
  }
}

/**
 * One configured path, from the lexical rule to the copy.
 *
 * The copy lands in its own scratch directory and is renamed into the staging
 * tree only once `cpSync` has RETURNED. A recursive copy that writes three files
 * and then throws would otherwise leave three files that no entry claims and no
 * byte count includes.
 */
function copyOne(
  root: string,
  entry: string,
  partial: string,
  staging: string,
  maxBytes: number | null,
): ArtifactEntryOutcome {
  const refusal = refuseArtifactPath(entry);
  if (refusal !== null) return { path: entry, status: 'refused', reason: refusal };

  try {
    const descent = safeDescend(root, entry);
    if (descent.kind === 'refused') {
      return { path: entry, status: 'refused', reason: descent.reason };
    }
    if (descent.kind === 'absent') {
      return { path: entry, status: 'missing', reason: descent.reason };
    }

    const kind = entryKind(descent.path);
    if (kind === 'link' || kind === 'unknown') {
      return {
        path: entry,
        status: 'refused',
        reason: `"${entry}" is a link, or could not be classified; nothing is copied through it`,
      };
    }

    // The third belt, and the only one that asks the host to canonicalize:
    // the lexical rule and the component walk both reason about the path as
    // written, and Windows does not.
    const escaped = outsideOf(root, descent.path);
    if (escaped !== null) return { path: entry, status: 'refused', reason: `"${entry}" ${escaped}` };

    const measured = measure(descent.path);
    if (maxBytes !== null && measured.bytes > maxBytes) {
      // Nothing at all, never a prefix of the tree: a truncated report that
      // looks whole is worse than an absent one that says it is absent.
      return {
        path: entry,
        status: 'too-large',
        files: measured.files,
        bytes: measured.bytes,
        reason: `${measured.bytes} bytes measured, over the ${maxBytes}-byte verify.artifactMaxBytes ceiling`,
        ...(measured.links.length > 0 ? { skippedLinks: measured.links } : {}),
      };
    }

    cpSync(descent.path, partial, {
      recursive: true,
      // The one mechanism that refuses anything, and it is called for every
      // entry including the source root. `linkageOf` is #53's predicate.
      filter: (source: string) => linkageOf(source) === 'plain',
    });

    // Into place only now. The destination mirrors the configured relative path
    // - `test-results/summary.json` lands at `<round>/test-results/summary.json`
    // - so two entries can never collide on a shared basename. Overlapping
    // entries are refused by config, so no destination can nest inside another.
    const segments = entry.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
    const destination = path.join(staging, ...segments);
    mkdirParents(staging, path.dirname(destination));
    // The same belt on the way out. The segments here are the ones the entry was
    // written with, so anything the host canonicalizes differently would place
    // the copy outside the tree that is about to be installed.
    const strayed = outsideOf(staging, path.dirname(destination));
    if (strayed !== null) throw new Error(`the destination for "${entry}" ${strayed}`);
    renameSync(partial, destination);

    return {
      path: entry,
      status: 'copied',
      files: measured.files,
      bytes: measured.bytes,
      ...(measured.links.length > 0 ? { skippedLinks: measured.links } : {}),
    };
  } catch (err: unknown) {
    discard(partial);
    return { path: entry, status: 'failed', reason: reason(err) };
  }
}

/**
 * Create `target`'s missing ancestors under `base`, one classified level at a
 * time. Everything here was created by this module inside its own staging
 * directory, so the classification is a belt on a belt - and cheap.
 */
function mkdirParents(base: string, target: string): void {
  const rel = path.relative(base, target);
  if (rel === '') return;
  let at = base;
  for (const segment of rel.split(path.sep).filter((s) => s !== '')) {
    at = path.join(at, segment);
    ensureDirectory(at);
  }
}
