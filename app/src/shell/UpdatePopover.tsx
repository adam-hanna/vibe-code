import { CircleArrowUp } from 'lucide-react';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tool } from './ActivityBar';
import { excerpt, progress } from './update';
import type { UpdateInfo, UpdateProgress } from './update';

/** Where an install is: nothing yet, under way as measured, or refused. */
export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'working'; progress: UpdateProgress | null }
  | { kind: 'failed'; message: string };

/**
 * The ⬆ tool and what it opens (#299).
 *
 * Drawn only while a newer, unskipped version exists, so the tool itself is the
 * notice; there is no banner and no toast. A popover rather than a dialog: it
 * guards nothing until Update & restart is pressed, and with runs going that
 * press is what opens the confirmation that does.
 *
 * Everything on it is something Rust said. The notes are the manifest's own,
 * cut to their first lines - nothing is fetched to show them - and the bar is
 * drawn only when the download sent a length to divide by.
 */
export function UpdatePopover({
  info,
  state,
  onInstall,
  onPage,
  onSkip,
}: {
  info: UpdateInfo;
  state: UpdateState;
  onInstall: () => void;
  onPage: () => void;
  onSkip: () => void;
}) {
  const notes = excerpt(info.notes);
  const working = state.kind === 'working';
  const measured = working && state.progress !== null ? progress(state.progress) : null;
  const date = info.date === null ? null : info.date.slice(0, 10);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Tool label={`Update available: ${info.version}`} className="text-accent">
          <CircleArrowUp className="size-5" aria-hidden />
        </Tool>
      </PopoverTrigger>
      <PopoverContent side="right" align="end" className="w-96">
        <div className="mb-2 flex items-baseline gap-2">
          <span className="text-label uppercase tracking-label text-tertiary">update available</span>
        </div>
        <div className="mb-3 flex items-baseline gap-2">
          <span className="text-title font-semibold tracking-tight text-display">Vibe {info.version}</span>
          {date !== null && <span className="font-mono text-mono-sm text-tertiary">{date}</span>}
        </div>

        {notes.text !== '' && (
          <pre className="m-0 mb-2 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-sm border border-rule-inner bg-panel p-2 font-mono text-mono-sm text-secondary">
            {notes.text}
            {notes.cut ? '\n…' : ''}
          </pre>
        )}
        <button
          type="button"
          onClick={onPage}
          className="mb-3 cursor-pointer border-none bg-transparent p-0 text-body-sm text-accent-on-tint underline-offset-2 hover:underline"
        >
          Release notes and downloads
        </button>

        {working && (
          <div className="mb-3 text-body-sm text-secondary" role="status">
            {measured === null ? 'Starting the download…' : measured.text}
            {measured !== null && measured.ratio !== null && (
              <span
                className="mt-1.5 block h-1 w-full border border-rule-inner bg-page"
                role="img"
                aria-label={`${Math.round(measured.ratio * 100)}% downloaded`}
              >
                <span className="block h-full bg-accent-base" style={{ width: `${measured.ratio * 100}%` }} />
              </span>
            )}
          </div>
        )}

        {state.kind === 'failed' && (
          <p className="mt-0 mb-3 rounded-sm bg-alarm px-3 py-2 text-body-sm text-primary [overflow-wrap:anywhere]" role="alert">
            {state.message}
          </p>
        )}

        {info.action === 'download' && (
          <p className="mt-0 mb-3 text-body-sm text-tertiary">
            This install updates by downloading the new version from the release page.
          </p>
        )}

        <div className="flex items-center justify-between gap-3">
          <Button variant="quiet" size="sm" onClick={onSkip} disabled={working}>
            Skip this version
          </Button>
          {info.action === 'install' ? (
            <Button variant="primary" onClick={onInstall} disabled={working}>
              {state.kind === 'failed' ? 'Try again' : 'Update & restart'}
            </Button>
          ) : (
            <Button variant="primary" onClick={onPage}>
              Download
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
