import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * The release workflow's shell steps run under macOS's own bash, which is 3.2.
 *
 * `shell: bash` on a macOS runner is `/bin/bash`, and Apple has shipped 3.2
 * there since 2007. v1.6.0's mac build compiled, bundled and attested, then
 * died uploading with `mapfile: command not found` (exit 127), because
 * `mapfile` is bash 4. Linux and Windows runners have bash 5, so nothing else
 * failed, and the rc tags before it predated the line.
 *
 * So the workflow is checked for the bash-4-only builtins and expansions that
 * have a 3.2 spelling. It reads the file and nothing else. It cannot prove a
 * script runs on 3.2; it only stops the constructs that are known not to.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// From dist/tests back to the repository root.
const root = path.join(here, '..', '..');
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');

const BASH4: readonly [RegExp, string][] = [
  [/\bmapfile\b/, 'mapfile (use a `while IFS= read -r` loop)'],
  [/\breadarray\b/, 'readarray (use a `while IFS= read -r` loop)'],
  [/\bdeclare\s+-A\b/, 'declare -A (associative arrays)'],
  [/\blocal\s+-n\b|\bdeclare\s+-n\b/, 'namerefs'],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*(,,|\^\^)/, 'case-changing expansions'],
  [/\bglobstar\b/, 'globstar'],
  [/&>>/, '&>>'],
  [/\bwait\s+-n\b/, 'wait -n'],
];

test('the release workflow uses no bash-4-only construct', () => {
  // Comments are prose and may name what not to use.
  const code = workflow
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  for (const [pattern, what] of BASH4) {
    assert.doesNotMatch(code, pattern, `release.yml uses ${what}, which macOS's bash 3.2 does not have`);
  }
});

test('the build job does run on macOS, which is why this matters', () => {
  assert.match(workflow, /os:\s*macos-/);
});
