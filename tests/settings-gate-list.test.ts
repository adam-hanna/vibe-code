import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig, writeConfigPatch } from '@src/config.js';

/**
 * The settings screen's gate list, from the core's side (#240).
 *
 * The bar the issue sets: from a project with one test command, a person ends
 * up with two named gates without opening the file, the file is exactly what a
 * hand-written one would be, and `loadConfig` accepts it. These drive the
 * patches the form sends (`app/src/cockpit/gateform.ts`) through
 * `writeConfigPatch`, the one road a save takes.
 */

const CORE = 'npm run typecheck && npm test';
const APP = 'cd app && npm run typecheck && npx vitest run && npm run audit:contrast';

function repo(contents: object): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-gatelist-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), `${JSON.stringify(contents, null, 2)}\n`);
  return dir;
}
const file = (dir: string): unknown => JSON.parse(readFileSync(path.join(dir, 'vibe.config.json'), 'utf8'));

test('one test command becomes two named gates, and the file is what a person would write', () => {
  const dir = repo({ loop: { maxPlanRounds: 4 }, verify: { command: CORE, runs: 2 } });

  // "split into named gates": the command becomes the first gate in the same write.
  writeConfigPatch(dir, { verify: { gates: [{ name: 'verification', command: CORE }], command: null } });
  // Renaming it and filling in the second row: the whole list, every save.
  writeConfigPatch(dir, {
    verify: {
      gates: [
        { name: 'core', command: CORE },
        { name: 'app', command: APP },
      ],
    },
  });

  assert.deepEqual(file(dir), {
    loop: { maxPlanRounds: 4 },
    verify: {
      runs: 2,
      gates: [
        { name: 'core', command: CORE },
        { name: 'app', command: APP },
      ],
    },
  });
  const cfg = loadConfig(dir);
  assert.deepEqual(
    cfg.verify.gates?.map((g) => g.name),
    ['core', 'app'],
  );
  assert.equal(cfg.verify.command, null);
});

test('removing the last gate puts its command back, in one write the core accepts', () => {
  const dir = repo({ verify: { gates: [{ name: 'core', command: CORE }] } });
  writeConfigPatch(dir, { verify: { gates: null, command: CORE } });

  assert.deepEqual(file(dir), { verify: { command: CORE } });
  assert.equal(loadConfig(dir).verify.command, CORE);
});

test("a gate the core refuses is refused in the core's words, and the file is left as it was", () => {
  const before = { verify: { gates: [{ name: 'core', command: CORE }] } };
  const dir = repo(before);

  assert.throws(
    () => writeConfigPatch(dir, { verify: { gates: [{ name: 'Core App', command: CORE }] } }),
    /verify\.gates\[0\]\.name must be kebab-case/,
  );
  assert.throws(
    () =>
      writeConfigPatch(dir, {
        verify: {
          gates: [
            { name: 'core', command: CORE },
            { name: 'core', command: APP },
          ],
        },
      }),
    /is used twice/,
  );
  assert.throws(
    () => writeConfigPatch(dir, { verify: { gates: [{ name: 'core', command: '' }] } }),
    /command must be a non-empty command string/,
  );
  assert.deepEqual(file(dir), before);
});

test('a lone null command, which the single field writes for auto-detect, is left alone', () => {
  const dir = repo({ verify: { command: CORE } });
  writeConfigPatch(dir, { verify: { command: null } });
  assert.deepEqual(file(dir), { verify: { command: null } });
});
