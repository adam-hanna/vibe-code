import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectRateLimit } from '@src/claude.js';
import { codexBin, parseEvents } from '@src/codex.js';
import { agentEnv } from '@src/auth.js';
import { attachEnding, describeEnding, run } from '@src/proc.js';
import type { ChildEnding, RunFn } from '@src/proc.js';
import type { PilotChatOptions, PilotChatResult } from '@src/pilotchat.js';

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
 * ## What it may do, and how that is enforced
 *
 * **Codex has no closed tool allow-list.** `claude --tools Read Glob Grep` names
 * what exists and everything else does not; Codex's tools are features, on by
 * default, and the only control is switching each one off. So this is a
 * deny-list - the shape `pilotchat.ts` replaced because a tool a future release
 * adds is not on it - and it is held to that standard by what sits under it:
 *
 * - **`OFF`** switches off the shell, code mode, the browser and computer use,
 *   image generation, apps, plugins, sub-agents, goals and hooks. Measured on
 *   0.157.1: the turn then lists only `exec` (which fails closed with code mode
 *   off), `wait` and `request_user_input`, and cannot read a file at all.
 * - **`web_search="disabled"`** - not a feature flag, a setting.
 * - **`-s read-only`** on a new thread, and `resume`'s default, which is the
 *   same: whatever a future tool does, it does not write and has no network.
 * - **`--ignore-user-config`** - no `config.toml`, so no MCP servers and none of
 *   the person's own tool settings, which is `--strict-mcp-config`'s job on the
 *   Claude side. Auth still comes from `CODEX_HOME`, which is the subscription.
 *
 * So the Codex pilot reads the disk only through vibe's own `list_dir` and
 * `read_file`, which the host answers inside the allowed directories - the same
 * boundary as the API-backed pilot, and narrower than the Claude CLI's.
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
  'shell_tool',
  'unified_exec',
  'code_mode_host',
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

/** The argv for one turn, given where its instructions were written. */
export function pilotCodexArgs(options: PilotChatOptions, instructions: string): readonly string[] {
  const common = [
    '--json',
    '-m',
    options.model,
    '--skip-git-repo-check',
    '--ignore-user-config',
    ...OFF.flatMap((feature) => ['--disable', feature]),
    '-c',
    'web_search="disabled"',
    // JSON's string syntax is TOML's basic string, so a path with a backslash
    // or a quote in it survives as itself.
    '-c',
    `model_instructions_file=${JSON.stringify(instructions)}`,
  ];
  // `resume` takes neither -C nor -s: its directory is the spawn's cwd and its
  // sandbox defaults to read-only, which is the one wanted. The prompt arrives
  // on stdin, which the trailing `-` says.
  return options.resume
    ? ['exec', 'resume', options.sessionId, ...common, '-']
    : ['exec', ...common, '-s', 'read-only', '-C', options.cwd, '-'];
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
    return {
      text: last,
      // The thread Codex says it ran on is the one that resumes. A first turn
      // has no id of ours to fall back on that Codex would recognise.
      sessionId: events.threadId ?? options.sessionId,
      tokens: events.tokens,
    };
  } catch (err: unknown) {
    throw ended.seen === null ? err : attachEnding(err, ended.seen);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
