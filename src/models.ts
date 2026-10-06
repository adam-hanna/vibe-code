import { tmpdir } from 'node:os';
import { agentEnv } from '@src/auth.js';
import { AppServerClient, spawnCodexAppServer } from '@src/appserver.js';
import { claudeBin } from '@src/claude.js';
import { codexBin } from '@src/codex.js';
import { run } from '@src/proc.js';
import type { AgentProvider } from '@src/runtime.js';

/**
 * Which models each CLI offers, asked of the CLI rather than written here (#223).
 *
 * Every picker in the product read a list this repository shipped - `opus`,
 * `sonnet`, `haiku`, `gpt-5.6-luna`, `gpt-5.6-pro` - and every one of them
 * aged on the vendors' schedule instead of ours: Opus 5.5 and Fable 5.1 could
 * not be picked in the pilot, Codex's default had moved to `gpt-6-astra`, and
 * `gpt-5.6-pro` was no longer in Codex's own list at all. *"What if claude
 * introduces a new model, we have to change source code? I really want to
 * avoid that."*
 *
 * Both CLIs will say, on the subscription and without spending a token:
 *
 * - **`claude`** answers the stream-json `initialize` control request - the one
 *   the Agent SDK's `supportedModels()` reads - with every model the account
 *   may pick, its alias, what that alias resolves to and a description. No user
 *   message is sent and stdin is closed after the request, so the process
 *   answers and exits without a turn: measured at 2.5s, exit 0, no `result`.
 * - **`codex app-server`** answers `model/list` with the same, and marks which
 *   one is its default.
 *
 * **Neither is a promised interface**, which is why both parsers fail closed:
 * a shape this build cannot read is a listing that failed and says why, never
 * a list guessed at. And there is **no fallback list in this file**, because a
 * fallback is a list somebody has to keep current, which is the problem this
 * exists to remove. A picker without a listing keeps the value it has and lets
 * a name be typed.
 *
 * Each child runs with `agentEnv`, so the list is the one the account a run
 * would bill can actually use.
 */

export { CLI_DEFAULT, modelArgs } from '@src/modelflag.js';
import { CLI_DEFAULT } from '@src/modelflag.js';

export interface ModelOption {
  /** What is saved and passed with `--model` / `-m`. */
  value: string;
  /** What that value runs today, when the CLI said. An alias resolves; a name is itself. */
  resolves: string | null;
  /** The CLI's own name for it. */
  name: string;
  /** The CLI's own one line about it, or empty. */
  description: string;
}

export type ModelListing =
  | { ok: true; models: readonly ModelOption[] }
  | { ok: false; why: string };

export type ModelListings = Readonly<Record<AgentProvider, ModelListing>>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/**
 * Claude's `initialize` answer, as options. `default` comes first, as Claude
 * lists it, with what it resolves to; null when the shape is not one this build
 * can read.
 */
export function readClaudeModels(models: unknown): ModelOption[] | null {
  if (!Array.isArray(models)) return null;
  const out: ModelOption[] = [];
  for (const m of models) {
    if (typeof m !== 'object' || m === null) continue;
    const r = m as Record<string, unknown>;
    const value = str(r['value']);
    if (value === null) continue;
    const resolves = str(r['resolvedModel']);
    const option: ModelOption = {
      value,
      resolves,
      name: str(r['displayName']) ?? value,
      description: str(r['description']) ?? '',
    };
    if (value === CLI_DEFAULT) out.unshift({ ...option, name: 'Default' });
    else out.push(option);
  }
  return out.length === 0 ? null : out;
}

/**
 * Codex's `model/list` pages, as options. Codex names no `default` value, so
 * the one it marks `isDefault` is offered again first as `default` - the value
 * that sends no `-m` - because that is what following Codex's default means.
 */
export function readCodexModels(pages: readonly unknown[]): ModelOption[] | null {
  const out: ModelOption[] = [];
  let fallback: ModelOption | null = null;
  for (const page of pages) {
    const data = typeof page === 'object' && page !== null ? (page as Record<string, unknown>)['data'] : undefined;
    if (!Array.isArray(data)) return null;
    for (const m of data) {
      if (typeof m !== 'object' || m === null) continue;
      const r = m as Record<string, unknown>;
      if (r['hidden'] === true) continue;
      const value = str(r['model']) ?? str(r['id']);
      if (value === null) continue;
      const option: ModelOption = {
        value,
        resolves: value,
        name: str(r['displayName']) ?? value,
        description: str(r['description']) ?? '',
      };
      if (r['isDefault'] === true) fallback = { ...option, value: CLI_DEFAULT, name: 'Default' };
      out.push(option);
    }
  }
  if (out.length === 0) return null;
  return fallback === null ? out : [fallback, ...out];
}

/** The line that asks `claude` for its models and nothing else. */
const INITIALIZE = `${JSON.stringify({ type: 'control_request', request_id: 'vibe-models', request: { subtype: 'initialize' } })}\n`;

const LIST_TIMEOUT_MS = 60_000;

/** Ask `claude`. Never throws: a failure is a listing that says why. */
export async function listClaudeModels(): Promise<ModelListing> {
  try {
    const result = await run(
      claudeBin(),
      ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config'],
      // A neutral directory: a repository's own settings could otherwise name
      // a model, and this list is about the account, not one project.
      { input: INITIALIZE, cwd: tmpdir(), timeoutMs: LIST_TIMEOUT_MS, env: agentEnv('claude') },
    );
    for (const line of result.stdout.split('\n')) {
      if (!line.includes('control_response')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const response = (parsed as { response?: { response?: { models?: unknown } } }).response?.response;
      const models = readClaudeModels(response?.models);
      if (models !== null) return { ok: true, models };
      return { ok: false, why: 'claude answered, but not with a list of models this build can read' };
    }
    const said = result.stderr.trim().split('\n').pop() ?? '';
    return { ok: false, why: `claude did not list its models${said === '' ? '' : `: ${said.slice(0, 300)}`}` };
  } catch (err: unknown) {
    return { ok: false, why: `claude could not be asked: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Ask `codex app-server`, following its pages. Never throws. */
export async function listCodexModels(): Promise<ModelListing> {
  let client: AppServerClient | null = null;
  try {
    client = new AppServerClient(spawnCodexAppServer(codexBin(), tmpdir()), {
      handshakeTimeoutMs: LIST_TIMEOUT_MS,
      requestTimeoutMs: LIST_TIMEOUT_MS,
    });
    await client.handshake();
    const pages: unknown[] = [];
    let cursor: string | null = null;
    // A bound on pages rather than on models: a server that kept handing back
    // a cursor would otherwise keep this loop alive for ever.
    for (let i = 0; i < 20; i += 1) {
      const page: unknown = await client.request('model/list', cursor === null ? {} : { cursor }, LIST_TIMEOUT_MS);
      pages.push(page);
      const next = typeof page === 'object' && page !== null ? (page as Record<string, unknown>)['nextCursor'] : null;
      cursor = typeof next === 'string' && next !== '' ? next : null;
      if (cursor === null) break;
    }
    const models = readCodexModels(pages);
    return models === null
      ? { ok: false, why: 'codex answered, but not with a list of models this build can read' }
      : { ok: true, models };
  } catch (err: unknown) {
    return { ok: false, why: `codex could not be asked: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    client?.close();
  }
}

/** Both, side by side. */
export async function listModels(): Promise<ModelListings> {
  const [claude, codex] = await Promise.all([listClaudeModels(), listCodexModels()]);
  return { claude, codex };
}
