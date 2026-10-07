import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrate } from '@src/orchestrator.js';
import * as log from '@src/log.js';
import type { Narration } from '@src/log.js';
import {
  agents,
  committing,
  config,
  freshRun,
  planFixture,
  report,
  verifying,
  work,
} from './helpers/loop-harness.js';
import type { Handlers } from './helpers/loop-harness.js';
import type { RunState } from '@src/types.js';

/**
 * The narration seam: what the loop says, arriving as data.
 *
 * The bar this has to clear is stated in #133 and it is a strict one - the CLI's
 * output is a contract, people read it and `vibe doctor` is scripted against it,
 * so installing a sink must not change a single byte of what the terminal sees.
 * Half of this file exists to prove that rather than to test the sink.
 *
 * The other half asserts by LEVEL AND ID, never by matching English. That is the
 * whole point of the seam: a host that branches on a sentence breaks silently
 * the next time someone improves the wording, which is the coupling this issue
 * exists to prevent. If a case here ever needs to read `message` to know what
 * happened, the line it is reading needs an id instead.
 */

/** Capture stdout and stderr at the console, which is where the contract lives. */
function capturing<T>(body: () => T): { out: string[]; err: string[]; value: T } {
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realError = console.error;
  console.log = (...args: unknown[]) => void out.push(args.join(' '));
  console.error = (...args: unknown[]) => void err.push(args.join(' '));
  try {
    return { out, err, value: body() };
  } finally {
    console.log = realLog;
    console.error = realError;
  }
}

/** Install a sink for the duration, and always take it off again. */
function collecting<T>(body: () => T): { seen: Narration[]; value: T } {
  const seen: Narration[] = [];
  log.setSink((n) => void seen.push(n));
  try {
    return { seen, value: body() };
  } finally {
    log.setSink(null);
  }
}

/**
 * Collect narration from an async body, with the console muted.
 *
 * Muting matters: `orchestrate` prints a whole run, and a test that dumped it
 * into the reporter's output would bury every other case in the file.
 */
async function collectingAsync(body: () => Promise<void>): Promise<Narration[]> {
  const seen: Narration[] = [];
  const realLog = console.log;
  const realError = console.error;
  log.setSink((n) => void seen.push(n));
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    await body();
  } finally {
    console.log = realLog;
    console.error = realError;
    log.setSink(null);
  }
  return seen;
}

test('every level reaches the sink, carrying its own name', () => {
  const { seen } = collecting(() =>
    capturing(() => {
      log.step('a');
      log.info('b');
      log.detail('c');
      log.ok('d');
      log.warn('e');
      log.fail('f');
      log.heading('g');
    }),
  );

  assert.deepEqual(
    seen.map((n) => n.level),
    ['step', 'info', 'detail', 'ok', 'warn', 'error', 'heading'],
  );
  assert.deepEqual(
    seen.map((n) => n.message),
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  );
});

test('id and data are null when the call site did not supply them', () => {
  // Absent, not invented. Most lines are prose nothing branches on, and an id
  // per line would be identifiers nobody consumes and every one a thing to keep
  // in sync. Null is what is true.
  const { seen } = collecting(() => capturing(() => log.info('nothing structured here')));

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.id, null);
  assert.equal(seen[0]?.data, null);
});

test('a call site that supplies identity gets it through unchanged', () => {
  const { seen } = collecting(() =>
    capturing(() =>
      log.warn('Fixing 3 finding(s) carried across the stop', {
        id: 'carried_findings',
        data: { count: 3, ids: ['F-01', 'F-02', 'F-03'] },
      }),
    ),
  );

  assert.equal(seen[0]?.id, 'carried_findings');
  assert.deepEqual(seen[0]?.data, { count: 3, ids: ['F-01', 'F-02', 'F-03'] });
});

test('installing a sink does not change one byte of what the console prints', () => {
  // The acceptance test #133 names. Same calls, twice, with the only difference
  // being whether a sink is attached.
  const calls = (): void => {
    log.step('Planning');
    log.info('  detail line');
    log.detail('dim line');
    log.ok('Plan approved - 2 non-blocking finding(s)');
    log.warn('oscillation: F-04');
    log.fail('the gate failed');
    log.heading('Run summary');
  };

  const without = capturing(calls);
  const withSink = collecting(() => capturing(calls)).value;

  assert.deepEqual(withSink.out, without.out);
  assert.deepEqual(withSink.err, without.err);
  // And the split across the two streams is part of the contract: `fail` is the
  // only one on stderr, which is what makes `vibe run 2>/dev/null` still useful.
  assert.equal(without.err.length, 1);
});

test('a sink that throws does not take the run down with it', () => {
  // The rule `progress.ts` already follows for its own emit, and the reason
  // `record` swallows a broken transcript: a host that throws while rendering is
  // a host bug, not a run failure.
  log.setSink(() => {
    throw new Error('the host is on fire');
  });
  try {
    const { out } = capturing(() => {
      log.ok('this still prints');
    });
    assert.deepEqual(out, [`  ${log.green('OK')} this still prints`]);
  } finally {
    log.setSink(null);
  }
});

test('setSink(null) detaches, and nothing arrives afterwards', () => {
  const seen: Narration[] = [];
  log.setSink((n) => void seen.push(n));
  capturing(() => log.info('heard'));
  log.setSink(null);
  capturing(() => log.info('not heard'));

  assert.deepEqual(
    seen.map((n) => n.message),
    ['heard'],
  );
});

/**
 * The seam in situ: a whole run through `orchestrate`, asserted by level.
 *
 * This is the case that proves the sink is reachable from where it matters
 * rather than only from a direct call. It deliberately asserts nothing about
 * any sentence.
 */
test('a whole run narrates through the sink', async () => {
  const state: RunState = freshRun({
    prefix: 'vibe-narrate-',
    task: 'narration',
    planOnly: false,
    git: true,
    commit: true,
  });

  const passing: Handlers = {
    claude: (label) =>
      label === 'plan' || label.startsWith('revise-') ? planFixture() : work(state, `${label}.txt`),
    codex: () => report([]),
  };

  const calls: string[] = [];
  const seen = await collectingAsync(async () => {
    await orchestrate(
      state,
      config({}, { ...committing(), ...verifying(state) }),
      false,
      agents(passing, calls),
    );
  });

  // The run really did run - otherwise an empty sink would pass vacuously.
  assert.deepEqual(calls, ['plan', 'critique-0', 'implement', 'review-0']);

  assert.ok(seen.length > 0, 'the loop narrated nothing at all');
  // Every level the loop emits is one of the seven it declares. This is the
  // assertion that would catch a new level being added without the host knowing
  // about it.
  const levels = new Set(seen.map((n) => n.level));
  for (const l of levels) {
    assert.ok(
      ['step', 'info', 'detail', 'ok', 'warn', 'error', 'heading'].includes(l),
      `unexpected level ${l}`,
    );
  }
  // A clean pass says nothing at error level.
  assert.equal(
    seen.filter((n) => n.level === 'error').length,
    0,
    seen.filter((n) => n.level === 'error').map((n) => n.message).join(' | '),
  );
  // The loop's own phases are announced as steps, so a host has something to
  // hang a card on even before ids exist.
  assert.ok(seen.some((n) => n.level === 'step'), 'no step-level narration at all');
});
