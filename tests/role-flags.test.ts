import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildRoleOverrides, configFromFlags, parseArgs } from '@src/cli.js';
import { applyOverrides, loadConfig } from '@src/config.js';
import type { Config, LoadedConfig } from '@src/types.js';

/**
 * `--role <role>:<key>=<value>`: the CLI surface for the role table (#89).
 *
 * The property under test is stated once and holds for every key: **a flag must
 * produce exactly what writing the same thing in `vibe.config.json` produces**,
 * including the toolchain contract derived from the table - not merely the same
 * `cfg.roles`. That is why the equivalence cases compare whole configs.
 *
 * Two things separate a flag from a config layer, and both are pinned below:
 *
 * - It **patches** rather than replacing. `mergeRoles` replaces a role's value
 *   wholesale and requires `provider` inside the object, because a partial object
 *   in a *layer* could hand a role to the other agent silently. A flag is not a
 *   layer: `--role reviewer:effort=max` over a file that named the reviewer's
 *   model must keep that model, and patching can never change a provider unless
 *   the flag says `provider=`.
 * - Its role names and keys are **user input reaching an object**, so every
 *   lookup is own-property-checked and every write goes through `setOwn`. Case
 *   10 is the one that would have caught a naive `base[roleName]`: `toString` is
 *   inherited, so an unchecked read reports it as an existing role and the flag
 *   is silently skipped rather than refused.
 *
 * Nothing here spawns an agent or touches the network: every case is config.
 */

/** The flag contract, without running main() - which resolves binaries and spawns. */
function patchesFor(args: readonly string[]): ReturnType<typeof buildRoleOverrides> {
  return buildRoleOverrides(parseArgs(args).flags);
}

/** A target repo holding just a vibe.config.json. */
function repoWith(config: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-role-flag-'));
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify(config), 'utf8');
  return dir;
}

function emptyRepo(): string {
  return mkdtempSync(path.join(tmpdir(), 'vibe-role-flag-empty-'));
}

/**
 * The config without the one field that says where it came from.
 *
 * `configPath` is a fact about sourcing, and the whole question here is whether
 * two differently-sourced configs describe the same run.
 */
function settings(cfg: LoadedConfig): Config {
  const { configPath: _configPath, ...rest } = cfg;
  return rest;
}

/** The message a call threw, for comparing two routes to the same refusal. */
function refusal(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  assert.fail('expected a refusal, got none');
}

// 1. Parsing.

test('--role parses into a per-role patch', () => {
  assert.deepEqual(patchesFor(['--role', 'reviewer:model=gpt-5.6-pro']), {
    reviewer: { model: 'gpt-5.6-pro' },
  });
});

test('a value may contain : and =, because only the first of each splits', () => {
  assert.deepEqual(patchesFor(['--role', 'reviewer:model=a:b=c']), {
    reviewer: { model: 'a:b=c' },
  });
});

test('--role without a colon or without an equals names the shape it wanted', () => {
  for (const bad of ['reviewer', 'reviewer:model', 'model=x']) {
    const message = refusal(() => patchesFor(['--role', bad]));
    assert.match(message, /--role expects <role>:<key>=<value>/);
    assert.match(message, /provider, model, effort or timeoutMs/);
    assert.match(message, /planner, implementer, critic, answerer, reviewer/);
  }
});

// 2. Last wins, and keys accumulate.

test('the last --role for a role and key wins, as every other flag does', () => {
  assert.deepEqual(patchesFor(['--role', 'reviewer:effort=low', '--role', 'reviewer:effort=max']), {
    reviewer: { effort: 'max' },
  });
});

test('different keys on one role accumulate, and different roles stay apart', () => {
  assert.deepEqual(
    patchesFor([
      '--role',
      'reviewer:effort=max',
      '--role',
      'reviewer:model=gpt-5.6-pro',
      '--role',
      'critic:timeoutMs=600000',
    ]),
    {
      reviewer: { effort: 'max', model: 'gpt-5.6-pro' },
      critic: { timeoutMs: 600_000 },
    },
  );
});

// 3. timeoutMs is the one key that has to arrive as a number.

test('timeoutMs is coerced to a number, because roleSetting tests typeof first', () => {
  assert.deepEqual(patchesFor(['--role', 'critic:timeoutMs=600000']), {
    critic: { timeoutMs: 600_000 },
  });
  // Fractional is legal for the provider key this overrides (#84), so it is
  // legal here: an override stricter than the value it replaces is a trap.
  assert.deepEqual(patchesFor(['--role', 'critic:timeoutMs=0.5']), { critic: { timeoutMs: 0.5 } });
});

test('a timeoutMs that is not a finite number stays a string, so it is refused as one', () => {
  // Passed through rather than rejected here: that is what makes the message
  // below identical to the config file's for the same value. `""` and `" "`
  // matter most - Number('') is 0, and coercing would report a figure the user
  // never typed.
  for (const raw of ['abc', '', ' ', 'Infinity', '30m']) {
    assert.deepEqual(patchesFor([`--role`, `critic:timeoutMs=${raw}`]), {
      critic: { timeoutMs: raw },
    });
  }
});

