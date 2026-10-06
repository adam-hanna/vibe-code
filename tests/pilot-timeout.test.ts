import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PILOT_ACCESS_DEFAULTS, PILOT_TIMEOUT_MS, readPilotAccess } from '@src/pilotaccess.js';
import { createSession } from '@src/serve.js';
import type { Outbound } from '@src/protocol.js';
import type { PilotChatOptions } from '@src/pilotchat.js';

/**
 * How long a pilot turn may take, as a setting (#223). It was a fixed five
 * minutes from when the pilot only answered, and a full CLI editing files ran
 * out of it: *"claude timed out after 300000ms. Can we change that anywhere in
 * the settings?"*
 */

test('the default is thirty minutes, the figure a Claude planning turn already has', () => {
  assert.equal(PILOT_TIMEOUT_MS, 30 * 60_000);
  assert.equal(readPilotAccess({}).timeoutMs, PILOT_TIMEOUT_MS);
  assert.equal(PILOT_ACCESS_DEFAULTS.timeoutMs, PILOT_TIMEOUT_MS);
});

test('it is set in the pilot section, and a value that could not run a turn is refused by name', () => {
  assert.equal(readPilotAccess({ pilot: { timeoutMs: 3_600_000 } }).timeoutMs, 3_600_000);
  for (const bad of [0, 59_999, 1.5, '600000', -1]) {
    assert.throws(() => readPilotAccess({ pilot: { timeoutMs: bad } }), /pilot\.timeoutMs must be/, String(bad));
  }
});

test('the turn is given the setting, and one that ran out says where the setting is', async () => {
  let given: number | null = null;
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => Promise.resolve(0),
    pilot: (options: PilotChatOptions) => {
      given = options.timeoutMs;
      // Ran for as long as it was allowed, which is what decides the hint.
      return new Promise((_, reject) => setTimeout(() => reject(new Error('claude timed out after 60000ms')), 5));
    },
    pilotAccess: () => ({ ...PILOT_ACCESS_DEFAULTS, timeoutMs: 1 }),
  });
  const frame = { type: 'pilot', id: 7, prompt: 'p', system: 's', model: 'm', sessionId: 'a', dir: '/repo', resume: false };
  session.write(`${JSON.stringify(frame)}\n`);
  for (let i = 0; i < 50 && !sent.some((m) => m.type === 'error'); i += 1) await new Promise((r) => setTimeout(r, 5));
  assert.equal(given, 1);
  const error = sent.find((m) => m.type === 'error');
  assert.ok(error !== undefined && error.type === 'error');
  assert.match(error.message, /claude timed out after 60000ms - the pilot's limit is .* in Settings \(pilot\.timeoutMs\)/);
});

test('a failure well inside the limit is reported as itself', async () => {
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => Promise.resolve(0),
    pilot: () => Promise.reject(new Error('model not found')),
    pilotAccess: () => PILOT_ACCESS_DEFAULTS,
  });
  const frame = { type: 'pilot', id: 8, prompt: 'p', system: 's', model: 'm', sessionId: 'a', dir: '/repo', resume: false };
  session.write(`${JSON.stringify(frame)}\n`);
  for (let i = 0; i < 50 && !sent.some((m) => m.type === 'error'); i += 1) await new Promise((r) => setTimeout(r, 5));
  const error = sent.find((m) => m.type === 'error');
  assert.ok(error !== undefined && error.type === 'error');
  assert.equal(error.message, 'model not found');
});
