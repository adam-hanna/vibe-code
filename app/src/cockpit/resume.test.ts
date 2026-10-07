import { describe, expect, test } from 'vitest';
import { emptyRun, reduce } from './model';
import { describeRun } from '../pilot/tools';
import { systemPrompt } from '../pilot/brief';
import type { Frame } from '../host';
import type { Run } from './model';

/**
 * What a resumed run shows about the part nobody in this window watched (#211).
 *
 * **Narration begins when the window connects.** Every round, turn and dollar of
 * an earlier session was narrated to a process that has since exited, so a run
 * picked up at review round 3 drew an empty column and a `starting` checklist -
 * and the pilot, whose whole picture is `describeRun`, described a run that had
 * done nothing. Reported as *"when I resume a past run, the pilot et al should
 * be brought back to wherever we're resuming from."*
 *
 * The fix is one frame read off `state.json`, and the thing these cases mostly
 * guard is what it is **not**: a replay. Re-emitting `phase_started` for turns
 * that already finished would fill the column at the price of drawing completed
 * work as running.
 */

const started = (data: Record<string, unknown>): Frame => ({
  type: 'narration',
  level: 'step',
  message: 'a sentence, which nothing here reads',
  id: 'run_started',
  data,
});

const FROM = {
  status: 'needs-input',
  phase: 'review',
  planRound: 2,
  questionRound: 1,
  reviewRound: 3,
  verifyRound: 0,
  tokensUsed: 8_800_000,
  costUsd: 12.5,
  codexTokens: 900_000,
  pendingFindings: 2,
  pendingFrom: 'review',
  carried: 1,
};

function resumed(from: unknown = FROM): Run {
  return reduce(
    emptyRun(),
    started({ runId: '20260908-163330-x', dir: 'C:/repo', resumed: true, from }),
    1_000,
  );
}

/**
 * A resume from a core that predates the frame — no `from` key at all.
 *
 * Its own helper because `resumed(undefined)` does **not** express it: a default
 * parameter fills `undefined` back in with the fixture, so that call tests the
 * opposite of what it reads as.
 */
function resumedByOldCore(): Run {
  return reduce(
    emptyRun(),
    started({ runId: '20260908-163330-x', dir: 'C:/repo', resumed: true }),
    1_000,
  );
}

describe('the history a resume picks up from', () => {
  test('it is folded onto the run, beside the identity rather than into it', () => {
    const run = resumed();
    expect(run.identity?.resumed).toBe(true);
    expect(run.from?.reviewRound).toBe(3);
    expect(run.from?.pendingFindings).toBe(2);
    expect(run.from?.tokensUsed).toBe(8_800_000);
  });

  test('a fresh run has none, and neither does a core too old to send it', () => {
    // Both mean the same thing to a reader - there is no history to show - so
    // they are allowed to collapse. What must not happen is a shell of nulls
    // drawn as "resumed from nothing", which is what an unreadable payload
    // would produce.
    const fresh = reduce(
      emptyRun(),
      started({ runId: 'r', dir: 'C:/repo', resumed: false }),
      1_000,
    );
    expect(fresh.from).toBeNull();
    expect(resumedByOldCore().from).toBeNull();
    expect(resumed('nonsense').from).toBeNull();
    expect(resumed(null).from).toBeNull();
    expect(resumed({}).from).toBeNull();
  });

  test('a partial payload keeps what was readable and nulls the rest', () => {
    // Never zero: on a resumed run a round drawn as 0 says the run has done
    // none, which is the opposite of what this frame exists to correct.
    const run = resumed({ reviewRound: 3 });
    expect(run.from?.reviewRound).toBe(3);
    expect(run.from?.planRound).toBeNull();
    expect(run.from?.tokensUsed).toBeNull();
  });

  test('it does not become cycles, turns or spend', () => {
    // The claim that matters most. A replay would fill the column, and every
    // card in it would be a finished turn drawn as a running one - and the
    // footer's totals would count work this session did not do.
    const run = resumed();
    expect(run.cycles).toEqual([]);
    expect(run.running).toBeNull();
    expect(run.spend.tokens).toBeNull();
    expect(run.censuses).toEqual([]);
  });
});

describe('what the pilot is told about it', () => {
  test('the run description carries it, labelled as before this session', () => {
    // Without this the pilot reads `cycles: []` on a run three review rounds in
    // and concludes - reasonably - that nothing has happened yet.
    const described = describeRun(resumed()) as { before: unknown; cycles: unknown[] };
    expect(described.before).not.toBeNull();
    expect(described.cycles).toEqual([]);
  });

  test('the prompt says how to read the two together', () => {
    // The block is one object with two timeframes in it, and a model told
    // nothing would average them. It is told instead.
    const prompt = systemPrompt(resumed(), null);
    expect(prompt).toMatch(/RESUMED/);
    expect(prompt).toMatch(/before/);
    // And the sentence that stops the specific wrong reading. On one line in
    // the prompt on purpose: the block is wrapped by hand, and a claim split
    // across a newline is one a reader can skim past.
    expect(prompt).toMatch(/an empty cycles list does not mean nothing has happened/);
  });

  test('a fresh run says nothing about a history it does not have', () => {
    const described = describeRun(emptyRun()) as { before: unknown };
    expect(described.before).toBeNull();
  });
});
