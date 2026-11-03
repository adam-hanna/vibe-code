/**
 * What a run decided without the person running it, in one place (#487).
 *
 * The planner's declared assumptions, the answers a model gave to the planner's
 * questions, the questions left on the planner's own default, and the plan
 * critique's P1s carried into implementation. Each already lived somewhere -
 * `plan.assumptions`, `answers-<n>.json`, `state.deferredQuestions`,
 * `state.carried` - and none of them was where a person approving the plan, or
 * an implementer that does not share the planner's conversation, would look.
 *
 * Two renderings from one set of items, so the two cannot drift:
 *
 * - `decidedSections`, PLAN.md's `## Assumptions` and `## Decided without you`,
 *   appended by `renderPlanDoc` for the callers that pass decisions;
 * - `renderDecisions`, DECISIONS.md, the same four lists one section each.
 *
 * The reasoning (He et al., CHI 2025): a person shown a plausible long plan is
 * misled by it, and editing one that is already good makes it worse, so the
 * useful thing to put in front of them is a short list of specific guesses to
 * accept or reject.
 *
 * vibe never reads DECISIONS.md back. Every planner or model string goes
 * through `inert`, as ASSUMED.md's assumption block does, so nothing written
 * here can begin a line of its own.
 */
import { inert, isSameQuestion } from '@src/questions.js';
import { artifact } from '@src/run.js';
import type {
  Assumption,
  DeferredQuestion,
  Finding,
  ModelAnswer,
  Plan,
  RunState,
} from '@src/types.js';

export const DECISIONS_FILE = 'DECISIONS.md';

/** The headings PLAN.md gains, spelled once: the hold card points at them. */
export const ASSUMPTIONS_SECTION = '## Assumptions';
export const DECIDED_SECTION = '## Decided without you';

const NOT_RECORDED = 'Not recorded for this run.';

export interface PlanDecisions {
  assumptions: readonly Assumption[];
  /** `undefined`: not recorded for this run - never rendered as none. */
  modelAnswers: readonly ModelAnswer[] | undefined;
  defaults: readonly DeferredQuestion[];
  carried: readonly Finding[];
}

/**
 * The decisions of record for this run and this plan.
 *
 * Model answers absent from a state that never ran a question round are none,
 * not unrecorded: no model could have answered anything, so "none" is a fact
 * for a state from before #487 too. Past round 0 an absent field stays absent.
 *
 * The defaults leave out any a person settled, by the two rules
 * `reconcileAssumed` uses - an exact match against what they answered, or a
 * disposal it already recorded - and without its side effects. A decision the
 * person made is not one made without them.
 *
 * The model answers leave out any the person answered too, by the first rule.
 * A `question-round` stop hands back every question of the round, including
 * the ones the answerer already answered, and on resume the person's answer
 * wins (`mergeHumanAnswers`) - so the revised plan follows theirs, and listing
 * the model's would tell an implementer the superseded one. A missing record
 * stays missing.
 */
export function planDecisions(state: RunState, plan: Plan): PlanDecisions {
  const answered = state.humanAnswered ?? [];
  const resolved = state.resolvedByHuman ?? [];
  const defaults = state.deferredQuestions.filter(
    (q) =>
      !answered.some((a) => isSameQuestion(a, q.question)) &&
      !resolved.some((r) => isSameQuestion(r.question, q.question)),
  );
  const recorded = state.modelAnswers ?? (state.questionRound === 0 ? [] : undefined);
  return {
    assumptions: plan.assumptions,
    modelAnswers: recorded?.filter((m) => !answered.some((a) => isSameQuestion(a, m.question))),
    defaults,
    carried: state.carried ?? [],
  };
}

function assumptionItems(items: readonly Assumption[]): string {
  return items
    .map(
      (a, i) =>
        `${i + 1}. **${inert(a.assumption)}**\n   - Why: ${inert(a.why)}\n   - If wrong: ${inert(a.blast_radius)}`,
    )
    .join('\n');
}