// 4. The equivalence property, per key, over the whole config.

test('a flag produces the same config as writing the same thing in vibe.config.json', () => {
  const cases: { flag: string; written: unknown }[] = [
    { flag: 'reviewer:provider=claude', written: { provider: 'claude' } },
    { flag: 'reviewer:model=gpt-5.6-pro', written: { provider: 'codex', model: 'gpt-5.6-pro' } },
    { flag: 'reviewer:effort=max', written: { provider: 'codex', effort: 'max' } },
    { flag: 'reviewer:timeoutMs=600000', written: { provider: 'codex', timeoutMs: 600_000 } },
  ];

  for (const { flag, written } of cases) {
    const fromFile = loadConfig(repoWith({ roles: { reviewer: written } }));
    const fromFlag = loadConfig(emptyRepo(), {}, patchesFor(['--role', flag]));

    // The WHOLE config, toolchain included - not just cfg.roles. deepEqual is
    // key-order-insensitive, which matters because a patched role object's key
    // order comes from the base plus insertion rather than from the file.
    assert.deepEqual(settings(fromFlag), settings(fromFile), flag);
  }
});

// 5 and 6. Patch, not replace.

const REVIEWER_NAMED_A_MODEL = {
  roles: { reviewer: { provider: 'codex', model: 'gpt-5.6-pro' } },
};

test('--role reviewer:effort=max keeps the model the config file named', () => {
  const cfg = loadConfig(repoWith(REVIEWER_NAMED_A_MODEL), {}, patchesFor(['--role', 'reviewer:effort=max']));

  assert.deepEqual(cfg.roles.reviewer, { provider: 'codex', model: 'gpt-5.6-pro', effort: 'max' });
});

test('moving a provider by flag keeps the file\'s model, unrepaired and unvalidated', () => {
  // #60's settled position, and it surfaces rather than being fixed: a model is
  // accepted on trust, never substituted, and the `Roles:` line shows it.
  const cfg = loadConfig(
    repoWith(REVIEWER_NAMED_A_MODEL),
    {},
    patchesFor(['--role', 'reviewer:provider=claude']),
  );

  assert.deepEqual(cfg.roles.reviewer, { provider: 'claude', model: 'gpt-5.6-pro' });
});

// 7 and 8. The toolchain contract, which is why the patch is applied where it is.

/** A writing Codex role needs this, or `roleRefusals` throws before any assertion. */
const ONE_SHOT_CODEX = { codex: { persistSession: false } };

test('moving the implementer by flag re-derives the role-scoped toolchain, both ways', () => {
  const toCodex = loadConfig(
    repoWith(ONE_SHOT_CODEX),
    {},
    patchesFor(['--role', 'implementer:provider=codex']),
  );
  assert.deepEqual(toCodex.toolchain['node']?.agents, ['codex']);
  assert.deepEqual(toCodex.toolchain['npm']?.agents, ['codex']);
  // The same table written in the file is the truth this is measured against.
  assert.deepEqual(
    settings(toCodex),
    settings(loadConfig(repoWith({ ...ONE_SHOT_CODEX, roles: { implementer: { provider: 'codex' } } }))),
  );

  const backToClaude = loadConfig(
    repoWith({ ...ONE_SHOT_CODEX, roles: { implementer: { provider: 'codex' } } }),
    {},
    patchesFor(['--role', 'implementer:provider=claude']),
  );
  assert.deepEqual(backToClaude.toolchain['node']?.agents, ['claude']);
  assert.deepEqual(backToClaude.toolchain['npm']?.agents, ['claude']);
});

test('applyOverrides re-derives too, over a stored config whose agents it wrote itself', () => {
  // The resume path. Every stored `state.config` carries concrete `agents`, so
  // `pinnedByAnyLayer` reports one on EVERY resume - and without the prior-table
  // comparison the contract would be left behind by a table that moved.
  const stored: Config = loadConfig(repoWith(ONE_SHOT_CODEX));
  assert.deepEqual(stored.toolchain['node']?.agents, ['claude'], 'the stored contract to begin with');

  const moved = applyOverrides(stored, {}, patchesFor(['--role', 'implementer:provider=codex']));
  assert.deepEqual(moved.toolchain['node']?.agents, ['codex']);
  assert.deepEqual(moved.toolchain['npm']?.agents, ['codex']);

  const back = applyOverrides(moved, {}, patchesFor(['--role', 'implementer:provider=claude']));
  assert.deepEqual(back.toolchain['node']?.agents, ['claude']);
});

