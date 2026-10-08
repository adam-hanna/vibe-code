import { Ellipsis, Pause, Play, Square } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { boundary, buildStamp, ending, tokens as fmtTokens } from '../cockpit/format';
import type { Build } from '../host';
import type { Run, Staleness } from '../cockpit/model';
import { StalenessNote } from '../cockpit/Staleness';
import { cn } from '@/lib/utils';

/**
 * The bar along the bottom: the window's standing facts, and the one control
 * a held run needs.
 *
 * What it carries from the old titlebar and footer, and the rule each keeps:
 *
 * - **Connection**, as a dot and a word. The host pid is not here: a
 *   diagnostic belongs in the chrome only while it is wrong (#204), so the pid
 *   lives in the popover and the bar shows only a **protocol alarm** when the
 *   window and the core disagree - naming the disagreement, never the value.
 * - **The run's state**, in one phrase: holding at a gate, a turn in flight,
 *   or how it ended. Continue, pause and stop sit beside it only while the run
 *   column's footer is not showing them (#264): the column collapsed, or
 *   showing a past run you opened. Two sets stacked was the bug. The full gate card, with the questions
 *   and the reason field, stays in the loop column; this is the summary.
 * - **Spend**, absent rather than `0 tok` before anything is charged - a run
 *   that has spent nothing has not spent zero, it has not been measured.
 * - **The build stamp**, because two builds of one version are otherwise
 *   identical (#201).
 *
 * Every phrase for an ending comes from `format.ts`'s closed map; a code this
 * build does not know shows as the number.
 */
export function StatusBar({
  outside,
  connected,
  failure,
  project,
  protocol,
  expected,
  run,
  busy,
  onDecide,
  onPause,
  onStop,
  pausing,
  stopping,
  controls,
  staleness,
  onSpend,
  build,
  diagnosticsOpen,
  onDiagnostics,
  diagnostics,
}: {
  /** A browser preview, with no host at all. */
  outside: boolean;
  connected: boolean;
  failure: string | null;
  /** The project on screen, or null. */
  project: string | null;
  protocol: number | null;
  expected: number;
  run: Run;
  busy: boolean;
  onDecide: (askId: number, decision: { kind: 'continue' } | { kind: 'stop'; reason: string }) => void;
  onPause: () => void;
  onStop: () => void;
  pausing: boolean;
  /** A stop was asked for and the core has not answered yet (#253). */
  stopping: boolean;
  /**
   * Draw continue, pause and stop, or only the state word (#264). False while
   * the run column's footer is showing them for the same run, so the window
   * never draws two sets one above the other. `statusBarControls` decides.
   */
  controls: boolean;
  /**
   * How quiet the live turn is (`7c`). Its `thinking` and `cannot tell` states
   * are drawn here rather than as a strip above the columns, which pushed the
   * whole window down each time the turn went quiet (#267).
   */
  staleness: Staleness;
  onSpend: () => void;
  build: Build | null;
  diagnosticsOpen: boolean;
  onDiagnostics: (open: boolean) => void;
  /** The popover's body. */
  diagnostics: ReactNode;
}) {
  const live = run.running !== null || run.preflight !== null;
  const how = run.completed === null ? null : ending(run.completed.exit);

  return (
    <footer
      className="flex h-6 shrink-0 items-center gap-3 border-t border-rule-structure bg-chrome px-2 text-label text-secondary"
      aria-label="Status"
    >
      <span className="flex items-center gap-1.5" title={outside ? 'No host in a browser' : connected ? 'The host is up' : 'Waiting for the host'}>
        <span
          className={cn(
            'size-1.5 rounded-full',
            outside ? 'bg-rule-strong' : connected ? 'bg-live' : 'bg-tertiary',
          )}
          aria-hidden
        />
        {outside ? 'browser preview' : connected ? 'connected' : 'connecting'}
      </span>

      {failure !== null && <Badge variant="alarm">no host · {failure}</Badge>}

      {!outside && protocol !== null && protocol !== expected && (
        <Badge variant="alarm">
          protocol {protocol} · expected {expected}
        </Badge>
      )}

      {project !== null && <span className="truncate text-tertiary">{project}</span>}

      {/* Before the spacer, so it takes the spacer's room as it comes and goes
          and nothing to its right moves (#267). */}
      <StalenessNote state={staleness} />

      <span className="flex-1" />

      {run.gate !== null ? (
        <span className="flex items-center gap-1.5">
          <Badge variant="accent">holding</Badge>
          <span>at {boundary(run.gate.boundary)}</span>
          {controls && (
          <>
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() => {
              if (run.gate !== null) onDecide(run.gate.askId, { kind: 'continue' });
            }}
          >
            <Play className="size-3" aria-hidden /> continue
          </Button>
          <Button
            size="sm"
            disabled={busy}
            onClick={() => {
              if (run.gate !== null) onDecide(run.gate.askId, { kind: 'stop', reason: '' });
            }}
          >
            <Square className="size-3" aria-hidden /> stop
          </Button>
          </>
          )}
        </span>
      ) : run.completed !== null ? (
        <span className="flex items-center gap-1.5">
          <Badge variant={how?.tone === 'alarm' ? 'alarm' : 'quiet'}>{how?.kicker ?? `exit ${run.completed.exit}`}</Badge>
        </span>
      ) : live ? (
        <span className="flex items-center gap-1.5">
          <Badge variant="live">{run.running === null ? 'preflight' : stopping ? 'stopping' : 'live'}</Badge>
          {controls && (
          <>
          <Button
            size="sm"
            variant="quiet"
            disabled={busy || pausing || stopping}
            onClick={onPause}
            title={pausing ? 'The run will wait after the current step.' : 'Let the current step finish, then wait before the next one. Nothing is lost.'}
          >
            <Pause className="size-3" aria-hidden /> {pausing ? 'pausing after this step' : 'pause'}
          </Button>
          {/* One name for one action (#253): the footer and the confirmation say `Stop run` too. */}
          <Button
            size="sm"
            variant="quiet"
            disabled={busy || stopping}
            onClick={onStop}
            title="Stop the run now. The current turn is cancelled, and you can resume the run later."
          >
            <Square className="size-3" aria-hidden /> {stopping ? 'stopping…' : 'stop run'}
          </Button>
          </>
          )}
        </span>
      ) : null}

      <button
        type="button"
        className="cursor-pointer rounded-sm border border-transparent bg-transparent px-1 text-secondary hover:text-emphasis"
        onClick={onSpend}
        title="Usage for the live run"
      >
        {run.spend.tokens === null ? 'no usage reported' : `${fmtTokens(run.spend.tokens)} tok`}
      </button>

      {build !== null && <span className="font-mono text-mono-sm text-tertiary">{buildStamp(build)}</span>}

      {!outside && (
        <Popover open={diagnosticsOpen} onOpenChange={onDiagnostics}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex size-5 cursor-pointer items-center justify-center rounded-sm border border-transparent bg-transparent text-secondary hover:text-emphasis"
              aria-label="Diagnostics"
              title="Diagnostics"
            >
              <Ellipsis className="size-4" aria-hidden />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" side="top" className="w-96">
            {diagnostics}
          </PopoverContent>
        </Popover>
      )}
    </footer>
  );
}
