import { describe, expect, test } from 'vitest';
import { launchArgv, readLaunchArgv } from '../cockpit/argv';
import { noCommands } from '../cockpit/commands';
import { emptyRun } from '../cockpit/model';
import { branchShapeRefusal, execute, TOOLS } from './tools';
import type { ToolContext } from './tools';

/**
 * The pilot names the run's branch on its `start_run` card (#356).
 *
 * The owner's decision: the pilot proposes `--branch <name>` in the command it
 * shows, the person asks for another name or presses "run it", and vibe
 * enforces no convention. So the field reaches the argv the card draws, the
 * reader gets it back, and a name that is plainly not one is refused by name
 * before the card exists - the core's `git check-ref-format` stays the
 * authority on everything else.
 */

const call = (input: unknown) => ({ name: 'start_run', input, unreadable: null });
const ctx = (): ToolContext => ({ run: emptyRun(), commands: noCommands(), dir: 'C:/repo' });
const good = { task: 'do the thing', directory: 'C:/repo', plan_only: false };

describe('start_run takes a branch', () => {
  test('the schema declares it, optional, so the pilot can be told what it is', () => {
    const tool = TOOLS.find((t) => t.name === 'start_run');
    const schema = tool?.input_schema as { properties: Record<string, unknown>; required: string[] };
    expect(schema.properties['branch']).toMatchObject({ type: 'string' });
    expect(schema.required).not.toContain('branch');
  });

  test('a branch reaches the argv the card shows, and the summary says it', () => {
    const settlement = execute(call({ ...good, branch: 'feat/356-branch-flag' }), ctx());
    expect(settlement.kind).toBe('proposes');
    if (settlement.kind !== 'proposes') return;
    expect(settlement.effect).toEqual({
      kind: 'invoke',
      argv: launchArgv('do the thing', 'C:/repo', false, { branch: 'feat/356-branch-flag' }),
    });
    expect(settlement.effect.kind === 'invoke' && settlement.effect.argv.slice(4, 6)).toEqual([
      '--branch',
      'feat/356-branch-flag',
    ]);
    expect(settlement.summary).toContain('on branch feat/356-branch-flag');
  });

  test('no branch is no flag: a default run is unchanged', () => {
    const settlement = execute(call(good), ctx());
    expect(settlement.kind === 'proposes' && settlement.effect).toEqual({
      kind: 'invoke',
      argv: launchArgv('do the thing', 'C:/repo', false),
    });
    expect(settlement.kind === 'proposes' && settlement.summary).not.toContain('branch');
  });

  test('a name that is plainly not a branch is refused by name, never cleaned up', () => {
    for (const branch of ['', 'two words', 'a..b', '-x', 'HEAD', 'x.lock', 'trailing/', 'a:b', 7]) {
      const settlement = execute(call({ ...good, branch }), ctx());
      expect(settlement.kind, String(branch)).toBe('refused');
      expect(settlement.kind === 'refused' && settlement.content).toContain('"branch"');
    }
  });

  test('the shape check passes the names a convention would produce', () => {
    for (const name of ['fix/login-timeout', 'feat/356-branch-flag', 'adam/wip_2', 'release/1.8.0']) {
      expect(branchShapeRefusal(name), name).toBeNull();
    }
  });
});

describe('the reader gets the branch back', () => {
  test('a launch with a branch round-trips with it', () => {
    const argv = launchArgv('the brief', '/r', true, { branch: 'fix/x', maxTokens: 5 });
    expect(readLaunchArgv(argv)).toEqual({ task: 'the brief', dir: '/r', planOnly: true, branch: 'fix/x' });
  });

  test('a launch without one has no branch field at all', () => {
    const read = readLaunchArgv(launchArgv('the brief', '/r', true));
    expect(read).toEqual({ task: 'the brief', dir: '/r', planOnly: true });
    expect(read !== null && 'branch' in read).toBe(false);
  });
});
