import type { CheckpointBoundary, GateMode, GateableBoundary, GatesConfig } from '@src/types.js';

/**
 * Which boundaries can hold a run, what a hold costs, and how to say so.
 *
 * A leaf, for the reason `@src/host.js`, `@src/charge.js` and `@src/roles.js`
 * are leaves: `config.ts` has to validate this table and `orchestrator.ts` has
 * to consult it, and neither may import the other. It imports types and nothing
 * else.
 *
 * `host.ts` is the neighbouring half and the split is worth stating: **this
 * module decides whether the loop holds, `host.ts` decides what an answer
 * means.** A boundary set to `auto` never reaches a host at all, and a host that
 * answers nonsense is `host.ts`'s problem rather than this one's.
 */

/** Order is the loop's, not the alphabet's - it is what `describeGates` prints. */
export const GATEABLE: readonly GateableBoundary[] = [
  'plan-round',
  'question-round',
  'plan-approved',
  'implemented',
  'verify-round',
  'review-round',
];

export const GATE_MODES: readonly GateMode[] = ['auto', 'step', 'stop'];

/**
 * The two boundaries with no row, and why each one has none.
 *
 * Two different reasons, so two different messages: telling someone who wrote
 * `"final-fix": "stop"` that it is "not a boundary" would be false - it is one,
 * and it is the *only* thing that changed about it here. `GateableBoundary`
 * already makes this unrepresentable in TypeScript; a `vibe.config.json` is not
 * TypeScript, and it is the one that has a person behind it.
 *
 * Worth being explicit that `consistency.ts` would NOT have caught a gate at
 * `complete`: `needs-input` is in `COMPLETION_STATUSES`, precisely because W8
 * may overwrite a terminal status without touching the phase, so `needs-input`
 * beside `phase: 'complete'` is a legal stored state and the guard would pass
 * it. These are decisions about what a gate MEANS, not constraints the
 * validators impose - which is why they have to be written down somewhere.
 */
export const UNGATEABLE: Readonly<Record<Exclude<CheckpointBoundary, GateableBoundary>, string>> = {
  'final-fix':
    'the loop goes straight back to the verification gate so it can prove the final fix broke ' +
    'nothing, so holding here is the same decision made with less information - and it turns a ' +
    'run that was one gate from finished into one reporting that it needs you',
  complete:
    'a gate holds before the next thing, and there is no next thing here - the plan is approved ' +
    'or it is not, the code is written, the review is finished',
};

/**
 * Where a run hands control back when nobody has said otherwise.
 *
 * This was every row `step` - what the loop did before there was a table - and
 * the comment here said in as many words that it was *"very probably not the
 * default anyone wants to keep"*, deferred to *"whoever has the settings screen
 * in front of them"*. #211 is that person, and the report is the one the old
 * comment predicted: **"remove the holding at the end of a plan round. We should
 * only do that if I choose to."**
 *
 * ## The line the two halves fall on
 *
 * The six boundaries are not one kind of decision, and grouping them as one is
 * what made the old default wrong rather than merely strict.
 *
 * **The planning ones are steps in an argument the loop is having with itself.**
 * A plan round is the planner rewriting the plan because the critic objected or
 * a question came back; a question round is the answerer taking its turn. Both
 * are followed by another machine looking at the result - the critic reads every
 * plan revision, which is the whole point of the phase. Holding there asks a
 * person to referee a draft that is *about* to be refereed, on every round of
 * every run. Nothing has been written, nothing has been committed, and the run
 * is minutes from producing the thing actually worth reading.
 *
 * **The other four are the moments the run's cost or its output changes hands.**
 * `plan-approved` is the last gate before code is written and committed;
 * `implemented` is the first sight of a diff; `verify-round` is a gate that
 * failed; `review-round` is a reviewer's findings and the fix turn they buy.
 * Each is a decision a person would want to be asked about, and each happens
 * once or a small number of times.
 *
 * So the planning pair defaults to `auto` and the other four keep `step`. That
 * is a **default**, not a rule: `vibe.config.json` still decides, `--gate`
 * still overrides, and the Settings matrix shows which rows are in force and
 * which are merely observed. Somebody who wants to referee every plan round can
 * still ask to.
 *
 * ## What this changes, said plainly
 *
 * A run in the app with no configuration now stops in four places rather than
 * six. That is a behaviour change for anyone relying on the default, which is
 * why it is a release note and not a quiet edit - and it is why the two rows
 * that moved are the two where nothing irreversible happens on either side of
 * the boundary.
 */
