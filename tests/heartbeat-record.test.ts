import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { createHeartbeat, emptySnapshot, formatHeartbeat, heartbeatData } from '@src/progress.js';
import type { HeartbeatLine } from '@src/progress.js';

/**
 * The heartbeat as data, not only as a line (#133).
 *
 * `formatHeartbeat` builds `implement: 9m12s · 47 tool uses · Read src/run.ts ·
 * 340k tok · ctx 22%`. A host that wanted the numbers back would have to parse
 * that apart, and would break the next time someone improves the wording - which
 * is the coupling the narration seam exists to prevent. So the string is one
 * renderer of a record, and this file pins the record.
 *
 * The two fixtures below are deliberately the *same two* that
 * `heartbeat-window.test.ts` asserts the rendered bytes of. Reading them side by
 * side is the point: one file says what the terminal sees, this one says what a
 * host sees, and both are built from one `HeartbeatLine`.
 */

/** As Codex actually reports: items, a total at turn.completed, no prompt size. */
const CODEX: HeartbeatLine = {
  label: 'critique-0',
  elapsedMs: 90_000,
  unit: 'event',
  snapshot: {
    ...emptySnapshot(),
    activities: 4,
    lastActivity: 'agent_message',
    tokens: 429_000,
  },
};

/** As Claude reports: tool uses, running tokens, and a live prompt size. */
const CLAUDE: HeartbeatLine = {
  label: 'implement',
  elapsedMs: 252_000,
  unit: 'tool use',
  contextWindow: 200_000,
  snapshot: {
    ...emptySnapshot(),
    activities: 23,
    lastActivity: 'Read src/orchestrator.ts',
    tokens: 340_000,
    promptTokens: 44_000,
  },
};

test('the record carries every number the line renders, and the unit that names them', () => {
  assert.deepEqual(heartbeatData(CLAUDE), {
    label: 'implement',
    elapsedMs: 252_000,
    activities: 23,
    unit: 'tool use',
    tokens: 340_000,
    promptTokens: 44_000,
    lastActivity: 'Read src/orchestrator.ts',
    contextWindow: 200_000,
  });

  // `unit` travels with `activities` because it is the noun that makes the
  // number mean something, and the two providers do not count the same thing:
  // Claude counts tool uses, Codex counts stream items.
  assert.equal(heartbeatData(CODEX)['unit'], 'event');
  assert.equal(heartbeatData(CLAUDE)['unit'], 'tool use');
});

test('a field the stream never supplied is absent, not zero', () => {
  // The repo's one recurring rule, applied here. Codex reports usage only at
  // `turn.completed`, so a mid-turn heartbeat has no prompt size and no window -
  // and `ctx 0%` would be a measurement nobody took.
  const data = heartbeatData(CODEX);

  assert.equal('contextWindow' in data, false);
  // The string omits the ctx segment for the same reason, from the same record.
  assert.equal(formatHeartbeat(CODEX).includes('ctx'), false);
});

test('a counted zero is a fact and stays in the record', () => {
  // The other half of the rule, and the reason this is not "omit anything
  // falsy". A turn that has genuinely done nothing yet has `activities: 0`, and
  // that is an observation, not an absence - it is exactly what tells a host the
  // turn is alive and idle rather than unmeasured.
  const quiet: HeartbeatLine = {
    label: 'plan',
    elapsedMs: 4_000,
    unit: 'tool use',
    snapshot: emptySnapshot(),
  };
  const data = heartbeatData(quiet);

  assert.equal(data['activities'], 0);
  assert.equal(data['tokens'], 0);
  assert.equal(data['promptTokens'], 0);
  // But `lastActivity` is null rather than counted, so it is absent.
  assert.equal('lastActivity' in data, false);
  // And the line drops all three segments, which is what makes them absences to
  // a reader of the terminal and facts to a reader of the record.
  assert.equal(formatHeartbeat(quiet), 'plan: 4s');
});

test('the record and the line come from one heartbeat, through the sink', () => {
  // The seam in situ: a real `createHeartbeat` with its default emit, which is
  // `log.detail` - so the terminal gets the sentence and a host gets the record,
  // from one call. Two calls here would let the two drift apart.
  const seen: Narration[] = [];
  const realLog = console.log;
  console.log = () => undefined;
  log.setSink((n) => void seen.push(n));

  try {
    let clock = 0;
    const hb = createHeartbeat({
      label: 'implement',
      intervalMs: 1_000,
      unit: 'tool use',
      provider: 'claude',
      // A fixed clock rather than a wall-clock fixture: AGENTS.md forbids the
      // latter, and this makes `elapsedMs` exactly assertable.
      now: () => clock,
      // A `LineParser` mutates the snapshot and says whether it recognised the
      // line. Stubbed rather than fed real stream JSON: what is under test is
      // that the record reaches the sink, not how a line is parsed - and
      // `progress.test.ts` already owns the parsers.
      parse: (snapshot) => {
        snapshot.activities += 1;
        snapshot.lastActivity = 'Read src/run.ts';
        snapshot.tokens += 1_200;
        return true;
      },
    });
    hb.begin();
    clock = 5_000;
    hb.onLine('anything - the parse stub above decides what it means');
    hb.stop();
  } finally {
    log.setSink(null);
    console.log = realLog;
  }

  const beats = seen.filter((n) => n.id === 'heartbeat');
  assert.ok(beats.length > 0, 'the heartbeat narrated nothing');

  const beat = beats[0];
  assert.equal(beat?.level, 'detail');
  const data = beat?.data ?? {};
  assert.equal(data['label'], 'implement');
  assert.equal(data['elapsedMs'], 5_000);
  assert.equal(data['unit'], 'tool use');
  // And the message is still the rendered line the terminal has always shown.
  assert.equal(beat?.message.startsWith('implement: 5s'), true, beat?.message);
});
