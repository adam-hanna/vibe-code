import { writeFileSync, readFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { attachSpend } from '@src/charge.js';
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
  /**
   * The shape the final message must take, or omitted for a turn whose product
   * is the working tree rather than a verdict - an implementing Codex role.
   * `-o` (`--output-last-message`) is what writes the file either way;
   * `--output-schema` only constrains what goes in it.
   */
  schema?: object | undefined;
  schemaName: string;
  artifactDir: string;
  model: string;
  effort: Effort;
  sandbox: Sandbox;
  cwd: string;
  timeoutMs: number;
  /** Existing Codex thread to continue. Null starts a new one. */
  sessionId?: string | null | undefined;
  /**
   * A parent thread to fork, for a forked run's first turn on this conversation
   * (#78). Mutually exclusive with `sessionId`.
   *
   * `codex exec fork <id>` copies the thread and runs the turn on the copy, so
   * the parent stays resumable. The new thread id is PROVIDER-minted - there is
   * no client-chosen equivalent of Claude's `--session-id` - which is why a
   * Codex fork is once-only except across a process kill before the turn is
   * charged; see the dispatch in `src/orchestrator.ts`.
   */
  forkFrom?: string | null | undefined;
  /** Live progress. Omitted disables it entirely, which is what preflight wants. */
  progress?: ProgressOptions | undefined;
}

