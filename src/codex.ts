import { writeFileSync, readFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { resolveBin, run } from '@src/proc.js';
import type { RunFn } from '@src/proc.js';
import { detail, warn } from '@src/log.js';
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
  /**
   * A `turn.failed` event: Codex's own verdict on the turn, as distinct from a
   * top-level `error`, which it also emits for conditions it goes on to recover
   * from. Only the verdict fails the turn - treating every `error` as fatal
   * would fail turns that completed.
   */
  failed: boolean;
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
  const out: CodexEvents = { threadId: null, tokens: ZERO_TOKENS, failure: null, failed: false };

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
      if (event['type'] === 'turn.failed') out.failed = true;
    }
  }
  return out;
}

/** One string seen in the event stream, with what the stream said about it. */
export interface ProbeString {
  value: string;
  /** From a streaming partial (`item.updated`, a `*.delta` type) - a prefix, not a result. */
  partial: boolean;
  /**
   * An envelope field or a tool's input: it describes the turn rather than
   * answering it, so it is never the probe record.
   */
  meta: boolean;
}

export interface CodexProbeStream {
  /** Every string in the stream, in the order it arrived. */
  strings: readonly ProbeString[];
  /** Null when no `turn.completed` usage block was seen. */
  tokens: TokenUsage | null;
  /** Lines that were not JSON at all - what plain `exec` would have printed. */
  plain: string;
}

/**
 * Keys whose strings describe the turn or feed a tool, rather than answering.
 *
 * Two groups, and both matter. The envelope names (`type`, `id`, ...) would
 * otherwise be spliced between the fragments of a streamed reply, corrupting
 * the very record the reassembly exists to recover. The input names (`command`,
 * `prompt`, ...) are what vibe or the model sent, and the probe prompt names
 * both sentinels itself, so a command echoing them must not pass as the answer.
 */
const META_KEYS: ReadonlySet<string> = new Set([
  // Envelope.
  'type',
  'id',
  'item_id',
  'thread_id',
  'turn_id',
  'role',
  'status',
  'model',
  // Input.
  'command',
  'input',
  'prompt',
  'instructions',
  'arguments',
  'argv',
  'cwd',
]);

/**
 * Read a probe turn's `--json` stream: its token usage, and every string in it.
 *
 * Deliberately sentinel-agnostic, and deliberately keyed off nothing but the
 * event `type` prefix: this module knows the wire format, not what the probe is
 * looking for. Choosing which of these strings holds the probe record is
 * `selectProbeTranscript`'s job, in the adapter that owns the sentinels. Keying
 * this off `item.completed` or `agent_message` would couple token accounting to
 * item names that cannot be verified without a live Codex.
 */
export function parseProbeStream(stdout: string): CodexProbeStream {
  const strings: ProbeString[] = [];
  const plain: string[] = [];
  let tokens: TokenUsage | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let event: unknown = null;
    if (trimmed.startsWith('{')) {
      try {
        event = JSON.parse(trimmed);
      } catch {
        event = null;
      }
    }
    if (!isRecord(event)) {
      plain.push(line);
      continue;
    }

    const type = typeof event['type'] === 'string' ? event['type'] : '';
    if (type === 'turn.completed' && isRecord(event['usage'])) {
      tokens = extractTokens(event['usage']);
      continue;
    }
    collectStrings(event, type === 'item.updated' || type.endsWith('.delta'), false, strings);
  }

  return { strings, tokens, plain: plain.join('\n') };
}

/**
 * Every string under `value`, in order, carrying down what the event said about it.
 *
 * `meta` is inherited rather than tested per level: the elements of a `command`
 * array are as much input as the array itself.
 */
function collectStrings(
  value: unknown,
  partial: boolean,
  meta: boolean,
  out: ProbeString[],
): void {
  if (typeof value === 'string') {
    if (value !== '') out.push({ value, partial, meta });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, partial, meta, out);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    collectStrings(nested, partial, meta || META_KEYS.has(key), out);
  }
}

