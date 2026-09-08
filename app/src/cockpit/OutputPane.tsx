import { useEffect, useMemo, useRef, useState } from 'react';
import { MetaChip } from '../design';
import type { OutputLine } from './model';

/**
 * The narration, filtered by phase (`1c`, #223).
 *
 * `1c` asks for output **filtered by phase, not one endless stream**, with the
 * raw log one click away, and a header that *"states who is running with which
 * settings, never inferred"*. Both halves of that are the same rule: the phase a
 * line belongs to is the one the loop had announced when the line arrived, and
 * the role is the one `turn_started` named. Nothing here reads a sentence to
 * work either out - that is the English-matching #133 exists to prevent, and it
 * would file a line under whatever word it happened to contain.
 *
 * **The raw log is the default.** A filter that is on when you arrive hides
 * lines you did not ask it to hide, and this pane's job during the ninety
 * minutes nothing happens is to be trustworthy rather than tidy.
 *
 * **The id is shown beside the line, not instead of it.** A host acts on the id
 * and a human reads the sentence; the whole seam is additive and this is the one
 * place both halves are visible at once, which makes it the place a wrong id
 * gets noticed.
 */

/** Lines that belong to no phase at all - preflight, the run announcement. */
const NO_PHASE = 'before the first phase';

export function OutputPane({ lines }: { lines: readonly OutputLine[] }) {
  const end = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [only, setOnly] = useState<string | null>(null);

  // The phases seen, in the order they arrived. Not a fixed list: a phase this
  // build has no name for still gets a filter, because the lines are there.
  const phases = useMemo(() => {
    const seen: string[] = [];
    for (const line of lines) {
      const key = line.phase ?? NO_PHASE;
      if (!seen.includes(key)) seen.push(key);
    }
    return seen;
  }, [lines]);

  const shown = only === null ? lines : lines.filter((l) => (l.phase ?? NO_PHASE) === only);

  useEffect(() => {
    // Only when the reader is already at the bottom. Yanking the view down while
    // somebody is reading back through a run is the reason log panes get muted.
    if (pinned.current) end.current?.scrollIntoView({ block: 'end' });
  }, [shown.length]);

  // Who is running, from the last line that carried a role. Told rather than
  // inferred, and absent rather than guessed between turns.
  const role = [...shown].reverse().find((l) => l.role !== null)?.role ?? null;

  return (
    <div className="v-outwrap">
      {phases.length > 1 && (
        <div className="v-output__filters">
          <button
            className={`v-output__filter ${only === null ? 'is-on' : ''}`}
            onClick={() => setOnly(null)}
          >
            everything
          </button>
          {phases.map((p) => (
            <button
              key={p}
              className={`v-output__filter ${only === p ? 'is-on' : ''}`}
              onClick={() => setOnly((cur) => (cur === p ? null : p))}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {only !== null && (
        <div className="v-output__head">
          <span>
            {shown.length} of {lines.length} lines
          </span>
          {/* Never inferred. A phase with no turn open says so rather than
              naming the role that most recently ran under a different one. */}
          {role === null ? (
            <MetaChip>no turn open</MetaChip>
          ) : (
            <MetaChip>{role} was running</MetaChip>
          )}
        </div>
      )}

      <div
        className="v-output"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        <ol className="v-output__lines">
          {shown.map((line) => (
            <li key={line.n} className={`v-output__line v-output__line--${line.level}`}>
              {line.id !== null && <span className="v-output__id">{line.id}</span>}
              <span className="v-output__msg">{line.message}</span>
            </li>
          ))}
        </ol>
        {lines.length === 0 && (
          <div className="v-output__empty">the run has not said anything yet</div>
        )}
        {lines.length > 0 && shown.length === 0 && (
          <div className="v-output__empty">nothing was said during {only}</div>
        )}
        <div ref={end} />
      </div>
    </div>
  );
}
