import { describe, expect, test } from 'vitest';
import { emptyRun } from './model';
import { noCommands, outcome, reduceCommands, running } from './commands';
import { execute } from '../pilot/tools';
import type { Commands } from './commands';
import type { CommandEnded, CommandOutput, CommandStarted } from '../host';

/**
 * Commands, folded from frames, and what the pilot may do about them (#211).
 *
 * The rule this feature lives under: **the model proposes and a person
 * presses.** `run_command` settles as `proposes`, exactly as `start_run` does,
 * so the conversation cannot continue until somebody has decided - and that
 * enforcement is in the data rather than in a component, because a `proposes`
 * settlement appends no tool result.
 */

const startedFrame = (over: Partial<CommandStarted> = {}): CommandStarted => ({
  type: 'command_started',
  id: 1,
  command: {
    id: 'cmd-1',
    program: 'npm',
    args: ['install'],
    resolved: 'node C:/nodejs/npm-cli.js',
    dir: 'C:/repo',
    startedAt: 1_000,
  },
  refused: null,
  ...over,
});

const outputFrame = (chunk: string, commandId = 'cmd-1'): CommandOutput => ({
  type: 'command_output',
  commandId,
  chunk,
});

const endedFrame = (over: Partial<CommandEnded> = {}): CommandEnded => ({
  type: 'command_ended',
  commandId: 'cmd-1',
  code: 0,
  signal: null,
  stopped: false,
  endedAt: 5_000,
  ...over,
});

function fold(...frames: (CommandStarted | CommandOutput | CommandEnded)[]): Commands {
  return frames.reduce(reduceCommands, noCommands());
}

describe('what the window knows about a command', () => {
  test('it is assembled from frames and from nothing else', () => {
    const state = fold(startedFrame(), outputFrame('added 412 packages\n'), endedFrame());
    expect(state.all).toHaveLength(1);
    expect(state.all[0]?.output).toBe('added 412 packages\n');
    expect(outcome(state.all[0]!)).toBe('exit 0');
  });

  test('a running command has no outcome, rather than a zero', () => {
    // A model reading `exit 0` on a live dev server would report it finished.
    const state = fold(startedFrame(), outputFrame('➜ Local: http://localhost:5173\n'));
    expect(outcome(state.all[0]!)).toBeNull();
    expect(running(state)).toHaveLength(1);
  });

  test('stopped outranks the exit code', () => {
    // On Windows a killed process closes with a code and no signal, so a stop
    // reporting `exit 1` reads as a crash - and the difference is the whole
    // point of having pressed stop (#131).
    const state = fold(startedFrame(), endedFrame({ code: 1, stopped: true }));
    expect(outcome(state.all[0]!)).toBe('stopped');
  });

  test('a refusal is kept, and is cleared by the next thing that started', () => {
    // A refusal is the runner declining to spawn, and it is the answer to what
    // was asked. Dropping it leaves a person pressing a button that visibly
    // does nothing.
    const refused = fold(startedFrame({ command: null, refused: 'npm.cmd is a shim' }));
    expect(refused.all).toHaveLength(0);
    expect(refused.refused).toMatch(/shim/);
    expect(reduceCommands(refused, startedFrame()).refused).toBeNull();
  });

  test('output for a command nobody started is dropped rather than inventing one', () => {
    const state = fold(startedFrame(), outputFrame('lost', 'cmd-999'));
    expect(state.all).toHaveLength(1);
    expect(state.all[0]?.output).toBe('');
  });
});

describe('what the pilot may do about one', () => {
  const ctx = (commands: Commands, dir = 'C:/repo') => ({ run: emptyRun(), commands, dir });
  const call = (name: string, input: unknown) => ({ name, input, unreadable: null });

  test('running a command is proposed, never done', () => {
    // The rule the whole feature is allowed to exist under. `proposes` appends
    // no tool result, so the conversation is unsendable until a person decides.
    const settlement = execute(
      call('run_command', { program: 'npm', args: ['install'], why: 'check it builds' }),
      ctx(noCommands()),
    );
    expect(settlement.kind).toBe('proposes');
    expect(settlement.kind === 'proposes' && settlement.effect).toEqual({
      kind: 'command',
      dir: 'C:/repo',
      program: 'npm',
      args: ['install'],
    });
  });

  test('shell syntax is refused with its reason rather than passed through', () => {
    // There is no shell, so `npm test && npm run build` would reach a program
    // called `npm` as literal arguments and fail confusingly. A model told this
    // sends two calls instead of guessing.
    for (const input of [
      { program: 'npm', args: ['test', '&&', 'npm', 'run', 'build'], why: 'x' },
      { program: 'sh', args: ['-c', 'npm test | tee log'], why: 'x' },
      { program: 'npm', args: ['run', 'dev', '>', 'out.log'], why: 'x' },
    ]) {
      const settlement = execute(call('run_command', input), ctx(noCommands()));
      expect(settlement.kind, JSON.stringify(input)).toBe('refused');
      expect(settlement.kind === 'refused' && settlement.content).toMatch(/no shell/);
    }
  });

  test('it is refused when the window is pointed at no repository', () => {
    // Fail closed: a command with nowhere to run must not fall back to whatever
    // directory this process happens to be in.
    const settlement = execute(
      call('run_command', { program: 'npm', args: [], why: 'x' }),
      ctx(noCommands(), ''),
    );
    expect(settlement.kind).toBe('refused');
  });

  test('reading one back reports it as running rather than as finished', () => {
    const state = fold(startedFrame(), outputFrame('➜ Local: http://localhost:5173\n'));
    const settlement = execute(call('read_command', { id: 'cmd-1' }), ctx(state));
    expect(settlement.kind).toBe('ran');
    const seen = JSON.parse(settlement.kind === 'ran' ? settlement.content : '{}') as {
      running: boolean;
      outcome: string | null;
      output: string;
    };
    expect(seen.running).toBe(true);
    expect(seen.outcome).toBeNull();
    expect(seen.output).toMatch(/5173/);
  });

  test('reading a command that does not exist is refused with the list', () => {
    const settlement = execute(call('read_command', { id: 'cmd-99' }), ctx(fold(startedFrame())));
    expect(settlement.kind).toBe('refused');
    expect(settlement.kind === 'refused' && settlement.content).toContain('cmd-1');
  });

  test('an empty session says so rather than reading as commands that failed', () => {
    const settlement = execute(call('read_command', {}), ctx(noCommands()));
    const seen = JSON.parse(settlement.kind === 'ran' ? settlement.content : '{}') as {
      note: string | null;
    };
    expect(seen.note).toMatch(/Nothing has been run/);
  });
});
