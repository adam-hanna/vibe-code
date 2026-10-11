import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * The Linux AppImage must not carry the build machine's libwayland (#331).
 *
 * v1.6.0's AppImage bundled Ubuntu 22.04's copy. On Fedora 44, WebKit then
 * could not create an EGL display against the host's own Mesa, aborted, and
 * left a white window with the process still running. Tauri runs linuxdeploy
 * itself, so `app/scripts/prune-appimage.mjs` repacks the finished file, and
 * `app/scripts/smoke-appimage.sh` launches it on six distributions before
 * anything is uploaded.
 *
 * Both scripts can go missing from the workflow without anything else failing:
 * the build still succeeds and the AppImage still uploads. So this checks the
 * list the script removes and that release.yml runs both, in an order where
 * nothing unpruned or unchecked is attested or uploaded. It does not run either
 * script. The smoke test needs containers and is run by hand, with results in
 * the PR.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// From dist/tests back to the repository root.
const root = path.join(here, '..', '..');
const workflow = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');

type Prune = { PRUNE: readonly string[]; pruned: (names: string[]) => string[] };

async function script(): Promise<Prune> {
  const mod: unknown = await import(pathToFileURL(path.join(root, 'app', 'scripts', 'prune-appimage.mjs')).href);
  assert.ok(mod !== null && typeof mod === 'object' && 'PRUNE' in mod && 'pruned' in mod);
  return mod as Prune;
}

// What v1.6.0's AppImage held in usr/lib, trimmed to the neighbours that matter.
const BUNDLED = [
  'im-wayland.so',
  'im-waylandgtk.so',
  'libepoxy.so.0',
  'libgtk-3.so.0',
  'libwayland-client.so.0',
  'libwayland-cursor.so.0',
  'libwayland-egl.so.1',
  'libwayland-server.so.0',
  'libwebkit2gtk-4.1.so.0',
];

test('the client-side libwayland libraries come out, and nothing else does', async () => {
  const { pruned } = await script();
  assert.deepEqual(pruned(BUNDLED), ['libwayland-client.so.0', 'libwayland-cursor.so.0', 'libwayland-egl.so.1']);
});

// GTK 3 does not pull it in, so a host can lack it: removing it stopped the app
// starting on Ubuntu 24.04 and Fedora images with GTK 3 and Mesa installed.
test('libwayland-server stays bundled', async () => {
  const { pruned } = await script();
  assert.deepEqual(pruned(['libwayland-server.so.0']), []);
});

test('GTK’s own wayland input-method modules are not libwayland', async () => {
  const { pruned } = await script();
  assert.deepEqual(pruned(['im-wayland.so', 'im-waylandgtk.so']), []);
});

test('a later soname is still matched', async () => {
  const { pruned } = await script();
  assert.deepEqual(pruned(['libwayland-client.so.0.24.0']), ['libwayland-client.so.0.24.0']);
});

/** Index of the line naming a step, or -1. */
function step(name: string): number {
  return workflow.split('\n').findIndex((l) => l.trim() === `- name: ${name}`);
}

test('release.yml prunes and then checks the AppImage, after the build and before the upload', () => {
  const build = step('Build the bundles');
  const prune = step('Take the host graphics libraries out of the AppImage');
  const smoke = step('Check the AppImage draws on other distributions');
  const collect = step('Collect the release files');
  for (const [name, at] of Object.entries({ build, prune, smoke, collect })) {
    assert.notEqual(at, -1, `release.yml has no ${name} step`);
  }
  assert.ok(build < prune && prune < smoke && smoke < collect, 'build, prune, smoke and collect are out of order');
  assert.match(workflow, /node app\/scripts\/prune-appimage\.mjs /);
  assert.match(workflow, /app\/scripts\/smoke-appimage\.sh /);
});

test('the prune step is handed the signing key, so the update bundle it changed is re-signed', () => {
  const lines = workflow.split('\n');
  const start = step('Take the host graphics libraries out of the AppImage');
  const end = step('Check the AppImage draws on other distributions');
  const body = lines.slice(start, end).join('\n');
  assert.match(body, /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/);
  assert.match(body, /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}/);
  assert.match(body, /if: runner\.os == 'Linux'/);
});
