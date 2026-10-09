import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeTurn } from '@src/claude.js';
import type { ClaudeTurnOptions } from '@src/claude.js';
import { codexTurn, resetCodexForkProbe } from '@src/codex.js';
import type { CodexTurnOptions } from '@src/codex.js';
import { configDiff, DEFAULTS, loadConfig } from '@src/config.js';
import {
  claudeMcpDefinitions,
  CODEX_MCP_CAVEAT,
  codexMcpDisableArgs,
  describeMcp,
  MCP_ENFORCEMENT,
  mcpRefusals,
  resolveClaudeGrants,
} from '@src/mcp.js';
import { runTurn } from '@src/orchestrator.js';
import type { AgentTurns, TurnRequest } from '@src/orchestrator.js';
import { claudeProbeArgs, codexProbeArgs } from '@src/preflight.js';
import type { RunFn, RunResult } from '@src/proc.js';
import { DEFAULT_ROLE_PROVIDERS, roleSetting, tableFor } from '@src/roles.js';
import type { RoleProviders, RoleTable } from '@src/roles.js';
import { createRun } from '@src/run.js';
import type { ClaudeTurnResult, Config, TokenUsage } from '@src/types.js';
import { isMcpList } from './helpers/codex-mcp.js';

/**
 * A run's children reach no MCP server unless a role names one (#138).
 *
 * Asserted against the argv the adapters actually build, through their
 * injected `exec`, never against config: the whole defect was that the config
 * said nothing and the CLI read the person's own servers anyway. No agent is
 * spawned; every child is a recording fake.
 */

const tmp = (prefix: string): string => mkdtempSync(path.join(tmpdir(), prefix));

function table(over: Partial<RoleProviders> = {}): RoleTable {
  return tableFor({ ...DEFAULT_ROLE_PROVIDERS, ...over });
}

function config(over: Partial<RoleProviders> = {}): Config {
  return {
    ...DEFAULTS,
    roles: { ...DEFAULT_ROLE_PROVIDERS, ...over },
    codex: { ...DEFAULTS.codex, readRateLimits: false },
    progress: { ...DEFAULTS.progress, enabled: false },
    context: { ...DEFAULTS.context, enabled: false },
  };
}

const neverCalled: RunFn = () => {
  throw new Error('nothing should be spawned');
};

// ---- Claude: the adapter's argv ---------------------------------------------

const CLAUDE_OK = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  session_id: 's',
});

interface ClaudeCall {
  args: string[];
  /** The `--mcp-config` file as it stood while the child ran, if there was one. */
  file: { path: string; mode: number; body: unknown } | null;
}

function claudeRecorder(): { calls: ClaudeCall[]; exec: RunFn } {
  const calls: ClaudeCall[] = [];
  const exec: RunFn = (_bin, argv, options): Promise<RunResult> => {
    const args = [...argv];
    const at = args.indexOf('--mcp-config');
    const file =
      at === -1
        ? null
        : {
            path: args[at + 1] as string,
            mode: statSync(args[at + 1] as string).mode & 0o777,
            body: JSON.parse(readFileSync(args[at + 1] as string, 'utf8')) as unknown,
          };
    calls.push({ args, file });
    options?.onLine?.(CLAUDE_OK);
    return Promise.resolve({ code: 0, signal: null, stdout: `${CLAUDE_OK}\n`, stderr: '' });
  };
  return { calls, exec };
}

function claudeOptions(over: Partial<ClaudeTurnOptions> = {}): ClaudeTurnOptions {
  return {
    prompt: 'plan this',
    sessionId: 's',
    resume: false,
    permissionMode: 'plan',
    model: 'm',
    effort: 'low',
    cwd: process.cwd(),
    timeoutMs: 1_000,
    tools: ['Read', 'Grep'],
    ...over,
  };
}

test('claude: a turn with no grant is strict and re-supplies nothing - fresh, resume and fork', async () => {
  for (const over of [{}, { resume: true }, { forkFrom: 'parent' }] as Partial<ClaudeTurnOptions>[]) {
    const { calls, exec } = claudeRecorder();
    await claudeTurn(claudeOptions(over), exec);
    const args = calls[0]?.args ?? [];
    assert.ok(args.includes('--strict-mcp-config'), `strict on ${JSON.stringify(over)}`);
    assert.equal(args.includes('--mcp-config'), false, `nothing re-supplied on ${JSON.stringify(over)}`);
    // `--tools` is variadic and still last.
    assert.deepEqual(args.slice(-3), ['--tools', 'Read', 'Grep']);
  }
});

