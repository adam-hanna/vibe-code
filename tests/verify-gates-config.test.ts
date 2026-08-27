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

test('an artifacts key is refused with the reason, not as an unknown key', () => {
  assert.throws(
    withVerify({
      gates: [{ name: 'qa', command: null, artifacts: ['playwright-report/**'] }],
    }),
    { message: /artifacts is not supported/ },
  );
  // It is a real request out of #47's own example, so it gets a real answer.
  assert.throws(
    withVerify({ gates: [{ name: 'qa', command: null, artifacts: [] }] }),
    { message: /#53/ },
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

test('a 1.1.0 config with no gates key still resolves and still validates', () => {
  const stored = structuredClone(DEFAULTS) as unknown as Record<string, Record<string, unknown>>;
  delete stored['verify']?.['gates'];

  const merged = applyOverrides(stored as unknown as Config, {});

  // DEFAULTS layered underneath supplies the key, and null is what says "the
  // legacy gate" - so a resume of a run recorded before #47 is unaffected.
  assert.equal(merged.verify.gates, null);
});
