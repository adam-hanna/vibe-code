import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { attachSpend } from '@src/charge.js';
import { OutputCutOffError } from '@src/codex.js';
import { DEFAULTS } from '@src/config.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { Escalation, EXIT, orchestrate } from '@src/orchestrator.js';
import type { Config, Finding, RunState } from '@src/types.js';
import {
  agents,
  config,
  freshRun,
  p1,
  planFixture,
  report,
  reviewingRun,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';

/**
 * A read-only Codex turn cut off at its output limit is run once more, on the
 * same request with a note appended, and a writer never is (#416).
 *
 * The cut-off is injected as the typed error the adapter throws, so this is the
 * dispatch's half: who is retried, how often, what is said, and that what the
 * cut-off answer had written never becomes the turn's verdict.
 */

const SALVAGED: Finding = { ...p1('salvaged-from-the-cut-off'), title: 'A finding the cut-off attempt wrote' };

function cutOff(findings: readonly Finding[] = [SALVAGED]): OutputCutOffError {
  const text = `{"verdict":"REVISE","findings":[...]${' '.repeat(122_408)}`;
  return new OutputCutOffError('cut off at its output limit (fixture)', { text, findings, reported: false });
}

interface Driven {
  calls: string[];
  seen: Narration[];
  prompts: Map<string, string[]>;
  error: unknown;
}

async function drive(state: RunState, cfg: Config, handlers: Handlers): Promise<Driven> {
  const calls: string[] = [];
  const seen: Narration[] = [];
  const prompts = new Map<string, string[]>();
  const record = (label: string, prompt: string): void => {
    prompts.set(label, [...(prompts.get(label) ?? []), prompt]);
  };
  const wrapped: Handlers = {
    ...handlers,
    claude: (label, options) => {
      record(label, options.prompt);
      if (handlers.claude !== undefined) return handlers.claude(label, options);
      return label === 'plan' || label.startsWith('revise-') ? planFixture() : work(state, `${label}.txt`);
    },
    codex: (label, options) => {
      record(label, options.prompt);
      return handlers.codex?.(label, options) ?? report([]);
    },
  };
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (): void => {};
  console.error = (): void => {};
  log.setSink((n) => void seen.push(n));
  let error: unknown = null;
  try {
    await orchestrate(state, cfg, false, agents(wrapped, calls));
  } catch (err: unknown) {
    error = err;
  } finally {
    log.setSink(null);
    console.log = originalLog;
    console.error = originalError;
  }
  return { calls, seen, prompts, error };
}

/** A handler that throws the cut-off for its first `n` calls on a label. */
function cutOffFirst(label: string, n: number, then: () => unknown = () => report([])): (label: string) => unknown {
  let seen = 0;
  return (l) => {
    if (l !== label) return report([]);
    seen += 1;
    if (seen <= n) throw cutOff();
    return then();
  };
}

const count = (calls: readonly string[], label: string): number => calls.filter((c) => c === label).length;

test('a critic cut off once is retried with the note, and the run goes on to approve', async () => {
  const state = freshRun({ prefix: 'vibe-cutoff-critic-' });
  const { calls, seen, prompts, error } = await drive(state, config(), { codex: cutOffFirst('critique-0', 1) });

  assert.equal(error, null);
  assert.equal(count(calls, 'critique-0'), 2, 'exactly one retry');
  assert.equal(state.status, 'planned', 'a plan-only run that approved');

  const warned = seen.find((n) => n.id === 'codex_cut_off');
  assert.ok(warned !== undefined, 'the cut-off is narrated');
  assert.match(
    warned.message,
    /Codex's answer to critique-0 was cut off at its output limit after [\d,]+ characters, followed by 122,408 characters of blank space\. Trying the turn again \(1 retry\)\./,
  );
  assert.match(warned.message, /Codex did not report what the cut-off attempt used\./);

  const retried = state.events.filter((e) => e.type === 'turn_retried');
  assert.equal(retried.length, 1);
  const [event] = retried;
  assert.equal(event?.['label'], 'critique-0');
  assert.equal(event?.['reason'], 'max_output_tokens');
  assert.equal(event?.['attempt'], 2);

  const [firstPrompt, retryPrompt] = prompts.get('critique-0') ?? [];
  assert.ok(firstPrompt !== undefined && retryPrompt !== undefined);
  assert.doesNotMatch(firstPrompt, /cut off/);
  assert.ok(retryPrompt.startsWith(firstPrompt), 'the retry is the same request with a note appended');
  assert.match(retryPrompt, /## An earlier attempt at this turn was cut off/);
  assert.match(retryPrompt, /it has not been verified/);
  assert.ok(retryPrompt.includes(SALVAGED.id));
});

test('what the cut-off answer wrote never becomes the verdict', async () => {
  // The salvaged finding is a P1, and the retry approves: nothing of the P1 may
  // reach the critique artifact, the plan's findings or the gate.
  const state = freshRun({ prefix: 'vibe-cutoff-verdict-' });
  const { error } = await drive(state, config({ p1Tolerance: 0 }), { codex: cutOffFirst('critique-0', 1) });

  assert.equal(error, null);
  assert.equal(state.status, 'planned', 'approved on the retry, whatever the cut-off attempt wrote');
  const critique = readFileSync(path.join(state.dir, 'plan-critique-0.json'), 'utf8');
  assert.ok(!critique.includes(SALVAGED.id), 'the critique artifact is the retry answer alone');
  assert.ok(
    !JSON.stringify(state.events.filter((e) => e.type !== 'codex_cut_off')).includes(SALVAGED.id),
    'no event other than the warning names the salvaged finding',
  );
});

test('a reviewer cut off twice ends the run as one cut-off did, naming both attempts', async () => {
  const state = reviewingRun({ prefix: 'vibe-cutoff-review-' });
  const { calls, error } = await drive(state, config(), { codex: cutOffFirst('review-0', 2) });

  assert.equal(count(calls, 'review-0'), 2, 'one retry, never a third attempt');
  assert.ok(error instanceof OutputCutOffError, `expected the cut-off to end the run, got ${String(error)}`);
  assert.match(error.message, /review-0 was cut off at its output limit on both attempts/);
  assert.match(error.message, /First attempt: /);
  assert.match(error.message, /Retry: /);
  assert.equal(state.events.filter((e) => e.type === 'turn_retried').length, 1);
});

test('a Codex writer cut off is not retried', async () => {
  const state = freshRun({ prefix: 'vibe-cutoff-writer-', planOnly: false, git: true, commit: true });
  const cfg = config({}, {
    roles: { planner: 'claude', implementer: 'codex', critic: 'codex', answerer: 'codex', reviewer: 'codex' },
    codex: { ...config().codex, persistSession: false },
  });
  const { calls, error } = await drive(state, cfg, { codex: cutOffFirst('implement', 1) });

  assert.equal(count(calls, 'implement'), 1, 'a writer may have edited the tree; it runs once');
  assert.ok(error instanceof OutputCutOffError);
  assert.equal(state.events.some((e) => e.type === 'turn_retried'), false);
});

test('a finder cut off twice is absorbed as before, after its one retry', async () => {
  const state = reviewingRun({ prefix: 'vibe-cutoff-finder-' });
  const cfg = config({ p1Tolerance: 0 }, { review: { ...DEFAULTS.review, finders: ['codex'] } });
  const { calls, error } = await drive(state, cfg, { codex: cutOffFirst('review-0-f1', 2) });

  assert.equal(error, null);
  assert.equal(count(calls, 'review-0-f1'), 2);
  assert.equal(state.status, 'done');
  assert.ok(state.events.some((e) => e.type === 'review_finder_failed'));
  assert.equal(state.events.filter((e) => e.type === 'turn_retried').length, 1);
});

test('a ceiling reached by the cut-off attempt escalates instead of retrying', async () => {
  const state = freshRun({ prefix: 'vibe-cutoff-ceiling-' });
  const cfg = config({}, { budget: { ...DEFAULTS.budget, maxTokens: 1_000_000 } });
  const { calls, error } = await drive(state, cfg, {
    codex: (label) => {
      if (label === 'critique-0') throw attachSpend(cutOff(), { costUsd: null, tokens: 2_000_000 });
      return report([]);
    },
  });

  assert.ok(error instanceof Escalation, `expected an escalation, got ${String(error)}`);
  assert.equal(count(calls, 'critique-0'), 1);
  assert.equal(state.events.some((e) => e.type === 'turn_retried'), false);
});

test('a ceiling that ends the run after a cut-off still says the turn was cut off, first', async () => {
  // The warning is said before the ceiling is enforced, so the record shows why
  // the last turn failed. It must not claim a retry that never happens, and the
  // escalation keeps the ceiling's exit code.
  const state = freshRun({ prefix: 'vibe-cutoff-ceiling-said-' });
  const cfg = config({}, { budget: { ...DEFAULTS.budget, maxTokens: 1_000_000 } });
  const { seen, error } = await drive(state, cfg, {
    codex: (label) => {
      if (label === 'critique-0') throw attachSpend(cutOff(), { costUsd: null, tokens: 2_000_000 });
      return report([]);
    },
  });

  assert.ok(error instanceof Escalation, `expected an escalation, got ${String(error)}`);
  assert.equal(error.code, EXIT.BUDGET, 'the ceiling exit code is unchanged');
  assert.match(error.message, /^Token ceiling exceeded/);

  const warned = seen.find((n) => n.id === 'codex_cut_off');
  assert.ok(warned !== undefined, 'the cut-off is narrated even though the ceiling ends the run');
  assert.match(warned.message, /Codex's answer to critique-0 was cut off at its output limit after [\d,]+ characters/);
  assert.match(warned.message, /Not tried again: the run has reached its token ceiling\./);
  assert.doesNotMatch(warned.message, /Trying the turn again/);
  assert.ok(state.events.some((e) => e.type === 'codex_cut_off'), 'and it is in the run record');
  assert.equal(state.events.some((e) => e.type === 'turn_retried'), false);
});

test('a cut-off with no final message is narrated without counts', async () => {
  // chars and blankChars are null when the adapter could name no final
  // message: the warning says so, and quotes no zero as if it were measured.
  const state = freshRun({ prefix: 'vibe-cutoff-nomessage-' });
  let seenCritique = 0;
  const { seen, error } = await drive(state, config(), {
    codex: (label) => {
      if (label === 'critique-0' && ++seenCritique === 1) {
        throw new OutputCutOffError('cut off before its final message arrived (fixture)', {
          text: '',
          findings: [],
          reported: false,
          chars: null,
          blankChars: null,
        });
      }
      return report([]);
    },
  });

  assert.equal(error, null);
  const warned = seen.find((n) => n.id === 'codex_cut_off');
  assert.ok(warned !== undefined);
  assert.match(
    warned.message,
    /^Codex's answer to critique-0 was cut off at its output limit before its final message arrived\. Trying the turn again \(1 retry\)\./,
  );
  assert.doesNotMatch(warned.message, /\b0 characters/);
  assert.equal(warned.data?.['chars'], null);
  assert.equal(warned.data?.['blankChars'], null);
});

test("a second cut-off's error points at both attempts' records", async () => {
  const state = reviewingRun({ prefix: 'vibe-cutoff-records-' });
  let n = 0;
  const { error } = await drive(state, config(), {
    codex: (label) => {
      if (label !== 'review-0') return report([]);
      n += 1;
      const keptAt = path.join(state.dir, 'codex', n === 1 ? 'review-0.cutoff.json' : 'review-0.cutoff-2.json');
      throw new OutputCutOffError(`cut off (fixture ${n})`, { text: '', findings: [], reported: false, keptAt });
    },
  });

  assert.ok(error instanceof OutputCutOffError);
  assert.ok(error.message.includes(path.join(state.dir, 'codex', 'review-0.cutoff.json')), error.message);
  assert.ok(error.message.includes(path.join(state.dir, 'codex', 'review-0.cutoff-2.json')), error.message);
});