export const DEFAULT_GATES: GatesConfig = {
  // The two the loop settles with another turn. See above.
  'plan-round': 'auto',
  'question-round': 'auto',
  // The four where the run's cost or its output changes hands.
  'plan-approved': 'step',
  implemented: 'step',
  'verify-round': 'step',
  'review-round': 'step',
};

function isGateable(boundary: CheckpointBoundary): boundary is GateableBoundary {
  return (GATEABLE as readonly string[]).includes(boundary);
}

/**
 * What this run does at this boundary.
 *
 * `auto` for anything without a row, so a caller may pass any `CheckpointBoundary`
 * and does not have to hold a second copy of which ones are gateable.
 *
 * **Unrecognised reads as `auto`, and that direction is deliberate.** By the time
 * the loop is running, `validateGates` has already refused every value that is
 * not a mode - this is defence in depth over `state.config`, the one field
 * `validateStoredState` passes through unchecked. Pointing it at `auto` rather
 * than at a halt follows `readOrigin` rather than `readDecision`: a *setting*
 * nobody could parse is not an instruction, and halting a run over a typo in a
 * config file would present a spelling mistake as a stall.
 */
export function gateMode(gates: GatesConfig, boundary: CheckpointBoundary): GateMode {
  if (!isGateable(boundary)) return 'auto';
  const mode: unknown = gates[boundary];
  return GATE_MODES.includes(mode as GateMode) ? (mode as GateMode) : 'auto';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Refuse a bad table by name, in the vocabulary the file was written in.
 *
 * Deliberately strict about *keys* as well as values, unlike every ordinary
 * section: `mergeSection` iterates the base's keys and drops the rest, which is
 * the right answer for a typo in a setting nobody would miss and the wrong one
 * here. Someone who wrote `"final_fix": "stop"` and got silence would believe
 * they had armed a gate, and would find out by watching a run go past it.
 */
export function validateGates(raw: unknown): void {
  if (!isRecord(raw)) throw new Error('gates must be an object of boundary: mode');
  for (const [key, value] of Object.entries(raw)) {
    if (!(GATEABLE as readonly string[]).includes(key)) {
      const why = (UNGATEABLE as Record<string, string | undefined>)[key];
      throw new Error(
        why === undefined
          ? `gates.${key} is not a boundary - the ones that take a mode are ${GATEABLE.join(', ')}`
          : `gates.${key} cannot be gated: ${why}`,
      );
    }
    if (!GATE_MODES.includes(value as GateMode)) {
      throw new Error(
        `gates.${key} must be one of ${GATE_MODES.join(', ')}, not ${JSON.stringify(value)}`,
      );
    }
  }
  for (const boundary of GATEABLE) {
    if (!(boundary in raw)) throw new Error(`gates.${boundary} is missing`);
  }
}

/**
 * The effective table in words, for `vibe doctor`.
 *
 * Grouped by mode rather than printed one row per line: six lines of `auto` is
 * six lines of nothing happening, and the question a reader has is "which of
 * these will stop me". The `step` caveat is printed **beside the rows it applies
 * to** rather than as a footnote, because a `step` row is the one setting in
 * this table that does nothing from a terminal, and the only way to find that
 * out otherwise is to run and not notice.
 */
export function describeGates(gates: GatesConfig): string[] {
  const by = (mode: GateMode): GateableBoundary[] => GATEABLE.filter((b) => gateMode(gates, b) === mode);
  const stop = by('stop');
  const step = by('step');
  const out: string[] = [];
  if (stop.length > 0) {
    out.push(`gates: stop at ${stop.join(', ')} - the run ends there and \`vibe resume\` continues it`);
  }
  if (step.length > 0) {
    out.push(
      `gates: step at ${step.join(', ')} - held only where a host can answer, so a run from ` +
        'this terminal goes straight through; use stop for a halt you can resume',
    );
  }
  if (out.length === 0) out.push('gates: none - every boundary runs through');
  return out;
}
