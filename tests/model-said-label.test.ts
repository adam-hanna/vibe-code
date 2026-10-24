import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import { createHeartbeat } from '@src/progress.js';
import type { Heartbeat, LineParser, ProgressSnapshot, RepeatingTimer, TimerApi } from '@src/progress.js';

/**
 * What a model said names its turn once two turns' words can interleave (#403).
 *
 * Every other per-turn line already starts with its label - a heartbeat, a
 * charge, a child's ending - and `model_said` was the one that did not, because
 * there was only ever one turn speaking. With review seats running at once, a
 * transcript of unlabelled prose from three verifiers cannot be read. So the
 * label is put in front while another turn is live in the same run, and a turn
 * alone says exactly what it always said.
 */

const idle: TimerApi = { repeat: (): RepeatingTimer => ({ unref: () => {}, cancel: () => {} }) };

/** Each line is something the model said. */
const saying: LineParser = (snapshot: ProgressSnapshot, line: string) => {
  snapshot.said.push(line);
  return true;
};

function heartbeat(label: string, scope: object): Heartbeat {
  return createHeartbeat({
    label,
    intervalMs: 60_000,
    scope,
    parse: saying,
    unit: 'tool use',
    provider: 'claude',
    emit: () => undefined,
    timers: idle,
    now: () => 0,
  });
}

function said(body: () => void): Narration[] {
  const seen: Narration[] = [];
  const originalLog = console.log;
  console.log = () => undefined;
  log.setSink((n) => void seen.push(n));
  try {
    body();
  } finally {
    log.setSink(null);
    console.log = originalLog;
  }
  return seen.filter((n) => n.id === 'model_said');
}

test('a turn alone says what it said, with no label in front', () => {
  const scope = {};
  const only = heartbeat('vote-0-1-v1', scope);
  only.begin();
  const lines = said(() => only.onLine('It is there.'));
  only.stop();
  assert.deepEqual(
    lines.map((n) => n.message),
    ['It is there.'],
  );
  assert.deepEqual(lines[0]?.data, { label: 'vote-0-1-v1', text: 'It is there.' });
});

test('with another turn live in the run, each line names the turn that said it', () => {
  const scope = {};
  const a = heartbeat('vote-0-1-v1', scope);
  const b = heartbeat('vote-0-1-v2', scope);
  a.begin();
  b.begin();
  const lines = said(() => {
    a.onLine('It is there.');
    b.onLine('It is handled.');
  });
  a.stop();
  b.stop();
  assert.deepEqual(
    lines.map((n) => n.message),
    ['vote-0-1-v1: It is there.', 'vote-0-1-v2: It is handled.'],
  );
  // The record a host reads is unchanged: the label was always in the data.
  assert.deepEqual(lines[1]?.data, { label: 'vote-0-1-v2', text: 'It is handled.' });
});

test('a turn in another run does not count as live beside this one', () => {
  const a = heartbeat('vote-0-1-v1', {});
  const b = heartbeat('vote-0-1-v2', {});
  a.begin();
  b.begin();
  const lines = said(() => a.onLine('It is there.'));
  a.stop();
  b.stop();
  assert.deepEqual(
    lines.map((n) => n.message),
    ['It is there.'],
  );
});
