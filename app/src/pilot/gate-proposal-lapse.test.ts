import { describe, expect, test } from 'vitest';
import { emptyRun, reduce as reduceRun } from '../cockpit/model';
import { noCommands } from '../cockpit/commands';
import { ask, emptyConversation, lapse, reduce, settle, unanswered } from './transcript';
import { execute, lapsedWhy } from './tools';
import type { Run } from '../cockpit/model';
import type { Binding, RunState } from './bound';
import type { Effect, Settlement } from './tools';
import type { Conversation } from './transcript';

/**
 * A gate proposal the gate outlived (#521).
 *
 * On #489's run the pilot proposed *continue at review-round*, the gate was
 * released from elsewhere before anybody pressed the card, and the run went on to
 * finish. The card stayed owed, and an owed proposal blocks the composer, so the
 * finished run's pilot could not be spoken to. These pin when such a proposal
 * lapses, and that lapsing frees the conversation without misplacing the result.
 */

function run(...frames: Parameters<typeof reduceRun>[1][]): Run {
  return frames.reduce((state, frame) => reduceRun(state, frame, 1_000), emptyRun());
}

function askAt(id: number, boundary: string, reviewRound: number) {
  return {
    type: 'ask' as const,
    id,
    context: { boundary, phase: 'reviewing', planRound: 1, questionRound: 0, reviewRound, verifyRound: 0 },
  };
}

const reviewGate = run(askAt(1, 'review-round', 1));

function bound(state: RunState, r: Run, source: 'window' | 'record' = 'window'): Binding {
  return { kind: 'run', runId: '20261103-114346-x', via: 'own', state, source, run: r };
}

/** The effect `answer_gate` proposes against `r`, as the tool builds it. */
function proposed(r: Run): Effect {
  const out: Settlement = execute(
    { name: 'answer_gate', input: { decision: 'continue' }, unreadable: null },
    { run: r, commands: noCommands(), dir: '/repo' },
  );
  if (out.kind !== 'proposes') throw new Error(`answer_gate did not propose: ${out.kind}`);
  return out.effect;
}

describe('a gate proposal lapses when its gate cannot be answered any more', () => {
  const effect = proposed(reviewGate);

  test('it stands while the run is holding at the gate it was proposed at', () => {
    expect(lapsedWhy(effect, bound('live', reviewGate))).toBeNull();
  });

  test('it lapses once the gate is answered another way', () => {
    // The footer, the matrix or a phone released it: the run on screen holds nothing.
    const released = lapsedWhy(effect, bound('live', run()));
    expect(released).toMatch(/^Nothing was sent/);
    expect(released).toContain('review-round');
  });

  test('it lapses when the run has ended or been lost', () => {
    expect(lapsedWhy(effect, bound('ended', reviewGate))).toMatch(/ended/);
    expect(lapsedWhy(effect, bound('lost', reviewGate))).toMatch(/lost/);
  });

  test('a resumed run holding a later gate under the same id is not the gate it was proposed at', () => {
    // Ask ids restart at 1 in every run host. Matching on the id alone, this
    // card would have answered round 2's gate with round 1's decision.
    const resumed = run(askAt(1, 'review-round', 2));
    expect(lapsedWhy(effect, bound('live', resumed))).toMatch(/^Nothing was sent/);
  });

  test('a run the window cannot see yet decides nothing', () => {
    expect(lapsedWhy(effect, bound('starting', run()))).toBeNull();
    expect(lapsedWhy(effect, bound('live', run(), 'record'))).toBeNull();
    expect(lapsedWhy(effect, { kind: 'reading', runId: 'r', via: 'own' })).toBeNull();
    expect(lapsedWhy(effect, null)).toBeNull();
  });

  test('a proposal saved before the gate was recorded still lapses, by its id', () => {
    const saved: Effect = { kind: 'answer', askId: 1, decision: { kind: 'continue', origin: 'pilot' } };
    expect(lapsedWhy(saved, bound('live', reviewGate))).toBeNull();
    expect(lapsedWhy(saved, bound('live', run(askAt(2, 'review-round', 2))))).toMatch(/^Nothing was sent/);
    expect(lapsedWhy(saved, bound('ended', run()))).toMatch(/ended/);
  });

  test('only a gate answer lapses: a launch proposal outlives any gate', () => {
    expect(lapsedWhy({ kind: 'invoke', argv: ['plan', 'x'] }, bound('ended', run()))).toBeNull();
  });
});

describe('a lapse answers the card where its turn is, and frees the composer', () => {
  /** #489's shape: the card, then a wake and a reply that came after it. */
  function overtaken(): Conversation {
    const asked = [
      { kind: 'tool_call' as const, turn: 1, id: 'toolu_G', name: 'answer_gate', arguments: '{}' },
      { kind: 'ended' as const, turn: 1, stop: 'tool_use' },
    ].reduce((state, event) => reduce(state, event), ask(emptyConversation(), 'hello', 1, 'anthropic'));
    const carded = settle(asked, 'toolu_G', {
      kind: 'proposes',
      summary: 'continue at review-round',
      effect: proposed(reviewGate),
    });
    return {
      ...carded,
      messages: [
        ...carded.messages,
        { role: 'user', content: '[the app woke you] the loop has stopped at review-round' },
        { role: 'assistant', content: 'The gate has already been answered.' },
      ],
    };
  }

  test('the conversation owes nothing once the card has lapsed', () => {
    const before = overtaken();
    expect(unanswered(before).map((c) => c.id)).toEqual(['toolu_G']);
    expect(unanswered(lapse(before, 'toolu_G', 'Nothing was sent: gone.'))).toEqual([]);
  });

  test('the result follows the turn that asked for it, not the end of the chat', () => {
    // Anthropic rejects a tool_result that is not in the message straight after
    // its tool_use, and by the time a gate is overtaken the chat has moved on.
    const after = lapse(overtaken(), 'toolu_G', 'Nothing was sent: gone.');
    expect(after.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'assistant']);
    expect(after.messages[2]).toEqual({
      role: 'tool',
      id: 'toolu_G',
      name: 'answer_gate',
      content: 'Nothing was sent: gone.',
    });
  });

  test('a card already answered is left as it was', () => {
    const once = lapse(overtaken(), 'toolu_G', 'first');
    expect(lapse(once, 'toolu_G', 'second')).toBe(once);
  });
});
