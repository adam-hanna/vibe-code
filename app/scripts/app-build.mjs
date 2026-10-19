// `npm run app:build`: `tauri build`, with linuxdeploy's strip switched off on a
// local Linux build (#324).
//
//   node scripts/app-build.mjs [tauri build args...]
//
// linuxdeploy runs its own bundled `strip` over every library it copies into
// the AppDir, and that strip is older than the libraries current distributions
// ship. On Fedora 44 it stops at the first one with a `.relr.dyn` section
// (`unknown type [0x13] section '.relr.dyn'`, libxml2, libzstd), and the build
// ends with only `failed to bundle project: failed to run linuxdeploy`.
// `NO_STRIP=true` is linuxdeploy's own switch for it, and the AppImage then
// builds: 157 MB here against CI's stripped 125 MB.
//
// Only off CI. The release is built on ubuntu-22.04, where the strip works and
// the smaller file is the one that ships; a local AppImage bundles this
// machine's libraries and is for testing this machine's build, never for
// handing out. A `NO_STRIP` already in the environment is left alone, so either
// choice can still be forced. Dependency-free, like every script here.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** What this build adds to the environment: `NO_STRIP` on a local Linux build, else nothing. Pure. */
export function buildEnv(env, platform) {
  if (platform !== 'linux') return {};
  if (env.CI !== undefined && env.CI !== '' && env.CI !== 'false') return {};
  if (env.NO_STRIP !== undefined) return {};
  return { NO_STRIP: 'true' };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const extra = buildEnv(process.env, process.platform);
  if (extra.NO_STRIP) {
    console.error('app-build: NO_STRIP=true for linuxdeploy - a local build, whose strip cannot read newer libraries (#324)');
  }
  // The CLI's own JavaScript, run by this node: no shim and no shell, so the
  // arguments release.yml passes (a `--config` JSON among them) arrive as given.
  const tauri = createRequire(import.meta.url).resolve('@tauri-apps/cli/tauri.js');
  const result = spawnSync(process.execPath, [tauri, 'build', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, ...extra },
  });
  if (result.error) {
    console.error(`app-build: could not start tauri: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
