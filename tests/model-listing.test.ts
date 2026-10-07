import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULTS } from '@src/config.js';
import { CLI_DEFAULT, modelArgs, readClaudeModels, readCodexModels } from '@src/models.js';
import { pilotChatArgs } from '@src/pilotchat.js';
import { pilotCodexArgs } from '@src/pilotcodex.js';
import { decode } from '@src/protocol.js';
import { createSession } from '@src/serve.js';
import type { ModelListings } from '@src/models.js';
import type { PilotChatOptions } from '@src/pilotchat.js';
import type { Outbound } from '@src/protocol.js';

/**
 * Which models each CLI offers, asked of the CLI (#223). Every picker read a list
 * this repository shipped, and every one had aged: *"What if claude introduces a
 * new model, we have to change source code? I really want to avoid that."*
 */

// Trimmed from what `claude` 2.1.287 answered to `initialize` on 2026-10-06.
const CLAUDE = [
  { value: 'default', resolvedModel: 'claude-fable-5-1', displayName: 'Default (recommended)', description: 'Fable 5.1' },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'For complex work and everyday tasks' },
  { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'For your toughest challenges' },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5', description: 'Fastest for quick answers' },
  { value: 'claude-opus-5', resolvedModel: 'claude-opus-5', displayName: 'Opus 5', description: 'Best for everyday, complex tasks' },
];

// And from what `codex app-server` 0.157.1 answered to `model/list`.
const CODEX = {
  data: [
    { id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6-Astra', description: 'Frontier intelligence', hidden: false, isDefault: true },
    { id: 'gpt-6-luna', model: 'gpt-6-luna', displayName: 'GPT-6-Luna', description: 'Fast and affordable', hidden: false, isDefault: false },
    { id: 'secret', model: 'secret', displayName: 'Secret', description: '', hidden: true, isDefault: false },
  ],
  nextCursor: null,
};

test("Claude's list is read as it was sent, with its default first and named for what it resolves to", () => {
  const models = readClaudeModels(CLAUDE);
  assert.ok(models !== null);
  assert.deepEqual(models[0], { value: 'default', resolves: 'claude-fable-5-1', name: 'Default', description: 'Fable 5.1' });
  assert.deepEqual(
    models.map((m) => m.value),
    ['default', 'opus', 'fable', 'haiku', 'claude-opus-5'],
  );
  assert.equal(models[1]?.resolves, 'claude-opus-5-5');
});

test("Codex's default is offered as `default`, ahead of the model it is today, and hidden ones are not offered", () => {
  const models = readCodexModels([CODEX]);
  assert.ok(models !== null);
  assert.deepEqual(models[0], { value: 'default', resolves: 'gpt-6-astra', name: 'Default', description: 'Frontier intelligence' });
  assert.deepEqual(
    models.map((m) => m.value),
    ['default', 'gpt-6-astra', 'gpt-6-luna'],
  );
});

test('a shape this build cannot read is no list, never a guessed one', () => {
  assert.equal(readClaudeModels(undefined), null);
  assert.equal(readClaudeModels([]), null);
  assert.equal(readClaudeModels([{ name: 'no value field' }]), null);
  assert.equal(readCodexModels([{ models: [] }]), null);
  assert.equal(readCodexModels([{ data: [] }]), null);
});

test('both run defaults follow the CLI, and `default` sends no model flag at all', () => {
  assert.equal(DEFAULTS.claude.model, CLI_DEFAULT);
  assert.equal(DEFAULTS.codex.model, CLI_DEFAULT);
  assert.deepEqual(modelArgs('--model', CLI_DEFAULT), []);
  assert.deepEqual(modelArgs('-m', 'gpt-6-luna'), ['-m', 'gpt-6-luna']);
});

test('every place a CLI is told its model goes through `modelArgs`', () => {
  // A site that still writes the flag itself would send `--model default` to
  // Claude and `-m default` to Codex, which refuses it.
  for (const file of ['src/claude.ts', 'src/codex.ts', 'src/pilotchat.ts', 'src/pilotcodex.ts', 'src/preflight.ts']) {
    const src = readFileSync(file, 'utf8');
    assert.doesNotMatch(src, /(?<!modelArgs\()'-m',\s*(model|options\.model|cfg\.codex\.model)\b/, file);
    assert.doesNotMatch(src, /(?<!modelArgs\()'--model',\s*(model|options\.model)\b/, file);
  }
});

test('the pilot on either CLI follows that CLI when told `default`', () => {
  const options: PilotChatOptions = {
    prompt: 'hi',
    system: 's',
    sessionId: 'x',
    resume: false,
    model: CLI_DEFAULT,
    cwd: '/repo',
    timeoutMs: 1000,
  };
  assert.ok(!pilotChatArgs(options).includes('--model'));
  assert.ok(!pilotCodexArgs(options, '/i.md').includes('-m'));
  assert.ok(pilotChatArgs({ ...options, model: 'opus' }).includes('opus'));
});

test('the host answers with the listing, keeps a good one and asks again after a failure', async () => {
  assert.deepEqual(decode('{"type":"models","id":3}'), { ok: true, message: { type: 'models', id: 3, fresh: false } });
  let asked = 0;
  let answer: ModelListings = {
    claude: { ok: false, why: 'no key yet' },
    codex: { ok: true, models: [] },
  };
  const sent: Outbound[] = [];
  const session = createSession((m) => sent.push(m), {
    models: async () => {
      asked += 1;
      return answer;
    },
  });
  const ask = async (line: string): Promise<void> => {
    session.write(`${line}\n`);
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
  };
  await ask('{"type":"models","id":1}');
  answer = { claude: { ok: true, models: [] }, codex: { ok: true, models: [] } };
  await ask('{"type":"models","id":2}');
  await ask('{"type":"models","id":3}');
  assert.equal(asked, 2, 'the failure was retried, and the good answer was kept');
  await ask('{"type":"models","id":4,"fresh":true}');
  assert.equal(asked, 3, 'fresh asks again');
  const frames = sent.filter((m) => m.type === 'models');
  assert.equal(frames.length, 4);
  assert.deepEqual(frames[0], { type: 'models', id: 1, listings: { claude: { ok: false, why: 'no key yet' }, codex: { ok: true, models: [] } } });
});
