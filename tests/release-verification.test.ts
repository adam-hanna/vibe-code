import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * What lets somebody check a downloaded desktop app (#317), and the pages that
 * tell them how.
 *
 * The release workflow attests every file it uploads, in the `build` job where
 * the files were made, and writes and attests `SHA256SUMS` in the `updater` job
 * once every platform has built. The README and `docs/app.md` tell a reader to
 * run `gh attestation verify` and to check against `SHA256SUMS`. Each half is
 * useless without the other, and either can go missing without anything else
 * failing: a workflow that stops attesting still builds, and a page that names
 * a file the release no longer has still renders. So this fails when either
 * half goes.
 *
 * `docs/app.md` also shows the updater's public key, decoded. That key is
 * written once, in `tauri.conf.json`, so the page is compared against it rather
 * than against a copy here.
 *
 * It reads files and nothing else, like `download-names.test.ts`. It checks
 * names and commands, never the prose around them.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// From dist/tests back to the repository root.
const root = path.join(here, '..', '..');
const read = (...parts: string[]): string => readFileSync(path.join(root, ...parts), 'utf8');

const workflow = read('.github', 'workflows', 'release.yml');
const ATTEST = 'uses: actions/attest-build-provenance@';

/** The text of `jobs.<name>`: from its key to the next job's, or the end. */
function job(name: string): string {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `release.yml has no job named ${name}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}[\w-]+:$/.test(l));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

// `build` makes and uploads the installers; `updater` is the final job, which
// writes latest.json and then SHA256SUMS.
for (const name of ['build', 'updater']) {
  test(`the ${name} job attests what it uploads`, () => {
    assert.ok(job(name).includes(ATTEST), `the ${name} job has no ${ATTEST} step`);
  });

  test(`the ${name} job may mint an attestation`, () => {
    const text = job(name);
    assert.match(text, /^\s+id-token: write$/m, `the ${name} job lacks id-token: write`);
    assert.match(text, /^\s+attestations: write$/m, `the ${name} job lacks attestations: write`);
  });
}

test('the workflow uploads SHA256SUMS', () => {
  assert.match(workflow, /gh release upload "\$TAG" SHA256SUMS/);
});

for (const page of [['README.md'], ['docs', 'app.md']]) {
  test(`${page.join('/')} says how to verify a download`, () => {
    const text = read(...page);
    assert.ok(text.includes('SHA256SUMS'), 'the page does not name SHA256SUMS');
    assert.match(text, /gh attestation verify \S+ --repo adam-hanna\/vibe-code/);
  });
}

test('docs/app.md shows the updater public key the app is built with', () => {
  const conf = JSON.parse(read('app', 'src-tauri', 'tauri.conf.json')) as {
    plugins?: { updater?: { pubkey?: unknown } };
  };
  const pubkey = conf.plugins?.updater?.pubkey;
  assert.equal(typeof pubkey, 'string');
  const decoded = Buffer.from(pubkey as string, 'base64').toString('utf8');
  const id = /^untrusted comment: minisign public key: ([0-9A-F]+)$/m.exec(decoded)?.[1];
  const key = decoded.split('\n').find((l) => l.startsWith('RW'));
  assert.ok(id, 'the configured public key has no minisign key id');
  assert.ok(key, 'the configured public key has no RW line');
  const page = read('docs', 'app.md');
  assert.ok(page.includes(key), 'docs/app.md does not show the configured public key');
  assert.ok(page.includes(id), 'docs/app.md does not show the key id');
});
