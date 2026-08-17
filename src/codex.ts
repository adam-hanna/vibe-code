import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { resolveBin, run } from '@src/proc.js';
import { detail } from '@src/log.js';
import { createHeartbeat, parseCodexLine, withHeartbeat } from '@src/progress.js';
import type { ProgressOptions } from '@src/progress.js';
import type { Effort, Sandbox, TokenUsage } from '@src/types.js';

let cachedBin: string | null = null;

export function codexBin(): string {
  cachedBin ??= resolveBin('codex', {
    envVar: 'VIBE_CODEX_BIN',
    // `.sandbox-bin` appears on PATH ahead of the real install on this layout,
    // but its `codex.exe` cannot execute shell commands without a
    // `codex-code-mode-host.exe` that is not shipped alongside it. Skipping it
    // during the PATH scan while keeping it as a last-resort fallback means a
    // machine where it is the only copy still works.
    deprioritize: /[\\/]\.sandbox-bin[\\/]/i,
    fallbacks: [
      // The versioned install directory first. `~/.codex/.sandbox-bin/codex.exe`
      // is a sandbox helper copy that expects a sibling
      // `codex-code-mode-host.exe`; where that sibling is absent every command
      // fails with "failed to spawn code-mode host", which reads like a broken
      // toolchain rather than a mis-resolved binary. Keep it last.
      '~/AppData/Local/OpenAI/Codex/bin/*/codex.exe',
      '~/.local/bin/codex',
      '/usr/local/bin/codex',
      '~/.codex/.sandbox-bin/codex.exe',
    ],
  });
  return cachedBin;
}

export interface CodexTurnOptions {
  prompt: string;
  schema: object;
  schemaName: string;
  artifactDir: string;
  model: string;
  effort: Effort;
  sandbox: Sandbox;
  cwd: string;
  timeoutMs: number;
  /** Existing Codex thread to continue. Null starts a new one. */
  sessionId?: string | null | undefined;
  /** Live progress. Omitted disables it entirely, which is what preflight wants. */
  progress?: ProgressOptions | undefined;
}

export interface CodexTurnResult {
  structured: unknown;
  raw: string;
  /** Thread id for this turn, to be passed back on the next call. */
  sessionId: string | null;
  /**
   * Tokens the turn moved. Costs nothing extra to obtain - `--json` reports it
   * on `turn.completed` - and without it the Codex side of a run is invisible
   * to every budget brake. There is still no USD figure: Codex reports none,
   * so `budget.maxCostUsd` remains a Claude-only ceiling.
   */
  tokens: TokenUsage;
}

/**
 * Fallback only. `--json` emits a `thread.started` event carrying the id;
 * this scrapes the human-readable stderr banner for the case where it does not.
 */
const SESSION_ID_RE = /session id:\s*([0-9a-fA-F-]{36})/;

const ZERO_TOKENS: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0 };

interface CodexEvents {
  threadId: string | null;
  tokens: TokenUsage;
  /** Message from a `turn.failed` or top-level `error` event, for diagnostics. */
  failure: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Tokens from Codex's `turn.completed` usage block.
 *
 * The nesting convention is OpenAI's, not Anthropic's: `cached_input_tokens`
 * is a SUBSET of `input_tokens`, and `reasoning_output_tokens` a subset of
 * `output_tokens`. Measured on a resumed thread - input 29163 with cached
 * 13056, where the previous turn's entire prompt had been 13690, so the cache
 * hit is counted inside the input figure rather than beside it; and output 59
 * with reasoning 41 for a one-word answer. Claude's envelope nests neither,
 * which is why claude.ts adds its four fields together and this adds two.
 * Summing all four here would count the same prompt twice.
 */
function extractTokens(usage: Record<string, unknown>): TokenUsage {
  const input = num(usage['input_tokens']);
  const output = num(usage['output_tokens']);
  return {
    input,
    output,
    cacheRead: num(usage['cached_input_tokens']),
    cacheCreation: num(usage['cache_write_input_tokens']),
    total: input + output,
  };
}

/**
 * Read the JSONL event stream.
 *
 * Tolerant by design: a line that does not parse is skipped rather than
 * failing the turn, because the structured output file is the actual result
 * and losing a token count is not worth losing the work for.
 */
function parseEvents(stdout: string): CodexEvents {
  const out: CodexEvents = { threadId: null, tokens: ZERO_TOKENS, failure: null };

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || !trimmed.startsWith('{')) continue;

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;

