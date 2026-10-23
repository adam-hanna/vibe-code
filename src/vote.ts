import type { RoleSetting } from '@src/roles.js';
import type { Ballot, Votes, VoteValue } from '@src/types.js';

/**
 * The review vote's tally (#388 Part C), pure and on its own so the whole truth
 * table can be tested without a run.
 *
 * ## Fail-closed, and why `cannot-tell` blocks
 *
 * The vote exists to stop a *wrong* blocker buying a fix round. It must never be
 * the thing that lets a *real* one through, so the burden is on the finding's
 * opponents, not on its supporters:
 *
 * - **confirmed** when `real >= q`;
 * - **unconfirmed** only when `notReal > n - q` - the quorum could not have been
 *   reached even if every `cannot-tell` had been `real`;
 * - **undecided** otherwise, and an undecided finding keeps its severity.
 *
 * A verifier that could not tell, a turn that failed, and a `not-real` that
 * pointed at nothing all count the same way: as not having voted against. Too
 * few usable votes therefore leaves a finding blocking, never releases it.
 */

/** The quorum this vote is held to: the configured one, or a majority of `n`. */
export function quorumFor(n: number, quorum: number | null): number {
  return quorum ?? Math.floor(n / 2) + 1;
}

/**
 * How a cast vote is counted.
 *
 * `unresolved` is null when the vote's evidence resolved, otherwise the reason
 * it did not. A `not-real` must point at something, as the finding had to (#48):
 * one that points at nothing is counted as `cannot-tell`, and the record keeps
 * both the vote as cast and why it was counted otherwise. A `real` vote needs no
 * evidence of its own - agreeing with the claim's evidence is enough.
 */
export function countBallot(
  cast: VoteValue,
  unresolved: string | null,
): { counted: VoteValue; countedReason?: string } {
  if (cast === 'not-real' && unresolved !== null) {
    return { counted: 'cannot-tell', countedReason: `its evidence resolved to nothing: ${unresolved}` };
  }
  return { counted: cast };
}

/** The ballot of a verifier whose turn failed: nothing was cast, so it cannot count against. */
export function failedBallot(entry: { path: string; setting: RoleSetting }, err: unknown): Ballot {
  const message = err instanceof Error ? err.message : String(err);
  return {
    seat: entry.path,
    provider: entry.setting.provider,
    model: entry.setting.model ?? 'default',
    vote: 'cannot-tell',
    counted: 'cannot-tell',
    reason: `the turn failed: ${message.split(/\r?\n/)[0] ?? ''}`,
    evidence: [],
  };
}

/** Count the ballots on one finding, by how each was counted. */
export function tally(ballots: readonly Ballot[], quorum: number | null): Votes {
  const n = ballots.length;
  const q = quorumFor(n, quorum);
  const real = ballots.filter((b) => b.counted === 'real').length;
  const notReal = ballots.filter((b) => b.counted === 'not-real').length;
  const cannotTell = n - real - notReal;
  const outcome: Votes['outcome'] = real >= q ? 'confirmed' : notReal > n - q ? 'unconfirmed' : 'undecided';
  return { quorum: q, n, real, notReal, cannotTell, outcome, ballots: [...ballots] };
}

/** The reason an unconfirmed finding was moved, naming the tally. */
export function tallyReason(v: Votes): string {
  return (
    `unconfirmed by vote: ${v.real} real, ${v.notReal} not-real, ${v.cannotTell} cannot-tell ` +
    `of ${v.n} (quorum ${v.quorum})`
  );
}

/** The vote as NEEDS-INPUT.md shows it: the tally, then one line per ballot. */
export function describeVotes(v: Votes): string[] {
  return [
    `*Vote:* ${v.real} real, ${v.notReal} not-real, ${v.cannotTell} cannot-tell of ${v.n} ` +
      `(quorum ${v.quorum}) - ${v.outcome}`,
    ...v.ballots.map((b) => {
      const counted =
        b.counted === b.vote ? '' : ` (counted as ${b.counted}${b.countedReason === undefined ? '' : ` - ${b.countedReason}`})`;
      return `- \`${b.seat}\` (${b.provider}/${b.model}): ${b.vote}${counted} - ${b.reason}`;
    }),
  ];
}

/**
 * The counts of a recorded vote, or null when they cannot be read (#436).
 *
 * `votes` rides through stored state unvalidated, so the end-of-run summary
 * reads it here rather than trusting the type. Fail closed: a count that is not
 * a whole number, counts that do not add up to `n`, or ballots that do not
 * agree with the counts all make the record unreadable, and the summary says
 * so instead of printing a number it would have had to choose between.
 */
export function readTally(
  raw: unknown,
): { n: number; quorum: number; real: number; notReal: number; cannotTell: number } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const count = (key: string): number | null => {
    const x = v[key];
    return typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : null;
  };
  const n = count('n');
  const quorum = count('quorum');
  const real = count('real');
  const notReal = count('notReal');
  const cannotTell = count('cannotTell');
  if (n === null || quorum === null || real === null || notReal === null || cannotTell === null) return null;
  if (n === 0 || real + notReal + cannotTell !== n) return null;
  const ballots = v['ballots'];
  if (!Array.isArray(ballots) || ballots.length !== n) return null;
  const counted = (value: VoteValue): number =>
    ballots.filter((b: unknown) => typeof b === 'object' && b !== null && (b as Record<string, unknown>)['counted'] === value)
      .length;
  if (counted('real') !== real || counted('not-real') !== notReal || counted('cannot-tell') !== cannotTell) return null;
  return { n, quorum, real, notReal, cannotTell };
}
