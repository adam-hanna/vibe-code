import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOverrides, DEFAULTS } from '@src/config.js';
import type { Config } from '@src/types.js';

/**
 * What a gate list may say, and what it may not.
 *
 * Every refusal here names the key it is about, for the reason `roleSetting`
 * does (#46): a setting the user wrote and vibe silently dropped is the failure
 * mode this repo keeps closing, and a gate is a place where dropping one means
 * running a different set of checks than the config describes.
 */

/** `verify` overlaid on the defaults, as a config file would be merged. */
function withVerify(verify: unknown): () => Config {
  return () => applyOverrides(DEFAULTS, { verify } as Partial<Config>);
}

test('a gate list alongside verify.command is refused, naming both', () => {
  assert.throws(withVerify({ command: 'npm test', gates: [{ name: 'test', command: 'npm test' }] }), {
    message: /verify\.command and verify\.gates/,
  });
  // --verify-command sets the same key, so it hits the same refusal rather than
  // being quietly ignored.
  assert.throws(
    () =>
      applyOverrides(
        { ...DEFAULTS, verify: { ...DEFAULTS.verify, gates: [{ name: 'test', command: 'npm test' }] } },
        { verify: { command: 'npm test' } },
      ),
    { message: /--verify-command/ },
  );
});

test('an empty gate list is refused; enabled:false is how verification is turned off', () => {
  assert.throws(withVerify({ gates: [] }), { message: /at least one gate/ });
  assert.throws(withVerify({ gates: [] }), { message: /verify\.enabled to false/ });
});

test('a gate name has to be one a finding id can carry', () => {
  assert.throws(withVerify({ gates: [{ name: 'Test', command: 'npm test' }] }), {
    message: /verify\.gates\[0\]\.name must be kebab-case/,
  });
  assert.throws(withVerify({ gates: [{ name: '-lead', command: 'npm test' }] }), {
    message: /kebab-case/,
  });
  assert.throws(withVerify({ gates: [{ name: 'unit test', command: 'npm test' }] }), {
    message: /kebab-case/,
  });
});

test('two gates may not share a name', () => {
  assert.throws(
    withVerify({
      gates: [
        { name: 'test', command: 'npm test' },
        { name: 'test', command: 'npm run test:e2e' },
      ],
    }),
    { message: /"test" is used twice/ },
  );
});

/**
 * This case used to assert that `artifacts` was refused *with its reason* -
 * "gate artifacts are not implemented ... waits on #53". #53 shipped (PR #101)
 * and #62 implemented the copy, so that reason is now false and the behaviour
 * genuinely moved (AGENTS.md case 2). What it was really guarding - that a
 * key out of #47's own example gets a real answer rather than a generic
 * "unknown key" - still holds and is what the rewritten case pins: the key is
 * accepted, and every way of writing a path that cannot safely be copied is
 * refused by a message that names it.
 */
test('an artifacts list of project-relative paths is accepted', () => {
  assert.doesNotThrow(
    withVerify({
      gates: [
        {
          name: 'qa',
          command: 'npx playwright test',
          artifacts: ['playwright-report', 'test-results/summary.json'],
        },
      ],
    }),
  );
  // Disjoint entries sharing a basename are fine: destinations mirror the
  // configured path, so they cannot collide.
  assert.doesNotThrow(
    withVerify({ gates: [{ name: 'qa', command: 'x', artifacts: ['a/report', 'b/report'] }] }),
  );
  // An empty list is a list, and it asks for nothing - which is not an error.
  assert.doesNotThrow(withVerify({ gates: [{ name: 'qa', command: null, artifacts: [] }] }));
});

test('an artifacts entry that cannot safely be copied is refused, by name', () => {
  const refused = (entry: unknown): (() => Config) =>
    withVerify({ gates: [{ name: 'qa', command: 'x', artifacts: [entry] }] });

  // Absolute in every spelling, and each is refused on EVERY host: a config
  // written on Windows and validated on CI must not have `C:\x` read as a
  // relative directory named `C:`.
  assert.throws(refused('/tmp/report'), { message: /verify\.gates\[0\]\.artifacts\[0\].*absolute/ });
  assert.throws(refused('C:\\reports'), { message: /"C:\\reports" is absolute/ });
  assert.throws(refused('\\\\server\\share'), { message: /is absolute/ });
  // `..` even where it resolves back inside: one rule that is easy to state.
  assert.throws(refused('../outside'), { message: /"\.\.\/outside" contains a "\.\." segment/ });
  assert.throws(refused('sub/../file'), { message: /contains a "\.\." segment/ });
  // The project root itself, which would copy the whole tree into itself.
  assert.throws(refused('.'), { message: /names the project root/ });
  assert.throws(refused('./'), { message: /names the project root/ });
  // The run directory, which would copy the archive into a descendant of itself.
  assert.throws(refused('.vibe/runs'), { message: /is under \.vibe/ });
  assert.throws(refused('reports/.vibe'), { message: /is under \.vibe/ });
  // Shapes that are not a path at all.
  assert.throws(refused(''), { message: /must be a non-empty path string/ });
  assert.throws(refused('   '), { message: /must be a non-empty path string/ });
  assert.throws(refused(7), { message: /must be a non-empty path string/ });
  assert.throws(withVerify({ gates: [{ name: 'qa', command: 'x', artifacts: 'report' }] }), {
    message: /verify\.gates\[0\]\.artifacts must be a list/,
  });
});

