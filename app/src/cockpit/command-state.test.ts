import { describe, expect, test } from 'vitest';
import { emptyRun } from './model';
import { COMMAND_OUTPUT_KEEP, noCommands, outcome, reduceCommands, running } from './commands';
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

// Shared by every describe below, because the three of them ask the same tools
// the same way and a second copy is a second answer to what a context is.
const ctx = (commands: Commands, dir = 'C:/repo') => ({ run: emptyRun(), commands, dir });
const call = (name: string, input: unknown) => ({ name, input, unreadable: null });

describe('what the pilot may do about one', () => {
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

describe('tailing a process that keeps writing', () => {
  /**
   * The half the runner was missing (#223).
   *
   * `read_command` answered with the whole buffer every time, so a dev server's
   * answer grew without bound and nothing in it said which part was new. The
   * pilot could start a process and could not follow one — reported as *"I need
   * it to be able to tail logs from processes it starts so it can debug"*.
   *
   * The arithmetic is in `tail` and is pure for that reason: it has two
   * off-by-one edges and a truncation case, and every one of them is a wrong
   * answer that reads as a right one.
   */
  const read = (state: Commands, input: Record<string, unknown>) => {
    const settlement = execute(call('read_command', input), ctx(state));
    expect(settlement.kind).toBe('ran');
    return JSON.parse(settlement.kind === 'ran' ? settlement.content : '{}') as {
      output: string;
      cursor: number;
      missed: number;
      running: boolean;
    };
  };

  test('a cursor returns what is new and nothing that was already read', () => {
    const state = fold(startedFrame(), outputFrame('starting\n'));
    const first = read(state, { id: 'cmd-1' });
    expect(first.output).toBe('starting\n');
    expect(first.cursor).toBe('starting\n'.length);

    const later = reduceCommands(state, outputFrame('ready on 5174\n'));
    const second = read(later, { id: 'cmd-1', since: first.cursor });
    expect(second.output).toBe('ready on 5174\n');
    expect(second.missed).toBe(0);
  });

  test('a cursor that has not moved is a command that has written nothing', () => {
    // Which is a real answer about a server that has finished starting, and is
    // deliberately not the same as "it is gone".
    const state = fold(startedFrame(), outputFrame('ready\n'));
    const first = read(state, { id: 'cmd-1' });
    const again = read(state, { id: 'cmd-1', since: first.cursor });
    expect(again.output).toBe('');
    expect(again.cursor).toBe(first.cursor);
    expect(again.running).toBe(true);
  });

  test('a cursor older than the buffer says how much it missed rather than pretending', () => {
    // The window keeps a bounded tail, so a reader that went away for an
    // afternoon cannot be served from where it left off. Both wrong answers are
    // worse than the number: handing back the tail as if it were everything
    // makes the reader believe it has the whole log, and handing back nothing
    // makes it believe the command went quiet.
    const state = fold(startedFrame(), outputFrame('x'.repeat(COMMAND_OUTPUT_KEEP + 500)));
    const seen = read(state, { id: 'cmd-1', since: 0 });
    expect(seen.missed).toBe(500);
    expect(seen.output).toHaveLength(COMMAND_OUTPUT_KEEP);
    expect(seen.cursor).toBe(COMMAND_OUTPUT_KEEP + 500);
  });

  test('the cursor counts what was written, so truncation cannot rewind it', () => {
    const state = fold(startedFrame(), outputFrame('y'.repeat(COMMAND_OUTPUT_KEEP + 10)));
    // Not `output.length`, which is capped. A cursor measured against the kept
    // buffer would go backwards the moment the front started dropping, and the
    // reader would be handed lines it had already seen.
    expect(state.all[0]?.bytes).toBe(COMMAND_OUTPUT_KEEP + 10);
    expect(state.all[0]?.output.length).toBe(COMMAND_OUTPUT_KEEP);
  });

  test('a cursor with no id is refused, because one position cannot describe two commands', () => {
    const settlement = execute(call('read_command', { since: 0 }), ctx(fold(startedFrame())));
    expect(settlement.kind).toBe('refused');
    expect(settlement.kind === 'refused' && settlement.content).toMatch(/needs an "id"/);
  });

  test('a cursor that is not a whole number is refused rather than read as zero', () => {
    // Coercing it would hand back the whole log under the name of a tail, which
    // is the one answer a reader cannot tell apart from a correct one.
    const settlement = execute(
      call('read_command', { id: 'cmd-1', since: 'latest' }),
      ctx(fold(startedFrame())),
    );
    expect(settlement.kind).toBe('refused');
  });
});

describe('stopping one', () => {
  /**
   * The off switch, and the improvisation that happened without it (#223).
   *
   * Asked to stop the server it had started, the pilot said *"I have no tool
   * that kills a command"* and proposed `npx kill-port 5173 4000`. That killed a
   * stale process on a port guessed from `package.json`, left the real server
   * running on the port Vite had fallen back to, and took an unrelated
   * `node --watch` down with it. A capability with no off switch is not a
   * narrower capability; it is one whose off switch gets improvised.
   */
  test('it proposes rather than stopping, exactly as starting one does', () => {
    const settlement = execute(
      call('stop_command', { id: 'cmd-1' }),
      ctx(fold(startedFrame(), outputFrame('up\n'))),
    );
    expect(settlement.kind).toBe('proposes');
    if (settlement.kind !== 'proposes') return;
    expect(settlement.effect).toEqual({ kind: 'stop_command', commandId: 'cmd-1' });
    // The command line is on the card, so what is stopped is what was read.
    expect(settlement.summary).toContain('npm install');
  });

  test('a command that has already ended is refused with its outcome', () => {
    // "Stopped" and "exited on its own" are different facts about a process, and
    // a model told the second will not report the first.
    const settlement = execute(
      call('stop_command', { id: 'cmd-1' }),
      ctx(fold(startedFrame(), endedFrame())),
    );
    expect(settlement.kind).toBe('refused');
    expect(settlement.kind === 'refused' && settlement.content).toMatch(/already ended/);
    expect(settlement.kind === 'refused' && settlement.content).toContain('exit 0');
  });

  test('a command that does not exist is refused with the list', () => {
    const settlement = execute(call('stop_command', { id: 'cmd-9' }), ctx(fold(startedFrame())));
    expect(settlement.kind).toBe('refused');
    expect(settlement.kind === 'refused' && settlement.content).toContain('cmd-1');
  });
});