export interface CodexTurnResult {
  /** The parsed output, or null for a turn that was given no schema. */
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
 * The flags the direct fork vector sends. `--output-schema` is conditional, so
 * it is checked only when a schema is in play.
 */
const FORK_FLAGS: readonly string[] = ['--json', '-m', '-c', '--skip-git-repo-check', '-o'];

/**
 * Every option token a help text declares, as exact tokens.
 *
 * Token boundaries, and short and long kept apart, because substring matching is
 * wrong in both directions here: `help.includes('-m')` is satisfied by `--model`
 * - and by `--skip-git-repo-check`, and by the word "command" in a sentence - so
 * a binary that accepts only the long forms would have read as accepting the
 * short ones and been sent a vector it rejects. The lookbehind is what stops
 * `--model` also contributing `-model`; the lookahead stops `--out` matching
 * inside `--output-schema`.
 */
export function parseOptionTokens(help: string): Set<string> {
  const found = new Set<string>();
  for (const match of help.matchAll(/(?<![A-Za-z0-9_-])(--?[A-Za-z0-9][A-Za-z0-9-]*)(?![A-Za-z0-9-])/g)) {
    const token = match[1];
    if (token !== undefined) found.add(token);
  }
  return found;
}

/**
 * What `codex exec fork --help` said, read once per process.
 *
 * `undefined` is "not asked yet", `null` is "asked and could not be read". The
 * distinction matters: an unreadable help text is not evidence that a flag is
 * missing, and switching to the slower two-call path on no evidence would be
 * the same fabrication this codebase refuses about numbers.
 */
let forkHelpText: string | null | undefined;

/** Exported for the tests, which must not inherit another case's probe. */
export function resetCodexForkProbe(): void {
  forkHelpText = undefined;
}

async function forkHelp(exec: RunFn, cwd: string): Promise<string | null> {
  if (forkHelpText !== undefined) return forkHelpText;
  try {
    const { code, stdout, stderr } = await exec(codexBin(), ['exec', 'fork', '--help'], { cwd });
    const text = `${stdout}\n${stderr}`;
    forkHelpText = code === 0 && text.trim() !== '' ? text : null;
  } catch {
    forkHelpText = null;
  }
  return forkHelpText;
}

/**
 * What `codex exec fork` on THIS machine accepts, or null when the help could
 * not be read.
 *
 * The plan pinned the direct form against codex-cli 0.150.0-alpha.8, and both
 * CLIs move. Rather than trust that reading forever, the help text is read once
 * and the answer decides which path a fork takes. Unreadable help means the
 * direct form, unchanged: it is what every probed version accepts, the fallback
 * is not free, and an unreadable help text is not evidence that anything is
 * missing.
 */
async function forkOptions(exec: RunFn, cwd: string): Promise<Set<string> | null> {
  const help = await forkHelp(exec, cwd);
  return help === null ? null : parseOptionTokens(help);
}

/** Whether the direct vector's whole flag set is declared. Unknown counts as yes. */
function directForkWorks(options: Set<string> | null, hasSchema: boolean): boolean {
  if (options === null) return true;
  const needed = hasSchema ? [...FORK_FLAGS, '--output-schema'] : FORK_FLAGS;
  return needed.every((flag) => options.has(flag));
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
  const { prompt, schema, schemaName, artifactDir, model, effort, sandbox, cwd, timeoutMs, sessionId, forkFrom } =
    options;

  const schemaFile = path.join(artifactDir, `${schemaName}.schema.json`);
  const outFile = path.join(artifactDir, `${schemaName}.out.json`);
  // No schema, no schema file: a writing role's product is the tree, and its
  // final message is a report. Writing an empty one would leave an artifact
  // claiming a contract this turn was never held to.
  if (schema !== undefined) writeFileSync(schemaFile, JSON.stringify(schema, null, 2), 'utf8');
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
  // Only when there is a schema to enforce. `-o` is `--output-last-message` and
  // stands alone, so a schema-less turn still writes its final message to the
  // same file - which is what the result path reads either way.
  const schemaArgs = schema === undefined ? [] : ['--output-schema', schemaFile];

  // `fork` is `resume`'s shape with a different verb, and for the same reasons:
  // it accepts neither -C nor -s, so the working directory comes from the
  // spawned process cwd and the sandbox defaults to read-only, and it inherits
  // neither the model nor the reasoning effort, so both are re-sent. The
  // explicit `-` is required - the prompt arrives on stdin.
  //
  // Mutually exclusive with `sessionId` by construction: the dispatch asks the
  // slot for a fork parent first and only resumes when there is none.
  //
  // The TWO-CALL fallback, for a `codex exec fork` that does not accept the flags
  // the direct vector sends: mint the forked thread with a bare
  // `codex exec fork <parent>` and no prompt - which copies the thread and runs
  // no turn, so it reports no usage and there is nothing to charge - then take
  // the turn itself on the new thread through the ordinary `exec resume` path.
  // Still a fork on the first turn, which is the property that matters.
  let resumeAfterFork: string | null = null;
  if (forkFrom) {
    const options = await forkOptions(exec, cwd);
    if (!directForkWorks(options, schema !== undefined)) {
      detail(`codex exec fork ${forkFrom} (two-call: this codex does not accept the direct flags)`);
      // The mint call sends NOTHING the probe has not confirmed. `--json` is one
      // of the flags that can be missing, and sending it here would fail on
      // exactly the binaries this path exists for - the fallback would then be
      // broken on every machine that needs it and on no machine that does not,
      // which is the worst possible place for a defect to hide.
      const wantsJson = options?.has('--json') === true;
      const minted = await exec(
        codexBin(),
        wantsJson ? ['exec', 'fork', forkFrom, '--json'] : ['exec', 'fork', forkFrom],
        { input: '', cwd, timeoutMs },
      );
      // With `--json` the id arrives as a `thread.started` event; without it,
      // the human-readable banner is all there is, and it is printed to either
      // stream depending on the version. All three are read, in order of how
      // much the source is trusted.
      const thread =
        parseEvents(minted.stdout).threadId ??
        SESSION_ID_RE.exec(minted.stderr)?.[1] ??
        SESSION_ID_RE.exec(minted.stdout)?.[1] ??
        null;
      if (thread === null) {
        throw new Error(
          `codex exec fork ${forkFrom} named no thread, so there is nothing to take the turn on. ` +
            `${minted.stderr.trim() || 'No error was reported.'}`,
        );
      }
      resumeAfterFork = thread;
    }
  }

  const args: string[] = resumeAfterFork
    ? [
        'exec', 'resume', resumeAfterFork,
        '--json',
        '-m', model,
        '-c', `model_reasoning_effort="${effort}"`,
        '--skip-git-repo-check',
        ...schemaArgs,
        '-o', outFile,
        '-',
      ]
    : forkFrom
    ? [
        'exec', 'fork', forkFrom,
        '--json',
        '-m', model,
        '-c', `model_reasoning_effort="${effort}"`,
        '--skip-git-repo-check',
        ...schemaArgs,
        '-o', outFile,
        '-',
      ]
    : sessionId
    ? [
        'exec', 'resume', sessionId,
        '--json',
        '-m', model,
        '-c', `model_reasoning_effort="${effort}"`,
        '--skip-git-repo-check',
        ...schemaArgs,
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
        ...schemaArgs,
        '-o', outFile,
        '-',
      ];

  const verb = forkFrom ? (resumeAfterFork === null ? 'fork' : 'fork+resume') : sessionId ? 'resume' : 'exec';
  detail(`codex ${verb} -m ${model} (${effort}) -> ${schemaName}`);

  const heartbeat = options.progress
    ? createHeartbeat({
        ...options.progress,
        parse: parseCodexLine,
        unit: 'event',
        provider: 'codex',
      })
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
    // `resumeAfterFork` is in the chain because the two-call path takes its turn
    // through `exec resume`, whose stream names the thread it resumed - but if
    // that turn emitted no `thread.started` at all, the id the first call minted
    // is still the thread this turn ran on, and losing it would leave the slot
    // fresh and re-fork a thread that already exists.
    const returnedSession =
      events.threadId ?? SESSION_ID_RE.exec(stderr)?.[1] ?? resumeAfterFork ?? sessionId ?? null;

    // What the turn spent before it failed. `parseEvents` has already read the
    // `turn.completed` usage block by this point, so every throw below can carry
    // it out and let the dispatch layer charge the failure through the shared
    // accounting rather than losing it. `costUsd` is null, not zero: Codex
    // reports no cost, and that is the distinction `applyCharge` routes on.
    // Where no `turn.completed` was seen this is ZERO_TOKENS, and `attachSpend`
    // records nothing at all for it: a turn that reported no usage and one that
    // reported none worth charging are the same answer to the only question the
    // accounting asks, so `spendOf` says null for both.
    const spent = { costUsd: null, tokens: events.tokens.total };

    if (!existsSync(outFile)) {
      // `turn.failed` states the actual cause (a bad model name, a refused
      // request); the raw streams are the fallback when it does not.
      const cause = events.failure === null ? '' : `\ncodex reported: ${events.failure}`;
      throw attachSpend(
        new Error(
          `codex wrote no structured output (exit ${code}).${cause}\n` +
            `stderr:\n${stderr.slice(-2000)}\nstdout:\n${stdout.slice(-1000)}`,
        ),
        spent,
      );
    }

    if (events.failed) {
      // Checked even though a file exists. `turn.failed` is Codex's own verdict,
      // and a file beside it is either a partial write or an artifact of an
      // earlier phase of the same turn; accepting it would hand the loop a
      // result the agent said was not one.
      throw attachSpend(
        new Error(`codex reported the turn failed (exit ${code}): ${events.failure ?? 'no detail'}`),
        spent,
      );
    }

    // Always read as UTF-8: Codex emits smart quotes and em dashes that mangle
    // under the Windows ANSI codepage.
    const raw = readFileSync(outFile, 'utf8');
    // Parsed only where a schema was asked for. A writing turn's last message is
    // a report in prose, and demanding JSON of it would fail a turn that did
    // exactly what it was told - the same distinction `structured: null` states.
    let structured: unknown = null;
    if (schema !== undefined) {
      try {
        structured = JSON.parse(raw) as unknown;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw attachSpend(
          new Error(`codex output was not valid JSON: ${message}\n${raw.slice(0, 1500)}`),
          spent,
        );
      }
    }

    if (code !== 0) {
      // Logged, not thrown: see the exit-status note above.
      warn(`codex exited ${String(code)} but wrote schema-conformant output; accepting it.`);
    }

    return { structured, raw, sessionId: returnedSession, tokens: events.tokens };
  });
}
