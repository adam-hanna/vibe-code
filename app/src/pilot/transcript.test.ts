import { describe, expect, test } from 'vitest';
import {
  ask,
  decide,
  emptyConversation,
  follow,
  reduce,
  refuse,
  settle,
  spendParts,
  unanswered,
  unrecognised,
} from './transcript';
import type { Conversation } from './transcript';
import type { PilotEvent, Usage } from './pilot';

/**
 * The pilot conversation, on the events the two adapters actually emit (#143).
 *
 * The Rust side has the adapters' own tests, folding recorded streams from both
 * vendors; this is the other end of the same wire. **Nothing here asserts on
 * English** and nothing adds a number up — a `spent` event carries the turn's
 * running total, assembled in Rust where the vendor difference lives.
 */

const usage = (over: Partial<Usage> = {}): Usage => ({
  input: null,
  output: null,
  cache_read: null,
  cache_write: null,
  ...over,
});

/** Fold a list of events into a conversation with one open turn. */
function fold(events: readonly PilotEvent[], turn = 1): Conversation {
  return events.reduce(
    (state, event) => reduce(state, event),
    ask(emptyConversation(), 'hello', turn, 'anthropic'),
  );
}

describe('a reply is assembled from deltas and from nothing else', () => {
  test('the text is the deltas, in order, concatenated', () => {
    const done = fold([
      { kind: 'started', turn: 1, provider: 'anthropic', model: 'claude-opus-5-20260501' },
      { kind: 'text', turn: 1, delta: 'Hel' },
      { kind: 'text', turn: 1, delta: 'lo.' },
      { kind: 'ended', turn: 1, stop: 'end_turn' },
    ]);
    expect(done.replies[0]?.text).toBe('Hello.');
    expect(done.replies[0]?.model).toBe('claude-opus-5-20260501');
    expect(done.replies[0]?.outcome).toEqual({ kind: 'ended', stop: 'end_turn' });
    expect(done.live).toBeNull();
  });

  test('the model is what answered, and stays absent until the vendor says', () => {
    // Never filled in from the request: an alias resolves to a dated version,
    // and showing the alias back would claim something nobody was told.
    const open = fold([{ kind: 'text', turn: 1, delta: 'x' }]);
    expect(open.live?.model).toBeNull();
  });

  test('a finished reply joins the conversation the next turn is sent', () => {
    const done = fold([
      { kind: 'text', turn: 1, delta: 'Hello.' },
      { kind: 'ended', turn: 1, stop: 'end_turn' },
    ]);
    expect(done.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hello.' },
    ]);
  });

  test('a reply with nothing in it does not become an assistant message', () => {
    // Sending an empty message would have the vendor answer a conversation that
    // never happened - and both APIs reject an empty content block anyway.
    const done = fold([{ kind: 'failed', turn: 1, message: 'overloaded_error: Overloaded' }]);
    expect(done.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(done.replies[0]?.outcome).toEqual({
      kind: 'failed',
      message: 'overloaded_error: Overloaded',
    });
  });

  test('what was said is recorded even when the reply never arrives', () => {
    // The user's message is appended when the turn opens, not when it succeeds.
    // A transcript that kept only successful turns would be missing exactly the
    // ones somebody needs to look at.
    const open = ask(emptyConversation(), 'hello', 1, 'openai');
    expect(open.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
});

describe('spend is reported, never computed', () => {
  test('each event replaces the total rather than adding to it', () => {
    // Anthropic reports usage twice and each event carries the running total,
    // merged in Rust. Accumulating here would double every input count.
    const done = fold([
      { kind: 'spent', turn: 1, usage: usage({ input: 120, cache_read: 4000 }) },
      { kind: 'spent', turn: 1, usage: usage({ input: 120, cache_read: 4000, output: 38 }) },
      { kind: 'ended', turn: 1, stop: 'end_turn' },
    ]);
    expect(done.replies[0]?.usage).toEqual(
      usage({ input: 120, output: 38, cache_read: 4000 }),
    );
  });

  test('a count the vendor never reported is left out, not drawn as zero', () => {
    // OpenAI has no cache-write charge to report. A zero would say it wrote
    // nothing to cache; the absence says the vendor did not tell us.
    expect(spendParts(usage({ input: 120, output: 38, cache_read: 64 }))).toEqual([
      '120 in',
      '38 out',
      '64 cache read',
    ]);
  });

  test('a zero the vendor did report is shown, because it is a measurement', () => {
    expect(spendParts(usage({ cache_write: 0 }))).toEqual(['0 cache write']);
  });

  test('a turn that never got a report has no usage at all', () => {
    const done = fold([{ kind: 'failed', turn: 1, message: 'no key' }]);
    expect(done.replies[0]?.usage).toBeNull();
  });
});

describe('an event that cannot be attributed is not recorded', () => {
  test('an event for another turn changes nothing', () => {
    // Applying it to whatever happens to be open would append one reply's text
    // into another's bubble.
    const open = ask(emptyConversation(), 'hello', 7, 'anthropic');
    expect(reduce(open, { kind: 'text', turn: 8, delta: 'not mine' })).toEqual(open);
  });

  test('an event with no turn open changes nothing', () => {
    const empty = emptyConversation();
    expect(reduce(empty, { kind: 'text', turn: 1, delta: 'x' })).toEqual(empty);
  });

  test('an event after the turn ended changes nothing', () => {
    // Rust guarantees one terminal event and that it is last, so this is the
    // belt to that braces: a duplicate would otherwise reopen a closed reply.
    const done = fold([{ kind: 'ended', turn: 1, stop: 'end_turn' }]);
    expect(reduce(done, { kind: 'text', turn: 1, delta: 'more' })).toEqual(done);
  });
});

describe('a refusal is part of the history', () => {
  test('a turn refused before it started is recorded as a failed reply', () => {
    // `pilot_send` validates and can reject without emitting an event, so this
    // outcome never arrives on the wire. It goes in the transcript rather than
    // a toast, because a toast is not history.
    const done = refuse(emptyConversation(), 'hello', 'openai', 'no model was named');
    expect(done.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(done.replies[0]?.outcome).toEqual({
      kind: 'failed',
      message: 'no model was named',
    });
    expect(done.live).toBeNull();
  });

  test('a refused turn cannot collide with an id Rust handed out', () => {
    // Rust's ids start at 1 and only go up; these are negative. Two replies
    // sharing a key is how React draws one into the other.
    const one = refuse(emptyConversation(), 'a', 'openai', 'no');
    const two = refuse(one, 'b', 'openai', 'no');
    expect(two.replies.map((r) => r.turn)).toEqual([-1, -2]);
  });
});

describe('an event this build does not know is counted, never discarded', () => {
  test('unrecognised events are visible', () => {
    expect(unrecognised(unrecognised(emptyConversation())).unknown).toBe(2);
  });
});

describe('a tool call is recorded as the model asked it (#144)', () => {
  test('a call joins the reply, with its arguments parsed and nothing run', () => {
    const done = fold([
      { kind: 'tool_call', turn: 1, id: 'toolu_A', name: 'start_run', arguments: '{"task":"x"}' },
      { kind: 'ended', turn: 1, stop: 'tool_use' },
    ]);
    expect(done.replies[0]?.calls).toEqual([
      {
        id: 'toolu_A',
        name: 'start_run',
        // The vendor's own bytes, kept as the record even though they parsed.
        arguments: '{"task":"x"}',
        input: { task: 'x' },
        unreadable: null,
        // The reducer reads a call; it does not run one. `settle` is what turns
        // this into an outcome, and it takes the run as an argument - which is
        // the seam that keeps this file pure.
        settlement: null,
      },
    ]);
  });

  test('a call with no arguments is a tool that takes no input, not a broken one', () => {
    // A tool whose schema takes nothing gets no argument fragments at all, and
    // an empty string must not be read as a parse failure.
    const done = fold([
      { kind: 'tool_call', turn: 1, id: 'toolu_A', name: 'list_runs', arguments: '' },
      { kind: 'ended', turn: 1, stop: 'tool_use' },
    ]);
    expect(done.replies[0]?.calls[0]?.input).toEqual({});
    expect(done.replies[0]?.calls[0]?.unreadable).toBeNull();
  });

  test('arguments that do not parse are reported, not thrown', () => {
    // A model emits truncated JSON when a turn hits its ceiling mid-call. The
    // honest report is a call that cannot be run; a reducer that threw would
    // take the whole pane down with it.
    const done = fold([
      { kind: 'tool_call', turn: 1, id: 'toolu_A', name: 'start_run', arguments: '{"task":' },
      { kind: 'ended', turn: 1, stop: 'max_tokens' },
    ]);
    const call = done.replies[0]?.calls[0];
    expect(call?.input).toBeUndefined();
    expect(call?.unreadable).toBeTruthy();
    // And the bytes survive, because they are the evidence.
    expect(call?.arguments).toBe('{"task":');
  });

  test('a turn that said nothing and asked for something is not empty', () => {
    // The common shape of a tool-calling turn. A test on the text alone would
    // drop the assistant message and have the vendor answer a conversation
    // that never happened.
    const done = fold([
      { kind: 'tool_call', turn: 1, id: 'toolu_A', name: 'start_run', arguments: '{}' },
      { kind: 'ended', turn: 1, stop: 'tool_use' },
    ]);
    expect(done.messages).toEqual([
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: '',
        calls: [{ id: 'toolu_A', name: 'start_run', input: {} }],
      },
    ]);
  });

  test('calls keep the order they were asked in', () => {
    const done = fold([
      { kind: 'tool_call', turn: 1, id: 'a', name: 'first', arguments: '{}' },
      { kind: 'tool_call', turn: 1, id: 'b', name: 'second', arguments: '{}' },
      { kind: 'ended', turn: 1, stop: 'tool_use' },
    ]);
    expect(done.replies[0]?.calls.map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('a conversation that owes a result cannot be sent', () => {
  test('an unanswered call is named', () => {
    // Both vendors reject an assistant turn whose tool_use has no matching
    // result. A real precondition, not a nicety.
    const done = fold([
      { kind: 'tool_call', turn: 1, id: 'toolu_A', name: 'start_run', arguments: '{}' },
      { kind: 'ended', turn: 1, stop: 'tool_use' },
    ]);
    expect(unanswered(done).map((c) => c.id)).toEqual(['toolu_A']);
  });

  test('a result settles it, matched by the vendor id and nothing else', () => {
    const done = fold([
      { kind: 'tool_call', turn: 1, id: 'toolu_A', name: 'start_run', arguments: '{}' },
      { kind: 'ended', turn: 1, stop: 'tool_use' },
    ]);
    const answered: Conversation = {
      ...done,
      messages: [
        ...done.messages,
        { role: 'tool', id: 'toolu_A', name: 'start_run', content: 'started' },
      ],
    };
    expect(unanswered(answered)).toEqual([]);
    // A result for a different id settles nothing - which is the case that
    // would otherwise send a 400 and blame the wrong call.
    const mismatched: Conversation = {
      ...done,
      messages: [
        ...done.messages,
        { role: 'tool', id: 'toolu_OTHER', name: 'start_run', content: 'started' },
      ],
    };
    expect(unanswered(mismatched).map((c) => c.id)).toEqual(['toolu_A']);
  });

  test('an ordinary conversation owes nothing', () => {
    expect(
      unanswered(
        fold([
          { kind: 'text', turn: 1, delta: 'Hello.' },
          { kind: 'ended', turn: 1, stop: 'end_turn' },
        ]),
      ),
    ).toEqual([]);
  });
});

describe('propose only, enforced by the data rather than by a component (#144)', () => {
  /** A conversation whose one turn asked for `name`, nothing settled yet. */
  function asked(name: string, id = 'toolu_A'): Conversation {
    return fold([
      { kind: 'tool_call', turn: 1, id, name, arguments: '{}' },
      { kind: 'ended', turn: 1, stop: 'tool_use' },
    ]);
  }

  test('a read is answered immediately, and the conversation can go on', () => {
    const done = settle(asked('read_run'), 'toolu_A', { kind: 'ran', content: '{"gate":null}' });
    expect(done.messages.at(-1)).toEqual({
      role: 'tool',
      id: 'toolu_A',
      name: 'read_run',
      content: '{"gate":null}',
    });
    expect(unanswered(done)).toEqual([]);
  });

  test('a proposal appends nothing, so the conversation cannot be sent', () => {
    // The whole enforcement. A pane that forgot to draw the card could not send
    // around it, because the call is still owed a result and both vendors reject
    // a conversation that leaves one open.
    const done = settle(asked('start_run'), 'toolu_A', {
      kind: 'proposes',
      summary: 'plan only, in /repo',
      effect: { kind: 'invoke', argv: ['plan', 'x', '-C', '/repo'] },
    });
    expect(done.messages.filter((m) => m.role === 'tool')).toEqual([]);
    expect(unanswered(done).map((c) => c.id)).toEqual(['toolu_A']);
    expect(done.replies[0]?.calls[0]?.settlement?.kind).toBe('proposes');
  });

  test('only a person clears a proposal, and the model is told which way', () => {
    const proposed = settle(asked('start_run'), 'toolu_A', {
      kind: 'proposes',
      summary: 'plan only, in /repo',
      effect: { kind: 'invoke', argv: ['plan', 'x', '-C', '/repo'] },
    });

    const yes = decide(proposed, 'toolu_A', true, 'go ahead');
    expect(unanswered(yes)).toEqual([]);
    expect(yes.messages.at(-1)).toMatchObject({ role: 'tool', id: 'toolu_A' });

    // A declined proposal answered with silence would leave the model reasoning
    // about a request it has no idea was refused, and building on that.
    const no = decide(proposed, 'toolu_A', false, 'wrong directory');
    expect(unanswered(no)).toEqual([]);
    const said = no.messages.at(-1);
    expect(said?.role === 'tool' && said.content).toContain('declined');
    expect(said?.role === 'tool' && said.content).toContain('wrong directory');
  });

  test('a call is settled once, and a second attempt changes nothing', () => {
    // Two results for one call is a 400 from both vendors, and the second would
    // be the one that survived - so the first answer wins by construction.
    const once = settle(asked('read_run'), 'toolu_A', { kind: 'ran', content: 'first' });
    expect(settle(once, 'toolu_A', { kind: 'ran', content: 'second' })).toEqual(once);
    expect(decide(once, 'toolu_A', true, '')).toEqual(once);
  });

  test('a settlement for a call nobody made is dropped', () => {
    // The same rule `reduce` follows for an event about the wrong turn: a fact
    // that cannot be attributed is not recorded.
    const conversation = asked('read_run');
    expect(settle(conversation, 'toolu_MISSING', { kind: 'ran', content: 'x' })).toEqual(
      conversation,
    );
  });

  test('a proposal is settled long after its turn ended, and finds its own call', () => {
    // A person can take as long as they like, and another turn can happen first
    // - so the lookup is by id across every reply rather than the last one.
    const first = settle(asked('start_run'), 'toolu_A', {
      kind: 'proposes',
      summary: 'plan only',
      effect: { kind: 'invoke', argv: ['plan'] },
    });
    const later: Conversation = {
      ...first,
      replies: [
        ...first.replies,
        {
          turn: 2,
          provider: 'anthropic',
          model: null,
          text: 'still waiting',
          calls: [],
          usage: null,
          outcome: { kind: 'ended', stop: 'end_turn' },
        },
      ],
    };
    const decided = decide(later, 'toolu_A', true, '');
    expect(unanswered(decided)).toEqual([]);
  });
});

describe('a tool follow-up is a turn nobody typed', () => {
  test('it opens a reply and appends no message', () => {
    // Sharing `ask`'s body would mean a user message with empty content, which
    // is a message the vendor is asked to answer and nobody wrote.
    const done = settle(
      fold([
        { kind: 'tool_call', turn: 1, id: 'toolu_A', name: 'read_run', arguments: '{}' },
        { kind: 'ended', turn: 1, stop: 'tool_use' },
      ]),
      'toolu_A',
      { kind: 'ran', content: '{}' },
    );
    const next = follow(done, 2, 'anthropic');
    expect(next.messages).toEqual(done.messages);
    expect(next.live?.turn).toBe(2);
  });

  test('and one that fails leaves the transcript as it was, plus the failure', () => {
    const conversation = fold([{ kind: 'ended', turn: 1, stop: 'end_turn' }]);
    const failed = refuse(conversation, null, 'anthropic', 'overloaded');
    expect(failed.messages).toEqual(conversation.messages);
    expect(failed.replies.at(-1)?.outcome).toEqual({ kind: 'failed', message: 'overloaded' });
  });
});
