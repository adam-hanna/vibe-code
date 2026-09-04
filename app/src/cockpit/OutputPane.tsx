import { useEffect, useRef } from 'react';
import type { OutputLine } from './model';

/**
 * The narration, at the density the terminal prints it.
 *
 * The one right-pane tab that needs no data which does not exist: every line the
 * loop says arrives as a frame carrying the same sentence the CLI renders, so
 * this is that sentence and nothing else. Diff, Findings, Questions and Prompt
 * are each waiting on their own issue.
 *
 * **The id is shown beside the line, not instead of it.** A host acts on the id
 * and a human reads the sentence; the whole seam is additive and this is the one
 * place both halves are visible at once, which makes it the place a wrong id
 * gets noticed.
 */
export function OutputPane({ lines }: { lines: readonly OutputLine[] }) {
  const end = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    // Only when the reader is already at the bottom. Yanking the view down while
    // somebody is reading back through a run is the reason log panes get muted.
    if (pinned.current) end.current?.scrollIntoView({ block: 'end' });
  }, [lines]);

  return (
    <div
      className="v-output"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      <ol className="v-output__lines">
        {lines.map((line) => (
          <li key={line.n} className={`v-output__line v-output__line--${line.level}`}>
            {line.id !== null && <span className="v-output__id">{line.id}</span>}
            <span className="v-output__msg">{line.message}</span>
          </li>
        ))}
      </ol>
      {lines.length === 0 && <div className="v-output__empty">the run has not said anything yet</div>}
      <div ref={end} />
    </div>
  );
}
