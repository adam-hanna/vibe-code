import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import type { CodexTurnOptions } from '@src/codex.js';
import { runTurn, spendOf } from '@src/orchestrator.js';
import type { AgentTurns, Role, TurnRequest } from '@src/orchestrator.js';
import type { RunFn, RunResult } from '@src/proc.js';
import { rolesFor } from '@src/roles.js';
import { createRun } from '@src/run.js';
import { REVIEW_SCHEMA } from '@src/schemas.js';
import type { Config, RunState } from '@src/types.js';
import { codexTurnNoMcp as codexTurn } from './helpers/codex-mcp.js';

/**
 * Per-turn schemas reach both providers, and a writer's unreadable output is
 * returned rather than thrown (#393, groundwork).
 *
 * The groundwork for recording a fixer's dispositions as data. Nothing in `src/`
 * puts a schema on a request yet, so every case here either drives the adapter
 * directly or makes such a request itself - and the last cases pin that a turn
 * which names no schema is dispatched exactly as before.
 *
 * Nothing is spawned: the adapter takes a fake `exec` that writes the `-o` file
 * the real child would, and `runTurn` takes its providers as an argument.
 */

const USAGE = JSON.stringify({
  type: 'turn.completed',
  usage: { input_tokens: 900, output_tokens: 100, cached_input_tokens: 50 },
});

const SCHEMA = {
  type: 'object',
  properties: { report: { type: 'string' } },
  required: ['report'],
};

/** A child that exits 0, reports usage, and writes `output` as its last message. */
function writingExec(output: string, argvs: string[][] = []): RunFn {
  return (_bin, args, _options): Promise<RunResult> => {
    argvs.push([...args]);
    const at = args.indexOf('-o');
    const outFile = at === -1 ? undefined : args[at + 1];
    if (outFile !== undefined) writeFileSync(outFile, output, 'utf8');
    return Promise.resolve({ code: 0, signal: null, stdout: `${USAGE}\n`, stderr: '' });
  };
}

function options(over: Partial<CodexTurnOptions> = {}): CodexTurnOptions {
  return {
    prompt: 'fix it',
    schema: SCHEMA,
    schemaName: 'fix-1',
    artifactDir: mkdtempSync(path.join(tmpdir(), 'vibe-schema-')),
    model: 'fixture-model',
    effort: 'low',
    sandbox: 'workspace-write',
    cwd: process.cwd(),
    timeoutMs: 1_000,
    ...over,
  };
}

// ---- The adapter: `unparseable` -------------------------------------------

test('a schema turn whose output does not parse still throws when unparseable is omitted', async () => {
  // The default is the old behaviour, for every turn that names nothing - which
  // is every judge, and every turn before this option existed.
  await assert.rejects(
    () => codexTurn(options(), writingExec('I fixed F1 and rebutted F2.')),
    (err: unknown) => {
      assert.match((err as Error).message, /codex output was not valid JSON/);
      assert.deepEqual(spendOf(err), { costUsd: null, tokens: 1000 });
      return true;
    },
  );
});

test("unparseable: 'throw' throws, with the spend attached", async () => {
  await assert.rejects(
    () => codexTurn(options({ unparseable: 'throw' }), writingExec('not json')),
    (err: unknown) => {
      assert.match((err as Error).message, /codex output was not valid JSON/);
      assert.deepEqual(spendOf(err), { costUsd: null, tokens: 1000 });
      return true;
    },
  );
});

test("unparseable: 'raw' returns the text, structured null, and the turn's tokens", async () => {
  const report = 'I fixed F1 and rebutted F2.';
  const result = await codexTurn(options({ unparseable: 'raw' }), writingExec(report));

  assert.equal(result.structured, null);
  assert.equal(result.raw, report);
  // The spend the parsing path would have returned: nothing is lost by not throwing.
  assert.equal(result.tokens.total, 1000);
});

test("unparseable: 'raw' still parses output that is JSON", async () => {
  const result = await codexTurn(options({ unparseable: 'raw' }), writingExec('{"report":"done"}'));
  assert.deepEqual(result.structured, { report: 'done' });
});

test("an unparsed 'raw' turn reports the same tokens as a parsed one", async () => {
  const parsed = await codexTurn(options({ unparseable: 'raw' }), writingExec('{"report":"done"}'));
  const unparsed = await codexTurn(options({ unparseable: 'raw' }), writingExec('done, in prose'));
  assert.deepEqual(unparsed.tokens, parsed.tokens);
});

// ---- The dispatch: the request's schema, and `unparseable` from access -----

function freshState(): RunState {
  return createRun(mkdtempSync(path.join(tmpdir(), 'vibe-schema-run-')), 'per-turn schema', false);
}

