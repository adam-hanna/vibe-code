#!/usr/bin/env node
// Prove, against the real CLIs, that a run's children reach no MCP server (#138).
//
// NOT part of `npm test`: it spawns real `codex` and `claude` turns, which the
// suite never does (AGENTS.md). Run it by hand after `npm run build`:
//
//   npm run build && node scripts/verify-mcp-closure.mjs
//
// Every check is marker-on-launch: the test server is a `node -e` that writes a
// file the moment it is started, so the result does not depend on what the
// model chooses to do with its tools - only on whether the CLI launched the
// server at all. Each closed case has a control that launches the same server,
// so an absent marker means "closed", not "the marker server is broken".
//
// It builds a throwaway CODEX_HOME and CLAUDE_CONFIG_DIR holding copies of your
// credentials (0600, removed at the end) and a marker server, so neither your
// own config nor your own MCP servers are touched or used. Costs four cheap
// agent turns (two Codex, two Claude haiku) and one app-server session.

import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'src');
const load = (m) => import(path.join(dist, m));

const { codexTurn, codexBin } = await load('codex.js');
const { claudeTurn } = await load('claude.js');
const { claudeMcpDefinitions, resolveClaudeGrants } = await load('mcp.js');
const { AppServerClient, spawnCodexAppServer } = await load('appserver.js');
const { run } = await load('proc.js');

const root = mkdtempSync(path.join(os.tmpdir(), 'vibe-mcp-verify-'));
const marker = path.join(root, 'MARKER');
const results = [];
const record = (name, expected, launched, detail = '') => {
  const pass = expected === null ? true : launched === expected;
  results.push({ name, expected, launched, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}: marker ${launched ? 'PRESENT' : 'absent'}${detail ? ` - ${detail}` : ''}`);
};
const clearMarker = () => rmSync(marker, { force: true });
const launched = () => existsSync(marker);

// The marker server: writes the file and exits. A server that dies at once is
// enough - launching it is the whole question.
const markerServer = {
  command: process.execPath,
  args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`],
};

const work = path.join(root, 'work');
mkdirSync(work, { recursive: true });
// The argv as printed: the plan-mode note is a paragraph, and it is not what is being checked.
const shown = (args) =>
  args.map((a, i) => (args[i - 1] === '--append-system-prompt' ? '<PLAN_MODE_NOTE>' : a)).join(' ');

