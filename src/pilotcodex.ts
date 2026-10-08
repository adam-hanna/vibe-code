import { modelArgs } from '@src/modelflag.js';
import { codexEffortOverride } from '@src/mcp.js';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectRateLimit } from '@src/claude.js';
import { codexBin, parseEvents } from '@src/codex.js';
import { agentEnv } from '@src/auth.js';
import { attachEnding, describeEnding, run } from '@src/proc.js';
import type { ChildEnding, RunFn } from '@src/proc.js';
import type { PilotChatOptions, PilotChatResult, PilotContext } from '@src/pilotchat.js';

/**
 * One pilot chat turn on the OpenAI subscription: `codex exec` (#223).
 *
 * `pilotchat.ts`'s twin for the other vendor, asked for as *"two options for
 * both anthropic and openAI: (1) subscription, (2) api key"*. Until this the
 * pilot could reach OpenAI only with a key. Same options, same result, same
 * reasons for not being a run turn: it narrates nothing, writes no state and is
 * charged to no run. What differs is how a chat is kept to its job, because
 * Codex's controls are not Claude's.
 *
 * ## What it may do: what Codex can, inside the person's rules
 *
 * **It has Codex's own shell now** (#223), at the owner's decision - *"the pilot
 * should be a full fledged cli … so long as it follows the sandbox rules"* -
 * which reverses the read-only pilot this module was written as. The limits are
 * the settings for all projects, and **Codex's sandbox** is what enforces them:
 *
 * - **YOLO** - `--dangerously-bypass-approvals-and-sandbox`. Nothing asked,
 *   nothing confined.
 * - **Otherwise** - `sandbox_mode="workspace-write"`, with the allowed
 *   directories as `writable_roots`: it reads anything, writes only inside the
 *   repository and those directories, and has no network. Set with `-c` on a
 *   resume as well as a new thread, because `resume` takes no `-s`. Measured on
 *   0.157.1: a resumed thread under this override wrote inside the repository
 *   and was refused (`read-only file system`) writing to the home directory.
 *
 * **The safe list cannot bound Codex's own commands, and that is said rather
 * than papered over.** `codex exec` has no per-command allow-list - its
 * approvals are off on that road - so outside YOLO every command may run *inside
 * the sandbox*, and the sandbox is the boundary. The safe list still decides
 * which of its `run_command` proposals run without a card, as on every backend.
 *
 * - **`OFF`** still switches off everything that is not coding: the browser and
 *   computer use, image generation, apps, plugins, sub-agents, goals, hooks.
 * - **`web_search="disabled"`** - a setting rather than a feature flag.
 * - **`--ignore-user-config`** - no `config.toml`, so no MCP servers and none of
 *   the person's own tool settings, which is `--strict-mcp-config`'s job on the
 *   Claude side. Auth still comes from `CODEX_HOME`, which is the subscription.
 *
 * ## The system prompt is a file, and why
 *
 * `model_instructions_file` replaces Codex's base instructions, as
 * `--system-prompt` replaces Claude's - measured, the turn's input fell from
 * ~12K tokens to ~7.6K with a short file. It is re-read on a resume, so the run
 * block the window rebuilds every turn reaches the model every turn. A file and
 * not `-c developer_instructions="…"`, because the prompt carries the run and the
 * tool table and Windows caps a whole command line at 32,767 characters.
 */

/** The features switched off for a chat turn (see the module comment). */
export const OFF: readonly string[] = [
  'apps',
  'plugins',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'in_app_browser',
  'image_generation',
  'view_image',
  'multi_agent',
  'goals',
  'hooks',
  'skill_search',
  'tool_suggest',
  'sleep_tool',
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The sandbox a turn runs in, from the person's settings (see the module
 * comment). The writable roots are the allowed directories beyond the
 * repository, which `workspace-write` already includes.
 */
