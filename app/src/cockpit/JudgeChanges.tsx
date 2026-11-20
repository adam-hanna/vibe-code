import { Markdown } from '../design/Markdown';
import { Badge } from '@/ui/badge';
import { cn } from '@/lib/utils';
import { disagreedFiles, needsLook, readReport, reviewReportName, seated } from './artifacts';
import { LABEL } from './pane';
import { shownRound } from './rounds';
import { useArtifact } from './useArtifacts';
import type { JudgedFile } from './artifacts';

/**
 * A review round's changes to the run's own judge - test files and
 * `vibe.config.json` - with what was said about each (#112, #404, #460).
 *
 * **A report, never a control.** A verdict does not block a run (#112), so
 * nothing here is a gate, a button or a prompt. What it is for is the case
 * #112 exists to surface: a file the round did not call justified, which the
 * terminal warns about at the end of a run and a run started from the window
 * never showed anywhere.
 *
 * **Read as stored.** Every verdict is the report's own `testChanges`, through
 * `readReport` - the reader the Review pane uses, so the pane, the round card
 * and the rail read one record one way. The combined verdict is never worked
 * out from the seats': the core keeps the stored one when a seat's entry was
 * dropped, and the window has to agree with it.
 *
 * **A round with no judge changes draws nothing**, not an empty section.
 */

const CAPTION = cn(LABEL, 'm-0 font-bold');
const LIST = 'm-0 flex list-none flex-col gap-2 p-0 text-body-sm text-secondary';
const REASON = 'text-body-sm text-secondary';

/** The combined verdict in words; an unreadable one says so rather than passing as fine. */
function verdictWords(v: string | null): string {
  return v ?? 'verdict unreadable';
}

/** `<seat> <provider>/<model>`, the naming the terminal's warning and `foundBy` use. */
function seatName(s: JudgedFile['seats'][number]): string {
  return `${s.seat} ${s.provider}/${s.model}`;
}

/** *"The seats disagreed on 1 of 3 files."* Only for a round that seated finders. */
export function disagreementLine(files: readonly JudgedFile[]): string | null {
  if (!seated(files)) return null;
  const n = disagreedFiles(files).length;
  return `The seats disagreed on ${String(n)} of ${String(files.length)} ${files.length === 1 ? 'file' : 'files'}.`;
}

/**
 * Every judge file of one round: path, combined verdict, its reason, and with
 * finders seated, who said what. Nothing for a round that touched none.
 */
export function JudgeChanges({ files, className }: { files: readonly JudgedFile[]; className?: string | undefined }) {
  if (files.length === 0) return null;
  const split = disagreementLine(files);
  return (
    <section className={cn('flex flex-col gap-2', className)} aria-label="changes to the tests">
      <h5 className={CAPTION}>Changes to the run’s own tests and config</h5>
      {split !== null && <p className="m-0 text-body-sm text-secondary">{split}</p>}
      <ul className={LIST}>
        {files.map((f) => (
          <li key={f.path} className="flex flex-col gap-1">
            <span className="flex flex-wrap items-baseline gap-2">
              <code className="font-mono text-mono-sm text-primary [overflow-wrap:anywhere]">{f.path}</code>
              <Badge variant={needsLook(f) ? 'alarm' : 'quiet'}>{verdictWords(f.verdict)}</Badge>
            </span>
            {f.reason !== null && <Markdown text={f.reason} className={REASON} />}
            {f.seats.length > 0 && (
              <ul className={cn(LIST, 'gap-1 border-l border-rule-inner pl-3')}>
                {f.seats.map((s) => (
                  <li key={s.seat} className="flex flex-col gap-0.5">
                    <span className="flex flex-wrap items-baseline gap-2">
                      <span className="text-primary">{seatName(s)}</span>
                      <Badge variant={s.verdict === 'justified' ? 'quiet' : 'alarm'}>{s.verdict}</Badge>
                    </span>
                    {s.reason !== null && <Markdown text={s.reason} className={REASON} />}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The files a person should look at, one line each, for a surface too narrow
 * for reasons: the run path's Code review stage. Nothing when every file was
 * justified - the rail is for what is wrong, and the round card has the rest.
 */
export function JudgeFlags({ round, files }: { round: number; files: readonly JudgedFile[] }) {
  const flagged = files.filter(needsLook);
  if (flagged.length === 0) return null;
  // Counted from one, as the round chip and the terminal's heading count it (#428).
  const shown = shownRound(round);
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label={`review round ${String(shown)} test changes`}>
      {flagged.map((f) => (
        <li key={f.path} className="flex min-w-0 flex-wrap items-baseline gap-2 text-body-sm">
          <span className="flex-none text-tertiary">Round {shown} test change</span>
          <Badge variant="alarm">{verdictWords(f.verdict)}</Badge>
          <code className="min-w-0 truncate font-mono text-mono-sm text-secondary" title={f.path}>
            {f.path}
          </code>
        </li>
      ))}
    </ul>
  );
}

/** Where a run's artifacts are read from, for a surface that is not a pane. */
export interface JudgeSource {
  dir: string;
  runId: string | null;
  /** The panes' re-read count: a report written while this is on screen is read. */
  revision: number;
}

/**
 * One review round's judge files, from `code-review-<round>.json`, or empty.
 *
 * Empty for a round whose report is not written yet, cannot be read, or holds
 * no `testChanges` - on a card and in the rail every one of those draws
 * nothing. The Review pane is where a read failure is said.
 */
export function useJudgeChanges(source: JudgeSource | null, round: number | null): readonly JudgedFile[] {
  const name = source === null || round === null ? null : reviewReportName(round);
  const { read } = useArtifact(source?.dir ?? '', source?.runId ?? null, name, source?.revision ?? 0);
  if (read?.kind !== 'text') return [];
  return readReport(read.text)?.testChanges ?? [];
}

/** A review round's section on its card: every file, read from the round's report. */
export function RoundJudgeChanges({
  source,
  round,
  className,
}: {
  source: JudgeSource;
  round: number;
  className?: string | undefined;
}) {
  const files = useJudgeChanges(source, round);
  return <JudgeChanges files={files} className={className} />;
}

/** A review round's flagged files in the rail, read from the round's report. */
export function RoundJudgeFlags({ source, round }: { source: JudgeSource; round: number }) {
  const files = useJudgeChanges(source, round);
  return <JudgeFlags round={round} files={files} />;
}
