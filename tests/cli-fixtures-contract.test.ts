import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeTurn, parseStructured } from '@src/claude.js';
import { parseEvents } from '@src/codex.js';
import { TESTED_CLI_VERSIONS } from '@src/config.js';
import { emptySnapshot, KNOWN_CODEX_ITEMS, parseClaudeLine, parseCodexLine } from '@src/progress.js';
import type { RunFn } from '@src/proc.js';
import type { AgentProvider } from '@src/runtime.js';
import { codexTurnNoMcp } from './helpers/codex-mcp.js';

/**
 * The parsers against what the real CLIs actually print (#298).
 *
 * `tests/fixtures/cli/<cli>-<version>/` holds the raw stdout of one real turn,
 * recorded by hand with `node scripts/record-cli-fixtures.mjs` - never by the
 * suite, which calls no real agent. Every fixture is fed through the REAL
 * parsers: the heartbeat's line parsers, Claude's result envelope through
 * `claudeTurn`, and Codex's event stream and output file through `codexTurn`.
 * A shape change upstream fails here instead of as a turn that quietly reads
 * nothing.
 *
 * **Missing fixtures fail.** A contract test with nothing to check must not
 * pass. The one exception is `VIBE_CLI_FIXTURES=pending`, set on the run that
 * introduced this file because a sandboxed run cannot record them; there is no
 * other way past it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// Read from the source tree, not `dist/`: fixtures are data, and `tsc` copies none.
const fixtures = path.join(here, '..', '..', 'tests', 'fixtures', 'cli');
const pending = process.env['VIBE_CLI_FIXTURES'] === 'pending';
const SKIP_REASON =
  'CLI fixture contract tests skipped: VIBE_CLI_FIXTURES=pending ' +
  '(fixtures are recorded by hand with node scripts/record-cli-fixtures.mjs)';

process.env['VIBE_CLAUDE_BIN'] = process.execPath;
process.env['VIBE_CODEX_BIN'] = process.execPath;

if (pending) console.log(SKIP_REASON);

const missing = (cli: AgentProvider): string =>
  `CLI fixtures for ${cli} ${TESTED_CLI_VERSIONS[cli]} are missing — run node scripts/record-cli-fixtures.mjs`;

function recorded(cli: AgentProvider): string[] {
  if (!existsSync(fixtures)) return [];
  return readdirSync(fixtures)
    .filter((name) => name.startsWith(`${cli}-`))
    .map((name) => path.join(fixtures, name));
}

const linesOf = (dir: string): string[] =>
  readFileSync(path.join(dir, 'stdout.jsonl'), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');

/** Replays a recorded stream as if the child had printed it. */
function replay(lines: readonly string[], before?: (args: readonly string[]) => void): RunFn {
  return (_bin, args, options) => {
    before?.(args);
    for (const line of lines) options?.onLine?.(line);
    return Promise.resolve({ code: 0, signal: null, stdout: lines.map((l) => `${l}\n`).join(''), stderr: '' });
  };
}

for (const cli of ['claude', 'codex'] as const) {
  test(`${cli}: the fixture for the tested version exists`, { skip: pending ? SKIP_REASON : false }, () => {
    const dir = path.join(fixtures, `${cli}-${TESTED_CLI_VERSIONS[cli]}`);
    assert.ok(existsSync(path.join(dir, 'stdout.jsonl')), missing(cli));
  });
}

test('claude: every recorded fixture parses to a session, tokens and the structured result', { skip: pending ? SKIP_REASON : false }, async () => {
  const dirs = recorded('claude');
  assert.ok(dirs.length > 0, missing('claude'));
  for (const dir of dirs) {
    const lines = linesOf(dir);
    const snapshot = emptySnapshot();
    for (const line of lines) parseClaudeLine(snapshot, line);
    assert.ok(snapshot.tokens > 0, `${dir}: parseClaudeLine read no tokens`);

    const result = await claudeTurn(
      {
        prompt: 'recorded',
        sessionId: 'not-the-recorded-one',
        resume: false,
        permissionMode: 'plan',
        model: 'haiku',
        effort: 'low',
        cwd: process.cwd(),
        timeoutMs: 1_000,
        jsonSchema: { type: 'object' },
      },
      replay(lines),
    );
    assert.ok(result.sessionId !== '' && result.sessionId !== 'not-the-recorded-one', `${dir}: no session id`);
    assert.ok(result.tokens.total > 0, `${dir}: the result envelope carried no tokens`);
    const structured = parseStructured(result.text) as Record<string, unknown>;
    assert.equal(typeof structured['answer'], 'string', `${dir}: no structured answer`);
  }
});

test('codex: every recorded fixture parses to a thread, tokens and the structured result', { skip: pending ? SKIP_REASON : false }, async () => {
  const dirs = recorded('codex');
  assert.ok(dirs.length > 0, missing('codex'));
  for (const dir of dirs) {
    const lines = linesOf(dir);
    const snapshot = emptySnapshot();
    for (const line of lines) parseCodexLine(snapshot, line);
    assert.ok(snapshot.tokens > 0, `${dir}: parseCodexLine read no tokens`);

    const events = parseEvents(lines.join('\n'));
    assert.ok(events.threadId !== null, `${dir}: parseEvents found no thread id`);
    assert.ok(events.tokens.total > 0, `${dir}: parseEvents read no tokens`);
    // The vocabulary the unknown-item warning holds Codex to (#298).
    assert.deepEqual(snapshot.unrecognised, [], `${dir}: item types missing from KNOWN_CODEX_ITEMS`);
    for (const line of lines) {
      const event = JSON.parse(line) as { type?: unknown; item?: { type?: unknown } };
      if (typeof event.type === 'string' && event.type.startsWith('item.') && typeof event.item?.type === 'string') {
        assert.ok(KNOWN_CODEX_ITEMS.has(event.item.type), `${dir}: unknown item type ${event.item.type}`);
      }
    }

    const result = await codexTurnNoMcp(
      {
        prompt: 'recorded',
        schema: { type: 'object' },
        schemaName: 'fixture',
        artifactDir: mkdtempSync(path.join(tmpdir(), 'vibe-cli-fixture-')),
        model: 'default',
        effort: 'low',
        sandbox: 'read-only',
        cwd: process.cwd(),
        timeoutMs: 1_000,
      },
      replay(lines, (args) => {
        const at = args.indexOf('-o');
        const out = args[at + 1];
        if (at >= 0 && out !== undefined) copyFileSync(path.join(dir, 'last-message.json'), out);
      }),
    );
    assert.ok(result.sessionId !== null, `${dir}: codexTurn found no thread id`);
    assert.equal(typeof (result.structured as Record<string, unknown>)['answer'], 'string', `${dir}: no structured answer`);
  }
});