test('the .vibe refusal follows the host filesystem, case included', (t) => {
  const spelled = (entry: string): (() => Config) =>
    withVerify({ gates: [{ name: 'qa', command: 'x', artifacts: [entry] }] });
  if (process.platform !== 'win32') {
    t.skip('.VIBE is a different directory from .vibe on this platform, and must stay allowed');
    return;
  }
  // Windows folds case and strips trailing dots and spaces, so all three of
  // these NAME the run directory and must not become a way into it.
  assert.throws(spelled('.VIBE/x'), { message: /is under \.vibe/ });
  assert.throws(spelled('.vibe./x'), { message: /is under \.vibe/ });
});

test('overlapping artifact paths are refused, naming both', () => {
  assert.throws(
    withVerify({
      gates: [{ name: 'qa', command: 'x', artifacts: ['reports', 'reports/output.json'] }],
    }),
    { message: /"reports" and "reports\/output\.json" overlap/ },
  );
  // The same entry twice, spelled two ways.
  assert.throws(
    withVerify({ gates: [{ name: 'qa', command: 'x', artifacts: ['a', './a'] }] }),
    { message: /overlap/ },
  );
  // Why it matters, stated in the message: the bytes would be counted twice.
  assert.throws(
    withVerify({ gates: [{ name: 'qa', command: 'x', artifacts: ['a', 'a/b/c'] }] }),
    { message: /counted twice/ },
  );
});

test('any other unknown key inside a gate is refused by name', () => {
  assert.throws(withVerify({ gates: [{ name: 'test', command: 'npm test', enabled: false }] }), {
    message: /unknown key "enabled"/,
  });
});

test('a gate must write its command, even when there is none', () => {
  assert.throws(withVerify({ gates: [{ name: 'qa' }] }), {
    message: /verify\.gates\[0\]\.command is required/,
  });
});

test('a blank command is refused at both spellings', () => {
  assert.throws(withVerify({ gates: [{ name: 'qa', command: '' }] }), {
    message: /verify\.gates\[0\]\.command must be a non-empty command string/,
  });
  assert.throws(withVerify({ gates: [{ name: 'qa', command: '   ' }] }), {
    message: /non-empty command string/,
  });
  // An empty string used to reach the shell, exit 0, and be reported as a pass.
  assert.throws(withVerify({ command: '' }), {
    message: /verify\.command must be a non-empty command string/,
  });
  assert.throws(withVerify({ command: '   ' }), { message: /non-empty command string/ });
});

test('per-gate numbers and flags are checked like every other setting', () => {
  assert.throws(withVerify({ gates: [{ name: 'test', command: 'npm test', runs: 1.5 }] }), {
    message: /verify\.gates\[0\]\.runs must be a positive integer/,
  });
  assert.throws(withVerify({ gates: [{ name: 'test', command: 'npm test', runs: 0 }] }), {
    message: /positive integer/,
  });
  assert.throws(withVerify({ gates: [{ name: 'test', command: 'npm test', timeoutMs: 0 }] }), {
    message: /verify\.gates\[0\]\.timeoutMs must be a positive number/,
  });
  assert.throws(
    withVerify({ gates: [{ name: 'test', command: 'npm test', required: 'yes' }] }),
    { message: /verify\.gates\[0\]\.required must be true or false/ },
  );
  assert.throws(withVerify({ gates: 'npm test' }), { message: /verify\.gates must be a list/ });
  assert.throws(withVerify({ gates: ['npm test'] }), {
    message: /verify\.gates\[0\] must be an object/,
  });
});

test('verify.runs and verify.timeoutMs compose as per-gate defaults a gate may override', () => {
  const cfg = applyOverrides(DEFAULTS, {
    verify: {
      runs: 5,
      timeoutMs: 1000,
      gates: [
        { name: 'typecheck', command: 'npm run typecheck', runs: 1 },
        { name: 'test', command: 'npm test' },
      ],
    },
  } as Partial<Config>);

  // A default that composes is not a second way of saying the same thing; a
  // second command would be, which is why only that pair is refused.
  assert.equal(cfg.verify.gates?.[0]?.runs, 1);
  assert.equal(cfg.verify.gates?.[1]?.runs, undefined);
  assert.equal(cfg.verify.runs, 5);
  assert.equal(cfg.verify.timeoutMs, 1000);
});

test('artifactMaxBytes is checked on the legacy path too, not only behind a gate list', () => {
  // The legacy shape - `gates` absent or null - is what most configs still are,
  // and `validateVerify` returns early for it. A ceiling validated after that
  // return would accept "10" in silence for exactly those runs.
  for (const gates of [null, undefined]) {
    assert.doesNotThrow(withVerify({ gates, artifactMaxBytes: null }));
    assert.doesNotThrow(withVerify({ gates, artifactMaxBytes: 1 }));
    assert.doesNotThrow(withVerify({ gates, artifactMaxBytes: 50_000_000 }));
    for (const bad of [0, -1, 1.5, '10']) {
      assert.throws(withVerify({ gates, artifactMaxBytes: bad }), {
        message: /verify\.artifactMaxBytes must be a positive integer/,
      });
    }
  }

  // And with a gate list, where the same rule has to still apply.
  assert.doesNotThrow(
    withVerify({ gates: [{ name: 'qa', command: 'x' }], artifactMaxBytes: 1024 }),
  );
  assert.throws(withVerify({ gates: [{ name: 'qa', command: 'x' }], artifactMaxBytes: 0 }), {
    message: /positive integer/,
  });
});

test('a 1.1.0 config with no gates key still resolves and still validates', () => {
  const stored = structuredClone(DEFAULTS) as unknown as Record<string, Record<string, unknown>>;
  delete stored['verify']?.['gates'];

  const merged = applyOverrides(stored as unknown as Config, {});

  // DEFAULTS layered underneath supplies the key, and null is what says "the
  // legacy gate" - so a resume of a run recorded before #47 is unaffected.
  assert.equal(merged.verify.gates, null);
});