try {
  // ---- Codex ----------------------------------------------------------------
  const codexHome = path.join(root, 'codex-home');
  mkdirSync(codexHome, { recursive: true });
  const realCodexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  copyFileSync(path.join(realCodexHome, 'auth.json'), path.join(codexHome, 'auth.json'));
  chmodSync(path.join(codexHome, 'auth.json'), 0o600);
  writeFileSync(
    path.join(codexHome, 'config.toml'),
    [
      '[mcp_servers.marker]',
      `command = ${JSON.stringify(markerServer.command)}`,
      `args = ${JSON.stringify(markerServer.args)}`,
      'startup_timeout_sec = 5',
      '',
    ].join('\n'),
    'utf8',
  );
  // `agentEnv` copies process.env, so every codex child vibe spawns - the
  // listing, the turn, the app-server - sees this home and only this home.
  process.env.CODEX_HOME = codexHome;

  const schema = {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
    additionalProperties: false,
  };
  const codexOptions = (name, mcpServers) => ({
    prompt: 'Answer {"ok": true}. Do not run any command or call any tool.',
    schema,
    schemaName: name,
    artifactDir: root,
    model: 'default',
    effort: 'low',
    sandbox: 'read-only',
    cwd: work,
    timeoutMs: 180_000,
    ...(mcpServers === undefined ? {} : { mcpServers }),
  });
  const argvOf = [];
  const recordingRun = (bin, args, options) => {
    argvOf.push([...args]);
    return run(bin, args, options);
  };

  clearMarker();
  argvOf.length = 0;
  try {
    await codexTurn(codexOptions('closed'), recordingRun);
  } catch (err) {
    console.log(`  (codex closed turn reported: ${err.message.split('\n')[0]})`);
  }
  const closedTurn = argvOf.find((a) => a[0] === 'exec') ?? [];
  record('codex exec, no grant (vibe argv)', false, launched(), `argv: codex ${shown(closedTurn)}`);

  clearMarker();
  argvOf.length = 0;
  try {
    await codexTurn(codexOptions('granted', ['marker']), recordingRun);
  } catch (err) {
    console.log(`  (codex granted turn reported: ${err.message.split('\n')[0]})`);
  }
  const grantedTurn = argvOf.find((a) => a[0] === 'exec') ?? [];
  record('codex exec, granted "marker" (positive control)', true, launched(), `argv: codex ${shown(grantedTurn)}`);

  // ---- Codex app-server -----------------------------------------------------
  // Spawned with no -c, as both callers spawn it (ratelimits.ts, models.ts).
  // Informational: whichever way it goes decides whether it needs closing.
  clearMarker();
  const client = new AppServerClient(spawnCodexAppServer(codexBin(), work), {
    handshakeTimeoutMs: 30_000,
    requestTimeoutMs: 30_000,
  });
  let appDetail = 'initialize + account/rateLimits/read + model/list';
  try {
    await client.handshake();
    await client.request('account/rateLimits/read', undefined, 30_000).catch((e) => {
      appDetail += ` (rateLimits: ${e.message})`;
    });
    await client.request('model/list', {}, 30_000).catch((e) => {
      appDetail += ` (model/list: ${e.message})`;
    });
    await sleep(5_000);
  } catch (err) {
    appDetail += ` (handshake: ${err.message})`;
  } finally {
    client.close();
  }
  record('codex app-server (no -c), measured', null, launched(), appDetail);

  // ---- Claude ---------------------------------------------------------------
  const claudeHome = path.join(root, 'claude-config');
  mkdirSync(claudeHome, { recursive: true });
  const realClaudeDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
  copyFileSync(path.join(realClaudeDir, '.credentials.json'), path.join(claudeHome, '.credentials.json'));
  chmodSync(path.join(claudeHome, '.credentials.json'), 0o600);
  // A USER-scope server: the source a non-strict claude loads with no approval,
  // so its absence under strict mode is a real closure and not a skipped
  // project-scope approval.
  writeFileSync(
    path.join(claudeHome, '.claude.json'),
    JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { marker: { type: 'stdio', ...markerServer } } }),
    'utf8',
  );
  process.env.CLAUDE_CONFIG_DIR = claudeHome;

  const claudeOptions = (sessionId, mcpServers) => ({
    prompt: 'Reply with the single word ok. Do not use any tool.',
    sessionId,
    resume: false,
    permissionMode: 'plan',
    model: 'haiku',
    effort: 'low',
    cwd: work,
    timeoutMs: 180_000,
    tools: ['Read'],
    ...(mcpServers === undefined ? {} : { mcpServers }),
  });

  // Control: the same CLI and config WITHOUT --strict-mcp-config, run directly,
  // so the marker server is shown to be one claude launches when left open.
  clearMarker();
  await run(
    (await load('claude.js')).claudeBin(),
    ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'haiku', '--tools', 'Read'],
    { input: 'Reply with the single word ok.', cwd: work, timeoutMs: 180_000, env: { ...process.env } },
  ).catch(() => undefined);
  record('claude -p WITHOUT --strict-mcp-config (control)', true, launched());

  clearMarker();
  argvOf.length = 0;
  await claudeTurn(claudeOptions(crypto.randomUUID()), recordingRun).catch((err) => {
    console.log(`  (claude closed turn reported: ${err.message.split('\n')[0]})`);
  });
  record('claude turn, no grant (vibe argv)', false, launched(), `argv: claude ${shown(argvOf[0] ?? [])}`);

  clearMarker();
  argvOf.length = 0;
  const defs = resolveClaudeGrants(
    'planner',
    ['marker'],
    claudeMcpDefinitions({ cwd: work, repoDir: work, home: os.homedir(), configDir: claudeHome }),
  );
  await claudeTurn(claudeOptions(crypto.randomUUID(), defs), recordingRun).catch((err) => {
    console.log(`  (claude granted turn reported: ${err.message.split('\n')[0]})`);
  });
  record(
    'claude turn, granted "marker" via --mcp-config (positive control)',
    true,
    launched(),
    `argv: claude ${shown(argvOf[0] ?? [])}`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

const v = await run(codexBin(), ['--version'], {}).catch(() => ({ stdout: '?' }));
console.log(`\ncodex: ${v.stdout.trim()}`);
console.log('\n| check | expected | marker |\n|---|---|---|');
for (const r of results) {
  const exp = r.expected === null ? 'measured' : r.expected ? 'launched' : 'not launched';
  console.log(`| ${r.name} | ${exp} | ${r.launched ? 'PRESENT' : 'absent'} ${r.pass ? '' : '**FAIL**'} |`);
}
process.exit(results.every((r) => r.pass) ? 0 : 1);
