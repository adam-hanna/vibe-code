import { useEffect, useMemo, useRef, useState } from 'react';
import { LivenessDot, MetaChip } from '../design';
import { elapsed } from './format';
import type { OutputLine, Staleness, Turn } from './model';

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
 *
 * ## What hi-fi 1 draws here, and why half of it is not built
 *
 * `design/AUDIT.md` §1.4 is the one finding it left open rather than answering,
 * and this is the answer. The design's Output pane is a **timestamped record of
 * what the agent did** — `14:02:11 ▸ read src/appserver.ts (612 lines)`,
 * `14:03:04 ✎ edit src/appserver.ts +48 −6` — with a strip above it naming the
 * turn and a liveness line below it. Three parts; the app had the middle one and
 * neither end.
 *
 * **The two ends are built**, because both are measured: the strip is what
 * `turn_started` said and the liveness line is what the heartbeat measured.
 *
 * **The timeline is not, and it is not going to be derived from these lines.**
 * It needs a record per tool call with a timestamp and an edit size. `#66`'s
 * `toolItems` is the nearest thing the core keeps and the scorecard census found
 * it on **34 of 265 recorded turns**, so drawing this pane from the archive would
 * be drawing 13% of it and implying the rest was quiet. The one thing it must
 * never become is a timeline reconstructed by reading the narration text — that
 * is the English-matching #133 exists to prevent, and it would file `▸ read` and
 * `✎ edit` under whatever verb a sentence happened to contain. So the pane says
 * what it is not showing and names what would supply it, exactly as the
 * launching row does for its ETA.
 */

/** Lines that belong to no phase at all - preflight, the run announcement. */
const NO_PHASE = 'before the first phase';

/**
 * Hi-fi 1's turn strip, above the pane.
 *
 * `implement · claude/opus · medium · bypassPermissions · follow ✓` in the
 * design. Two of those five are on this wire and three are not: `turn_started`
 * carries the role, the kind and the round, and it carries no model, no effort
 * and no permission mode.
 *
 * They are **not** filled in from the config's role table, which is the obvious
 * place to get them. That table says what a run *will* do; this strip is about a
 * turn that is running, and a session rotation or a model alias resolving
 * elsewhere would leave the strip confidently describing a turn that is not the
 * one on screen. The absence is named instead, which is the same call the pilot's
 * reply card makes about the model that answered it.
 */
function TurnStrip({ turn, staleness }: { turn: Turn; staleness: Staleness }) {
  return (
    <div className="v-turnstrip">
      <span className="v-turnstrip__who">
        {turn.role} · {turn.kind}
      </span>
      {turn.round !== null && <MetaChip kind="checkable">round {turn.round}</MetaChip>}
      {/* Not the config's role table. See above. */}
      <MetaChip>model, effort and permission mode — no turn frame carries them</MetaChip>
      {/* The design's `working · last activity 8s ago`, drawn from `7c`'s two
          clocks rather than from one. `outputMs` is how long the CHILD has been
          silent, which is the half a person is actually asking about; a beat
          fires on a timer whether or not the child said anything, so its
          arrival proves vibe is alive and proves nothing about the turn.
          Absent, with the reason, when the child has written nothing at all —
          which is a different fact from zero. */}
      <span className="v-turnstrip__live">
        <LivenessDot state={staleness.state === 'live' ? 'live' : 'quiet'} />
        {staleness.outputMs === null
          ? 'nothing written yet this turn'
          : `last output ${elapsed(staleness.outputMs)} ago`}
      </span>
    </div>
  );
}

export function OutputPane({
  lines,
  turn,
  staleness,
}: {
  lines: readonly OutputLine[];
  /** The turn that is open, or null between turns. Never inferred from a line. */
  turn: Turn | null;
  /** `7c`'s two clocks, already computed once for the whole window. */
  staleness: Staleness;
}) {
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
      {/* Hi-fi 1 puts a turn strip above this pane. Absent between turns rather
          than showing the last role that ran, which is what `1c` means by
          *never inferred*. */}
      {turn !== null && <TurnStrip turn={turn} staleness={staleness} />}

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

      {/* Named rather than left implied, the way the launching row names its
          missing ETA. Hi-fi 1 draws a tool timeline here and the data for one
          is on 34 of 265 recorded turns, so what would be drawn is 13% of a
          pane presented as all of it. */}
      <div className="v-output__unbuilt">
        These are the loop&apos;s own lines. What the agent <em>did</em> — each read, each edit
        and its size — is not here: the core records tool items on a minority of turns, and
        reconstructing a timeline by reading these sentences is the one thing this pane must
        never do.
      </div>
    </div>
  );
}
