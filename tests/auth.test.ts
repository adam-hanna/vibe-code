import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentEnv, readRoutes } from '@src/auth.js';
import { loadConfig, writeConfigPatch } from '@src/config.js';
import { acceptKeys, KEYS_SECRET_VAR, resetKeys } from '@src/heldkeys.js';
import { readPilotAccess } from '@src/pilotaccess.js';
import { run } from '@src/proc.js';

/**
 * One road per vendor, for runs as well as the pilot (#223).
 *
 * *"If we have api keys set, we should use them everywhere (pilot, runs, etc).
 * Same for subscriptions."* No CLI is spawned here: what decides the billing is
 * the environment a child is given, and that is a pure function of the route
 * and the keys held, so these drive `agentEnv` directly. That both CLIs prefer
 * a key in the environment to their login was measured once by hand while this
 * was built, with a bogus key each.
 */

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

const SUB = { anthropic: 'subscription', openai: 'subscription' } as const;
const API = { anthropic: 'api', openai: 'api' } as const;
const SHELL_KEYS = {
  ANTHROPIC_API_KEY: 'sk-ant-from-the-shell',
  ANTHROPIC_AUTH_TOKEN: 'token-from-the-shell',
  OPENAI_API_KEY: 'sk-openai-from-the-shell',
  CODEX_API_KEY: undefined,
};

test('on the subscription, a key in the environment never reaches the CLI', () => {
  withEnv(SHELL_KEYS, () => {
    const claude = agentEnv('claude', SUB);
    assert.equal(claude['ANTHROPIC_API_KEY'], undefined);
    assert.equal(claude['ANTHROPIC_AUTH_TOKEN'], undefined);
    const codex = agentEnv('codex', SUB);
    assert.equal(codex['OPENAI_API_KEY'], undefined);
    assert.equal(codex['CODEX_API_KEY'], undefined);
    // Nothing else about the environment moves.
    assert.equal(claude['PATH'], process.env['PATH']);
  });
});

test('on a key, the app’s key wins, and a terminal’s own key is the fallback', () => {
  resetKeys();
  withEnv(SHELL_KEYS, () => {
    assert.equal(agentEnv('claude', API)['ANTHROPIC_API_KEY'], 'sk-ant-from-the-shell');
    // OpenAI's usual name is read, and Codex is handed the one `codex exec` reads.
    const codex = agentEnv('codex', API);
    assert.equal(codex['CODEX_API_KEY'], 'sk-openai-from-the-shell');
    assert.equal(codex['OPENAI_API_KEY'], undefined);
  });
  withEnv({ [KEYS_SECRET_VAR]: 'the-secret' }, () => {
    assert.equal(acceptKeys({ type: 'keys', secret: 'the-secret', anthropic: 'sk-ant-from-the-app', openai: null }), true);
  });
  withEnv(SHELL_KEYS, () => {
    assert.equal(agentEnv('claude', API)['ANTHROPIC_API_KEY'], 'sk-ant-from-the-app');
  });
  resetKeys();
});

test('a key route with no key anywhere is refused before anything spawns', () => {
  resetKeys();
  withEnv({ ANTHROPIC_API_KEY: undefined, CODEX_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => {
    assert.throws(() => agentEnv('claude', API), /auth\.anthropic is "api", and there is no Anthropic key/);
    assert.throws(() => agentEnv('codex', API), /set CODEX_API_KEY, or switch OpenAI to subscription/);
  });
});

test('a keys frame without the app’s secret is refused, and the secret leaves the environment', () => {
  resetKeys();
  withEnv({ [KEYS_SECRET_VAR]: 'the-secret', ANTHROPIC_API_KEY: undefined }, () => {
    assert.equal(acceptKeys({ type: 'keys', secret: 'a-guess', anthropic: 'sk-ant-forged' }), false);
    assert.equal(process.env[KEYS_SECRET_VAR], undefined, 'no child inherits it');
    assert.throws(() => agentEnv('claude', API), /no Anthropic key/);
  });
  resetKeys();
  withEnv({ [KEYS_SECRET_VAR]: undefined }, () => {
    // A host the app did not spawn takes no keys frame at all.
    assert.equal(acceptKeys({ type: 'keys', secret: undefined, anthropic: 'sk-ant-x' }), false);
  });
  resetKeys();
});

test('what a child prints is redacted of every key it could have been given', async () => {
  resetKeys();
  const key = 'sk-bogus-0123456789';
  await withEnv({ CODEX_API_KEY: key }, async () => {
    const out = await run(process.execPath, [
      '-e',
      `console.log("Incorrect API key provided: ${key}."); console.error("${key}")`,
    ]);
    assert.ok(!out.stdout.includes(key) && !out.stderr.includes(key));
    assert.match(out.stdout, /Incorrect API key provided: \[redacted key\]\./);
  });
});

test('the routes are the machine’s, and moved out of pilot by name', () => {
  assert.deepEqual(readRoutes({ auth: { openai: 'api' } }), { anthropic: 'subscription', openai: 'api' });
  assert.throws(() => readRoutes({ auth: { gemini: 'api' } }), /auth\.gemini is not a setting/);
  assert.throws(() => readPilotAccess({ pilot: { anthropic: 'api' } }), /pilot\.anthropic has moved to auth\.anthropic/);
  assert.equal(readPilotAccess({ auth: { anthropic: 'api' } }).anthropic, 'api');

  const dir = mkdtempSync(path.join(os.tmpdir(), 'vibe-auth-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify({ auth: { anthropic: 'api' } }));
  assert.throws(() => loadConfig(dir), /sets auth, and only your settings for all projects can/);
  const fresh = mkdtempSync(path.join(os.tmpdir(), 'vibe-auth-'));
  assert.throws(() => writeConfigPatch(fresh, { auth: { openai: 'api' } }, 'project'), /sets auth/);
});
