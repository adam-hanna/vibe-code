import { needsKey } from './backend';
import type { Backend } from './backend';

/**
 * How hard the pilot thinks, picked beside its model (#296).
 *
 * The CLIs' own list, the one a run's seat takes (`EFFORTS` in `src/types.ts`),
 * copied rather than imported because the app and the core are two packages -
 * and pinned to it by `effort.test.ts`, which reads that file as source and
 * fails on the commit that lets the two drift. `default` sends nothing, so the
 * CLI picks, which is what `model: "default"` already means for the model.
 */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const DEFAULT_EFFORT = 'default';

/**
 * What a turn sends for the effort picked, or undefined to send nothing.
 *
 * **Only the subscription roads take one.** They are `claude --effort` and
 * Codex's `model_reasoning_effort`, the flags a run already uses. The API roads
 * would each need a request field of their own, and a field nobody has checked
 * against a vendor is a turn that fails with a 400 after a person pressed send -
 * so there the control says it does not apply rather than sending a guess.
 */
export function effortToSend(backend: Backend, picked: string): string | undefined {
  if (needsKey(backend)) return undefined;
  return (EFFORTS as readonly string[]).includes(picked) ? picked : undefined;
}

/** The turn's `effort` field, present only when there is one to send. */
export function withEffort(effort: string | undefined): { effort: string } | Record<string, never> {
  return effort === undefined ? {} : { effort };
}

/** Why the control is off, or null when it is on. */
export function effortOff(backend: Backend): string | null {
  return needsKey(backend)
    ? 'Effort is set only when the pilot runs on a subscription CLI; an API key turn sends none.'
    : null;
}