    if (event['type'] === 'thread.started' && typeof event['thread_id'] === 'string') {
      out.threadId = event['thread_id'];
    } else if (event['type'] === 'turn.completed' && isRecord(event['usage'])) {
      out.tokens = extractTokens(event['usage']);
    } else if (event['type'] === 'turn.failed' || event['type'] === 'error') {
      const err = event['error'];
      const message = isRecord(err) ? err['message'] : event['message'];
      if (typeof message === 'string') out.failure = message;
    }
  }
  return out;
}

/**
 * One Codex turn with a schema-constrained final message.
 *
 * `--output-schema` is what makes the surrounding loop terminable: the stop
 * condition reads a typed `severity` field instead of pattern-matching prose.
 *
 * When `sessionId` is supplied the turn continues that thread via
 * `codex exec resume`, so the reviewer keeps everything it already worked out
 * about this repo and knows which findings it has already raised.
 */
export async function codexTurn(options: CodexTurnOptions): Promise<CodexTurnResult> {
  const { prompt, schema, schemaName, artifactDir, model, effort, sandbox, cwd, timeoutMs, sessionId } =
    options;

  const schemaFile = path.join(artifactDir, `${schemaName}.schema.json`);
  const outFile = path.join(artifactDir, `${schemaName}.out.json`);
  writeFileSync(schemaFile, JSON.stringify(schema, null, 2), 'utf8');

  // `resume` accepts neither -C nor -s: it takes its working directory from the
  // spawned process cwd, and its sandbox defaults to read-only. It does NOT
  // inherit -m or the reasoning effort either, so both are re-sent every turn -
  // omitting them silently drops back to the config.toml default model.
  // `--json` turns stdout into JSONL, which is the only way Codex reports token
  // usage. It does not change what lands in `outFile`, so the result path is
  // unaffected; it is accepted by both `exec` and `exec resume`.
  const args: string[] = sessionId
    ? [
        'exec', 'resume', sessionId,
        '--json',
        '-m', model,
        '-c', `model_reasoning_effort="${effort}"`,
        '--skip-git-repo-check',
        '--output-schema', schemaFile,
        '-o', outFile,
        '-',
      ]
    : [
        'exec',
        '--json',
        '-m', model,
        '-c', `model_reasoning_effort="${effort}"`,
        '-s', sandbox,
        '--skip-git-repo-check',
        '-C', cwd,
        '--output-schema', schemaFile,
        '-o', outFile,
        '-',
      ];

  detail(`codex ${sessionId ? 'resume' : 'exec'} -m ${model} (${effort}) -> ${schemaName}`);

  const heartbeat = options.progress
    ? createHeartbeat({ ...options.progress, parse: parseCodexLine, unit: 'event' })
    : null;
  const { code, stdout, stderr } = await withHeartbeat(heartbeat, () =>
    run(codexBin(), args, {
      input: prompt,
      cwd,
      timeoutMs,
      ...(heartbeat === null ? {} : { onLine: heartbeat.onLine }),
    }),
  );

  const events = parseEvents(stdout);
  const returnedSession = events.threadId ?? SESSION_ID_RE.exec(stderr)?.[1] ?? sessionId ?? null;

  if (!existsSync(outFile)) {
    // `turn.failed` states the actual cause (a bad model name, a refused
    // request); the raw streams are the fallback when it does not.
    const cause = events.failure === null ? '' : `\ncodex reported: ${events.failure}`;
    throw new Error(
      `codex wrote no structured output (exit ${code}).${cause}\n` +
        `stderr:\n${stderr.slice(-2000)}\nstdout:\n${stdout.slice(-1000)}`,
    );
  }

  // Always read as UTF-8: Codex emits smart quotes and em dashes that mangle
  // under the Windows ANSI codepage.
  const raw = readFileSync(outFile, 'utf8');
  try {
    return {
      structured: JSON.parse(raw) as unknown,
      raw,
      sessionId: returnedSession,
      tokens: events.tokens,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`codex output was not valid JSON: ${message}\n${raw.slice(0, 1500)}`);
  }
}
