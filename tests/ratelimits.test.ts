import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideCodexLimit, parseRateLimits, recordLimits } from '@src/ratelimits.js';
import type { CodexRateLimits } from '@src/ratelimits.js';

/** The payload measured against a real ChatGPT Plus account, verbatim. */
const MEASURED = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 15, windowDurationMins: 10080, resetsAt: 1787196925 },
    secondary: null,
    credits: { hasCredits: true, unlimited: false, balance: '974.5723860000' },
    spendControlReached: false,
    planType: 'plus',
  },
};

function twoWindows(primaryPercent: number, secondaryPercent: number, reached?: string): unknown {
  return {
    rateLimits: {
      primary: { usedPercent: primaryPercent, windowDurationMins: 10080, resetsAt: 1787196925 },
      secondary: { usedPercent: secondaryPercent, windowDurationMins: 300, resetsAt: 1787100000 },
      ...(reached === undefined ? {} : { rateLimitReachedType: reached }),
      planType: 'plus',
    },
  };
}

function parsed(payload: unknown): CodexRateLimits {
  const limits = parseRateLimits(payload);
  assert.ok(limits !== null, 'expected the payload to parse');
  return limits;
}

test('the measured payload parses', () => {
  const limits = parsed(MEASURED);

  assert.equal(limits.primary?.usedPercent, 15);
  assert.equal(limits.primary?.windowDurationMins, 10080);
  assert.deepEqual(limits.primary?.resetsAt, new Date(1787196925 * 1000));
  assert.equal(limits.secondary, null);
  assert.equal(limits.planType, 'plus');
  // The key is absent from the measured payload, so absent must read as "not reached".
  assert.equal(limits.reachedType, null);
  assert.equal(limits.reachedWindow, null);
  assert.equal(limits.worstWindow.kind, 'primary');
  assert.equal(limits.usedPercent, 15);
});

test('a pushed update parses identically to a polled read', () => {
  const fromRead = parsed(MEASURED);
  // The notification carries the same object under params; one parser serves both.
  const fromPush = parsed({ rateLimits: MEASURED.rateLimits });

  assert.deepEqual({ ...fromPush, capturedAt: null }, { ...fromRead, capturedAt: null });
});

test('a bare rateLimits object parses too', () => {
  assert.equal(parsed(MEASURED.rateLimits).usedPercent, 15);
});

test('the fuller window is the worst one', () => {
  assert.equal(parsed(twoWindows(10, 90)).worstWindow.kind, 'secondary');
  assert.equal(parsed(twoWindows(90, 10)).worstWindow.kind, 'primary');
  assert.equal(parsed(twoWindows(90, 10)).usedPercent, 90);
});

test('an unusable payload reads as no signal rather than a zero reading', () => {
  assert.equal(parseRateLimits({}), null);
  assert.equal(parseRateLimits(null), null);
  assert.equal(parseRateLimits('nope'), null);
  assert.equal(parseRateLimits([]), null);
  assert.equal(parseRateLimits({ rateLimits: { primary: {}, secondary: null } }), null);
  assert.equal(parseRateLimits({ rateLimits: { primary: { usedPercent: 'lots' } } }), null);
});

test('reachedType resolves to the window it names, and only to that window', () => {
  assert.equal(parsed(twoWindows(10, 90, 'primary')).reachedWindow?.kind, 'primary');
  assert.equal(parsed(twoWindows(10, 90, 'secondary')).reachedWindow?.kind, 'secondary');
  assert.equal(parsed(twoWindows(10, 90, 'PRIMARY')).reachedWindow?.kind, 'primary');

  const unknown = parsed(twoWindows(10, 90, 'weekly'));
  assert.equal(unknown.reachedType, 'weekly');
  assert.equal(unknown.reachedWindow, null);
});

test('a resetsAt already in milliseconds is not multiplied again', () => {
  const ms = 1787196925000;
  const limits = parsed({ rateLimits: { primary: { usedPercent: 5, resetsAt: ms } } });

  assert.deepEqual(limits.primary?.resetsAt, new Date(ms));
});

