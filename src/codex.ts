import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { resolveBin, run } from '@src/proc.js';
import { detail } from '@src/log.js';
import type { Effort, Sandbox } from '@src/types.js';

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
}

export interface CodexTurnResult {
  structured: unknown;
  raw: string;
  /** Thread id for this turn, to be passed back on the next call. */
  sessionId: string | null;
}

/** Codex prints its thread id in the stderr banner; there is no JSON field for it. */
const SESSION_ID_RE = /session id:\s*([0-9a-fA-F-]{36})/;

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
  const args: string[] = sessionId
    ? [
        'exec', 'resume', sessionId,
        '-m', model,
        '-c', `model_reasoning_effort="${effort}"`,
        '--skip-git-repo-check',
        '--output-schema', schemaFile,
        '-o', outFile,
        '-',
      ]
    : [
        'exec',
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

  const { code, stdout, stderr } = await run(codexBin(), args, { input: prompt, cwd, timeoutMs });

  const matched = SESSION_ID_RE.exec(stderr);
  const returnedSession = matched?.[1] ?? sessionId ?? null;

  if (!existsSync(outFile)) {
    throw new Error(
      `codex wrote no structured output (exit ${code}).\n` +
        `stderr:\n${stderr.slice(-2000)}\nstdout:\n${stdout.slice(-1000)}`,
    );
  }

  // Always read as UTF-8: Codex emits smart quotes and em dashes that mangle
  // under the Windows ANSI codepage.
  const raw = readFileSync(outFile, 'utf8');
  try {
    return { structured: JSON.parse(raw) as unknown, raw, sessionId: returnedSession };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`codex output was not valid JSON: ${message}\n${raw.slice(0, 1500)}`);
  }
}
