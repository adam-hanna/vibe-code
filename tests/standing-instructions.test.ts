import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { claudeTurn } from '@src/claude.js';
import { codexTurnNoMcp as codexTurn } from './helpers/codex-mcp.js';
import { configDiff, DEFAULTS, loadConfig } from '@src/config.js';
import { clearPromptOverrides, installStandingInstructions, STANDING_HEAD, withStanding } from '@src/prompts.js';
import type { RunFn } from '@src/proc.js';

/**
 * Standing instructions: one text every agent turn and the pilot is given (#273).
 *
 * Asked for as *"a way to give vibe instructions it can remember across runs.
 * Kind of like a global agents.md."* The claims worth pinning are that it reaches
 * BOTH agents through the adapters, that it lives happily in the global file,
 * and that a run with none is byte-identical to one before the key existed.
 */
process.env['VIBE_CLAUDE_BIN'] = process.execPath;
process.env['VIBE_CODEX_BIN'] = process.execPath;

const RULE = 'Never push to main. Use the gh CLI with GH_TOKEN.';

test('a blank text leaves the prompt exactly as it was', () => {
  clearPromptOverrides();
  assert.equal(withStanding('the task'), 'the task');
  installStandingInstructions('   \n ');
  assert.equal(withStanding('the task'), 'the task');
  clearPromptOverrides();
});

test('a text goes in front of the prompt, introduced as the person\'s and not vibe\'s', () => {
  installStandingInstructions(RULE);
  try {
    const said = withStanding('the task');
    assert.ok(said.startsWith(STANDING_HEAD));
    assert.ok(said.includes(RULE));
    assert.ok(said.endsWith('the task'), 'the turn\'s own prompt comes last, unchanged');
  } finally {
    clearPromptOverrides();
  }
});

/** A fake child that records what it was sent on stdin. */
function recording(onInput: (input: string) => void, lines: readonly string[], after?: () => void): RunFn {
  return (_bin, _args, options) => {
    onInput(String(options?.input ?? ''));
    for (const line of lines) options?.onLine?.(line);
    after?.();
    return Promise.resolve({ code: 0, signal: null, stdout: lines.map((l) => `${l}\n`).join(''), stderr: '' });
  };
}

test('both agents are given it, on stdin, by the adapters every turn goes through', async () => {
  installStandingInstructions(RULE);
  try {
    let toClaude = '';
    await claudeTurn(
      {
        prompt: 'plan this',
        sessionId: 's',
        resume: true,
        permissionMode: 'plan',
        model: 'm',
        effort: 'low',
        cwd: process.cwd(),
        timeoutMs: 1_000,
      },
      recording((i) => (toClaude = i), [
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's' }),
      ]),
    );
    // A RESUMED turn too: it is on every turn, not only a session's first.
    assert.ok(toClaude.includes(RULE));
    assert.ok(toClaude.endsWith('plan this'));

    const dir = mkdtempSync(path.join(tmpdir(), 'vibe-standing-'));
    let toCodex = '';
    await codexTurn(
      {
        prompt: 'review this',
        schema: { type: 'object' },
        schemaName: 'review-0',
        artifactDir: dir,
        model: 'm',
        effort: 'low',
        sandbox: 'read-only',
        cwd: process.cwd(),
        timeoutMs: 1_000,
      },
      recording((i) => (toCodex = i), [JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } })], () =>
        writeFileSync(path.join(dir, 'review-0.out.json'), '{"findings":[]}', 'utf8'),
      ),
    );
    assert.ok(toCodex.includes(RULE), 'the Codex seats get the same text, which no vendor file gives them both');
    assert.ok(toCodex.endsWith('review this'));
  } finally {
    clearPromptOverrides();
  }
});

/** A repository and a global file of its own, with the variable put back. */
function withGlobal<T>(global: unknown, project: unknown, body: (dir: string) => T): T {
  const root = mkdtempSync(path.join(tmpdir(), 'vibe-standing-cfg-'));
  const at = path.join(root, 'home', 'config.json');
  mkdirSync(path.dirname(at), { recursive: true });
  writeFileSync(at, JSON.stringify(global), 'utf8');
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  if (project !== null) writeFileSync(path.join(repo, 'vibe.config.json'), JSON.stringify(project), 'utf8');
  const before = process.env['VIBE_GLOBAL_CONFIG'];
  process.env['VIBE_GLOBAL_CONFIG'] = at;
  try {
    return body(repo);
  } finally {
    if (before === undefined) delete process.env['VIBE_GLOBAL_CONFIG'];
    else process.env['VIBE_GLOBAL_CONFIG'] = before;
  }
}

test('empty by default, so a run with none is the run it was', () => {
  assert.deepEqual(DEFAULTS.instructions, { text: '' });
});

test('the global file may hold it, and every project takes it from there', () => {
  withGlobal({ instructions: { text: RULE } }, null, (repo) => {
    assert.equal(loadConfig(repo).instructions.text, RULE);
  });
});

test("a project's own file wins, as with every setting", () => {
  withGlobal({ instructions: { text: RULE } }, { instructions: { text: 'this repo only' } }, (repo) => {
    assert.equal(loadConfig(repo).instructions.text, 'this repo only');
  });
});

test('a value that is not text is refused by name', () => {
  withGlobal({}, { instructions: { text: 3 } }, (repo) => {
    assert.throws(() => loadConfig(repo), /instructions\.text/);
  });
});

test("a run's record says when its agents were told something different", () => {
  const after = { ...DEFAULTS, instructions: { text: RULE } };
  assert.deepEqual(configDiff(DEFAULTS, after), ['instructions.text']);
});

test('a cleared box lets the instructions for all projects show through again', () => {
  // The settings screen clears a field by writing null.
  withGlobal({ instructions: { text: RULE } }, { instructions: { text: null } }, (repo) => {
    assert.equal(loadConfig(repo).instructions.text, RULE);
  });
});