test('a reached primary window waits on the primary reset', () => {
  const limits = parsed(twoWindows(80, 20, 'primary'));
  const decision = decideCodexLimit(limits, 95);

  assert.equal(decision.action, 'wait');
  if (decision.action !== 'wait') return;
  assert.equal(decision.window?.kind, 'primary');
  assert.deepEqual(decision.resetsAt, limits.primary?.resetsAt);
});

test('a reached secondary window waits on the secondary reset, not the fuller one', () => {
  // primary is fuller, secondary is the one that was actually reached: waiting
  // on the fuller window's reset would resume straight back into the limit.
  const limits = parsed(twoWindows(90, 40, 'secondary'));
  const decision = decideCodexLimit(limits, 95);

  assert.equal(decision.action, 'wait');
  if (decision.action !== 'wait') return;
  assert.equal(decision.window?.kind, 'secondary');
  assert.deepEqual(decision.resetsAt, limits.secondary?.resetsAt);
  assert.notDeepEqual(decision.resetsAt, limits.primary?.resetsAt);
});

test('a reached type naming no known window waits without inventing a reset', () => {
  const decision = decideCodexLimit(parsed(twoWindows(10, 20, 'weekly')), 95);

  assert.equal(decision.action, 'wait');
  if (decision.action !== 'wait') return;
  assert.equal(decision.window, null);
  assert.equal(decision.resetsAt, null);
  assert.match(decision.reason, /weekly/);
});

test('the threshold stops on the window that fired', () => {
  const decision = decideCodexLimit(parsed(twoWindows(30, 96)), 95);

  assert.equal(decision.action, 'stop');
  if (decision.action !== 'stop') return;
  assert.equal(decision.window.kind, 'secondary');
  assert.match(decision.reason, /codexLimitPercent/);
});

test('the threshold fires at exactly the configured percent and not below it', () => {
  assert.equal(decideCodexLimit(parsed(twoWindows(95, 10)), 95).action, 'stop');
  assert.equal(decideCodexLimit(parsed(twoWindows(94, 10)), 95).action, 'proceed');
});

test('a threshold of zero disables the stop entirely', () => {
  assert.equal(decideCodexLimit(parsed(twoWindows(99, 99)), 0).action, 'proceed');
});

test('recordLimits keeps the server-named window and says so', () => {
  const limits = parsed(twoWindows(90, 40, 'secondary'));
  const decision = decideCodexLimit(limits, 95);
  assert.equal(decision.action, 'wait');
  if (decision.action !== 'wait') return;

  const record = recordLimits(limits, decision.window);

  assert.equal(record.window, 'secondary');
  assert.equal(record.windowFromServer, true);
  assert.equal(record.usedPercent, 40);
  assert.equal(record.reachedType, 'secondary');
});

test('recordLimits falls back to the fuller window and flags that it did', () => {
  const limits = parsed(twoWindows(10, 90, 'weekly'));
  const decision = decideCodexLimit(limits, 95);
  assert.equal(decision.action, 'wait');
  if (decision.action !== 'wait') return;

  const record = recordLimits(limits, decision.window);

  assert.equal(record.window, 'secondary');
  assert.equal(record.usedPercent, 90);
  // The window came from vibe, not from the server: the summary must not claim
  // this reset is the one the server reported.
  assert.equal(record.windowFromServer, false);
  assert.equal(record.reachedType, 'weekly');
});

test('recordLimits handles a proceed decision, which names no window at all', () => {
  const limits = parsed(twoWindows(10, 20));
  const record = recordLimits(limits, null);

  assert.equal(record.window, 'secondary');
  assert.equal(record.windowFromServer, false);
  assert.equal(record.reachedType, null);
});

test('a record survives the JSON round trip that state.json puts it through', () => {
  const record = recordLimits(parsed(MEASURED), null);

  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
  assert.equal(record.resetsAt, new Date(1787196925 * 1000).toISOString());
  assert.equal(typeof record.capturedAt, 'string');
});
