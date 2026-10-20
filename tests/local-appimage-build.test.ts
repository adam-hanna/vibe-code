import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/**
 * A local Linux build bundles the AppImage unstripped (#324).
 *
 * linuxdeploy's bundled `strip` cannot read the `.relr.dyn` sections newer
 * distributions ship, so on Fedora 44 every local `npm run app:build` failed at
 * the AppImage with only `failed to run linuxdeploy`. `app/scripts/app-build.mjs`
 * sets `NO_STRIP=true` there. CI must keep stripping: the release is built on
 * Ubuntu 22.04, where strip works and the smaller file is the one that ships.
 * So this pins the decision and the route `npm run app:build` takes to it; it
 * runs no build.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
// From dist/tests back to the repository root.
const root = path.join(here, '..', '..');

type BuildEnv = (env: Record<string, string | undefined>, platform: string) => Record<string, string>;

async function buildEnv(): Promise<BuildEnv> {
  const mod: unknown = await import(pathToFileURL(path.join(root, 'app', 'scripts', 'app-build.mjs')).href);
  assert.ok(mod !== null && typeof mod === 'object' && 'buildEnv' in mod && typeof mod.buildEnv === 'function');
  return mod.buildEnv as BuildEnv;
}

test('a local Linux build turns linuxdeploy’s strip off', async () => {
  const decide = await buildEnv();
  assert.deepEqual(decide({}, 'linux'), { NO_STRIP: 'true' });
  assert.deepEqual(decide({ CI: '' }, 'linux'), { NO_STRIP: 'true' });
  assert.deepEqual(decide({ CI: 'false' }, 'linux'), { NO_STRIP: 'true' });
});

test('CI keeps stripping, because the stripped file is the one that ships', async () => {
  const decide = await buildEnv();
  // GitHub Actions sets CI=true on every runner.
  assert.deepEqual(decide({ CI: 'true' }, 'linux'), {});
  assert.deepEqual(decide({ CI: '1' }, 'linux'), {});
});

test('a NO_STRIP already set is left alone, so either choice can be forced', async () => {
  const decide = await buildEnv();
  assert.deepEqual(decide({ NO_STRIP: '' }, 'linux'), {});
  assert.deepEqual(decide({ NO_STRIP: 'true', CI: 'true' }, 'linux'), {});
});

test('macOS and Windows are untouched: they have no AppImage', async () => {
  const decide = await buildEnv();
  assert.deepEqual(decide({}, 'darwin'), {});
  assert.deepEqual(decide({}, 'win32'), {});
});

test('npm run app:build goes through the script, and release.yml builds through npm run app:build', () => {
  const pkg: unknown = JSON.parse(readFileSync(path.join(root, 'app', 'package.json'), 'utf8'));
  assert.ok(pkg !== null && typeof pkg === 'object' && 'scripts' in pkg);
  const scripts = pkg.scripts as Record<string, string>;
  assert.equal(scripts['app:build'], 'node scripts/app-build.mjs');
  const workflow = readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.match(workflow, /npm run app:build/);
});
