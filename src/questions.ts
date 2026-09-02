/**
 * Question identity, and the record of every time two wordings were treated as
 * one question (#65).
 *
 * Its own module because both `src/orchestrator.ts` (the re-ask guard) and
 * `src/cli.ts` (the `ASSUMED.md` report) need the same rule, and `orchestrator`
 * cannot import from `cli` - `cli` already imports `orchestrate`. Nothing here
 * imports either of them; `@src/run.js` is the deepest it reaches, so there is
 * no cycle.
 *
 * The metric itself moved to `src/similarity.ts` in #116 and is re-exported
 * below; the census that produced its threshold lives with it.
 *
 * The rule is exact-then-fuzzy, and the two halves are deliberately different in
 * what they cost:
 *
 * - An **exact** match (equal after `normalize`) is silent. That is what the
 *   guard has always done, and 80 of the 335 within-run question pairs measured
 *   over this repository's archive are exactly that case working.
 * - A **fuzzy** match is recorded - the wording, what it matched, the score -
 *   and written to `REPHRASED.md`. A false positive then costs a visible,
 *   checkable line rather than a silent omission, which is the whole reason a
 *   threshold measured over one corpus is acceptable at all.
 */
import * as log from '@src/log.js';
import { artifact, hasArtifact, removeArtifact, saveState } from '@src/run.js';
import { normalize, REPHRASE_THRESHOLD, similarity } from '@src/similarity.js';
import type { DeferredQuestion, ResolvedQuestion, RunState, SuppressedQuestion } from '@src/types.js';

/**
 * The metric, the threshold and the token rule live in `src/similarity.ts` since
 * #116, unchanged, because `src/run.ts` needs the same rule for finding identity
 * and cannot import this module - this one imports it. Re-exported here so every
 * existing import site is untouched, and so the census that produced the number
 * stays one document.
 */
export { normalize, REPHRASE_THRESHOLD, similarity };

/** The artifact both fuzzy decisions are recorded in. */
export const REPHRASED_FILE = 'REPHRASED.md';

/** The artifact the deferred questions are reported in. */
export const ASSUMED_FILE = 'ASSUMED.md';

/** The exact rule: what `answeredQuestions` has always keyed on. */
export function isSameQuestion(a: string, b: string): boolean {
  const key = normalize(a);
  return key !== '' && key === normalize(b);
}

export interface Rephrase {
  candidate: string;
  score: number;
}

/**
 * The closest candidate that is a *rephrasing* of `question`, or null.
 *
 * The contract, in order, because both callers depend on all of it:
 *
 *   1. If any candidate is an exact match, return null. An exact repeat has
 *      nothing fuzzy to report, and both callers handle exactness themselves -
 *      silently. This is what stops the two rules ever disagreeing about one
 *      question.
 *   2. Otherwise the highest-scoring candidate at or above `REPHRASE_THRESHOLD`.
 *   3. Ties resolve to the first such candidate, so the record is deterministic.
 *   4. The threshold is inclusive.
 *   5. An empty or whitespace-only question matches nothing.
 *
 * `normalize` is idempotent, so candidates may be normalized keys (the guard
 * passes `answeredQuestions`) or verbatim text (the report passes
 * `humanAnswered`).
 */
export function findRephrase(question: string, candidates: readonly string[]): Rephrase | null {
  if (normalize(question) === '') return null;
  let best: Rephrase | null = null;
  for (const candidate of candidates) {
    if (isSameQuestion(question, candidate)) return null;
    const score = similarity(question, candidate);
    if (score < REPHRASE_THRESHOLD) continue;
    if (best === null || score > best.score) best = { candidate, score };
  }
  return best;
}

// ---- the record ------------------------------------------------------------

const suppressions = (state: RunState): readonly SuppressedQuestion[] =>
  state.suppressedQuestions ?? [];
const resolutions = (state: RunState): readonly ResolvedQuestion[] => state.resolvedByHuman ?? [];

/** Two decimals: the score is a measurement, and this is where it is displayed. */
const pct = (score: number): string => score.toFixed(2);

/**
 * Rewrite `REPHRASED.md` from state, whole, or remove it when there is nothing
 * to say.
 *
 * Never appends. Every caller hands it the same state and gets the same file,
 * which is what lets a resume, a fork and a duplicate suppression all call it
 * without producing a doubled record.
 */