test('claude: a grant is re-supplied from a 0600 file holding exactly that server, removed after', async () => {
  const home = tmp('vibe-mcp-home-');
  const cwd = tmp('vibe-mcp-cwd-');
  writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        granted: { command: 'node', args: ['granted.js'], env: { TOKEN: 'secret' } },
        other: { command: 'node', args: ['other.js'] },
      },
    }),
    'utf8',
  );
  const defs = resolveClaudeGrants('planner', ['granted'], claudeMcpDefinitions({ cwd, repoDir: cwd, home }));
  const { calls, exec } = claudeRecorder();

  await claudeTurn(claudeOptions({ cwd, mcpServers: defs }), exec);

  const call = calls[0];
  assert.ok(call?.args.includes('--strict-mcp-config'));
  assert.ok(call?.file !== null && call?.file !== undefined, 'a --mcp-config file was passed');
  assert.equal(call.file.mode, 0o600);
  assert.deepEqual(Object.keys((call.file.body as { mcpServers: object }).mcpServers), ['granted']);
  // The secret is in a file, never on the command line.
  assert.equal(call.args.some((a) => a.includes('secret')), false);
  assert.equal(existsSync(call.file.path), false, 'the file does not outlive the child');
  assert.deepEqual(call.args.slice(-3), ['--tools', 'Read', 'Grep']);
});

test('claude: a server named __proto__ is re-supplied, not lost to the prototype', () => {
  const home = tmp('vibe-mcp-home-');
  const cwd = tmp('vibe-mcp-cwd-');
  writeFileSync(
    path.join(cwd, '.mcp.json'),
    '{"mcpServers": {"__proto__": {"command": "proto"}, "other": {"command": "o"}}}',
    'utf8',
  );
  const defs = resolveClaudeGrants('planner', ['__proto__'], claudeMcpDefinitions({ cwd, repoDir: cwd, home }));
  assert.deepEqual(Object.keys(defs), ['__proto__']);
  assert.deepEqual(JSON.parse(JSON.stringify({ mcpServers: defs })), {
    mcpServers: JSON.parse('{"__proto__": {"command": "proto"}}'),
  });
});

test('claude: the preflight probe is strict too', () => {
  const args = claudeProbeArgs(['--settings', 'x.json']);
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args.includes('--mcp-config'), false);
  assert.deepEqual(args.slice(-2), ['--tools', 'Bash']);
});

// ---- Claude: where a definition comes from ----------------------------------

test('claude: a worktree turn resolves a server from the repository .mcp.json', () => {
  const home = tmp('vibe-mcp-home-');
  const repo = tmp('vibe-mcp-repo-');
  const worktree = path.join(repo, '.worktrees', 'run-1');
  mkdirSync(worktree, { recursive: true });
  writeFileSync(path.join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { repoOnly: { command: 'x' } } }), 'utf8');

  const defs = claudeMcpDefinitions({ cwd: worktree, repoDir: repo, home });
  assert.deepEqual(resolveClaudeGrants('implementer', ['repoOnly'], defs), { repoOnly: { command: 'x' } });
});

test('claude: local scope beats .mcp.json, which beats the user scope', () => {
  const home = tmp('vibe-mcp-home-');
  const cwd = tmp('vibe-mcp-cwd-');
  writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify({
      mcpServers: { a: { command: 'user' }, b: { command: 'user' }, c: { command: 'user' } },
      projects: { [path.resolve(cwd)]: { mcpServers: { a: { command: 'local' } } } },
    }),
    'utf8',
  );
  writeFileSync(
    path.join(cwd, '.mcp.json'),
    JSON.stringify({ mcpServers: { a: { command: 'project' }, b: { command: 'project' } } }),
    'utf8',
  );
  const defs = claudeMcpDefinitions({ cwd, repoDir: cwd, home });
  assert.deepEqual(defs.get('a'), { command: 'local' });
  assert.deepEqual(defs.get('b'), { command: 'project' });
  assert.deepEqual(defs.get('c'), { command: 'user' });
});

