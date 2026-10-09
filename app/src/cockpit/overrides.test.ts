import { describe, expect, test } from 'vitest';
import { briefFor, launchArgv, readLaunchArgv, splitBrief } from './argv';
import pilotPane from '../pilot/PilotPane.tsx?raw';

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

describe('the composer hands its settings to the pilot in the message (#223)', () => {
  // `1b` launches nothing now. What it chose has to reach the run through the
  // pilot's `start_run`, and the message is where the person can see that it did.
  test('the brief comes first and is untouched, the settings after it', () => {
    const said = briefFor('  fix the thing\n', true);
    expect(said.startsWith('fix the thing\n')).toBe(true);
    expect(said).toContain('start_run');
    expect(said).toContain('- plan_only: true');
  });

  test('plan-only is always stated, because start_run will not guess it', () => {
    expect(briefFor('t', false)).toContain('- plan_only: false');
  });

  test('only overrides somebody set are stated', () => {
    // A list of the project's defaults would read as choices somebody made.
    const plain = briefFor('t', true, { gates: {}, maxTokens: null, p1Tolerance: null });
    expect(plain).not.toMatch(/gates|max_tokens|p1_tolerance/);
  });

  test('the overrides use the field names start_run takes', () => {
    const said = briefFor('t', false, {
      gates: { 'review-round': 'stop', implemented: 'auto' },
      maxTokens: 0,
      p1Tolerance: 2,
    });
    // Sorted, as the argv is. And a cap of 0 is stated as 0, because it turns the
    // ceiling off - it is a choice, not an absence.
    expect(said).toContain('- gates: implemented=auto, review-round=stop');
    expect(said).toContain('- max_tokens: 0');
    expect(said).toContain('- p1_tolerance: 2');
  });
});

describe('the settings ride under the brief and are drawn as chips, not as your words (#258)', () => {
  // The block stays on the wire because the pilot needs it on the turn that
  // proposes the run. What changes is that the pane stops drawing it as prose.
  test('a round trip gives back exactly the brief that was typed', () => {
    const brief = 'fix the thing\n\nwith a second paragraph';
    expect(splitBrief(briefFor(`  ${brief}\n`, false))).toEqual({ brief, settings: ['full run'] });
  });

  test('every setting the composer can state has a chip', () => {
    const said = briefFor('t', true, {
      gates: { 'review-round': 'stop', implemented: 'auto' },
      maxTokens: 40_000_000,
      p1Tolerance: 2,
    });
    expect(splitBrief(said).settings).toEqual([
      'plan only',
      'gates implemented=auto, review-round=stop',
      'max 40.00M tok',
      'P1 tolerance 2',
    ]);
  });

  test('a ceiling of 0 is stated as a choice, because it turns the ceiling off', () => {
    expect(splitBrief(briefFor('t', false, { maxTokens: 0 })).settings).toContain('no token ceiling');
  });

  test('a message that only looks like one is left whole', () => {
    const typed = 'notes\n\n---\nnot the composer';
    expect(splitBrief(typed)).toEqual({ brief: typed, settings: [] });
    // The heading with prose after it is not the block either.
    const prose = briefFor('t', false) + '\nand then I kept typing';
    expect(splitBrief(prose).settings).toEqual([]);
  });

  test('a setting this build does not know is shown as itself, never dropped', () => {
    const said = briefFor('t', false) + '\n- reviewer: pro';
    expect(splitBrief(said).settings).toEqual(['full run', 'reviewer: pro']);
  });

  test('the pane draws the brief, and the settings as chips', () => {
    expect(pilotPane).toMatch(/splitBrief\(reply\.asked\)/);
    expect(pilotPane).toMatch(/\{yours\.brief\}/);
    expect(pilotPane).not.toMatch(/\{reply\.asked\}/);
  });
});
