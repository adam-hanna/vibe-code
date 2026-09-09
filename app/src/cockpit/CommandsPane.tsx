import { useState } from 'react';
import { Button, LivenessDot, MetaChip, StateKicker } from '../design';
import { clock, elapsed } from './format';
import { line, outcome } from './commands';
import type { Command, Commands } from './commands';

/**
 * The window's own command control (#211).
 *
 * **It exists so that running a command is not a pilot power.** #144's rule is
 * that every pilot capability is a host request the app already makes, so that a
 * capability the UI lacks is a missing control rather than a special ability.
 * The pilot proposing `npm install` and the button here send the same frame
 * through the same `runCommand` in `Cockpit`.
 *
 * ## What it will not do
 *
 * **There is no command line here, and that is not an oversight.** A single
 * input would have to be split into a program and its arguments, and splitting
 * is what puts a `;` back in play - `src/commands.ts` keeps the two apart the
 * whole way down precisely so there is no line for one to be in. Two fields, and
 * the arguments are split on whitespace with what that means stated, which is
 * the honest version of the same convenience.
 */

function CommandCard({
  command,
  onStop,
}: {
  command: Command;
  onStop: (id: string) => void;
}) {
  const how = outcome(command);
  return (
    <div className={`v-cmd${how === null ? ' v-cmd--live' : ''}`}>
      <div className="v-cmd__head">
        {how === null && <LivenessDot state="live" />}
        <code className="v-cmd__line">{line(command)}</code>
        {how === null ? (
          <StateKicker tone="accent">running</StateKicker>
        ) : (
          <MetaChip kind={how === 'exit 0' ? 'checkable' : 'alarm'}>{how}</MetaChip>
        )}
        {how === null && (
          <Button level="secondary" onClick={() => onStop(command.id)}>
            ⏹ stop
          </Button>
        )}
      </div>

      <div className="v-cmd__meta">
        <span>{command.dir}</span>
        {/* What was actually spawned, when it is not what was typed. `npm`
            resolves to `node …/npm-cli.js` so that no shell is involved, and
            hiding that would make the card a description rather than a record. */}
        {command.resolved !== command.program && (
          <span className="v-cmd__resolved">ran {command.resolved}</span>
        )}
        <span>
          {/* An instant once it has stopped, a duration while it runs - the pair
              #202 settled. `last activity 6s ago` on a finished card ages into a
              lie; a start time does not. */}
          {command.endedAt === null
            ? `started ${clock(command.startedAt)}`
            : `${elapsed(command.endedAt - command.startedAt)}, ended ${clock(command.endedAt)}`}
        </span>
      </div>

      {command.output === '' ? (
        <div className="v-cmd__quiet">
          {how === null ? 'no output yet' : 'it wrote nothing'}
        </div>
      ) : (
        <pre className="v-cmd__output v-selectable">
          {command.truncated ? '…earlier output was dropped\n' : ''}
          {command.output}
        </pre>
      )}
    </div>
  );
}

export function CommandsPane({
  commands,
  dir,
  onRun,
  onStop,
}: {
  commands: Commands;
  dir: string;
  onRun: (program: string, args: readonly string[]) => void;
  onStop: (id: string) => void;
}) {
  const [program, setProgram] = useState('npm');
  const [args, setArgs] = useState('install');

  const parts = args.split(/\s+/).filter((a) => a !== '');
  const ready = program.trim() !== '' && dir.trim() !== '';

  return (
    <div className="v-cmds">
      <div className="v-cmds__form">
        <label className="v-cmds__label" htmlFor="cmdprog">
          program
        </label>
        <input
          id="cmdprog"
          className="v-cmds__prog"
          value={program}
          onChange={(e) => setProgram(e.target.value)}
        />
        <label className="v-cmds__label" htmlFor="cmdargs">
          arguments
        </label>
        <input
          id="cmdargs"
          className="v-cmds__args"
          value={args}
          onChange={(e) => setArgs(e.target.value)}
        />
        <Button
          level="primary"
          disabled={!ready}
          onClick={() => {
            onRun(program.trim(), parts);
          }}
        >
          run
        </Button>
      </div>

      <p className="v-cmds__note">
        {dir.trim() === '' ? (
          <>Set a repository first — a command runs in one, and there is none.</>
        ) : (
          <>
            Runs in <code>{dir}</code>. <strong>There is no shell</strong>: arguments are split
            on spaces and passed straight to the program, so pipes, <code>&amp;&amp;</code>,
            redirection and globs are literal text rather than syntax. Run one program at a
            time.
          </>
        )}
      </p>

      {commands.refused !== null && (
        <div className="v-cmds__refused">
          <StateKicker tone="alarm">refused</StateKicker>
          <span>{commands.refused}</span>
        </div>
      )}

      {commands.all.length === 0 ? (
        <div className="v-cmds__empty">
          <StateKicker tone="quiet">nothing run yet</StateKicker>
          <p>
            Anything started here keeps running while you work, and stops when the app does. The
            pilot can propose a command; it cannot run one.
          </p>
        </div>
      ) : (
        // Newest first: a session accumulates these, and the one just started is
        // the one being looked at.
        [...commands.all]
          .reverse()
          .map((command) => (
            <CommandCard key={command.id} command={command} onStop={onStop} />
          ))
      )}
    </div>
  );
}
