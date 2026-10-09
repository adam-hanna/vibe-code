import { describe, expect, test } from 'vitest';
import { backToCommand, blankRow, convert, gatesPatch, pastedEscapes, readGates, ready, toGate, toRow } from './gateform';
import type { GateRow } from './gateform';

/**
 * The gate list's decisions (#240): what is sent, in the shape a hand-written
 * `vibe.config.json` would hold, and the one write that changes the file's shape.
 */

const CORE = 'npm run typecheck && npm test';
const APP = 'cd app && npm run typecheck && npx vitest run && npm run audit:contrast';
const typed = (row: GateRow, change: Partial<GateRow>): GateRow => ({ ...row, ...change });

describe('converting the single test command', () => {
  test('the command becomes the first gate, and the same write clears it', () => {
    const rows = convert(CORE);
    expect(rows.map((r) => [r.name, r.command])).toEqual([
      ['verification', CORE],
      ['', ''],
    ]);
    expect(gatesPatch(rows, true)).toEqual({
      verify: { gates: [{ name: 'verification', command: CORE }], command: null },
    });
  });

  test('a file that never named a command is not given a line saying so', () => {
    expect(gatesPatch(convert(CORE), false)).toEqual({
      verify: { gates: [{ name: 'verification', command: CORE }] },
    });
  });

  test('with auto-detect there is nothing to carry over, and nothing is sent yet', () => {
    const rows = convert(null);
    expect(rows).toHaveLength(1);
    expect(gatesPatch(rows, false)).toBeNull();
  });
});

describe('which rows are sent', () => {
  test('a new row waits for a name and a command', () => {
    expect(ready(blankRow())).toBe(false);
    expect(ready(typed(blankRow(), { name: 'app' }))).toBe(false);
    expect(ready(typed(blankRow(), { name: 'app', command: APP }))).toBe(true);
  });

  test('a saved row is always sent, so emptying its command reaches the core and is refused there', () => {
    const row = typed(toRow({ name: 'core', command: CORE }), { command: '' });
    expect(ready(row)).toBe(true);
    expect(toGate(row)).toEqual({ name: 'core', command: '' });
  });

  test("the issue's two gates, from one command, are exactly what a person would write", () => {
    const [first, blank] = convert(CORE);
    const rows = [typed(first!, { name: 'core' }), typed(blank!, { name: 'app', command: APP })];
    expect(gatesPatch(rows, false)).toEqual({
      verify: {
        gates: [
          { name: 'core', command: CORE },
          { name: 'app', command: APP },
        ],
      },
    });
  });
});

describe('a gate in the file shape', () => {
  test('optional keys appear only when they say something', () => {
    const row = typed(blankRow(), { name: 'app', command: APP, runs: '1', minutes: '20', required: false });
    expect(toGate(row)).toEqual({ name: 'app', command: APP, runs: 1, timeoutMs: 1_200_000, required: false });
  });

  test('what the form does not edit survives a save, and so does an explicit required', () => {
    const row = toRow({ name: 'app', command: APP, required: true, artifacts: ['app/coverage'] });
    expect(toGate(typed(row, { command: 'npm test' }))).toEqual({
      name: 'app',
      command: 'npm test',
      required: true,
      artifacts: ['app/coverage'],
    });
  });

  test('a number that is not one is sent as typed, for the core to refuse by name', () => {
    expect(toGate(typed(blankRow(), { name: 'a', command: 'x', runs: 'two' }))['runs']).toBe('two');
  });

  test('a saved gate read back and sent unchanged is the same list, key for key', () => {
    const file = [{ name: 'core', command: CORE, runs: 2, timeoutMs: 60_000, required: false }];
    const gates = readGates(file)!;
    expect(JSON.stringify(gates.map((g) => toGate(toRow(g))))).toBe(JSON.stringify(gates));
  });
});

test('removing the last gate goes back to one test command, in one write', () => {
  expect(backToCommand(toRow({ name: 'core', command: CORE }))).toEqual({
    verify: { gates: null, command: CORE },
  });
  expect(backToCommand(toRow({ name: 'core', command: null }))).toEqual({
    verify: { gates: null, command: null },
  });
});

describe('a command pasted out of JSON', () => {
  test('is warned about, showing what the shell would have been given without the escapes', () => {
    const pasted = 'git worktree add \\"$VIBE_WORKTREE\\" \\"$VIBE_BRANCH\\"';
    const warning = pastedEscapes(pasted);
    expect(warning).not.toBeNull();
    expect(warning).toContain('git worktree add "$VIBE_WORKTREE" "$VIBE_BRANCH"');
  });

  test('an ordinary quoted command is not', () => {
    expect(pastedEscapes('git worktree add "$VIBE_WORKTREE"')).toBeNull();
  });
});
