import type { RunSummary } from '@src/types.js';

/**
 * The arguments `tests/fixtures/prompts/plan-no-runs.txt` was generated from.
 *
 * Here, and imported by BOTH the generator and the assertion, for the reason
 * `prompt-fixture-args.ts` gives: a fixture generated with one tuple and
 * asserted against another proves nothing at all, and the bar #52 was accepted
 * against - "a repo with no prior runs renders a planning prompt byte-identical
 * to develop's" - would pass on a coincidence.
 *
 * This module imports nothing but a type, deliberately: generating the fixture
 * means compiling it inside a checkout of the commit being frozen, where
 * nothing else in this directory exists yet.
 *
 * Everything is a fixed literal. Nothing time-dependent, nothing
 * path-dependent, and `environment` is passed as `null` at the call site, so
 * the same call on any machine produces the same bytes.
 */
export const TASK = '# Widget\n\nReturn the new string instead of the old one.';

export const EXTRA_CONTEXT = 'The widget module is under src/.';

/** A listing row, with only the fields a case cares about spelled out. */
export function summary(over: Partial<RunSummary> & { id: string }): RunSummary {
  return { status: 'done', task: '', costUsd: 0, ...over };
}
