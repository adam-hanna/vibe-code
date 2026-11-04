import type { ClaudeTurnOptions } from '@src/claude.js';
import type { CodexTurnOptions } from '@src/codex.js';
import { DEFAULTS } from '@src/config.js';
import * as log from '@src/log.js';
import { orchestrate } from '@src/orchestrator.js';
import type { Config, Evidence, Finding, RunState } from '@src/types.js';
import { agents, config, p1, planFixture, report, work } from './loop-harness.js';

/**
 * The loop driven through several review rounds, for the findings ledger
 * (#498): every turn's label, prompt and response schema, as each provider was
 * handed them. Shared by `findings-ledger-off.test.ts`, `findings-ledger.test.ts`
 * and `prior-id.test.ts`, which is why it is here and not in one of them.
 */

export interface Turn {
  label: string;
  prompt: string;
  schema: object | undefined;
}

/** What a review turn returns, by its label: `review-<n>`, `review-<n>-f<k>`, `-part<i>`. */
export type Review = (label: string) => object;

/** A citation of a real line of the harness's fixture file, so a P1 stays blocking. */
export const AT: Evidence = { kind: 'code', path: 'implemented.ts', line: 1 };

export const cited = (id: string, over: Partial<Finding> = {}): Finding => ({ ...p1(id), evidence: [AT], ...over });

/**
 * Rounds 1 and 2 block, under new ids so the repeat guard never fires; round 3
 * approves, so the run ends after three review rounds.
 */
export const threeRounds: Review = (label) => {
  if (label.startsWith('review-0')) return report([cited('first-defect')]);
  if (label.startsWith('review-1')) return report([cited('second-defect')]);
  return report([]);
};

/** No carried P1, one Claude finder beside the Codex reviewer, and the ledger as asked. */
export function threeRoundConfig(findingsLedger: boolean, over: Partial<Config> = {}): Config {
  return config(
    { p1Tolerance: 0, findingsLedger },
    { review: { ...DEFAULTS.review, finders: ['claude'] }, ...over },
  );
}

export async function driveReview(
  state: RunState,
  cfg: Config,
  review: Review = threeRounds,
  resume = true,
): Promise<{ turns: Turn[]; calls: string[] }> {
  const turns: Turn[] = [];
  const calls: string[] = [];
  const handlers = {
    claude: (label: string, options: ClaudeTurnOptions): unknown => {
      turns.push({ label, prompt: options.prompt, schema: options.jsonSchema });
      if (label === 'plan' || label.startsWith('revise')) return planFixture();
      if (label.startsWith('review-')) return review(label);
      return work(state, `${label}.txt`);
    },
    codex: (label: string, options: CodexTurnOptions): unknown => {
      turns.push({ label, prompt: options.prompt, schema: options.schema });
      if (label.startsWith('review-')) return review(label);
      return report([]);
    },
  };
  const originalLog = console.log;
  const originalError = console.error;
  log.setSink(() => undefined);
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await orchestrate(state, cfg, resume, agents(handlers, calls));
  } finally {
    log.setSink(null);
    console.log = originalLog;
    console.error = originalError;
  }
  return { turns, calls };
}

/** The ledger section of a prompt, or null when it has none. */
export function ledgerOf(prompt: string): string | null {
  const start = prompt.indexOf('## Findings from earlier rounds');
  if (start < 0) return null;
  const end = prompt.indexOf('\n## ', start + 1);
  return prompt.slice(start, end < 0 ? undefined : end);
}