test('claude: a claude.ai connector and an unknown name are refused by name, before anything spawns', async () => {
  const home = tmp('vibe-mcp-home-');
  const cwd = tmp('vibe-mcp-cwd-');
  const roles = table({ planner: { provider: 'claude', mcpServers: ['claude.ai Gmail', 'nowhere'] } });
  const cfg = config({ planner: { provider: 'claude', mcpServers: ['claude.ai Gmail', 'nowhere'] } });

  const refusals = await mcpRefusals(cfg, roles, {
    cwd,
    repoDir: cwd,
    exec: neverCalled,
    codexBin: () => 'codex',
    home,
  });

  assert.equal(refusals.length, 2);
  assert.match(refusals[0] ?? '', /roles\.planner\.mcpServers names "claude\.ai Gmail", a claude\.ai connector/);
  assert.match(refusals[1] ?? '', /roles\.planner\.mcpServers names "nowhere", which is in none of/);
});

test('claude: a table that grants nothing asks nothing and spawns nothing', async () => {
  const refusals = await mcpRefusals(config(), table(), {
    cwd: process.cwd(),
    repoDir: process.cwd(),
    exec: neverCalled,
    codexBin: () => 'codex',
  });
  assert.deepEqual(refusals, []);
});

// ---- Codex: the adapter's argv ----------------------------------------------

const DISABLE_A = ['-c', 'mcp_servers.a.enabled=false'];
const DISABLE_B = ['-c', 'mcp_servers.b.enabled=false'];

/** Whether `args` holds `pair` as two adjacent entries. */
function hasPair(args: readonly string[], pair: readonly string[]): boolean {
  return args.some((a, i) => a === pair[0] && args[i + 1] === pair[1]);
}

interface CodexRecording {
  calls: { args: string[]; cwd: string | undefined }[];
  exec: RunFn;
}

/**
 * A codex whose `mcp list` reports `listed`, whose `exec fork --help` names
 * `forkFlags`, and whose fork mint names a thread. Every call is recorded.
 */
function codexRecorder(
  dir: string,
  listed: readonly string[] | RunResult = ['a', 'b'],
  /** `null` is help that could not be read: exit 1, nothing printed. */
  forkFlags: readonly string[] | null = ['--json', '-m', '-c', '--skip-git-repo-check', '-o', '--output-schema'],
): CodexRecording {
  const calls: { args: string[]; cwd: string | undefined }[] = [];
  const exec: RunFn = (_bin, argv, options): Promise<RunResult> => {
    calls.push({ args: [...argv], cwd: options?.cwd });
    if (isMcpList(argv)) {
      return Promise.resolve(
        Array.isArray(listed)
          ? {
              code: 0,
              signal: null,
              stdout: JSON.stringify((listed as string[]).map((name) => ({ name, enabled: true }))),
              stderr: '',
            }
          : (listed as RunResult),
      );
    }
    if (argv[2] === '--help') {
      return Promise.resolve(
        forkFlags === null
          ? { code: 1, signal: null, stdout: '', stderr: '' }
          : { code: 0, signal: null, stdout: `Usage\n\n${forkFlags.join('\n')}\n`, stderr: '' },
      );
    }
    if (argv[1] === 'fork' && !argv.includes('-')) {
      return Promise.resolve({
        code: 0,
        signal: null,
        stdout: JSON.stringify({ type: 'thread.started', thread_id: 'minted' }),
        stderr: '',
      });
    }
    writeFileSync(path.join(dir, 'review-0.out.json'), '{"findings":[]}', 'utf8');
    return Promise.resolve({ code: 0, signal: null, stdout: '', stderr: '' });
  };
  return { calls, exec };
}

function codexOptions(dir: string, over: Partial<CodexTurnOptions> = {}): CodexTurnOptions {
  return {
    prompt: 'review this',
    schema: { type: 'object' },
    schemaName: 'review-0',
    artifactDir: dir,
    model: 'fixture-model',
    effort: 'low',
    sandbox: 'read-only',
    cwd: dir,
    timeoutMs: 1_000,
    ...over,
  };
}

/** The calls that are not the listing or the help probe: mints and turns. */
const spawned = (rec: CodexRecording): string[][] =>
  rec.calls.map((c) => c.args).filter((a) => !isMcpList(a) && a[2] !== '--help');