test('a pin the derivation would not have produced survives a role patch', () => {
  // The negative that keeps the exception honest. Only a pin equal to what the
  // PRIOR table derived is treated as derived; anything else is a contract the
  // user wrote, and it still wins.
  // The whole requirement, not just `agents`: `mergeToolchain` replaces a tool's
  // entry wholesale, because the section has open-ended keys.
  const stored: Config = loadConfig(
    repoWith({
      ...ONE_SHOT_CODEX,
      toolchain: {
        node: {
          probe: 'node --version',
          phases: ['implement', 'review'],
          agents: ['claude', 'codex'],
        },
      },
    }),
  );
  assert.deepEqual(stored.toolchain['node']?.agents, ['claude', 'codex'], 'the hand-written pin');

  const moved = applyOverrides(stored, {}, patchesFor(['--role', 'implementer:provider=codex']));

  assert.deepEqual(moved.toolchain['node']?.agents, ['claude', 'codex'], 'the pin is untouched');
  // npm named no agents of its own, so it is role-derived and does move.
  assert.deepEqual(moved.toolchain['npm']?.agents, ['codex']);
});

// 9. One vocabulary: a flag is refused in the words the config key is refused in.

test('a bad value from a flag reads exactly as the same bad value in the config file', () => {
  const cases: { flag: string; written: unknown }[] = [
    { flag: 'reviewer:effort=maximum', written: { provider: 'codex', effort: 'maximum' } },
    { flag: 'reviewer:model=', written: { provider: 'codex', model: '' } },
    { flag: 'reviewer:timeoutMs=abc', written: { provider: 'codex', timeoutMs: 'abc' } },
    { flag: 'reviewer:timeoutMs=-5', written: { provider: 'codex', timeoutMs: -5 } },
    { flag: 'reviewer:sandbox=read-only', written: { provider: 'codex', sandbox: 'read-only' } },
    { flag: 'reviewer:provider=gpt', written: { provider: 'gpt' } },
  ];

  for (const { flag, written } of cases) {
    const fromFile = refusal(() => loadConfig(repoWith({ roles: { reviewer: written } })));
    const fromFlag = refusal(() => loadConfig(emptyRepo(), {}, patchesFor(['--role', flag])));

    assert.equal(fromFlag, fromFile, flag);
  }
});

test('an unknown role name is refused by name, in the config file\'s own words', () => {
  const fromFile = refusal(() => loadConfig(repoWith({ roles: { revewer: 'codex' } })));
  const fromFlag = refusal(() =>
    loadConfig(emptyRepo(), {}, patchesFor(['--role', 'revewer:effort=max'])),
  );

  assert.equal(fromFlag, fromFile);
  assert.match(fromFlag, /roles\."revewer" is not a role/);
});

// 10. The hole this whole area is strict about.

test('an inherited or reserved role name is refused by name, never silently skipped', () => {
  const prototypeBefore = Object.getOwnPropertyNames(Object.prototype).sort();

  for (const name of ['__proto__', 'toString', 'constructor', 'valueOf']) {
    // The failure this pins is NOT a crash: an unchecked `base[name]` returns
    // something inherited, the patch decides the role already exists and is
    // malformed, skips it - and the run proceeds on a table the user believes
    // they changed.
    const message = refusal(() =>
      loadConfig(emptyRepo(), {}, patchesFor(['--role', `${name}:effort=max`])),
    );
    assert.equal(message, `roles."${name}" is not a role; expected one of planner, implementer, critic, answerer, reviewer`);
  }

  for (const key of ['__proto__', 'toString', 'constructor', 'valueOf']) {
    const message = refusal(() =>
      loadConfig(emptyRepo(), {}, patchesFor(['--role', `reviewer:${key}=x`])),
    );
    assert.match(message, new RegExp(`roles\\.reviewer has unknown key "${key}"`));
  }

  // Proved, not assumed: `setOwn` exists so `__proto__` becomes an own key
  // rather than invoking the prototype setter.
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), prototypeBefore);
  const plain = {} as Record<string, unknown>;
  assert.equal(plain['effort'], undefined);
  assert.equal(plain['provider'], undefined);
});

// 11. The compatibility claim.

test('a run passing no --role is byte-identical to one from before the flag', () => {
  assert.equal(parseArgs([]).flags.role, undefined);
  assert.deepEqual(buildRoleOverrides({}), {});

  for (const dir of [emptyRepo(), repoWith(REVIEWER_NAMED_A_MODEL)]) {
    assert.deepEqual(loadConfig(dir, {}, {}), loadConfig(dir));
  }
});

// 12. The seam `cmdRun` builds its config through.

test('configFromFlags carries both the role patch and the provider-level flags', () => {
  const cfg = configFromFlags(
    emptyRepo(),
    parseArgs([
      '--role',
      'implementer:provider=codex',
      '--no-codex-session',
      '--claude-model',
      'sonnet',
    ]).flags,
  );

  assert.deepEqual(cfg.roles.implementer, { provider: 'codex' });
  assert.deepEqual(cfg.toolchain['node']?.agents, ['codex']);
  assert.equal(cfg.claude.model, 'sonnet', 'the provider-level flag is not lost to the role one');
});
