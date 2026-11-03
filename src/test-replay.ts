import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveInside } from '@src/evidence.js';
import * as git from '@src/git.js';
import { CONFIG_FILE, REVIEW_FILE, isJudge } from '@src/judge.js';
import * as log from '@src/log.js';
import { REFUSED_ROOTS } from '@src/reproducer.js';
import { artifactDir, linkedArtifactReason, saveState } from '@src/run.js';
import type { ToolchainContract } from '@src/runtime.js';
import type {
  Config,
  FileChange,
  RunState,
  TestReplay,
  TestReplayCache,
  TestReplayFile,
  TestReplayInFlight,
} from '@src/types.js';
import { resolveGates, runGateCommand } from '@src/verify.js';
import type { ResolvedGate } from '@src/verify.js';

/**
 * Replay the earliest committed version of each edited test against the run's
 * code (#486).
 *
 * A review seat judges an edit to a test by reading it, and on the bench a seat
 * that did not read the history called a planted weakening justified. This runs
 * it instead: the earliest version of each edited test is written back in place,
 * the user's own gates run once, and the head copy is restored. An earlier
 * version that still passes certifies itself - its assertions hold against the
 * code as it is now. One that fails turns the judge's question into a sharper
 * one: is that failing earlier assertion still the contract?
 *
 * It records and nothing else. No prompt reads it, nothing blocks on it, and the
 * exit code does not move (#112).
 *
 * ## The verdict discipline is the reproducer's (#113)
 *
 * A pass certifies itself. A failure counts only against a gate that passed on
 * the same tree in the pass just before - `state.gateOutcomes` - and otherwise
 * it is `unproven`, as is every other way this can go wrong. vibe reads exit
 * codes and parses no reporter, so `earlier-fails` includes failing to compile.
 * It never means tampering: a legitimate contract change fails too.
 *
 * ## Why it is safe to write into the tree
 *
 * It runs only between a gate pass and the next agent turn, so no agent reads a
 * swapped tree. A marker is saved before the first write and cleared after the
 * last restore, and a process that dies in between leaves it for the next one,
 * which restores before anything else runs. Backups are named by the SHA-256 of
 * their bytes, never by path: the run directory can sit inside the tree a test
 * runner walks, and a backup named `foo.test.js` would be run alongside the
 * swapped-in version.
 */

/** A file the replay will swap, with what it swaps in and what it must put back. */
export interface Candidate {
  path: string;
  earliest: { commit: string; blob: string };
  /** The head copy's filtered content id. */
  head: string;
}

/** The gates a replay would run, or null when none is eligible (decision 7). */
export function replayGates(cfg: Config, cwd: string): ResolvedGate[] | null {
  if (!cfg.verify.enabled) return null;
  const gates = resolveGates(cfg.verify, cwd).filter((g) => g.replay && g.command !== null);
  return gates.length > 0 ? gates : null;
}

/**
 * The names of the gates that passed on this tree in the pass just before, on
 * the command they would run now. The same-tree baseline a failure needs.
 */
export function passedGates(state: RunState, gates: readonly ResolvedGate[]): Set<string> {
  const outcomes = state.gateOutcomes ?? [];
  return new Set(
    gates
      .filter((g) => outcomes.some((o) => o.name === g.name && o.status === 'passed' && o.command === g.command))
      .map((g) => g.name),
  );
}

/**
 * Decide, per listed judge file, whether it is replayed and against what.
 *
 * Order matters and is the order below. A rename on either side is `renamed`
 * whatever else is true of it. The two control files are never tests, whatever
 * `verify.testPaths` matches (decision 1) - `**\/*` would otherwise swap the
 * gate configuration itself. Everything else needs its earliest committed
 * version: the base version for a file the base had, and for a file the run
 * added, its version in the first commit after the base that contains it.
 */