test('codex: every listed server is disabled on a fresh exec and on a resume', async () => {
  for (const over of [{}, { sessionId: 'thread-9' }] as Partial<CodexTurnOptions>[]) {
    const dir = tmp('vibe-mcp-codex-');
    const rec = codexRecorder(dir);
    await codexTurn(codexOptions(dir, over), rec.exec);

    const list = rec.calls[0];
    assert.ok(list !== undefined && isMcpList(list.args), 'the listing comes first');
    assert.equal(list.cwd, dir, "listed in the child's own cwd");
    assert.ok(hasPair(list.args, ['-c', 'model_reasoning_effort="low"']), 'with the same -c the turn carries');
    const turn = spawned(rec)[0] ?? [];
    assert.ok(hasPair(turn, DISABLE_A) && hasPair(turn, DISABLE_B), `both disabled on ${JSON.stringify(over)}`);
  }
});

test('codex: the direct fork carries the closure', async () => {
  resetCodexForkProbe();
  const dir = tmp('vibe-mcp-codex-');
  const rec = codexRecorder(dir);
  await codexTurn(codexOptions(dir, { forkFrom: 'parent' }), rec.exec);
  const turn = spawned(rec)[0] ?? [];
  assert.deepEqual(turn.slice(0, 3), ['exec', 'fork', 'parent']);
  assert.ok(hasPair(turn, DISABLE_A) && hasPair(turn, DISABLE_B));
});

test('codex: the two-call fork carries the closure on the mint and on the turn when -c is declared', async () => {
  resetCodexForkProbe();
  const dir = tmp('vibe-mcp-codex-');
  // No `--skip-git-repo-check`, so the direct vector is refused - but `-c` is declared.
  const rec = codexRecorder(dir, ['a', 'b'], ['--json', '-m', '-c', '-o', '--output-schema']);
  await codexTurn(codexOptions(dir, { forkFrom: 'parent' }), rec.exec);

  const [mint, turn] = spawned(rec);
  assert.deepEqual(mint?.slice(0, 4), ['exec', 'fork', 'parent', '--json']);
  assert.ok(hasPair(mint ?? [], DISABLE_A) && hasPair(mint ?? [], DISABLE_B), 'the mint is closed');
  assert.deepEqual(turn?.slice(0, 3), ['exec', 'resume', 'minted']);
  assert.ok(hasPair(turn ?? [], DISABLE_A) && hasPair(turn ?? [], DISABLE_B), 'the turn is closed');
});

test('codex: a fork whose help does not declare -c is refused after the probe, before the mint', async () => {
  resetCodexForkProbe();
  const dir = tmp('vibe-mcp-codex-');
  const rec = codexRecorder(dir, ['a', 'b'], ['--json', '-m', '--skip-git-repo-check', '-o', '--output-schema']);

  await assert.rejects(() => codexTurn(codexOptions(dir, { forkFrom: 'parent' }), rec.exec), /does not accept -c/);
  assert.ok(rec.calls.some((c) => c.args[2] === '--help'), 'the help probe ran');
  assert.deepEqual(spawned(rec), [], 'no mint and no turn followed it');
});

test('codex: a fork whose help cannot be read is refused too, when there are servers to disable', async () => {
  resetCodexForkProbe();
  const dir = tmp('vibe-mcp-codex-');
  const rec = codexRecorder(dir, ['a'], null);

  await assert.rejects(
    () => codexTurn(codexOptions(dir, { forkFrom: 'parent' }), rec.exec),
    /help could not be read, so it is not known to accept -c/,
  );
  assert.ok(rec.calls.some((c) => c.args[2] === '--help'), 'the help probe ran');
  assert.deepEqual(spawned(rec), [], 'no direct fork, no mint and no turn followed it');
});

test('codex: unreadable help with nothing to disable still takes the direct fork', async () => {
  resetCodexForkProbe();
  const dir = tmp('vibe-mcp-codex-');
  const rec = codexRecorder(dir, [], null);
  await codexTurn(codexOptions(dir, { forkFrom: 'parent' }), rec.exec);
  assert.deepEqual(spawned(rec)[0]?.slice(0, 3), ['exec', 'fork', 'parent']);
});

