import type { CommandEnded, CommandOutput, CommandStarted } from '../host';

/**
 * Commands this window started, folded from frames and from nothing else (#211).
 *
 * **Its own state rather than a field on `Run`, and the reason is lifetime.** A
 * run is one invocation of the loop; a command is not part of one. It is started
 * when there is no run at all - *"does the thing you just built actually
 * start"* is asked after a run finishes - and a dev server left up outlives
 * several. Folding it into `Run` would mean `nextRun` killing the card of a
 * process that is still listening on 5173.
 *
 * Pure, for the reason `model.ts` is: this is where a bug would be invisible,
 * and the components have no tests by design.
 */

export interface Command {
  id: string;
  program: string;
  args: readonly string[];
  /** What was actually spawned. `npm` resolves to `node …/npm-cli.js`. */
  resolved: string;
  dir: string;
  startedAt: number;
  /** Null while it is still running - which is the interesting state here. */
  endedAt: number | null;
  code: number | null;
  signal: string | null;
  /** Whether a person stopped it, which the exit code cannot say on Windows. */
  stopped: boolean;
  /** stdout and stderr interleaved, as a terminal shows them. */
  output: string;
  /** True once output has been dropped from the front. */
  truncated: boolean;
}

export interface Commands {
  /** Oldest first, so the list reads as a session's history. */
  all: readonly Command[];
  /**
   * The last refusal, or null.
   *
   * Kept rather than thrown: a refusal is the runner declining to spawn - a
   * shim it will not shell, a directory that does not exist - and it is the
   * answer to the question that was asked. Dropping it would leave a person
   * pressing a button that visibly does nothing.
   */
  refused: string | null;
}

export function noCommands(): Commands {
  return { all: [], refused: null };
}

/**
 * How much of one command's output is kept in the window.
 *
 * A display choice and allowed to be one, exactly as `OUTPUT_KEEP` is: the host
 * already bounds its own copy, and this bounds the copy being rendered. What is
 * not allowed is presenting a tail as the whole, which `truncated` prevents.
 */
export const COMMAND_OUTPUT_KEEP = 64 * 1024;

function mapCommand(
  commands: Commands,
  id: string,
  f: (command: Command) => Command,
): Commands {
  return { ...commands, all: commands.all.map((c) => (c.id === id ? f(c) : c)) };
}

/** The answer to a request: a command that started, or a refusal. */
export function started(commands: Commands, frame: CommandStarted): Commands {
  if (frame.command === null) {
    return { ...commands, refused: frame.refused };
  }
  const command: Command = {
    ...frame.command,
    endedAt: null,
    code: null,
    signal: null,
    stopped: false,
    output: '',
    truncated: false,
  };
  // A refusal is cleared by a start, because the two answer the same question
  // and the newer one is the answer.
  return { all: [...commands.all, command], refused: null };
}

/** Output as it arrives. A chunk for a command nobody started is dropped. */
export function output(commands: Commands, frame: CommandOutput): Commands {
  return mapCommand(commands, frame.commandId, (command) => {
    let text = command.output + frame.chunk;
    let truncated = command.truncated;
    if (text.length > COMMAND_OUTPUT_KEEP) {
      text = text.slice(text.length - COMMAND_OUTPUT_KEEP);
      truncated = true;
    }
    return { ...command, output: text, truncated };
  });
}

/** It ended, however it ended. */
export function ended(commands: Commands, frame: CommandEnded): Commands {
  return mapCommand(commands, frame.commandId, (command) => ({
    ...command,
    endedAt: frame.endedAt,
    code: frame.code,
    signal: frame.signal,
    stopped: frame.stopped,
  }));
}

/** Fold one frame. The one entry point, so a caller needs no switch. */
export function reduceCommands(
  commands: Commands,
  frame: CommandStarted | CommandOutput | CommandEnded,
): Commands {
  if (frame.type === 'command_started') return started(commands, frame);
  if (frame.type === 'command_output') return output(commands, frame);
  return ended(commands, frame);
}

/** Still running, which is what a stop button and a liveness dot ask about. */
export function running(commands: Commands): readonly Command[] {
  return commands.all.filter((c) => c.endedAt === null);
}

/**
 * How a command ended, in words, or null while it is still going.
 *
 * **`stopped` outranks the exit code**, because on Windows a killed process
 * closes with a code and no signal (#131): a stopped command reporting `exit 1`
 * would read as one that failed, and the difference is the whole point of
 * pressing stop.
 */
export function outcome(command: Command): string | null {
  if (command.endedAt === null) return null;
  if (command.stopped) return 'stopped';
  if (command.signal !== null) return `killed by ${command.signal}`;
  if (command.code === null) return 'ended without an exit code';
  return command.code === 0 ? 'exit 0' : `exit ${String(command.code)}`;
}

/** The command line as a person reads it. Never what is spawned - see `resolved`. */
export function line(command: Command): string {
  return [command.program, ...command.args].join(' ');
}
