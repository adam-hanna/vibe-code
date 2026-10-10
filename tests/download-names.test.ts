import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * The download links and the names the release workflow uploads (#239).
 *
 * The README and `docs/app.md` link to
 * `releases/latest/download/<stable name>`, which GitHub serves from the newest
 * published release. That works only if every release uploads a file under
 * exactly that name, so the names are written once - the `=Vibe-…` half of each
 * matrix entry's `assets` in `.github/workflows/release.yml` - and this file
 * fails when a page links a name the workflow does not upload, or the workflow
 * uploads one a page does not link.
 *
 * A broken link here fails silently and late: the page builds, the release
 * builds, and the first person to click gets a 404 from GitHub. The docs site's
 * dead-link check cannot see it, because the target is outside the site.
 *
 * It reads files and nothing else, like `docs-drift.test.ts`. It checks the
 * names, never the prose around them.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// From dist/tests back to the repository root.
const root = path.join(here, '..', '..');
const read = (...parts: string[]): string => readFileSync(path.join(root, ...parts), 'utf8');

const LATEST = 'https://github.com/adam-hanna/vibe-code/releases/latest/download/';
const workflow = read('.github', 'workflows', 'release.yml');

/** The stable names the workflow uploads: the right side of `<glob>=<name>`. */
function uploaded(): string[] {
  return [...workflow.matchAll(/^\s+bundle\/\S+=(Vibe-\S+)$/gm)].map((m) => m[1] ?? '');
}

/** The names a page links under `releases/latest/download/`. */
function linked(page: string): string[] {
  const escaped = LATEST.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return [...page.matchAll(new RegExp(`${escaped}([^)\\s>]+)`, 'g'))].map((m) => m[1] ?? '');
}

const sorted = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

test('the workflow uploads one stable name per installer, each once', () => {
  const names = uploaded();
  assert.deepEqual(sorted(names), [
    'Vibe-linux-amd64.deb',
    'Vibe-linux-x86_64.AppImage',
    'Vibe-macos-arm64.dmg',
    'Vibe-windows-x64-setup.exe',
    'Vibe-windows-x64.msi',
  ]);
  assert.equal(names.length, new Set(names).size, 'a stable name is uploaded twice');
});

for (const page of [['README.md'], ['docs', 'app.md']]) {
  test(`${page.join('/')} links exactly the names the workflow uploads`, () => {
    assert.deepEqual(sorted(linked(read(...page))), sorted(uploaded()));
  });
}

test('an installed app is told of updates at a name the workflow writes', () => {
  // #299's updater checks `releases/latest/download/latest.json`; the `updater`
  // job is what uploads it.
  assert.match(workflow, /gh release upload "\$TAG" latest\.json/);
  assert.match(workflow, /createUpdaterArtifacts": true/);
});

test('the app config names that same endpoint and a public key', () => {
  // Without `plugins.updater` the bundler refuses to make updater artifacts at
  // all: `v1.5.1-rc.1` failed on every platform with "plugins > updater doesn't
  // exist". The endpoint is the stable name, so it never changes per release.
  const conf = JSON.parse(read('app', 'src-tauri', 'tauri.conf.json')) as {
    plugins?: { updater?: { pubkey?: unknown; endpoints?: unknown } };
  };
  const updater = conf.plugins?.updater;
  assert.deepEqual(updater?.endpoints, [`${LATEST}latest.json`]);
  assert.equal(typeof updater?.pubkey, 'string');
  assert.notEqual(updater?.pubkey, '');
});