test('codex: a granted server is the one left enabled', async () => {
  const dir = tmp('vibe-mcp-codex-');
  const rec = codexRecorder(dir);
  await codexTurn(codexOptions(dir, { mcpServers: ['a'] }), rec.exec);
  const turn = spawned(rec)[0] ?? [];
  assert.equal(hasPair(turn, DISABLE_A), false);
  assert.ok(hasPair(turn, DISABLE_B));
});

test('codex: a listing that fails or does not parse refuses the turn before anything spawns', async () => {
  for (const listed of [
    { code: 1, signal: null, stdout: '', stderr: 'boom' },
    { code: 0, signal: null, stdout: 'not json', stderr: '' },
    { code: 0, signal: null, stdout: '{"name":"a"}', stderr: '' },
  ] as RunResult[]) {
    const dir = tmp('vibe-mcp-codex-');
    const rec = codexRecorder(dir, listed);
    await assert.rejects(() => codexTurn(codexOptions(dir), rec.exec), /codex mcp list could not be read/);
    assert.deepEqual(spawned(rec), [], 'no codex exec child');
  }
});

test('codex: a listed name a -c path cannot address is refused, not quoted', () => {
  assert.throws(() => codexMcpDisableArgs(['a.b'], []), /cannot be addressed/);
  // Granted, it needs no address and is fine.
  assert.deepEqual(codexMcpDisableArgs(['a.b'], ['a.b']), []);
});

test('codex: the preflight probe carries the disable pairs beside the effort', () => {
  const args = codexProbeArgs(DEFAULTS, ['-s', 'read-only'], '/repo', [...DISABLE_A, ...DISABLE_B]);
  assert.ok(hasPair(args, DISABLE_A) && hasPair(args, DISABLE_B));
  assert.equal(args.at(-1), '-');
});

test('codex: a granted name the listing does not report is refused by name before the first turn', async () => {
  const dir = tmp('vibe-mcp-codex-');
  const rec = codexRecorder(dir, ['a']);
  const over = { reviewer: { provider: 'codex' as const, mcpServers: ['a', 'missing'] } };
  const refusals = await mcpRefusals(config(over), table(over), {
    cwd: dir,
    repoDir: dir,
    exec: rec.exec,
    codexBin: () => 'codex',
  });
  assert.deepEqual(refusals, [
    `roles.reviewer.mcpServers names "missing", which codex mcp list does not report in ${dir}.`,
  ]);
});

test('codex: a listing that cannot be read is a refusal before the first turn', async () => {
  const dir = tmp('vibe-mcp-codex-');
  const rec = codexRecorder(dir, { code: 2, signal: null, stdout: '', stderr: 'nope' });
  const over = { reviewer: { provider: 'codex' as const, mcpServers: ['a'] } };
  const refusals = await mcpRefusals(config(over), table(over), {
    cwd: dir,
    repoDir: dir,
    exec: rec.exec,
    codexBin: () => 'codex',
  });
  assert.equal(refusals.length, 1);
  assert.match(refusals[0] ?? '', /codex mcp list could not be read/);
});

// ---- Dispatch: a configured grant reaches the adapter -----------------------

function tokens(total: number): TokenUsage {
  return { input: total, output: 0, cacheRead: 0, cacheCreation: 0, total };
}

function recordingTurns(): { turns: AgentTurns; claude: ClaudeTurnOptions[]; codex: CodexTurnOptions[] } {
  const claude: ClaudeTurnOptions[] = [];
  const codex: CodexTurnOptions[] = [];
  return {
    claude,
    codex,
    turns: {
      claude: (options): Promise<ClaudeTurnResult> => {
        claude.push(options);
        return Promise.resolve({
          text: 'ok',
          costUsd: 0,
          sessionId: options.sessionId,
          denials: [],
          numTurns: 1,
          usage: null,
          tokens: tokens(1),
        });
      },
      codex: (options) => {
        codex.push(options);
        return Promise.resolve({ structured: { findings: [] }, raw: '{}', sessionId: 't', tokens: tokens(1) });
      },
    },
  };
}

function request(role: TurnRequest['role'], cwd: string): TurnRequest {
  return { role, prompt: 'do it', cwd, label: `${role}-0`, timeoutMs: 1_000 };
}

async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = (): void => undefined;
  try {
    return await work();
  } finally {
    console.log = original;
  }
}