export function sandboxArgs(options: PilotChatOptions): readonly string[] {
  if (options.access?.yolo === true) return ['--dangerously-bypass-approvals-and-sandbox'];
  const roots = (options.addDirs ?? []).filter((d) => d !== options.cwd);
  return [
    '-c',
    'sandbox_mode="workspace-write"',
    // JSON's array and string syntax are TOML's, so any path survives as itself.
    ...(roots.length === 0 ? [] : ['-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(roots)}`]),
  ];
}

/** The argv for one turn, given where its instructions were written. */
export function pilotCodexArgs(options: PilotChatOptions, instructions: string): readonly string[] {
  const common = [
    '--json',
    ...modelArgs('-m', options.model),
    // On a resume too: `exec resume` inherits neither the model nor the effort.
    ...(options.effort === undefined ? [] : codexEffortOverride(options.effort)),
    '--skip-git-repo-check',
    '--ignore-user-config',
    ...OFF.flatMap((feature) => ['--disable', feature]),
    '-c',
    'web_search="disabled"',
    // JSON's string syntax is TOML's basic string, so a path with a backslash
    // or a quote in it survives as itself.
    '-c',
    `model_instructions_file=${JSON.stringify(instructions)}`,
    ...sandboxArgs(options),
  ];
  // `resume` takes neither -C nor -s: its directory is the spawn's cwd, and the
  // sandbox comes from the `-c` overrides above, which it does honour. The
  // prompt arrives on stdin, which the trailing `-` says.
  return options.resume
    ? ['exec', 'resume', options.sessionId, ...common, '-']
    : ['exec', ...common, '-C', options.cwd, '-'];
}

/**
 * How full a Codex thread is, from the record Codex keeps of it (#223).
 *
 * **`codex exec --json` does not say**, so this is the one place the pilot reads
 * a file another program owns. `turn.completed` carries the turn's usage summed
 * over every request in it - measured on a pilot thread, 40,078 input tokens
 * against a last prompt of 14,280 - so it overstates occupancy by however many
 * requests the turn made, and it names no window at all. Codex's own rollout,
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-…-<thread>.jsonl`, writes a
 * `token_count` event after every request carrying both: `last_token_usage`
 * and `model_context_window`. That window is the figure Codex itself compacts
 * against, so it is a measurement made on this machine and not a table.
 *
 * **Fails closed, to null.** A format nobody promised can change under us, and
 * the right drawing of a context nobody measured is no figure - never the
 * turn's aggregate standing in for it. `cached_input_tokens` is a subset of
 * `input_tokens` (OpenAI's nesting, see `codex.ts`), so input alone is the
 * prompt.
 */
export function rolloutContext(
  threadId: string,
  home: string = process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex'),
): PilotContext | null {
  const file = findRollout(path.join(home, 'sessions'), threadId);
  if (file === null) return null;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? '';
    if (!line.includes('"token_count"')) continue;
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const payload = isRecord(event) ? event['payload'] : null;
    if (!isRecord(payload) || payload['type'] !== 'token_count') continue;
    const info = payload['info'];
    if (!isRecord(info)) continue;
    const last = info['last_token_usage'];
    const tokens = isRecord(last) ? last['input_tokens'] : null;
    if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return null;
    const window = info['model_context_window'];
    return {
      tokens,
      window: typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : null,
    };
  }
  return null;
}

/**
 * The rollout file for a thread, newest day first.
 *
 * A resumed thread keeps writing to the file it was created in, so the search
 * cannot stop at today. Matched on the name's suffix and never built from the
 * id, so a thread id is not a path anybody can steer.
 */
function findRollout(sessions: string, threadId: string): string | null {
  const suffix = `-${threadId}.jsonl`;
  const down = (dir: string): string[] => {
    try {
      return readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const year of down(sessions)) {
    for (const month of down(path.join(sessions, year))) {
      for (const day of down(path.join(sessions, year, month))) {
        const dir = path.join(sessions, year, month, day);
        const hit = down(dir).find((name) => name.endsWith(suffix));
        if (hit !== undefined) return path.join(dir, hit);
      }
    }
  }
  return null;
}

/** The text of an `agent_message` that completed on this line, or null. */
export function readMessage(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(event) || event['type'] !== 'item.completed') return null;
  const item = event['item'];
  if (!isRecord(item) || item['type'] !== 'agent_message') return null;
  const text = item['text'];
  return typeof text === 'string' && text !== '' ? text : null;
}

/**
 * Run one turn. `exec` is injected for `pilotChat`'s reason: the real CLI needs
 * a logged-in account and spends quota.
 *
 * Every message is passed on as it completes, separated by a blank line, so a
 * `vibe-tool` block written in an early message is read as surely as one in the
 * last — the lesson #223 already paid for on the Claude side. The reply is the
 * last message, which is what a person reads as the answer.
 */
export async function pilotCodex(
  options: PilotChatOptions,
  exec: RunFn = run,
  /** Injected so a test never reads the machine's own `~/.codex`. */
  readContext: (threadId: string) => PilotContext | null = rolloutContext,
): Promise<PilotChatResult> {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'vibe-pilot-'));
  const instructions = path.join(scratch, 'instructions.md');
  writeFileSync(instructions, options.system, 'utf8');
  const ended: { seen: ChildEnding | null } = { seen: null };
  let last: string | null = null;
  try {
    const { code, signal, stdout, stderr } = await exec(codexBin(), [...pilotCodexArgs(options, instructions)], {
      input: options.prompt,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      env: agentEnv('codex'),
      onLine: (line: string) => {
        const said = readMessage(line);
        if (said === null) return;
        const first = last === null;
        last = said;
        try {
          options.onDelta?.(first ? said : `\n\n${said}`);
        } catch {
          // A progress signal; see `pilotChat`.
        }
      },
    });
    ended.seen = { code, signal };
    const events = parseEvents(stdout);
    if (events.failed || last === null) {
      const detail = events.failure ?? 'no detail';
      const limit = detectRateLimit(`${detail}\n${stderr}`);
      if (limit !== null) throw limit;
      throw new Error(
        `the pilot's codex turn ${events.failed ? 'failed' : 'said nothing'} ` +
          `(${describeEnding({ code, signal })}): ${detail}\nstderr:\n${stderr.slice(-2000)}`,
      );
    }
    // The thread Codex says it ran on is the one that resumes. A first turn
    // has no id of ours to fall back on that Codex would recognise.
    const thread = events.threadId ?? (options.resume ? options.sessionId : null);
    return {
      text: last,
      sessionId: thread ?? options.sessionId,
      tokens: events.tokens,
      context: thread === null ? null : readContext(thread),
    };
  } catch (err: unknown) {
    throw ended.seen === null ? err : attachEnding(err, ended.seen);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
