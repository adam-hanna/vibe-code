import { describe, expect, test } from 'vitest';
import { launchArgv, readLaunchArgv } from './argv';

/**
 * The overrides `4a` can express (#223).
 *
 * **Every one is a flag `parseArgs` already takes**, and that is the constraint
 * the modal is built under rather than a limitation to work around: the GUI's
 * job is a form to an argv, so the set of legal invocations still has exactly
 * one definition and it is the CLI's. A control with no flag behind it would be
 * a promise the app cannot keep.
 *
 * What is worth pinning is the pair of rules that decide what an *empty* field
 * means, because both of them are places where a zero and an absence are
 * opposite instructions.
 */

describe('an override reaches the argv as the flag the CLI takes', () => {
  test('gates become repeated --gate boundary=mode', () => {
    const argv = launchArgv('t', '/r', false, {
      gates: { 'review-round': 'stop', 'plan-round': 'auto' },
    });
    // Sorted, so the same overrides always build the same argv. Two forms
    // differing only in the order somebody clicked would otherwise produce two
    // different commands, and one of them would be the one in a bug report.
    expect(argv.slice(4)).toEqual(['--gate', 'plan-round=auto', '--gate', 'review-round=stop']);
  });

  test('roles become --role role:key=value, which patches rather than replaces', () => {
    const argv = launchArgv('t', '/r', false, {
      roles: [{ role: 'reviewer', key: 'effort', value: 'max' }],
    });
    expect(argv.slice(4)).toEqual(['--role', 'reviewer:effort=max']);
  });

  test('the positional four are untouched, whatever follows them', () => {
    const argv = launchArgv('  the brief  ', '  /r  ', true, { maxTokens: 5 });
    expect(argv.slice(0, 4)).toEqual(['plan', 'the brief', '-C', '/r']);
  });
});

describe('empty is not zero, and here both directions matter', () => {
  test('an unset ceiling sends no flag at all', () => {
    // `--max-tokens 0` turns the ceiling OFF, which is the opposite of leaving
    // it alone. A form that coerced an empty field would silently unbound every
    // run somebody did not think about.
    expect(launchArgv('t', '/r', false, { maxTokens: null })).toHaveLength(4);
    expect(launchArgv('t', '/r', false, {})).toHaveLength(4);
  });

  test('a ceiling of zero is sent, because it means something', () => {
    expect(launchArgv('t', '/r', false, { maxTokens: 0 }).slice(4)).toEqual(['--max-tokens', '0']);
  });

  test('a tolerance of zero is sent, and it demands a spotless verdict', () => {
    expect(launchArgv('t', '/r', false, { p1Tolerance: 0 }).slice(4)).toEqual([
      '--p1-tolerance',
      '0',
    ]);
    expect(launchArgv('t', '/r', false, { p1Tolerance: null })).toHaveLength(4);
  });
});

describe('the builder and the reader stay in step', () => {
  test('everything the builder emits, the reader accounts for', () => {
    // The round trip IS the guard. A flag added to `launchArgv` and not added to
    // `KNOWN_FLAGS` makes this null, which is the failure that catches the
    // drift - a reader that skipped the tail would let the two halves diverge
    // in silence.
    const argv = launchArgv('the brief', '/r', false, {
      gates: { 'plan-round': 'auto' },
      roles: [{ role: 'critic', key: 'timeoutMs', value: '600000' }],
      maxTokens: 900_000,
      p1Tolerance: 0,
    });
    expect(readLaunchArgv(argv)).toEqual({ task: 'the brief', dir: '/r', planOnly: false });
  });
});