export function writeRephrased(state: RunState): string | null {
  const suppressed = suppressions(state);
  const resolved = resolutions(state);
  if (suppressed.length === 0 && resolved.length === 0) {
    removeArtifact(state, REPHRASED_FILE);
    return null;
  }

  const lines: string[] = [
    '# Questions treated as ones already asked\n',
    `**Run:** \`${state.id}\``,
    '',
    'Each pair below scored at or above ' +
      `${REPHRASE_THRESHOLD} on a similarity measured over every question this tool has asked in`,
    'this repository, so the run treated them as one question rather than asking twice.',
    '',
    '**If any pair here is not the same question, that is a defect worth reporting** - the',
    'run acted on the match, and this file is the only place it says so.\n',
  ];

  if (suppressed.length > 0) {
    lines.push('## Re-asks suppressed\n');
    lines.push('The planner asked these again in new words. They were not put to the answerer.\n');
    for (const [i, s] of suppressed.entries()) {
      lines.push(`### ${i + 1}. ${s.question}`);
      // The normalized key, because `answeredQuestions` only ever held that -
      // the earlier wording verbatim is not recoverable from it.
      lines.push(`*Matched (normalized):* ${s.matched}`);
      lines.push(`*Score:* ${pct(s.score)}\n`);
    }
  }

  if (resolved.length > 0) {
    lines.push('## Deferred questions your answer disposed of\n');
    lines.push(
      'These were left on the planner\'s default, and then you answered what the run judged to',
    );
    lines.push(`be the same question. They are not in ${ASSUMED_FILE}.\n`);
    for (const [i, r] of resolved.entries()) {
      lines.push(`### ${i + 1}. ${r.question}`);
      lines.push(`*You answered:* ${r.answered}`);
      lines.push(`*Score:* ${pct(r.score)}\n`);
    }
  }

  return artifact(state, REPHRASED_FILE, lines.join('\n'));
}

/**
 * Restore `REPHRASED.md` from persisted state.
 *
 * Here for the reason `reconcileFollowUps` exists: the state write and the
 * artifact write are two atomic operations, and a process killed between them
 * leaves the record in `state.json` with no file to read. A fork has the same
 * shape - the child inherits the checkpoint's state and none of the parent's
 * artifacts - and a forked run is always started by `vibe resume`, so this pass
 * is where it gets its copy.
 *
 * Returns before touching the filesystem when there is nothing recorded, so a
 * run that suppressed nothing is byte-identical to one built before this
 * existed.
 */
export function reconcileRephrased(state: RunState): void {
  if (suppressions(state).length === 0 && resolutions(state).length === 0) return;
  writeRephrased(state);
}

/**
 * Record a re-ask the guard suppressed, and publish it.
 *
 * The pair is the identity: the same wording matched against the same earlier
 * key is one decision however many rounds repeat it. "The same wording" by the
 * rule the guard itself uses - `isSameQuestion`, not raw equality. A planner
 * that re-asks its rephrasing with a comma moved has not made a second
 * decision, and recording it twice would put two lines in `REPHRASED.md` for
 * one suppression. The first verbatim wording is the one kept, because it is
 * the one the run acted on.
 *
 * The artifact is rewritten even when the pair is already recorded, so a file
 * lost to a kill is restored by the next suppression as well as by the next
 * resume.
 */
export function recordSuppressed(state: RunState, question: string, near: Rephrase): void {
  const known = suppressions(state).some(
    (s) => isSameQuestion(s.question, question) && isSameQuestion(s.matched, near.candidate),
  );
  if (!known) {
    state.suppressedQuestions = [
      ...suppressions(state),
      { question, matched: near.candidate, score: near.score },
    ];
    saveState(state);
  }
  writeRephrased(state);
}

// ---- ASSUMED.md ------------------------------------------------------------

export interface DeferredOutcome {
  /** Deferred questions no human answer disposed of - what `ASSUMED.md` says. */
  remaining: DeferredQuestion[];
  /** Every fuzzy disposal in force, whichever pass first found it. */
  resolved: ResolvedQuestion[];
  /**
   * The subset this call recorded for the first time, and warned about.
   *
   * The warning belongs to the moment the decision is taken, not to the end of
   * a run that may never come - so it is emitted here rather than by the
   * reporter, and a second pass over the same state stays quiet. A caller that
   * wants to say more about the disposals reads this rather than warning again.
   */
  announced: ResolvedQuestion[];
  /** Where `ASSUMED.md` was written, or null when there is none to write. */
  file: string | null;
}

