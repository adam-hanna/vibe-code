import type {
  DispositionSeat,
  Finding,
  FindingDisposition,
  FixDispositions,
  ReviewSeat,
} from '@src/types.js';
import type { FixOutput } from '@src/validate.js';
import { authorOf, reproductionAt } from '@src/validate.js';

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
  said: FixOutput['dispositions'],
  ctx: { round: number; label: string; answers: number; reviewSeat: ReviewSeat | undefined },
): FixDispositions {
  const shown = new Set(findings.map((f) => f.id));
  const answered = new Map<string, FixOutput['dispositions'][number]>();
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
      seats: seatsOf(f, ctx.answers, ctx.reviewSeat),
      reproducer: reproductionAt(f, 'review')?.verdict ?? null,
    };
  });
  return { round: ctx.round, label: ctx.label, answers: ctx.answers, dispositions, dropped, duplicates };
}

/**
 * The seats credited with a finding, or null when none can be established.
 *
 * Every seat in `foundBy` when a round seated additional finders (#388 Part B)
 * - a finding two finders raised is credited to both. Otherwise the seat that
 * took that review round's own turn, read from the stamp `reviewPhase` wrote
 * when the round was recorded, and only when the stamp is for the round this
 * fix answers: a resume can move `roles.reviewer` between the review and the
 * fix, and crediting today's seat would credit a model that never looked.
 *
 * Only a reviewer's finding falls back to the stamp. A person's (#141) or
 * vibe's own was never raised by the seat, so it is credited to nobody.
 */
function seatsOf(
  f: Finding,
  answers: number,
  stamp: ReviewSeat | undefined,
): DispositionSeat[] | null {
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
  if (authorOf(f) !== 'reviewer' || stamp === undefined || stamp.round !== answers) return null;
  return [{ seat: 'roles.reviewer', provider: stamp.provider, model: stamp.model }];
}

/**
 * The narration for a recorded round: every count beside the others and the
 * total, so a rebuttal count never reads alone, and the ids that were dropped
 * or repeated named rather than merely counted.
 */
export function dispositionSummary(d: FixDispositions): string {
  const count = (k: FindingDisposition['disposition']): number =>
    d.dispositions.filter((x) => x.disposition === k).length;
  let line =
    `${d.label}: ${String(count('fixed'))} fixed, ${String(count('rebutted'))} rebutted by the fixer, ` +
    `${String(count('deferred'))} deferred, ${String(count('not-addressed'))} not addressed, ` +
    `of ${String(d.dispositions.length)}`;
  if (d.dropped.length > 0) line += `; ignored ids not in the prompt: ${d.dropped.join(', ')}`;
  if (d.duplicates.length > 0) line += `; duplicate ids, first kept: ${d.duplicates.join(', ')}`;
  return line;
}
