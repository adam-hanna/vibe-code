import { useEffect, useMemo, useState } from 'react';
import * as host from '../host';
import type { ArchiveRun } from '../host';
import { Badge } from '../ui/badge';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '../ui/command';
import { chordLabel } from './actions';
import type { Action, ActionId } from './actions';

/**
 * ⌘K: every action, and every run (`5f`, widened).
 *
 * The switcher it replaces answered one question - *take me to a run* - and
 * read the archive once, when it opened. Both survive here as the **Runs**
 * group. What is added is the action table, so anything a button does can be
 * typed for.
 *
 * **Picking a run OPENS it; it does not start one.** The switcher resumed on
 * pick, which predates the sidebar's rule and contradicts it: a resume probes
 * both CLIs, takes the lock and spends, and a palette pick is a read like a
 * sidebar click. Starting a run stays in `1b` and the pilot.
 *
 * The run list is substring-matched on the id and the task and nothing
 * cleverer, through `cmdk`'s own filter with a value that is both - a fuzzy
 * reorder would make the same keystrokes pick a different run on a different
 * day. Runs needing a human sort first (`4e`).
 */
function openable(run: ArchiveRun): boolean {
  return run.linked !== true && run.unverified !== true && run.status !== 'unreadable';
}

export function Palette({
  open,
  onOpenChange,
  actions,
  onAction,
  dir,
  onOpenRun,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Already filtered to what makes sense now. */
  actions: readonly Action[];
  onAction: (id: ActionId) => void;
  /** The repository whose archive is listed. */
  dir: string;
  onOpenRun: (runId: string, task: string) => void;
}) {
  const [runs, setRuns] = useState<readonly ArchiveRun[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRuns(null);
    setFailure(null);
    if (!host.inShell()) {
      setFailure('there is no host in a browser, so there is no archive to read');
      return;
    }
    if (dir.trim() === '') {
      setFailure('no project is open');
      return;
    }
    let cancelled = false;
    void host
      .archive(dir)
      .then((got) => {
        if (!cancelled) setRuns(got);
      })
      .catch((err: unknown) => {
        if (!cancelled) setFailure(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, dir]);

  const sorted = useMemo(() => {
    const wants = (r: ArchiveRun): number => (r.status === 'needs-input' ? 0 : 1);
    return [...(runs ?? [])].sort((a, b) => wants(a) - wants(b));
  }, [runs]);

  const groups = useMemo(() => {
    const out = new Map<string, Action[]>();
    for (const a of actions) out.set(a.group, [...(out.get(a.group) ?? []), a]);
    return [...out.entries()];
  }, [actions]);

  const platform = typeof navigator === 'undefined' ? '' : navigator.platform;

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Command palette">
      <CommandInput placeholder="Type an action, or a run…" autoFocus />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        {groups.map(([group, list]) => (
          <CommandGroup key={group} heading={group}>
            {list.map((a) => (
              <CommandItem
                key={a.id}
                value={`${a.group} ${a.label}`}
                onSelect={() => {
                  onOpenChange(false);
                  onAction(a.id);
                }}
              >
                {a.label}
                {a.shortcut !== undefined && <CommandShortcut>{chordLabel(a.shortcut, platform)}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
        <CommandSeparator />
        <CommandGroup heading="Runs">
          {failure !== null && <p className="px-2 py-1.5 text-body-sm text-tertiary">{failure}</p>}
          {failure === null && runs === null && <p className="px-2 py-1.5 text-body-sm text-tertiary">reading the archive…</p>}
          {runs !== null && runs.length === 0 && (
            <p className="px-2 py-1.5 text-body-sm text-tertiary">no runs in this repository yet</p>
          )}
          {sorted.map((run) => (
            <CommandItem
              key={run.id}
              value={`${run.id} ${run.task}`}
              disabled={!openable(run)}
              onSelect={() => {
                onOpenChange(false);
                onOpenRun(run.id, run.task);
              }}
            >
              <code className="shrink-0 font-mono text-mono-sm text-tertiary">{run.id}</code>
              <span className="truncate">{run.task}</span>
              {/* One collapsed verdict chip, never four: here it is a status. */}
              <span className="ml-auto shrink-0">
                {run.linked === true ? (
                  <Badge variant="alarm">a link</Badge>
                ) : run.unverified === true ? (
                  <Badge variant="alarm">unclassified</Badge>
                ) : (
                  <Badge>{run.status}</Badge>
                )}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