function answerItems(items: readonly ModelAnswer[]): string {
  return items
    .map((a, i) => {
      const rationale = inert(a.rationale);
      return (
        `${i + 1}. ${inert(a.question)}\n` +
        `   - Answer: ${inert(a.answer)}\n` +
        `   - Confidence: ${a.confidence}${rationale === '' ? '' : ` - ${rationale}`} (question round ${a.round})`
      );
    })
    .join('\n');
}

function defaultItems(items: readonly DeferredQuestion[]): string {
  return items
    .map((q, i) => `${i + 1}. ${inert(q.question)}\n   - Default used: ${inert(q.recommended)}`)
    .join('\n');
}

function carriedItems(items: readonly Finding[]): string {
  return items.map((f) => `- ${inert(f.title)} \`${inert(f.id)}\``).join('\n');
}

const answersOrNone = (d: PlanDecisions): string =>
  d.modelAnswers === undefined
    ? NOT_RECORDED
    : d.modelAnswers.length === 0
      ? 'None.'
      : answerItems(d.modelAnswers);
const listOrNone = (count: number, rendered: () => string): string =>
  count === 0 ? 'None.' : rendered();

/**
 * PLAN.md's two sections, starting with a newline so they append after the
 * acceptance section.
 *
 * "Decided without you" collapses to one line only when every list is known to
 * be empty. An unrecorded model-answer list always shows the three groups, so
 * the one-line form can never print "nothing" over a record that is missing.
 */
export function decidedSections(d: PlanDecisions): string {
  const assumptions =
    d.assumptions.length === 0
      ? '(the planner declared no material unresolved assumptions)'
      : assumptionItems(d.assumptions);
  const nothing =
    d.modelAnswers !== undefined &&
    d.modelAnswers.length === 0 &&
    d.defaults.length === 0 &&
    d.carried.length === 0;
  const decided = nothing
    ? "(nothing - no question was answered by a model or left on the planner's default, and no plan critique finding was carried into implementation)"
    : [
        `**Answered by a model**\n\n${answersOrNone(d)}`,
        `**Left on the planner's default**\n\n${listOrNone(d.defaults.length, () => defaultItems(d.defaults))}`,
        `**Carried into implementation**\n\n${listOrNone(d.carried.length, () => carriedItems(d.carried))}`,
      ].join('\n\n');
  return `\n${ASSUMPTIONS_SECTION}\n\n${assumptions}\n\n${DECIDED_SECTION}\n\n${decided}\n`;
}

/**
 * The block a memoryless implementer turn is handed beside its own prompt.
 *
 * Every writer prompt restates `plan_md` and nothing else of the record, so
 * `freshConversationPrefix` withholds the plan of record from them - and with
 * it, before this, the decisions. This is the part of the record no writer
 * prompt restates.
 */
export function decisionsPrefix(d: PlanDecisions): string {
  return `## Decisions the approved plan carries

The plan in this turn's prompt was approved with these. They are part of the plan of record, and your conversation does not carry them.
${decidedSections(d)}
---

`;
}

/** DECISIONS.md: the same four lists, one section each. */
export function renderDecisions(state: RunState, d: PlanDecisions): string {
  return [
    '# Decisions made without you\n',
    `**Run:** \`${state.id}\``,
    '',
    "What this run's plan rests on that nobody asked you about: the planner's",
    'assumptions, the answers a model gave to its questions, the questions left on',
    "the planner's default, and the plan critique findings carried into",
    'implementation. Written beside PLAN.md, which lists the same under',
    `\`${ASSUMPTIONS_SECTION}\` and \`${DECIDED_SECTION}\`. vibe never reads this file back.\n`,
    `${ASSUMPTIONS_SECTION}\n`,
    `${listOrNone(d.assumptions.length, () => assumptionItems(d.assumptions))}\n`,
    '## Answered by a model\n',
    `${answersOrNone(d)}\n`,
    "## Left on the planner's default\n",
    `${listOrNone(d.defaults.length, () => defaultItems(d.defaults))}\n`,
    '## Carried into implementation\n',
    `${listOrNone(d.carried.length, () => carriedItems(d.carried))}\n`,
  ].join('\n');
}

/** Write DECISIONS.md for this plan, from this state. */
export function writeDecisions(state: RunState, plan: Plan): string {
  return artifact(state, DECISIONS_FILE, renderDecisions(state, planDecisions(state, plan)));
}
