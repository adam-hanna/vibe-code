import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLI_FLAG_REQUIREMENTS, checkClis, helpCommands, resetCliProbes } from '@src/cliversions.js';
import type { CliCheck } from '@src/cliversions.js';
import { DEFAULTS } from '@src/config.js';
import { preflight } from '@src/preflight.js';
import type { AgentPreflight } from '@src/preflight.js';
import type { RunFn } from '@src/proc.js';

/**
 * Refuse only on a capability that is actually missing (#298).
 *
 * The evidence is the installed CLI's own `--help`. A run flag missing from help
 * that WAS read refuses; help that could not be read warns, because an
 * unreadable help text is not evidence of anything - `forkHelp`'s rule; and a
 * flag only the pilot passes warns, because no run passes it.
 */

const BINS = { claude: () => 'claude-bin', codex: () => 'codex-bin' };

/** A clap-style help text declaring `flags`, with a `Commands:` section when asked. */
function helpText(flags: readonly string[], commands: readonly string[] = []): string {
  const head = commands.length === 0 ? '' : `Commands:\n${commands.map((c) => `  ${c}  does ${c}\n`).join('')}\n`;
  return `Usage: x [OPTIONS]\n\n${head}Options:\n${flags.map((f) => `      ${f} <value>\n          about ${f}\n`).join('')}`;
}

type Answer = { code: number; stdout: string } | 'throw';

/** Every help as the installed 2.1.294 / 0.157.1 have it, with overrides. */
function fakeExec(overrides: Record<string, Answer> = {}, calls: string[] = []): RunFn {
  const answers: Record<string, Answer> = {
    'claude-bin --version': { code: 0, stdout: '2.1.294 (Claude Code)' },
    'codex-bin --version': { code: 0, stdout: 'codex-cli 0.157.1' },
  };
  for (const req of CLI_FLAG_REQUIREMENTS) {
    answers[`${req.cli}-bin ${req.help.join(' ')}`] = {
      code: 0,
      stdout: helpText([...req.run, ...req.pilot], req.commands ?? []),
    };
  }
  Object.assign(answers, overrides);
  return (bin, args) => {
    const key = `${bin} ${args.join(' ')}`;
    calls.push(key);
    const answer = answers[key];
    if (answer === 'throw') return Promise.reject(new Error('spawn failed'));
    const { code, stdout } = answer ?? { code: 127, stdout: '' };
    return Promise.resolve({ code, signal: null, stdout, stderr: '' });
  };
}

function without(cli: string, help: string, flag: string): Record<string, Answer> {
  const req = CLI_FLAG_REQUIREMENTS.find((r) => r.cli === cli && r.help.join(' ') === help);
  assert.ok(req);
  const flags = [...req.run, ...req.pilot].filter((f) => f !== flag);
  return { [`${cli}-bin ${help}`]: { code: 0, stdout: helpText(flags, req.commands ?? []) } };
}

async function check(overrides: Record<string, Answer> = {}): Promise<CliCheck> {
  resetCliProbes();
  try {
    return await checkClis(fakeExec(overrides), BINS);
  } finally {
    resetCliProbes();
  }
}

test('help declaring every flag vibe passes refuses nothing and warns about nothing', async () => {
  const result = await check();
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.versions, { claude: '2.1.294', codex: '0.157.1' });
  assert.ok(result.confirmations.includes('claude 2.1.294 (tested 2.1.294)'));
  assert.ok(result.confirmations.some((c) => c.startsWith('codex exec resume --help: all ')));
});

test('a run flag missing from help that was read refuses, naming the flag, CLI and both versions', async () => {
  const result = await check({
    ...without('claude', '--help', '--json-schema'),
    'claude-bin --version': { code: 0, stdout: '2.2.0 (Claude Code)' },
  });
  assert.equal(result.blocking.length, 1);
  const [reason] = result.blocking;
  assert.match(reason ?? '', /--json-schema/);
  assert.match(reason ?? '', /claude/);
  assert.match(reason ?? '', /Installed claude 2\.2\.0, tested with 2\.1\.294/);
  // The version moved too, and that is a warning on its own, not the refusal.
  assert.ok(result.warnings.some((w) => /newer than the tested 2\.1\.294/.test(w)));
});

test('a short flag is not satisfied by a long one that contains it', async () => {
  const result = await check(without('codex', 'exec resume --help', '-o'));
  assert.equal(result.blocking.length, 1);
  assert.match(result.blocking[0] ?? '', /codex no longer declares -o/);
});

test('exec help that no longer lists the resume subcommand refuses', async () => {
  const req = CLI_FLAG_REQUIREMENTS.find((r) => r.help.join(' ') === 'exec --help');
  assert.ok(req);
  const result = await check({
    'codex-bin exec --help': { code: 0, stdout: helpText([...req.run, ...req.pilot], ['fork', 'review']) },
  });
  assert.equal(result.blocking.length, 1);
  assert.match(result.blocking[0] ?? '', /resume/);
});

test('a flag only the pilot passes warns and refuses nothing', async () => {
  const result = await check(without('claude', '--help', '--restricted'));
  assert.deepEqual(result.blocking, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? '', /--restricted/);
  assert.match(result.warnings[0] ?? '', /Runs are unaffected/);
});

test('help that cannot be read warns that nothing was checked, and refuses nothing', async () => {
  for (const answer of [{ code: 2, stdout: 'error' }, { code: 0, stdout: '  ' }, 'throw'] as const) {
    const result = await check({ 'codex-bin exec --help': answer });
    assert.deepEqual(result.blocking, [], JSON.stringify(answer));
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? '', /`codex exec --help` could not be read/);
    assert.match(result.warnings[0] ?? '', /not evidence a flag is missing/);
  }
});

test('each help text is read once per process, until reset', async () => {
  resetCliProbes();
  const calls: string[] = [];
  const exec = fakeExec({}, calls);
  await checkClis(exec, BINS);
  await checkClis(exec, BINS);
  assert.equal(calls.filter((c) => c === 'claude-bin --help').length, 1);
  assert.equal(calls.filter((c) => c === 'codex-bin --version').length, 1);
  resetCliProbes();
  await checkClis(exec, BINS);
  assert.equal(calls.filter((c) => c === 'claude-bin --help').length, 2);
  resetCliProbes();
});

test('the Commands section is read as subcommands and nothing else', () => {
  const help = 'Usage\n\nCommands:\n  resume  Resume a session\n  fork    Fork\n\nOptions:\n  -c, --config <x>\n';
  assert.deepEqual([...helpCommands(help)], ['resume', 'fork']);
  assert.deepEqual([...helpCommands('Options:\n  resume  not a command\n')], []);
});

test('a blocking CLI check refuses preflight before any agent probe spends a token', async () => {
  let probed = 0;
  const probe = (): Promise<AgentPreflight> => {
    probed += 1;
    return Promise.reject(new Error('must not be probed'));
  };
  const report = await preflight('/nowhere', DEFAULTS, ['plan'], '/nowhere/.vibe', {
    claude: probe,
    codex: probe,
    clis: () =>
      Promise.resolve({
        versions: { claude: '2.1.294', codex: '0.157.1' },
        confirmations: [],
        warnings: ['a warning'],
        blocking: ['claude no longer declares --json-schema'],
      }),
  });
  assert.equal(probed, 0);
  assert.equal(report.ok, false);
  assert.deepEqual(report.blockingReasons, ['claude no longer declares --json-schema']);
  assert.deepEqual(report.warnings, ['a warning']);
});