/**
 * Clear `file`, keeping its content at `keepAt` if there was any.
 *
 * The removal is what matters and must happen either way: if the rename fails -
 * a locked file, a directory that has gone away - the file is deleted instead,
 * because leaving it would let the next turn mistake it for its own output.
 */
function supersede(file: string, keepAt: string): void {
  if (!existsSync(file)) return;
  try {
    renameSync(file, keepAt);
  } catch {
    rmSync(file, { force: true });
  }
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
 *
 * **What counts as a failed turn.** A `turn.failed` verdict, or no parseable
 * structured output written by this child. Not the exit status: a non-zero exit
 * alongside a schema-conformant output file means teardown failed after the work
 * was done, so it is warned about and accepted rather than discarding a turn
 * that has already been paid for. Deterministic tools are judged the other way
 * round; see git.ts and verify.ts.
 *
 * `exec` is injected so the adapter's boundary with the heartbeat can be tested
 * without spawning a real agent, as `rotateSession` and `ClaudeProbeExecutor`
 * already are.
 */
export async function codexTurn(
  options: CodexTurnOptions,
  exec: RunFn = run,
): Promise<CodexTurnResult> {
  const { prompt, schema, schemaName, artifactDir, model, effort, sandbox, cwd, timeoutMs, sessionId } =
    options;

  const schemaFile = path.join(artifactDir, `${schemaName}.schema.json`);
  const outFile = path.join(artifactDir, `${schemaName}.out.json`);
  writeFileSync(schemaFile, JSON.stringify(schema, null, 2), 'utf8');
  // Moved aside before the child runs, because the name is derived from the
  // round (`review-2`) and withRateLimitRetry re-runs the same turn under the
  // same name. Left in place, a retry whose child wrote nothing found the
  // previous attempt's file, parsed it, and reported a superseded result as this
  // turn's - a failed turn passing as a successful one by way of the filesystem.
  //
  // Renamed rather than deleted: nothing else persists a rejected turn's raw
  // output (runCodex keeps only the parsed structure), so deleting it would make
  // the attempt that went wrong the one attempt with no evidence left. One slot,
  // overwritten by the next supersede - the point is diagnosing the last
  // failure, not keeping a history.
  supersede(outFile, path.join(artifactDir, `${schemaName}.superseded.json`));

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
  // Validation runs inside the heartbeat's work, not after it: the end-of-turn
  // flush is a claim that the turn completed, and while only `run()` was wrapped
  // a turn that wrote no usable output still persisted as one that had.
  return withHeartbeat(heartbeat, async () => {
    const { code, stdout, stderr } = await exec(codexBin(), args, {
      input: prompt,
      cwd,
      timeoutMs,
      ...(heartbeat === null ? {} : { onLine: heartbeat.onLine }),
    });

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

    if (events.failed) {
      // Checked even though a file exists. `turn.failed` is Codex's own verdict,
      // and a file beside it is either a partial write or an artifact of an
      // earlier phase of the same turn; accepting it would hand the loop a
      // result the agent said was not one.
      throw new Error(`codex reported the turn failed (exit ${code}): ${events.failure ?? 'no detail'}`);
    }

    // Always read as UTF-8: Codex emits smart quotes and em dashes that mangle
    // under the Windows ANSI codepage.
    const raw = readFileSync(outFile, 'utf8');
    let structured: unknown;
    try {
      structured = JSON.parse(raw) as unknown;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`codex output was not valid JSON: ${message}\n${raw.slice(0, 1500)}`);
    }

    if (code !== 0) {
      // Logged, not thrown: see the exit-status note above.
      warn(`codex exited ${String(code)} but wrote schema-conformant output; accepting it.`);
    }

    return { structured, raw, sessionId: returnedSession, tokens: events.tokens };
  });
}
