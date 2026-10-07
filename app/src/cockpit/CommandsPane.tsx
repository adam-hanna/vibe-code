import { useState } from 'react';
import { Square } from 'lucide-react';
import { LivenessDot } from '../design';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { clock, dayOf, elapsed } from './format';
import { line, outcome } from './commands';
import { BLOCK, FIELD, LABEL } from './pane';
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

const NOTE = 'm-0 text-body-sm text-secondary';

/**
 * One command. The live one takes the accent rule, which is the same signal a
 * running turn takes in the loop column - a process holding a port is the thing
 * on this screen most worth noticing.
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
    <div className={cn('flex flex-col gap-2 border-l-2 pl-3', how === null ? 'border-accent-border' : 'border-rule-card')}>
      <div className="flex flex-wrap items-center gap-2">
        {how === null && <LivenessDot state="live" />}
        <code className="font-mono text-mono-sm text-primary">{line(command)}</code>
        {how === null ? (
          <Badge variant="accent">running</Badge>
        ) : (
          <Badge variant={how === 'exit 0' ? 'live' : 'alarm'} className="normal-case tracking-normal">{how}</Badge>
        )}
        {how === null && (
          <Button variant="secondary" size="sm" onClick={() => onStop(command.id)}>
            <Square size={12} aria-hidden="true" /> stop
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-3 text-body-sm text-secondary">
        <span>{command.dir}</span>
        {/* What was actually spawned, when it is not what was typed. `npm`
            resolves to `node …/npm-cli.js` so that no shell is involved, and
            hiding that would make the card a description rather than a record. */}
        {command.resolved !== command.program && (
          <span className="font-mono text-mono-sm">ran {command.resolved}</span>
        )}
        <span>
          {/* An instant once it has stopped, a duration while it runs - the pair
              #202 settled. `last activity 6s ago` on a finished card ages into a
              lie; a start time does not. */}
          {command.endedAt === null
            ? `started ${clock(command.startedAt)}${command.restored ? `, ${dayOf(command.startedAt)}` : ''}`
            : `${elapsed(command.endedAt - command.startedAt)}, ended ${clock(command.endedAt)}${command.restored ? `, ${dayOf(command.endedAt)}` : ''}`}
        </span>
      </div>

      {command.output === '' ? (
        <div className={NOTE}>
          {how === null ? 'no output yet' : 'it wrote nothing'}
        </div>
      ) : (
        <pre className={cn(BLOCK, 'max-h-88 select-text')}>
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
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className={LABEL} htmlFor="cmdprog">
          program
        </label>
        <input
          id="cmdprog"
          className={cn(FIELD, 'w-32 font-mono text-mono-sm')}
          value={program}
          onChange={(e) => setProgram(e.target.value)}
        />
        <label className={LABEL} htmlFor="cmdargs">
          arguments
        </label>
        <input
          id="cmdargs"
          className={cn(FIELD, 'min-w-48 flex-1 font-mono text-mono-sm')}
          value={args}
          onChange={(e) => setArgs(e.target.value)}
        />
        <Button
          variant="primary"
          disabled={!ready}
          onClick={() => {
            onRun(program.trim(), parts);
          }}
        >
          run
        </Button>
      </div>

      <p className={NOTE}>
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
        <div className="flex flex-wrap items-baseline gap-2 rounded-sm bg-alarm px-3 py-2 text-body-sm text-emphasis">
          <Badge variant="alarm">refused</Badge>
          <span>{commands.refused}</span>
        </div>
      )}

      {commands.all.length === 0 ? (
        <div className="flex flex-col gap-2">
          <Badge className="self-start">nothing run yet</Badge>
          <p className={NOTE}>
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
