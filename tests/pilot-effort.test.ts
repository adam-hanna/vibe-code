import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pilotChatArgs } from '@src/pilotchat.js';
import type { PilotChatOptions } from '@src/pilotchat.js';
import { pilotCodexArgs } from '@src/pilotcodex.js';
import { decode } from '@src/protocol.js';

/**
 * The pilot's effort (#296): picked beside the model, carried on the `pilot`
 * frame, and handed to each CLI as the flag a run's seat already takes.
 */

const OPTIONS: PilotChatOptions = {
  prompt: 'hello',
  system: 'you are the pilot',
  sessionId: 'thread-1',
  resume: false,
  model: 'default',
  cwd: '/repo',
  timeoutMs: 1000,
};

const frame = (extra: Record<string, unknown>): string =>
  JSON.stringify({
    type: 'pilot',
    id: 7,
    prompt: 'hi',
    system: 's',
    model: 'default',
    sessionId: 'abc',
    dir: '/repo',
    resume: false,
    ...extra,
  });

test('the frame carries an effort the CLIs take, and leaves it out when none was picked', () => {
  const picked = decode(frame({ effort: 'high' }));
  assert.ok(picked.ok);
  assert.equal(picked.ok && picked.message.type === 'pilot' ? picked.message.effort : null, 'high');

  const none = decode(frame({}));
  assert.ok(none.ok && none.message.type === 'pilot' && !('effort' in none.message));
});

test('an effort neither CLI takes is refused by the frame, not by a spawned child', () => {
  const bad = decode(frame({ effort: 'turbo' }));
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? '' : bad.reason, /effort must be one of low, medium, high, xhigh, max/);
});

test('Claude is told with --effort, and only when one was picked', () => {
  const args = pilotChatArgs({ ...OPTIONS, effort: 'xhigh' });
  const at = args.indexOf('--effort');
  assert.ok(at > -1);
  assert.equal(args[at + 1], 'xhigh');
  assert.ok(!pilotChatArgs(OPTIONS).includes('--effort'));
});

test('Codex is told with model_reasoning_effort, on a resume as well as a new thread', () => {
  for (const resume of [false, true]) {
    const args = pilotCodexArgs({ ...OPTIONS, resume, effort: 'low' }, '/i.md');
    assert.ok(args.includes('model_reasoning_effort="low"'), `resume=${String(resume)}`);
  }
  assert.ok(!pilotCodexArgs(OPTIONS, '/i.md').some((a) => a.startsWith('model_reasoning_effort')));
});
