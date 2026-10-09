import { codexTurn as adapterCodexTurn } from '@src/codex.js';
import type { CodexTurnOptions, CodexTurnResult } from '@src/codex.js';
import type { RunFn } from '@src/proc.js';

/**
 * Whether a recorded argv is the `codex mcp list` every Codex child of a run is
 * now preceded by (#138), rather than a turn, a fork mint or a help probe.
 */
export function isMcpList(args: readonly string[]): boolean {
  return args[0] === 'mcp' && args[1] === 'list';
}

/**
 * A fake `exec` that answers the MCP listing itself and hands every other call
 * to `exec`.
 *
 * `codexTurn` asks `codex mcp list --json` before it spawns anything, and a
 * fake written before that call existed would answer it as if it were a turn.
 * The listing is answered here and never reaches `exec`, so a fake that counts
 * its calls or records its argvs sees exactly what it saw before.
 */
export function answeringMcpList(exec: RunFn, servers: readonly string[] = []): RunFn {
  return (bin, args, options) =>
    isMcpList(args)
      ? Promise.resolve({
          code: 0,
          signal: null,
          stdout: JSON.stringify(servers.map((name) => ({ name, enabled: true }))),
          stderr: '',
        })
      : exec(bin, args, options);
}

/**
 * `codexTurn` for a test written against the adapter before it listed MCP
 * servers: the same adapter, with the listing answered (no servers configured).
 */
export function codexTurnNoMcp(options: CodexTurnOptions, exec: RunFn): Promise<CodexTurnResult> {
  return adapterCodexTurn(options, answeringMcpList(exec));
}
