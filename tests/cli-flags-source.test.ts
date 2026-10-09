import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_FLAG_REQUIREMENTS } from '@src/cliversions.js';
import type { AgentProvider } from '@src/runtime.js';

/**
 * The required-flag lists are pinned to the call sites (#298).
 *
 * Preflight refuses a run when the installed CLI's `--help` stops declaring a
 * flag vibe passes, so the list it checks has to be the list the adapters
 * actually send. A free-standing list would drift the first time somebody added
 * a flag to an argv and forgot the list - and the check would then pass on a
 * CLI that rejects the new flag, which is the failure #298 exists to surface.
 * So this reads the adapter sources, the same shape `prompt-blocks.test.ts` and
 * `run-replay.test.ts` use, and fails on the commit that adds a flag literal
 * the list does not name.
 *
 * Out of scope, deliberately: `src/models.ts` (the model listing, which fails
 * closed to no list), `src/appserver.ts` (rate limits only) and `codex mcp list`
 * - none is a turn's argv.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string): string => readFileSync(path.join(here, '..', '..', 'src', file), 'utf8');

/** `export function <name>` to the next top-level export. */
function slice(source: string, name: string): string {
  const start = source.indexOf(`export function ${name}`);
  assert.ok(start >= 0, `export function ${name} is gone`);
  const end = source.indexOf('\nexport ', start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

function after(source: string, marker: string): string {
  const at = source.indexOf(marker);
  assert.ok(at >= 0, `marker ${marker} is gone`);
  return source.slice(at);
}

type Scope = 'run' | 'pilot';

const SITES: readonly { file: string; cli: AgentProvider; scope: Scope; text: () => string }[] = [
  { file: 'claude.ts', cli: 'claude', scope: 'run', text: () => read('claude.ts') },
  { file: 'adapters/claude-adapter.ts', cli: 'claude', scope: 'run', text: () => read('adapters/claude-adapter.ts') },
  { file: 'preflight.ts claudeProbeArgs', cli: 'claude', scope: 'run', text: () => slice(read('preflight.ts'), 'claudeProbeArgs') },
  { file: 'mcp.ts claudeMcpArgs', cli: 'claude', scope: 'run', text: () => slice(read('mcp.ts'), 'claudeMcpArgs') },
  { file: 'pilotchat.ts', cli: 'claude', scope: 'pilot', text: () => read('pilotchat.ts') },
  { file: 'codex.ts', cli: 'codex', scope: 'run', text: () => read('codex.ts') },
  { file: 'adapters/codex-adapter.ts', cli: 'codex', scope: 'run', text: () => read('adapters/codex-adapter.ts') },
  { file: 'preflight.ts codexProbeArgs', cli: 'codex', scope: 'run', text: () => slice(read('preflight.ts'), 'codexProbeArgs') },
  { file: 'mcp.ts (Codex half)', cli: 'codex', scope: 'run', text: () => after(read('mcp.ts'), '// ---- Codex') },
  { file: 'pilotcodex.ts', cli: 'codex', scope: 'pilot', text: () => read('pilotcodex.ts') },
];

/** `--help` is the read itself, not a flag a turn passes. */
const EXCLUDED = new Set(['--help']);

function flagLiterals(source: string): Set<string> {
  const found = new Set<string>();
  for (const m of source.matchAll(/'(--?[A-Za-z][A-Za-z0-9-]*)'/g)) {
    const flag = m[1];
    if (flag !== undefined && !EXCLUDED.has(flag)) found.add(flag);
  }
  return found;
}

function listed(cli: AgentProvider, scope: Scope): Set<string> {
  const out = new Set<string>();
  for (const req of CLI_FLAG_REQUIREMENTS.filter((r) => r.cli === cli)) {
    for (const flag of req.run) out.add(flag);
    if (scope === 'pilot') for (const flag of req.pilot) out.add(flag);
  }
  return out;
}

test('every flag literal an adapter passes is in the required list for its CLI', () => {
  for (const site of SITES) {
    const flags = flagLiterals(site.text());
    assert.ok(flags.size > 0, `${site.file}: no flag literals found - has the argv moved?`);
    const known = listed(site.cli, site.scope);
    for (const flag of flags) {
      assert.ok(
        known.has(flag),
        `src/${site.file} passes ${flag} but CLI_FLAG_REQUIREMENTS does not list it for ${site.cli}` +
          (site.scope === 'run' ? ' as a run flag' : ''),
      );
    }
  }
});

test('every listed flag is passed somewhere, so the list cannot hold a stale entry', () => {
  for (const cli of ['claude', 'codex'] as const) {
    const passed = new Set<string>();
    for (const site of SITES.filter((s) => s.cli === cli)) for (const flag of flagLiterals(site.text())) passed.add(flag);
    for (const flag of listed(cli, 'pilot')) {
      assert.ok(passed.has(flag), `CLI_FLAG_REQUIREMENTS lists ${flag} for ${cli}, and no adapter passes it`);
    }
  }
});

test('the run lists hold no flag only the pilot passes', () => {
  for (const cli of ['claude', 'codex'] as const) {
    const runPassed = new Set<string>();
    for (const site of SITES.filter((s) => s.cli === cli && s.scope === 'run')) {
      for (const flag of flagLiterals(site.text())) runPassed.add(flag);
    }
    for (const flag of listed(cli, 'run')) {
      assert.ok(runPassed.has(flag), `${flag} refuses ${cli} runs, but no run argv passes it`);
    }
  }
});
