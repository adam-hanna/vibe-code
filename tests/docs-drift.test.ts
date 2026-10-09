import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DEFAULTS } from '@src/config.js';
import { EXIT } from '@src/charge.js';

/**
 * The docs site's reference pages against the source they describe (#230).
 *
 * The configuration, exit-code and CLI pages under `docs/` are written by hand,
 * so the one way they go wrong silently is by not moving when the code does: a
 * key added to `DEFAULTS`, an exit code added to `EXIT` or a command added to
 * `src/cli.ts` with no line on the page. That, and only that, is what this file
 * checks.
 *
 * WHAT A PASS MEANS: NOTHING IS MISSING. IT DOES NOT MEAN THE DOCS ARE ACCURATE.
 * Not checked, by design:
 *   - whether a description is correct;
 *   - whether a stated default matches `DEFAULTS`;
 *   - any flag beyond the command names (`--role`, `--max-tokens` and the rest);
 *   - the open-ended schema of a section, such as `toolchain.<tool>.minVersion`
 *     or a custom tool's entry, which is not a leaf of `DEFAULTS`.
 * For exit codes and commands it also checks the other direction: the page
 * documents nothing the source lacks.
 *
 * It reads files and nothing else - the markdown under `docs/`, and `src/` as
 * source the way `prompt-blocks.test.ts` does - and imports the two constants
 * it compares against. It never imports VitePress and never needs
 * `docs/node_modules`, so `npm test` runs it with the docs never installed.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// From dist/tests back to the repository root.
const root = path.join(here, '..', '..');
const read = (...parts: string[]): string => readFileSync(path.join(root, ...parts), 'utf8');

const NOT_CHECKED =
  'This test checks only that nothing is missing: it does not check that a description ' +
  'is correct, that a stated default matches the code, or any flag beyond the command names.';

/** Top-level sections documented as a whole: open-ended maps, not fixed leaves. */
const SECTIONS = new Set(['roles', 'gates', 'prompts']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The names in `const GATE_KEYS = [...]`, read from `src/config.ts` as source. */
function gateKeys(configSource: string): string[] {
  const list = /const GATE_KEYS = \[([^\]]*)\]/.exec(configSource);
  const names = list === null ? [] : [...(list[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '');
  if (names.length === 0) {
    // Fail closed: a regex that stopped matching must not pass with nothing to check.
    throw new Error('could not read GATE_KEYS out of src/config.ts; the drift test needs updating');
  }
  return names;
}

/** Every config path the configuration page must name, in dotted form. */
function configPaths(defaults: unknown, configSource: string): string[] {
  const out: string[] = [];
  const walk = (value: unknown, at: string): void => {
    if (isPlainObject(value)) {
      for (const [key, child] of Object.entries(value)) walk(child, at === '' ? key : `${at}.${key}`);
      return;
    }
    out.push(at);
  };
  if (!isPlainObject(defaults)) throw new Error('DEFAULTS is not an object');
  for (const [key, value] of Object.entries(defaults)) {
    if (SECTIONS.has(key)) out.push(key);
    else walk(value, key);
  }
  for (const k of gateKeys(configSource)) out.push(`verify.gates[].${k}`);
  return out;
}

/** The paths whose backticked form does not appear anywhere on the page. */
function missingConfigKeys(page: string, paths: readonly string[]): string[] {
  return paths.filter((p) => !page.includes(`\`${p}\``));
}

/** Codes in table rows whose first cell is a backticked number. */
function documentedCodes(page: string): number[] {
  return [...page.matchAll(/^\|\s*`(\d+)`\s*\|/gm)].map((m) => Number(m[1]));
}

function exitCodeDiff(page: string, codes: readonly number[]): { missing: number[]; extra: number[] } {
  const shown = documentedCodes(page);
  return {
    missing: codes.filter((c) => !shown.includes(c)),
    extra: [...new Set(shown)].filter((c) => !codes.includes(c)),
  };
}

/** The commands `main()` dispatches, read from `src/cli.ts` as source. */
function cliCommands(cliSource: string): string[] {
  const found = [...cliSource.matchAll(/case '([a-z]+)':\s*\n\s*return (?:await )?cmd\w+\(/g)].map(
    (m) => m[1] ?? '',
  );
  if (found.length === 0) {
    throw new Error('found no command dispatch in src/cli.ts; the drift test needs updating');
  }
  return [...new Set(found)];
}

/** The commands the CLI page has a `## \`vibe <cmd>\`` section for. */
function documentedCommands(page: string): string[] {
  return [...page.matchAll(/^## `vibe ([a-z]+)/gm)].map((m) => m[1] ?? '');
}

function commandDiff(page: string, commands: readonly string[]): { missing: string[]; extra: string[] } {
  const shown = documentedCommands(page);
  return {
    missing: commands.filter((c) => !shown.includes(c)),
    extra: [...new Set(shown)].filter((c) => !commands.includes(c)),
  };
}

const configSource = read('src', 'config.ts');
const cliSource = read('src', 'cli.ts');
const exitCodes = Object.values(EXIT);

test('the configuration page names every config key, section and verify.gates field', () => {
  const paths = configPaths(DEFAULTS, configSource);
  const missing = missingConfigKeys(read('docs', 'configuration.md'), paths);
  assert.deepEqual(
    missing,
    [],
    `docs/configuration.md does not mention ${missing.map((p) => `\`${p}\``).join(', ')}. ` +
      `Each key must appear in backticks with its full dotted path. ${NOT_CHECKED}`,
  );
});

test('the exit-codes page lists every code in EXIT, and no other', () => {
  const diff = exitCodeDiff(read('docs', 'exit-codes.md'), exitCodes);
  assert.deepEqual(
    diff,
    { missing: [], extra: [] },
    `docs/exit-codes.md is missing ${JSON.stringify(diff.missing)} and lists codes EXIT ` +
      `does not have: ${JSON.stringify(diff.extra)}. Only the codes are checked, not what ` +
      `the page says they mean. ${NOT_CHECKED}`,
  );
});

test('the CLI page has a section for every command src/cli.ts dispatches, and no other', () => {
  const commands = cliCommands(cliSource);
  assert.ok(commands.length > 0);
  const diff = commandDiff(read('docs', 'cli.md'), commands);
  assert.deepEqual(
    diff,
    { missing: [], extra: [] },
    `docs/cli.md has no section for ${JSON.stringify(diff.missing)} and documents commands ` +
      `the CLI does not have: ${JSON.stringify(diff.extra)}. ${NOT_CHECKED}`,
  );
});

// The proofs that each check fails: fixture strings only, never an edit to a real page.

test('a config page missing a key, or a verify.gates field, is reported by name', () => {
  const paths = configPaths(DEFAULTS, configSource);
  assert.ok(paths.includes('loop.maxPlanRounds'));
  assert.ok(paths.includes('verify.gates[].required'));
  assert.ok(paths.includes('roles') && paths.includes('gates') && paths.includes('prompts'));
  assert.ok(!paths.some((p) => p.startsWith('roles.') || p.startsWith('gates.')));

  const all = paths.map((p) => `\`${p}\``).join('\n');
  assert.deepEqual(missingConfigKeys(all, paths), []);

  const withoutCap = paths.filter((p) => p !== 'loop.maxPlanRounds').map((p) => `\`${p}\``).join('\n');
  assert.deepEqual(missingConfigKeys(withoutCap, paths), ['loop.maxPlanRounds']);

  const withoutRequired = paths
    .filter((p) => p !== 'verify.gates[].required')
    .map((p) => `\`${p}\``)
    .join('\n');
  assert.deepEqual(missingConfigKeys(withoutRequired, paths), ['verify.gates[].required']);
});

test('GATE_KEYS is read from source, and a source without it fails closed', () => {
  assert.deepEqual(gateKeys("const GATE_KEYS = ['name', 'command', 'shiny'] as const;"), [
    'name',
    'command',
    'shiny',
  ]);
  assert.throws(() => gateKeys('nothing here'), /GATE_KEYS/);
});

test('an exit-code table missing a code, or listing one EXIT lacks, is reported', () => {
  const row = (c: number): string => `| \`${String(c)}\` | NAME | meaning |`;
  const table = (codes: readonly number[]): string =>
    ['| Code | Name | Meaning |', '|---|---|---|', ...codes.map(row)].join('\n');

  assert.deepEqual(exitCodeDiff(table([0, 1, 2, 3, 4, 5, 6, 7]), [0, 1, 2, 3, 4, 5, 6, 7]), {
    missing: [],
    extra: [],
  });
  assert.deepEqual(exitCodeDiff(table([0, 1, 2, 3, 4, 5, 6]), [0, 1, 2, 3, 4, 5, 6, 7]), {
    missing: [7],
    extra: [],
  });
  assert.deepEqual(exitCodeDiff(table([0, 1, 2, 3, 4, 5, 6, 7, 9]), [0, 1, 2, 3, 4, 5, 6, 7]), {
    missing: [],
    extra: [9],
  });
});

test('a CLI page missing a command, or documenting one the CLI lacks, is reported', () => {
  const commands = ['run', 'plan', 'resume', 'fork', 'list', 'stats', 'doctor'];
  const page = (cmds: readonly string[]): string =>
    cmds.map((c) => `## \`vibe ${c}\`\n\nWhat it does.\n`).join('\n');

  assert.deepEqual(commandDiff(page(commands), commands), { missing: [], extra: [] });
  assert.deepEqual(
    commandDiff(page(commands.filter((c) => c !== 'stats')), commands),
    { missing: ['stats'], extra: [] },
  );
  assert.deepEqual(commandDiff(page([...commands, 'frobnicate']), commands), {
    missing: [],
    extra: ['frobnicate'],
  });
});

test('the command list comes from the dispatch in source, not a copy', () => {
  const source = [
    'switch (cmd) {',
    "  case 'run':",
    '    return await cmdRun(argv.slice(1), false, loop);',
    "  case 'prune':",
    '    return cmdPrune(argv.slice(1));',
    "  case '-C':",
    '  case \'--cwd\': out.flags.cwd = next(); break;',
    '}',
  ].join('\n');
  assert.deepEqual(cliCommands(source), ['run', 'prune']);
  assert.throws(() => cliCommands('no dispatch'), /command dispatch/);
  // And the real source's dispatch is found - checked loosely, so a new command
  // reaches the page check above rather than failing here.
  assert.ok(cliCommands(cliSource).includes('run'));
});