test('dispatch: a Claude role grant reaches the adapter as exactly that definition', async () => {
  const repo = tmp('vibe-mcp-dispatch-');
  writeFileSync(
    path.join(repo, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'vibe-test-srv': { command: 'srv' }, other: { command: 'o' } } }),
    'utf8',
  );
  const over = { planner: { provider: 'claude' as const, mcpServers: ['vibe-test-srv'] } };
  const state = createRun(repo, 'mcp dispatch', false);
  const rec = recordingTurns();

  await quietly(() => runTurn(state, config(over), request('planner', repo), rec.turns, table(over)));

  assert.deepEqual(rec.claude[0]?.mcpServers, { 'vibe-test-srv': { command: 'srv' } });
});

test('dispatch: a Codex role grant reaches the adapter by name', async () => {
  const repo = tmp('vibe-mcp-dispatch-');
  const over = { reviewer: { provider: 'codex' as const, mcpServers: ['a'] } };
  const state = createRun(repo, 'mcp dispatch', false);
  const rec = recordingTurns();

  await quietly(() => runTurn(state, config(over), request('reviewer', repo), rec.turns, table(over)));

  assert.deepEqual(rec.codex[0]?.mcpServers, ['a']);
});

test('dispatch: a role that named nothing passes no grant on either provider', async () => {
  const repo = tmp('vibe-mcp-dispatch-');
  const state = createRun(repo, 'mcp dispatch', false);
  const rec = recordingTurns();

  await quietly(() => runTurn(state, config(), request('planner', repo), rec.turns, table()));
  await quietly(() => runTurn(state, config(), request('reviewer', repo), rec.turns, table()));

  assert.deepEqual(rec.claude[0]?.mcpServers, {});
  assert.deepEqual(rec.codex[0]?.mcpServers, []);
});

// ---- Config -----------------------------------------------------------------

test('config: mcpServers is an array of names, refused by name otherwise', () => {
  assert.deepEqual(roleSetting('reviewer', { provider: 'codex', mcpServers: ['github'] }), {
    provider: 'codex',
    mcpServers: ['github'],
  });
  for (const bad of ['github', [''], [' '], [1], null]) {
    assert.throws(
      () => roleSetting('reviewer', { provider: 'codex', mcpServers: bad }),
      /roles\.reviewer\.mcpServers is .*; must be an array of MCP server names/,
    );
  }
  assert.throws(
    () => roleSetting('reviewer', { provider: 'codex', servers: [] }),
    /provider, model, effort, timeoutMs and mcpServers/,
  );
  // A role that named none carries no key at all.
  assert.equal('mcpServers' in table().reviewer, false);
});

test('config: a project file naming servers loads, and a change to them is a named difference', () => {
  const repo = tmp('vibe-mcp-cfg-');
  writeFileSync(
    path.join(repo, 'vibe.config.json'),
    JSON.stringify({ roles: { reviewer: { provider: 'codex', mcpServers: ['github'] } } }),
    'utf8',
  );
  const loaded = loadConfig(repo);
  assert.deepEqual(tableFor(loaded.roles as RoleProviders).reviewer.mcpServers, ['github']);
  // The resume path's `configDiff` names it, so `resume_config` records it with
  // no mechanism of its own.
  assert.deepEqual(configDiff(DEFAULTS, loaded), ['roles.reviewer']);
});

// ---- The words ---------------------------------------------------------------

test('describeMcp states each seat, both mechanisms and the Codex caveat', () => {
  const lines = describeMcp(table({ reviewer: { provider: 'codex', mcpServers: ['github'] } }));
  const text = lines.join('\n');
  assert.equal(MCP_ENFORCEMENT.claude, 'replaced (--strict-mcp-config)');
  assert.equal(MCP_ENFORCEMENT.codex, 'disabled by name');
  assert.match(text, /Claude: replaced \(--strict-mcp-config\)/);
  assert.match(text, /Codex: disabled by name - a deny-list: a server Codex does not list cannot be disabled/);
  assert.ok(text.includes(CODEX_MCP_CAVEAT));
  assert.match(text, /reviewer:\s+github\s+\(Codex: disabled by name\)/);
  assert.match(text, /planner:\s+none\s+\(Claude: replaced/);
});
