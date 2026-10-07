// `npm test`, with the global settings layer switched off (#223).
//
// `loadConfig` reads `~/.config/vibe/config.json` (or `%APPDATA%\vibe`) under a
// project's `vibe.config.json`, and a suite that read the developer's own
// settings would pass or fail according to whose machine it ran on. An empty
// `VIBE_GLOBAL_CONFIG` turns the layer off, and every child the suite spawns
// inherits it. A script rather than `VAR= node ...` in package.json, because
// that syntax is a POSIX shell's and this repo is developed on Windows too.
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  process.execPath,
  ['--test', 'dist/tests/**/*.test.js', ...process.argv.slice(2)],
  { stdio: 'inherit', env: { ...process.env, VIBE_GLOBAL_CONFIG: '' } },
);
process.exit(result.status ?? 1);
