import type {
  DispositionSeat,
  Finding,
  FindingAuthor,
  FindingDisposition,
  FixDispositions,
  PlanDispositions,
  ReviewSeat,
  VoteOutcome,
} from '@src/types.js';
import type { SaidDisposition } from '@src/validate.js';
import { authorOf, reproductionAt } from '@src/validate.js';
import { readTally } from '@src/vote.js';

/**
 * What a review fix round's fixer said it did with each finding, joined onto
 * the findings it was shown (#393).
 *
 * Pure: the orchestrator parses the turn, hands the result here, and writes
 * what comes back as `fix-dispositions-<n>.json` and the `fix_dispositions`
 * event. Nothing here decides whether the output was readable - an unreadable
 * output never reaches this function, because a round whose answer could not be
 * read records nothing at all rather than a list of findings nobody addressed.
 *
 * ## Missing is a fact; unreadable is not
 *
 * A finding the fixer's *readable* answer leaves out is recorded
 * `not-addressed`: the fixer answered and did not mention it, which is a real
 * thing that happened. An id the fixer gave that it was never shown is dropped,
 * and a repeated id keeps its first answer. Both are named back to the caller
 * so the narration can say so.
 */
export function settleDispositions(
  findings: readonly Finding[],
  said: readonly SaidDisposition[],
  ctx: { round: number; label: string; answers: number; reviewSeat: ReviewSeat | undefined },
): FixDispositions {
  const { dispositions, dropped, duplicates } = settle(findings, said, {
    author: 'reviewer',
    seat: 'roles.reviewer',
    stamp: ctx.reviewSeat,
    answers: ctx.answers,
    reproducerAt: 'review',
  });
  return { round: ctx.round, label: ctx.label, answers: ctx.answers, dispositions, dropped, duplicates };
}

/**
 * What a findings revision's planner said it did with each critique finding,
 * joined onto the findings it was shown (#453). The same join as
 * `settleDispositions`, credited to the critic, with each finding's vote
 * outcome beside it and no reproducer: nothing reproduces a plan finding, and
 * a review-phase observation is never read as one.
 */
export function settlePlanDispositions(
  findings: readonly Finding[],
  said: readonly SaidDisposition[],
  ctx: { round: number; label: string; answers: number; criticSeat: ReviewSeat | undefined },
): PlanDispositions {
  const { dispositions, dropped, duplicates } = settle(findings, said, {
    author: 'critic',
    seat: 'roles.critic',
    stamp: ctx.criticSeat,
    answers: ctx.answers,
    reproducerAt: null,
  });
  return {
    round: ctx.round,
    label: ctx.label,
    answers: ctx.answers,
    dispositions: dispositions.map((d, i) => {
      const f = findings[i];
      return { ...d, vote: f === undefined ? null : voteOutcomeOf(f) };
    }),
    dropped,
    duplicates,
  };
}

/**
 * Whose stamp a finding with no `foundBy` falls back to, and which moment's
 * reproducer rides along. The review passes the reviewer and `review`; the
 * critique passes the critic and nothing.
 */
interface Credit {
  author: FindingAuthor;
  seat: string;
  stamp: ReviewSeat | undefined;
  answers: number;
  reproducerAt: 'review' | null;
}

function settle(
  findings: readonly Finding[],
  said: readonly SaidDisposition[],
  credit: Credit,
): { dispositions: FindingDisposition[]; dropped: string[]; duplicates: string[] } {
  const shown = new Set(findings.map((f) => f.id));
  const answered = new Map<string, SaidDisposition>();
  const dropped: string[] = [];
  const duplicates: string[] = [];
  for (const d of said) {
    if (!shown.has(d.id)) dropped.push(d.id);
    else if (answered.has(d.id)) duplicates.push(d.id);
    else answered.set(d.id, d);
  }
  const dispositions = findings.map((f): FindingDisposition => {
    const d = answered.get(f.id);
    return {
      id: f.id,
      severity: f.severity,
      raisedBy: authorOf(f),
      disposition: d?.disposition ?? 'not-addressed',
      reason: d?.reason ?? '',
      seats: seatsOf(f, credit),
      reproducer: credit.reproducerAt === null ? null : (reproductionAt(f, credit.reproducerAt)?.verdict ?? null),
    };
  });
  return { dispositions, dropped, duplicates };
}

/**
 * A finding's vote outcome, or null when it was not voted on or its vote cannot
 * be read (#453). The stored outcome is taken as it is, never recounted from
 * the ballots, and only once `readTally` accepts the record it sits in.
 */
function voteOutcomeOf(f: Finding): VoteOutcome | null {
  const raw: unknown = f.votes;
  if (readTally(raw) === null) return null;
  const outcome = (raw as Record<string, unknown>)['outcome'];
  return outcome === 'confirmed' || outcome === 'unconfirmed' || outcome === 'undecided' ? outcome : null;
}

/**
 * The seats credited with a finding, or null when none can be established.
 *
 * Every seat in `foundBy` when a round seated additional finders (#388 Part B,
 * #405) - a finding two finders raised is credited to both. Otherwise the seat
 * that took that round's own turn, read from the stamp the phase wrote when the
 * round was recorded (`reviewSeat` for a review, `criticSeat` for a critique),
 * and only when the stamp is for the round being answered: a resume can move
 * the role between the round and its answer, and crediting today's seat would
 * credit a model that never looked.
 *
 * Only the phase's own author falls back to the stamp. A person's (#141) or
 * vibe's own finding was never raised by the seat, so it is credited to nobody.
 */
function seatsOf(f: Finding, credit: Credit): DispositionSeat[] | null {
  // `foundBy` rides through `readFinding` unvalidated, so each entry is checked
  // here rather than trusted.
  const raw: unknown = f.foundBy;
  if (Array.isArray(raw) && raw.length > 0) {
    const seats: DispositionSeat[] = [];
    for (const entry of raw as unknown[]) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const { seat, provider, model } = e;
      if (typeof seat !== 'string' || typeof provider !== 'string' || typeof model !== 'string') continue;
      seats.push({ seat, provider, model });
    }
    return seats.length > 0 ? seats : null;
  }
  const { stamp } = credit;
  if (authorOf(f) !== credit.author || stamp === undefined || stamp.round !== credit.answers) return null;
  return [{ seat: credit.seat, provider: stamp.provider, model: stamp.model }];
}

/**
 * The narration for a recorded round: every count beside the others and the
 * total, so a rebuttal count never reads alone, and the ids that were dropped
 * or repeated named rather than merely counted.
 */
export function dispositionSummary(d: FixDispositions | PlanDispositions, who: 'fixer' | 'planner' = 'fixer'): string {
  const list: readonly FindingDisposition[] = d.dispositions;
  const count = (k: FindingDisposition['disposition']): number => list.filter((x) => x.disposition === k).length;
  let line =
    `${d.label}: ${String(count('fixed'))} fixed, ${String(count('rebutted'))} rebutted by the ${who}, ` +
    `${String(count('deferred'))} deferred, ${String(count('not-addressed'))} not addressed, ` +
    `of ${String(list.length)}`;
  if (d.dropped.length > 0) line += `; ignored ids not in the prompt: ${d.dropped.join(', ')}`;
  if (d.duplicates.length > 0) line += `; duplicate ids, first kept: ${d.duplicates.join(', ')}`;
  return line;
}
