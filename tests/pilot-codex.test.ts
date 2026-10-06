import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeBin } from '@src/claude.js';
import { configuredBin, readCliPaths } from '@src/clipaths.js';
import { loadConfig, writeConfigPatch } from '@src/config.js';
import { OFF, pilotCodex, pilotCodexArgs } from '@src/pilotcodex.js';
import { decode } from '@src/protocol.js';
import { createSession } from '@src/serve.js';
import type { RunFn, RunOptions } from '@src/proc.js';
import type { Outbound } from '@src/protocol.js';
import type { PilotChatOptions, PilotChatResult } from '@src/pilotchat.js';

/**
 * The OpenAI subscription pilot, and telling vibe where the CLIs are (#223).
 *
 * *"two options for both anthropic and openAI: (1) subscription, (2) api key.
 * For subscription, we should talk about how we look for the cli tool but give
 * them an option to provide a path."* The Codex turn is driven through an
 * injected `exec`, because the real CLI needs a login and spends quota; it was
 * run for real once while this was built (a new thread and a resume, with the
 * instructions file honoured on both), and these pin the shape that did.
 */

const OPTIONS: PilotChatOptions = {
  prompt: 'hello',
  system: 'you are the pilot',
  sessionId: 'thread-1',
  resume: false,
  model: 'gpt-5.6-luna',
  cwd: '/repo',
  timeoutMs: 1000,
};

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };

test('a new Codex chat turn has its shell, in the workspace-write sandbox, with the extras off', () => {
  // Case 2 (#223): this pinned a read-only pilot with its shell switched off,
  // and the owner reversed that - a full CLI bounded by the settings. What still
  // holds is kept: in the project, no user config (so no MCP), no web search,
  // the non-coding features off, the instructions file, the prompt on stdin.
  const args = pilotCodexArgs({ ...OPTIONS, addDirs: ['/repo', '/notes'] }, '/tmp/x/instructions.md');
  assert.equal(args[0], 'exec');
  assert.ok(!args.includes('-s'), 'the sandbox is set by -c, the one form resume also takes');
  assert.ok(args.includes('sandbox_mode="workspace-write"'));
  assert.ok(args.includes('sandbox_workspace_write.writable_roots=["/notes"]'), 'the repository is the workspace already');
  assert.deepEqual(args.slice(args.indexOf('-C'), args.indexOf('-C') + 2), ['-C', '/repo']);
  assert.ok(args.includes('--ignore-user-config'), 'no config.toml, so no MCP servers');
  for (const feature of ['shell_tool', 'unified_exec', 'code_mode_host']) {
    assert.ok(!OFF.includes(feature), `${feature} is the shell, and is on`);
  }
  for (const feature of ['browser_use', 'computer_use', 'multi_agent', 'plugins']) {
    assert.ok(args.join(' ').includes(`--disable ${feature}`), `${feature} is off`);
  }
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes('model_instructions_file="/tmp/x/instructions.md"'));
  assert.equal(args[args.length - 1], '-', 'the prompt arrives on stdin');
});

test('YOLO drops the sandbox, on a resume as well', () => {
  const yolo = { ...OPTIONS, access: { yolo: true, safeCommands: [] } };
  for (const args of [pilotCodexArgs(yolo, '/i.md'), pilotCodexArgs({ ...yolo, resume: true }, '/i.md')]) {
    assert.ok(args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!args.includes('sandbox_mode="workspace-write"'));
  }
});

test('a resumed turn names the thread and sends neither -C nor -s, which resume refuses', () => {
  const args = pilotCodexArgs({ ...OPTIONS, resume: true }, '/i.md');
  assert.deepEqual(args.slice(0, 3), ['exec', 'resume', 'thread-1']);
  assert.ok(!args.includes('-C'));
  assert.ok(!args.includes('-s'));
  assert.ok(args.includes('--disable'));
});

const line = (v: unknown): string => JSON.stringify(v);