/** The default table with the implementer seated on Codex. */
function codexWriterConfig(): Config {
  return {
    ...DEFAULTS,
    roles: { ...DEFAULTS.roles, implementer: 'codex' },
    // No app-server: the Codex rate-limit probe returns before it would connect.
    codex: { ...DEFAULTS.codex, readRateLimits: false },
    progress: { ...DEFAULTS.progress, enabled: false },
    context: { ...DEFAULTS.context, enabled: false },
  };
}

function request(role: Role, over: Partial<TurnRequest> = {}): TurnRequest {
  return { role, prompt: 'do the thing', cwd: process.cwd(), label: 'fix-1', timeoutMs: 1_000, ...over };
}

/** Codex through the real adapter and a fake child, recording what it was asked. */
function throughAdapter(
  output: string,
  calls: CodexTurnOptions[] = [],
  argvs: string[][] = [],
): AgentTurns {
  return {
    claude: () => Promise.reject(new Error('claude was dispatched to and should not have been')),
    codex: (opts) => {
      calls.push(opts);
      return codexTurn(opts, writingExec(output, argvs));
    },
  };
}

/** Runs `work` with console output swallowed; the dispatch narrates. */
async function quietly<T>(work: () => Promise<T>): Promise<T> {
  const log = console.log;
  const error = console.error;
  console.log = (): void => undefined;
  console.error = (): void => undefined;
  try {
    return await work();
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('a request schema reaches a Codex writer, marked unparseable: raw', async () => {
  const cfg = codexWriterConfig();
  const calls: CodexTurnOptions[] = [];
  const argvs: string[][] = [];
  const outcome = await quietly(() =>
    runTurn(
      freshState(),
      cfg,
      request('implementer', { jsonSchema: SCHEMA }),
      throughAdapter('{"report":"done"}', calls, argvs),
      rolesFor(cfg),
    ),
  );

  assert.equal(calls[0]?.schema, SCHEMA, 'the request schema, not the role (which has none)');
  assert.equal(calls[0]?.unparseable, 'raw');
  assert.ok(argvs.some((a) => a.includes('--output-schema')), 'the child was held to it');
  assert.deepEqual(outcome.structured, { report: 'done' });
});

test('a Codex writer whose schema output does not parse is a successful turn, charged the same', async () => {
  const cfg = codexWriterConfig();

  const parsedState = freshState();
  await quietly(() =>
    runTurn(
      parsedState,
      cfg,
      request('implementer', { jsonSchema: SCHEMA }),
      throughAdapter('{"report":"done"}'),
      rolesFor(cfg),
    ),
  );

  const unparsedState = freshState();
  const outcome = await quietly(() =>
    runTurn(
      unparsedState,
      cfg,
      request('implementer', { jsonSchema: SCHEMA }),
      throughAdapter('Fixed F1; rebutted F2.'),
      rolesFor(cfg),
    ),
  );

  assert.equal(outcome.structured, null);
  assert.equal(outcome.text, 'Fixed F1; rebutted F2.');
  assert.equal(unparsedState.tokensUsed, 1000);
  assert.equal(unparsedState.tokensUsed, parsedState.tokensUsed);
});

test('a read-only Codex seat given a request schema still fails on output that does not parse', async () => {
  // The lenient path is a writer's only: a judge never reaches it by accident.
  const cfg = codexWriterConfig();
  const calls: CodexTurnOptions[] = [];
  await quietly(() =>
    assert.rejects(
      () =>
        runTurn(
          freshState(),
          cfg,
          request('reviewer', { label: 'review-1', jsonSchema: SCHEMA }),
          throughAdapter('looks fine to me', calls),
          rolesFor(cfg),
        ),
      /codex output was not valid JSON/,
    ),
  );
  assert.equal(calls[0]?.unparseable, 'throw');
  assert.equal(calls[0]?.schema, SCHEMA);
});

// ---- A turn that names no schema is dispatched as before ------------------

test('a Codex writer with no request schema is sent no schema and no --output-schema', async () => {
  const cfg = codexWriterConfig();
  const calls: CodexTurnOptions[] = [];
  const argvs: string[][] = [];
  const outcome = await quietly(() =>
    runTurn(freshState(), cfg, request('implementer'), throughAdapter('Implemented.', calls, argvs), rolesFor(cfg)),
  );

  assert.equal(calls[0]?.schema, undefined);
  assert.ok(argvs.length > 0);
  assert.ok(argvs.every((a) => !a.includes('--output-schema')));
  assert.equal(outcome.structured, null);
  assert.equal(outcome.text, 'Implemented.');
});

test('a Codex judge with no request schema is sent its role schema, as before', async () => {
  const cfg = codexWriterConfig();
  const calls: CodexTurnOptions[] = [];
  await quietly(() =>
    runTurn(
      freshState(),
      cfg,
      request('reviewer', { label: 'review-1' }),
      throughAdapter('{"findings":[],"summary":"ok"}', calls),
      rolesFor(cfg),
    ),
  );
  assert.equal(calls[0]?.schema, REVIEW_SCHEMA);
  assert.equal(calls[0]?.unparseable, 'throw');
});
