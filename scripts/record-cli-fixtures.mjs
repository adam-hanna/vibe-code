// Record one real turn of each agent CLI, for the contract tests (#298).
//
//   node scripts/record-cli-fixtures.mjs [--force]
//
// Spawns ONE small real turn of `claude` and one of `codex`, in the argv shapes
// vibe uses - `claude -p` stream-json with a `--json-schema` result on `haiku`,
// and `codex exec --json` with `--output-schema` - and writes the raw stdout to
// `tests/fixtures/cli/claude-<version>/` and `tests/fixtures/cli/codex-<version>/`
// beside a `meta.json` giving the version, the date and the argv.
// `tests/cli-fixtures-contract.test.ts` feeds every recorded fixture through
// the real parsers, and fails when the version in `TESTED_CLI_VERSIONS` has none.
//
// Run by hand, once per CLI bump, and commit what it writes. Never from the test
// suite, which calls no real agent, and never from inside a vibe turn: a
// sandboxed turn spawning agents hangs or is blocked. It spends a few thousand
// tokens on each subscription.
//
// The binaries are `VIBE_CLAUDE_BIN` / `VIBE_CODEX_BIN` when set, else `claude`
// and `codex` on PATH. An existing fixture directory is refused unless
// `--force`. Dependency-free on purpose, like every script here.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = path.join(root, 'tests', 'fixtures', 'cli');
const force = process.argv.includes('--force');

const SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
const PROMPT = 'Reply with the JSON object {"answer": "ok"} and nothing else. Do not use any tools.';

// Windows resolves `claude` / `codex` through a shim; a shell is what runs one.
const shell = process.platform === 'win32';

function call(bin, args, options = {}) {
  return spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, shell, maxBuffer: 64 * 1024 * 1024, ...options });
}

// The same regex as `versionOf` in src/runtime.ts.
function versionOf(cli, bin) {
  const result = call(bin, ['--version']);
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const m = /(\d+(?:\.\d+)*)/.exec(text);
  if (result.status !== 0 || !m) fail(cli, `\`${bin} --version\` did not report a version:\n${text}`);
  return { version: m[1], versionOutput: text.trim() };
}

function fail(cli, why) {
  console.error(`record-cli-fixtures: ${cli}: ${why}`);
  process.exit(1);
}

function target(cli, version) {
  const dir = path.join(fixtures, `${cli}-${version}`);
  if (existsSync(dir)) {
    if (!force) fail(cli, `${dir} already exists - pass --force to re-record it`);
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeMeta(dir, cli, found, argv) {
  const meta = { cli, version: found.version, versionOutput: found.versionOutput, recordedAt: new Date().toISOString(), argv };
  writeFileSync(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
}

function recordClaude() {
  const bin = process.env.VIBE_CLAUDE_BIN || 'claude';
  const found = versionOf('claude', bin);
  const work = mkdtempSync(path.join(tmpdir(), 'vibe-fixture-claude-'));
  const argv = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', 'plan',
    '--session-id', randomUUID(),
    '--model', 'haiku',
    '--effort', 'low',
    '--json-schema', JSON.stringify(SCHEMA),
    '--strict-mcp-config',
    '--tools', 'Read',
  ];
  try {
    const result = call(bin, argv, { cwd: work, input: PROMPT });
    if (result.status !== 0) fail('claude', `the turn exited ${result.status}:\n${result.stderr}\n${result.stdout}`);
    const dir = target('claude', found.version);
    writeFileSync(path.join(dir, 'stdout.jsonl'), result.stdout);
    writeMeta(dir, 'claude', found, argv);
    console.log(`recorded claude ${found.version} -> ${path.relative(root, dir)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function recordCodex() {
  const bin = process.env.VIBE_CODEX_BIN || 'codex';
  const found = versionOf('codex', bin);
  const work = mkdtempSync(path.join(tmpdir(), 'vibe-fixture-codex-'));
  const schemaFile = path.join(work, 'schema.json');
  const outFile = path.join(work, 'last-message.json');
  writeFileSync(schemaFile, JSON.stringify(SCHEMA));
  // No `-m`: vibe's default is the CLI's own model (`src/modelflag.ts`).
  const argv = [
    'exec',
    '--json',
    '-c', 'model_reasoning_effort="low"',
    '-s', 'read-only',
    '--skip-git-repo-check',
    '-C', work,
    '--output-schema', schemaFile,
    '-o', outFile,
    '-',
  ];
  try {
    const result = call(bin, argv, { cwd: work, input: PROMPT });
    if (result.status !== 0) fail('codex', `the turn exited ${result.status}:\n${result.stderr}\n${result.stdout}`);
    if (!existsSync(outFile)) fail('codex', 'the turn wrote no structured output');
    const dir = target('codex', found.version);
    writeFileSync(path.join(dir, 'stdout.jsonl'), result.stdout);
    writeFileSync(path.join(dir, 'last-message.json'), readFileSync(outFile, 'utf8'));
    writeMeta(dir, 'codex', found, argv.map((a) => a.split(work).join('<tmp>')));
    console.log(`recorded codex ${found.version} -> ${path.relative(root, dir)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

recordClaude();
recordCodex();