test('every message reaches the window, the last is the reply, and the instructions file is gone after', async () => {
  let instructionsSeen: string | null = null;
  let instructionsAt: string | null = null;
  const exec: RunFn = (_bin, args, options?: RunOptions) => {
    const flag = args.find((a) => a.startsWith('model_instructions_file='));
    instructionsAt = flag === undefined ? null : (JSON.parse(flag.slice(flag.indexOf('=') + 1)) as string);
    instructionsSeen = instructionsAt === null ? null : readFileSync(instructionsAt, 'utf8');
    const out = [
      line({ type: 'thread.started', thread_id: 'th-9' }),
      line({ type: 'item.completed', item: { type: 'agent_message', text: 'reading' } }),
      line({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
      line({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 2 } }),
    ];
    for (const l of out) options?.onLine?.(l);
    return Promise.resolve({ code: 0, signal: null, stdout: out.join('\n'), stderr: '' });
  };
  const deltas: string[] = [];
  const reply = await pilotCodex({ ...OPTIONS, onDelta: (t) => deltas.push(t) }, exec, () => null);
  assert.equal(instructionsSeen, 'you are the pilot');
  assert.equal(reply.text, 'done');
  assert.equal(reply.sessionId, 'th-9', "Codex's thread is the one that resumes");
  assert.equal(reply.tokens.total, 12);
  // Joined with a blank line, so a block in an early message is not run into the next.
  assert.deepEqual(deltas, ['reading', '\n\ndone']);
  assert.ok(instructionsAt !== null && !existsSync(instructionsAt));
});

test('a turn that failed, or said nothing, is an error and never an empty reply', async () => {
  const failing: RunFn = () =>
    Promise.resolve({
      code: 1,
      signal: null,
      stdout: line({ type: 'turn.failed', error: { message: 'model not found' } }),
      stderr: '',
    });
  await assert.rejects(pilotCodex(OPTIONS, failing, () => null), /model not found/);
  const silent: RunFn = () => Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '' });
  await assert.rejects(pilotCodex(OPTIONS, silent, () => null), /said nothing/);
});

const settle = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

test('the host sends a turn naming codex to the Codex pilot, and only that one', async () => {
  const seen: string[] = [];
  const answer = (who: string) => (): Promise<PilotChatResult> => {
    seen.push(who);
    return Promise.resolve({ text: 'ok', sessionId: 's', tokens: ZERO, context: null });
  };
  const sent: Outbound[] = [];
  const session = createSession((m) => void sent.push(m), {
    invoke: () => Promise.resolve(0),
    pilot: answer('claude'),
    pilotCodex: answer('codex'),
    pilotAccess: () => ({
      yolo: false,
      safeCommands: [],
      dirs: [],
      anthropic: 'subscription',
      openai: 'subscription',
    }),
  });
  const frame = { type: 'pilot', prompt: 'p', system: 's', model: 'm', sessionId: 'a', dir: '/repo', resume: false };
  session.receive(line({ ...frame, id: 1, agent: 'codex' }));
  session.receive(line({ ...frame, id: 2 }));
  await settle();
  assert.deepEqual(seen, ['codex', 'claude'], 'absent is claude, which is what older windows send');
  assert.equal(decode(line({ ...frame, id: 3, agent: 'gemini' })).ok, false);
});

function withEnv<T>(vars: Record<string, string | undefined>, body: () => T): T {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return body();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('a CLI path in the settings is used, the environment variable still wins, and a bad one is named', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'vibe-cli-'));
  const global = path.join(home, 'config.json');
  const fake = path.join(home, 'claude');
  writeFileSync(fake, '#!/bin/sh\n');
  chmodSync(fake, 0o755);
  writeFileSync(global, JSON.stringify({ cli: { claude: fake } }));
  withEnv({ VIBE_GLOBAL_CONFIG: global, VIBE_CLAUDE_BIN: undefined }, () => {
    assert.equal(claudeBin(), fake);
  });
  const other = path.join(home, 'other-claude');
  writeFileSync(other, '');
  withEnv({ VIBE_GLOBAL_CONFIG: global, VIBE_CLAUDE_BIN: other }, () => {
    assert.equal(claudeBin(), other, 'the environment variable is the more specific act');
  });
  writeFileSync(global, JSON.stringify({ cli: { claude: path.join(home, 'nope') } }));
  withEnv({ VIBE_GLOBAL_CONFIG: global, VIBE_CLAUDE_BIN: undefined }, () => {
    assert.throws(() => configuredBin('claude'), /cli\.claude in your settings points at/);
  });
});

test('the cli section is validated by name, and a project file may not set it', () => {
  assert.deepEqual(readCliPaths({ cli: { codex: '/x/codex', claude: null } }), { claude: null, codex: '/x/codex' });
  assert.throws(() => readCliPaths({ cli: { gemini: '/x' } }), /cli\.gemini is not a setting/);
  assert.throws(() => readCliPaths({ cli: { claude: 7 } }), /cli\.claude must be a path/);

  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibe-cli-project-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ cli: { claude: '/evil' } }));
  assert.throws(() => loadConfig(dir), /sets cli, and only your settings for all projects can/);
  const fresh = mkdtempSync(path.join(os.tmpdir(), 'vibe-cli-project-'));
  assert.throws(() => writeConfigPatch(fresh, { cli: { codex: '/x' } }, 'project'), /sets cli/);
});

test('a route that is not one of the two is refused', () => {
  // The routes moved from `pilot` to `auth` when they began to cover runs as
  // well (#223); the claim - only the two values, refused by name - is unchanged.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibe-route-'));
  const global = path.join(dir, 'g.json');
  withEnv({ VIBE_GLOBAL_CONFIG: global }, () => {
    writeConfigPatch(dir, { auth: { openai: 'api' } }, 'global');
    assert.throws(() => writeConfigPatch(dir, { auth: { anthropic: 'keys' } }, 'global'), /auth\.anthropic must be/);
  });
});
