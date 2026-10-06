import { describe, expect, test } from 'vitest';
import pane from '../pilot/PilotPane.tsx?raw';
import cockpit from './Cockpit.tsx?raw';
import { emptyRun } from './model';
import { isRunning, noCommands, outcome, reduceCommands, restore, running, tail } from './commands';
import { execute } from '../pilot/tools';
import type { PastCommand } from '../host';

/**
 * Commands an earlier launch ran, read back from the host's logs (#223). The
 * Commands tab was empty after every relaunch, because the host held the output
 * only in memory and took it with it.
 */

const past = (over: Partial<PastCommand> = {}): PastCommand => ({
  id: 'cmd-4',
  program: 'npm',
  args: ['run', 'dev'],
  resolved: 'node npm-cli.js',
  dir: '/repo',
  startedAt: 1_000,
  endedAt: 9_000,
  code: 1,
  signal: null,
  stopped: false,
  output: 'Error: EADDRINUSE\n',
  truncated: false,
  bytes: 18,
  lost: false,
  ...over,
});

const ctx = (commands: ReturnType<typeof noCommands>) => ({ run: emptyRun(), commands, dir: '/repo' });
const call = (name: string, input: unknown) => ({ name, input, unreadable: null });

describe('a past command', () => {
  test('comes before this launch, keeps its ending, and is not running', () => {
    const live = reduceCommands(noCommands(), {
      type: 'command_started',
      id: 1,
      command: { id: 'cmd-5', program: 'ls', args: [], resolved: 'ls', dir: '/repo', startedAt: 10_000 },
      refused: null,
    });
    const state = restore(live, [past()]);
    expect(state.all.map((c) => c.id)).toEqual(['cmd-4', 'cmd-5']);
    expect(state.all[0]?.restored).toBe(true);
    expect(state.all[1]?.restored).toBe(false);
    expect(outcome(state.all[0]!)).toBe('exit 1');
    expect(running(state).map((c) => c.id)).toEqual(['cmd-5']);
  });

  test('asked for twice is listed once', () => {
    const state = restore(restore(noCommands(), [past()]), [past()]);
    expect(state.all).toHaveLength(1);
  });

  test('one the host lost is neither running nor given an ending it never had', () => {
    const lost = restore(noCommands(), [past({ endedAt: null, code: null, lost: true })]).all[0]!;
    expect(isRunning(lost)).toBe(false);
    expect(lost.endedAt).toBeNull();
    expect(outcome(lost)).toBe('the app closed before it ended');
  });

  test('the pilot can read it, and is refused stopping it', () => {
    const state = restore(noCommands(), [past({ endedAt: null, code: null, lost: true })]);
    const read = execute(call('read_command', { id: 'cmd-4' }), ctx(state));
    expect(read.kind).toBe('ran');
    const seen = JSON.parse(read.kind === 'ran' ? read.content : '{}') as { running: boolean; output: string };
    expect(seen.running).toBe(false);
    expect(seen.output).toMatch(/EADDRINUSE/);
    expect(execute(call('stop_command', { id: 'cmd-4' }), ctx(state)).kind).toBe('refused');
  });

  test('a truncated log keeps the cursor arithmetic honest', () => {
    const one = restore(noCommands(), [past({ output: 'tail', truncated: true, bytes: 104 })]).all[0]!;
    expect(tail(one, 0)).toEqual({ text: 'tail', missed: 100, cursor: 104 });
  });

  test('never wakes the pilot, and is asked for once the host is up', () => {
    expect(pane).toMatch(/if \(command\.restored\) continue;/);
    expect(cockpit).toMatch(/\.pastCommands\(\)/);
  });
});