/**
 * Reconcile the deferred questions against what a human actually answered, and
 * bring `ASSUMED.md` into line with the answer.
 *
 * Idempotent and driven entirely by persisted state, so it can run at any point
 * a resume reaches - which is the point. `humanAnswered` becomes durable in
 * `cmdResume` long before the loop finishes, and the paths that leave without
 * finishing (a preflight refusal, an escalation, a kill) used to leave an
 * `ASSUMED.md` still calling an answered question a guess.
 *
 * `create` is what preserves the existing contract that the file is *authored*
 * at the end of a successful run: without it this only repairs a file that is
 * already there, and never invents one mid-run.
 *
 * Matching is exact-then-fuzzy for the reason §4 of the brief gives: in the run
 * that motivated this the human answered the *fourth* wording of a question
 * whose first wording is the one sitting in `ASSUMED.md`.
 *
 * A fuzzy disposal is announced here, on the pass that first records it, and
 * that is deliberate. This runs before preflight and at the top of every
 * `orchestrate` pass; the run may then exit at the preflight gate or stop for
 * input and never reach the reporter, and an entry that left `ASSUMED.md` on
 * the strength of a similarity score must not be able to leave in silence.
 */
export function reconcileAssumed(
  state: RunState,
  options: { create?: boolean } = {},
): DeferredOutcome {
  const outcome: DeferredOutcome = { remaining: [], resolved: [], announced: [], file: null };
  if (state.deferredQuestions.length === 0) return outcome;

  const answered = state.humanAnswered ?? [];
  for (const q of state.deferredQuestions) {
    // Exact: unambiguous, and silent - the same rule the guard uses.
    if (answered.some((a) => isSameQuestion(a, q.question))) continue;
    const near = findRephrase(q.question, answered);
    if (near === null) {
      outcome.remaining.push(q);
      continue;
    }
    outcome.resolved.push({ question: q.question, answered: near.candidate, score: near.score });
  }

  // By question identity, not by raw text, for the reason `recordSuppressed`
  // dedupes that way: the same disposal reached through a differently
  // punctuated wording is still one disposal.
  const fresh = outcome.resolved.filter(
    (r) =>
      !resolutions(state).some(
        (s) => isSameQuestion(s.question, r.question) && isSameQuestion(s.answered, r.answered),
      ),
  );
  if (fresh.length > 0) {
    state.resolvedByHuman = [...resolutions(state), ...fresh];
    saveState(state);
    outcome.announced = fresh;
    for (const r of fresh) {
      // One line, carrying both wordings and the score: this is the whole
      // audit a human gets at the moment the entry leaves ASSUMED.md, and it
      // has to stand on its own wherever the run stops afterwards.
      log.warn(
        `Not calling this an assumption - you answered what the run judged to be the same ` +
          `question (${pct(r.score)}). Deferred: "${r.question}" / you answered: "${r.answered}". ` +
          `See ${REPHRASED_FILE}; if those are two different questions, that is a defect.`,
      );
    }
  }
  // Every disposal is auditable, not just the first pass that found it: the
  // entry is gone from ASSUMED.md and this file is where it says why.
  if (outcome.resolved.length > 0) writeRephrased(state);

  if (outcome.remaining.length === 0) {
    // A run that finished once may have written one before the answer existed.
    removeArtifact(state, ASSUMED_FILE);
    return outcome;
  }
  if (options.create === true || hasArtifact(state, ASSUMED_FILE)) {
    outcome.file = artifact(state, ASSUMED_FILE, renderAssumed(state, outcome.remaining));
  }
  return outcome;
}

function renderAssumed(state: RunState, remaining: readonly DeferredQuestion[]): string {
  const lines: string[] = [
    '# Questions answered by assumption\n',
    `**Run:** \`${state.id}\``,
    '',
    'Codex declined these and they were not blocking, so the run continued on the',
    "planner's fallback. Nothing is wrong with the run - but these are the points",
    'where the result rests on a guess rather than a decision.\n',
  ];
  for (const [i, q] of remaining.entries()) {
    lines.push(`### ${i + 1}. ${q.question}`);
    lines.push(`*Kind:* ${q.kind}`);
    lines.push(`*Proceeded with:* ${q.recommended}`);
    lines.push(`*Why Codex declined:* ${q.reason}\n`);
  }
  return lines.join('\n');
}

/**
 * The repair call, for every entry point that is not the end of a run.
 *
 * Silent unless something moved: a resume that changes nothing about the record
 * says nothing about it, and `reconcileAssumed` has already warned about
 * anything it disposed of.
 */
export function reconcileQuestionRecords(state: RunState): void {
  reconcileRephrased(state);
  const outcome = reconcileAssumed(state);
  if (outcome.announced.length > 0) {
    log.info(`  ${ASSUMED_FILE} now covers ${outcome.remaining.length} question(s).`);
  }
}