export async function classify(
  cwd: string,
  judged: readonly FileChange[],
  renamedFrom: ReadonlyMap<string, string>,
  blobs: ReadonlyMap<string, string | null>,
  patterns: readonly string[],
  baseSha: string | null,
): Promise<{ file: TestReplayFile; candidate: Candidate | null }[]> {
  const renameSides = new Set<string>([...renamedFrom.keys(), ...renamedFrom.values()]);
  const out: { file: TestReplayFile; candidate: Candidate | null }[] = [];
  const said = (file: TestReplayFile): void => {
    out.push({ file, candidate: null });
  };
  for (const change of judged) {
    const p = change.path;
    if (renameSides.has(p)) {
      said({ path: p, verdict: 'renamed' });
      continue;
    }
    if (p === CONFIG_FILE || p === REVIEW_FILE || !isJudge(p, patterns)) {
      said({ path: p, verdict: 'not-a-test' });
      continue;
    }
    if (change.status === 'deleted') {
      said({ path: p, verdict: 'deleted' });
      continue;
    }
    let commit: string | null;
    try {
      commit = change.status === 'added' || baseSha === null ? await git.firstCommitWith(cwd, baseSha, p) : baseSha;
    } catch (err) {
      said({ path: p, verdict: 'unproven', reason: `git could not say where it was first committed (${message(err)})` });
      continue;
    }
    if (commit === null) {
      said({ path: p, verdict: 'no-committed-version' });
      continue;
    }
    let entry: Awaited<ReturnType<typeof git.entryAt>>;
    try {
      entry = await git.entryAt(cwd, commit, p);
    } catch (err) {
      said({ path: p, verdict: 'unproven', reason: `git could not read it at ${commit.slice(0, 7)} (${message(err)})` });
      continue;
    }
    if (entry === 'absent') {
      said({ path: p, verdict: 'no-committed-version' });
      continue;
    }
    const earliest = { commit, blob: entry.blob };
    if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
      said({
        path: p,
        verdict: 'unproven',
        earliest,
        reason: `its earliest committed version is not a regular file (mode ${entry.mode})`,
      });
      continue;
    }
    const head = blobs.get(p) ?? null;
    if (head === null) {
      said({ path: p, verdict: 'unproven', earliest, reason: 'its head content could not be read' });
      continue;
    }
    if (head === earliest.blob) {
      said({ path: p, verdict: 'unchanged', earliest, head });
      continue;
    }
    out.push({ file: { path: p, verdict: 'unproven', earliest, head }, candidate: { path: p, earliest, head } });
  }
  return out;
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Where a repo-relative path lands, or why it must not be written (#486).
 *
 * The containment `placeReproducer` applies, for the reason it applies it: this
 * module WRITES, and `resolveInside` is lexical. Every component below the root
 * is `lstat`ed, so a test directory replaced by a link - by a gate, or by hand
 * while a process was dead - is refused rather than followed out of the tree.
 * `.git` and `.vibe` are refused as for a reproducer. The leaf must be a regular
 * file, or, for a restore, missing.
 */
export function treeTarget(
  cwd: string,
  rel: string,
  allowMissing = false,
): { absolute: string; exists: boolean } | { reason: string } {
  const { absolute, relative } = resolveInside(cwd, rel, null);
  if (absolute === null || relative === null || relative === '.') {
    return { reason: `${rel} does not resolve to a file inside the working tree` };
  }
  const segments = relative.split('/').filter((s) => s !== '');
  const first = segments[0];
  if (first === undefined || REFUSED_ROOTS.has(first)) {
    return { reason: `${relative} is under ${first ?? 'nothing'}, which vibe does not write` };
  }
  let at = path.resolve(cwd);
  for (const [i, segment] of segments.entries()) {
    at = path.join(at, segment);
    const last = i === segments.length - 1;
    let kind: 'missing' | 'link' | 'dir' | 'file' | 'other';
    try {
      const stat = lstatSync(at);
      kind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other';
    } catch {
      kind = 'missing';
    }
    if (kind === 'link') return { reason: `${relative} passes through a symlink` };
    if (last) {
      if (kind === 'file') return { absolute, exists: true };
      if (kind === 'missing' && allowMissing) return { absolute, exists: false };
      return { reason: kind === 'missing' ? `${relative} is missing` : `${relative} is not a regular file` };
    }
    if (kind !== 'dir') {
      return { reason: kind === 'missing' ? `${relative} is under a directory that is gone` : `${relative} is under a file` };
    }
  }
  return { reason: `${rel} does not name a file` };
}

/**
 * A backup's absolute path, or why it cannot be trusted (#486). The directory
 * must not be a link (`linkedArtifactReason`, the run directory's own rule), and
 * the file must be a regular file - or missing, when it is about to be written.
 */
function backupTarget(
  state: RunState,
  backup: string,
  allowMissing: boolean,
): { absolute: string; exists: boolean } | { reason: string } {
  const [dir, name, ...rest] = backup.split('/');
  if (dir === undefined || name === undefined || rest.length > 0) return { reason: `${backup} is not a backup name` };
  const linked = linkedArtifactReason(state.dir, dir);
  if (linked !== null) return { reason: linked };
  const absolute = path.join(state.dir, dir, name);
  try {
    const stat = lstatSync(absolute);
    if (stat.isFile()) return { absolute, exists: true };
    return { reason: `${absolute} is not a regular file` };
  } catch {
    return allowMissing ? { absolute, exists: false } : { reason: `${absolute} is missing` };
  }
}

/** Thrown when a swapped test could not be put back. Never retried past. */
export class ReplayRestoreError extends Error {
  override name = 'ReplayRestoreError';
}

/**
 * Thrown, after the restore, when a replayed gate timed out and vibe could not
 * confirm its processes had stopped (#486): one still held the gate's output
 * after every kill. Going on - another pass, or the next turn - would run beside
 * a process that may still be reading and writing the tree, so the run stops
 * instead, with the head copies already back - and the in-flight marker kept, because
 * that process may still write the earlier versions back over them. The resume
 * restores and verifies them again before anything else runs. Never retried past.
 */
export class ReplayGateEscapedError extends Error {
  override name = 'ReplayGateEscapedError';
}

/**
 * Put every head copy back, or say exactly what could not be (#486). Never
 * throws; returns the problems, each naming the file and its backup.
 *
 * Every backup is checked first - present, a regular file, and the SHA-256 of
 * its bytes the one the marker recorded - even for a file that already holds
 * its head bytes, so a backup that went missing is always said (decision 5).
 * Only then is each file compared and, where it differs, written and read back.
 * Compared by exact bytes, never by git's filtered id: two files that differ
 * only in line endings share a blob id under `text`.
 */
export function restoreFiles(state: RunState, cwd: string, entries: TestReplayInFlight['files']): string[] {
  const problems: string[] = [];
  const say = (entry: TestReplayInFlight['files'][number], absolute: string, why: string): void => {
    problems.push(`${entry.path} (backup ${absolute}): ${why}`);
  };
  const backups = new Map<string, Buffer>();
  for (const entry of entries) {
    const target = backupTarget(state, entry.backup, false);
    const shown = path.join(state.dir, entry.backup);
    if ('reason' in target) {
      say(entry, shown, target.reason);
      continue;
    }
    try {
      const bytes = readFileSync(target.absolute);
      if (sha256(bytes) !== entry.sha256) say(entry, shown, 'the backup does not hold the bytes that were saved');
      else backups.set(entry.path, bytes);
    } catch (err) {
      say(entry, shown, `the backup could not be read (${message(err)})`);
    }
  }
  if (problems.length > 0) return problems;
  for (const entry of entries) {
    const shown = path.join(state.dir, entry.backup);
    const bytes = backups.get(entry.path);
    if (bytes === undefined) continue;
    const target = treeTarget(cwd, entry.path, true);
    if ('reason' in target) {
      say(entry, shown, target.reason);
      continue;
    }
    try {
      if (target.exists && sha256(readFileSync(target.absolute)) === entry.sha256) continue;
      writeFileSync(target.absolute, bytes);
      if (sha256(readFileSync(target.absolute)) !== entry.sha256) {
        say(entry, shown, 'the restored file does not hold the backup\'s bytes');
      }
    } catch (err) {
      say(entry, shown, `it could not be written back (${message(err)})`);
    }
  }
  return problems;
}

function restoreMessage(problems: readonly string[], when: string): string {
  return (
    `${when}, and ${problems.length} test file(s) could not be restored safely: ${problems.join('; ')}. ` +
    'An earlier committed version may still be in the working tree, so nothing was run. Copy each backup ' +
    'over its file, remove "testReplayInFlight" from state.json, and resume.'
  );
}

/**
 * Restore what a dead process left swapped, before anything else runs (#486).
 *
 * Called first in `execute` - before preflight, which touches the tree - and
 * first in `runPhases`, for callers that reach the loop directly. Whatever the
 * replay settings now say: a marker means files are swapped, and turning the
 * replay off does not put them back. A failure keeps the marker and throws, and
 * `execute` reports it as `EXIT.ERROR` even after a stop.
 */
export async function restoreInFlight(state: RunState, cwd: string): Promise<void> {
  const marker = state.testReplayInFlight;
  if (marker === undefined) return;
  const problems = restoreFiles(state, cwd, marker.files);
  if (problems.length > 0) {
    throw new ReplayRestoreError(
      restoreMessage(problems, 'The last process stopped while earlier versions of this run\'s tests were swapped in'),
    );
  }
  delete state.testReplayInFlight;
  saveState(state);
  const files = marker.files.map((f) => f.path);
  log.info(`Restored ${files.length} test file(s) an interrupted replay had swapped: ${files.join(', ')}`, {
    id: 'test_replay_restored',
    data: { round: marker.round, files },
  });
}

/** What one swap-and-run pass observed. */
interface PassOutcome {
  verdict: 'preserved' | 'earlier-fails' | 'unproven';
  gate?: string;
  gates: string[];
  reason?: string;
}

/** A candidate with everything a pass needs already read and backed up. */
interface Ready {
  candidate: Candidate;
  earliest: Buffer;
  entry: TestReplayInFlight['files'][number];
}

export interface ReplayContext {
  state: RunState;
  cwd: string;
  /** The raw `state.reviewRound`, which names the backup directory and the artifact. */
  round: number;
  gates: readonly ResolvedGate[];
  passed: ReadonlySet<string>;
  contract: ToolchainContract;
}

/**
 * Swap, run and restore, batched (decision 3). Returns a verdict per candidate.
 *
 * One pass swaps every candidate in. If it passes, every file is `preserved`.
 * Any other outcome with more than one file is followed by one pass per file,
 * because a pass certifies itself: a file that passes alone is `preserved` even
 * when the batch timed out or failed for a reason nothing could attribute.
 *
 * Throws `ReplayRestoreError`, with the marker still saved, when a head copy
 * could not be put back. That is the one failure that must stop the run.
 */
export async function runReplay(
  ctx: ReplayContext,
  candidates: readonly Candidate[],
): Promise<Map<string, PassOutcome>> {
  const { state, cwd, round } = ctx;
  const result = new Map<string, PassOutcome>();
  const unproven = (c: Candidate, reason: string): void => {
    result.set(c.path, { verdict: 'unproven', gates: [], reason });
  };

  const dir = `test-replay-${round}`;
  const linked = linkedArtifactReason(state.dir, dir);
  if (linked !== null) {
    for (const c of candidates) unproven(c, `its backup could not be written: ${linked}`);
    return result;
  }

  const ready: Ready[] = [];
  for (const c of candidates) {
    const earliest = await git.blobBytes(cwd, c.earliest.blob, c.path);
    if (earliest === null) {
      unproven(c, 'git could not write out its earliest committed version');
      continue;
    }
    const target = treeTarget(cwd, c.path);
    if ('reason' in target) {
      unproven(c, target.reason);
      continue;
    }
    let head: Buffer;
    try {
      head = readFileSync(target.absolute);
    } catch (err) {
      unproven(c, `its head copy could not be read (${message(err)})`);
      continue;
    }
    const hash = sha256(head);
    const entry = { path: c.path, backup: `${dir}/${hash}.head`, sha256: hash };
    // Named by the bytes' hash, never by the path (decision 3), so no test runner
    // walking a run directory inside the tree finds a second copy of a test.
    try {
      // Inside the handler: a regular file where the directory should be makes
      // `mkdir` throw, and that is this file unmeasured, not a failed run.
      artifactDir(state, dir);
      const backup = backupTarget(state, entry.backup, true);
      if ('reason' in backup) throw new Error(backup.reason);
      if (!backup.exists || sha256(readFileSync(backup.absolute)) !== hash) writeFileSync(backup.absolute, head);
      if (sha256(readFileSync(backup.absolute)) !== hash) throw new Error('the backup did not read back as written');
    } catch (err) {
      unproven(c, `its head copy could not be backed up (${message(err)})`);
      continue;
    }
    ready.push({ candidate: c, earliest, entry });
  }
  if (ready.length === 0) return result;

  // Saved before the first write to the tree, so a process killed from here on
  // leaves the record of what to put back.
  state.testReplayInFlight = { round, files: ready.map((r) => r.entry) };
  saveState(state);

  let keepMarker = false;
  try {
    const batch = await attempt(ctx, ready);
    if (batch.verdict === 'preserved' || ready.length === 1) {
      for (const r of ready) result.set(r.candidate.path, batch);
    } else {
      for (const r of ready) result.set(r.candidate.path, await attempt(ctx, [r]));
    }
  } catch (err) {
    // Kept after an escaped gate too, though its restore was verified: the
    // process that escaped may hold the earlier bytes and write them back after
    // this returns, so the restore has to be done again, and checked, once it
    // has been stopped. The resume does that before anything else runs.
    if (err instanceof ReplayRestoreError || err instanceof ReplayGateEscapedError) keepMarker = true;
    throw err;
  } finally {
    // Every pass restores in its own `finally`, so the tree holds its head copies
    // unless a restore said otherwise - and then the marker must survive.
    if (!keepMarker) {
      delete state.testReplayInFlight;
      saveState(state);
    }
  }
  return result;
}

/**
 * One pass: write the earlier versions, confirm them, run the gates, restore.
 *
 * Confirmed twice before any gate runs. The bytes must read back as written,
 * and they must hash back - through git's clean filter, as `hash-object` does -
 * to the committed blob. The second is what makes the replay a replay of the
 * committed version: a smudge filter that does not round-trip (one that drops a
 * line, say) writes bytes that are not that version, and a pass over them would
 * certify assertions that never ran.
 */
async function attempt(ctx: ReplayContext, files: readonly Ready[]): Promise<PassOutcome> {
  const { state, cwd } = ctx;
  try {
    for (const f of files) {
      const target = treeTarget(cwd, f.candidate.path);
      if ('reason' in target) return { verdict: 'unproven', gates: [], reason: target.reason };
      try {
        writeFileSync(target.absolute, f.earliest);
      } catch (err) {
        // A test that can be read and not written: nothing was measured, and the
        // restore below finds it still holding its head bytes.
        return { verdict: 'unproven', gates: [], reason: `its earliest committed version could not be written (${message(err)})` };
      }
      if (!readFileSync(target.absolute).equals(f.earliest)) {
        return { verdict: 'unproven', gates: [], reason: 'its earliest committed version could not be written as committed' };
      }
    }
    const ids = await git.hashObjects(
      cwd,
      files.map((f) => f.candidate.path),
    );
    if (ids === null || ids.some((id, i) => id !== files[i]?.candidate.earliest.blob)) {
      return {
        verdict: 'unproven',
        gates: [],
        reason: 'the checked-out bytes do not hash back to the committed version (a filter changed them)',
      };
    }

    const ran: string[] = [];
    for (const gate of ctx.gates) {
      const result = await runGateCommand(cwd, { ...gate, runs: 1 }, ctx.contract);
      ran.push(gate.name);
      if (result.escaped === true) {
        throw new ReplayGateEscapedError(
          `The ${gate.name} gate timed out while replaying earlier versions of ${files.map((f) => f.candidate.path).join(', ')}, ` +
            'and a process it started was still holding its output after every process vibe could find was killed. ' +
            'The head copies of the tests were put back, but that process may still be running in the working tree ' +
            'and could write the earlier versions back, so the run stopped rather than go on beside it. ' +
            'Stop it, then resume: the resume puts the head copies back again and checks them before anything else runs. ' +
            'verify.gates[].replay: false keeps this gate out of the replay.',
        );
      }
      if (result.unavailable !== null) {
        return { verdict: 'unproven', gates: ran, reason: `the ${gate.name} gate was unavailable: ${result.unavailable}` };
      }
      if (result.unlaunchable !== null) {
        return { verdict: 'unproven', gates: ran, reason: `the ${gate.name} gate could not run: ${result.unlaunchable}` };
      }
      if (result.ok) continue;
      const exitCode = result.attempts[0]?.exitCode ?? result.exitCode;
      if (exitCode === null) {
        return { verdict: 'unproven', gates: ran, reason: `the ${gate.name} gate timed out or was killed` };
      }
      if (!ctx.passed.has(gate.name)) {
        return {
          verdict: 'unproven',
          gates: ran,
          reason:
            `the ${gate.name} gate failed with the earlier version in place, but nothing observed it passing ` +
            'on this tree, so the failure cannot be attributed to it',
        };
      }
      return { verdict: 'earlier-fails', gate: gate.name, gates: ran };
    }
    return { verdict: 'preserved', gates: ran };
  } catch (err) {
    if (err instanceof ReplayGateEscapedError) throw err;
    // Anything else that went wrong in the pass measured nothing, so it is this
    // pass's `unproven`, never the run's error. The restore below still runs,
    // and a restore that fails still throws over this: that one must stop.
    return { verdict: 'unproven', gates: [], reason: `the replay could not be completed (${message(err)})` };
  } finally {
    const problems = restoreFiles(
      state,
      cwd,
      files.map((f) => f.entry),
    );
    if (problems.length > 0) {
      // Thrown over whatever went wrong before it, on purpose: a test left
      // swapped is the one outcome worse than any other this pass can have.
      throw new ReplayRestoreError(restoreMessage(problems, 'A replay of earlier test versions finished'));
    }
  }
}

/** The cache key's gate half: names and commands, in order. */
export function gateKey(gates: readonly ResolvedGate[]): { name: string; command: string }[] {
  return gates.map((g) => ({ name: g.name, command: g.command ?? '' }));
}

/**
 * A verdict measured on this tree, these gates and this earliest version, or
 * null (decision 6). Anything less than all three is not the same measurement.
 */
export function cached(
  cache: TestReplayCache | undefined,
  tree: string | null,
  gates: readonly ResolvedGate[],
  candidate: Candidate,
): TestReplayFile | null {
  if (cache === undefined || tree === null || cache.tree !== tree) return null;
  const key = gateKey(gates);
  if (
    cache.gates.length !== key.length ||
    cache.gates.some((g, i) => g.name !== key[i]?.name || g.command !== key[i]?.command)
  ) {
    return null;
  }
  const hit = cache.files.find((f) => f.path === candidate.path && f.earliest === candidate.earliest.blob);
  if (hit === undefined) return null;
  return {
    path: candidate.path,
    verdict: hit.verdict,
    earliest: candidate.earliest,
    head: candidate.head,
    ...(hit.gate === undefined ? {} : { gate: hit.gate }),
    gates: [...hit.gates],
    cached: true,
  };
}

export interface ReplayCounts {
  preserved: number;
  earlierFails: number;
  unproven: number;
  unchanged: number;
  deleted: number;
  renamed: number;
  noCommittedVersion: number;
  notATest: number;
  cached: number;
}

export function replayCounts(record: TestReplay): ReplayCounts {
  const n = (v: TestReplayFile['verdict']): number => record.files.filter((f) => f.verdict === v).length;
  return {
    preserved: n('preserved'),
    earlierFails: n('earlier-fails'),
    unproven: n('unproven'),
    unchanged: n('unchanged'),
    deleted: n('deleted'),
    renamed: n('renamed'),
    noCommittedVersion: n('no-committed-version'),
    notATest: n('not-a-test'),
    cached: record.files.filter((f) => f.cached === true).length,
  };
}

/** Where in the run a record was taken, as a sentence fragment. */
export function replayWhen(record: TestReplay): string {
  return record.at === 'review' ? `before review round ${record.round + 1}` : `after review round ${record.round}`;
}

/**
 * One sentence about a replay, for the narration and the end of the run, so
 * the two cannot word the same fact differently. Null when nothing was run.
 *
 * Worded as what was observed - the earlier version fails a named gate against
 * the current code - and never as tampering, which it does not show.
 */
export function describeReplay(record: TestReplay): string | null {
  const c = replayCounts(record);
  if (c.preserved + c.earlierFails + c.unproven === 0) return null;
  const parts: string[] = [];
  const failing = record.files.filter((f) => f.verdict === 'earlier-fails');
  if (failing.length > 0) {
    parts.push(
      failing
        .map((f) => `\`${f.path}\`: its earliest committed version fails the \`${f.gate ?? '?'}\` gate against the current code`)
        .join('; '),
    );
  }
  parts.push(`${c.preserved} preserved (the earlier version still passes)`);
  if (c.unproven > 0) parts.push(`${c.unproven} unproven`);
  return `Replayed the earliest committed version of ${c.preserved + c.earlierFails + c.unproven} edited test(s) ${replayWhen(record)}: ${parts.join('; ')}.`;
}
