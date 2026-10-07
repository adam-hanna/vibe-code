import { useEffect, useMemo, useRef, useState } from 'react';
import { LivenessDot } from '../design';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { cn } from '@/lib/utils';
import { elapsed } from './format';
import { groups, readTranscript } from './outgroups';
import { noText, useArtifact } from './useArtifacts';
import type { OutGroup } from './outgroups';
import type { OutputLine, Staleness, Turn } from './model';

/**
 * The file a finished run's narration is in.
 *
 * Named here rather than composed from the run id: it is a fixed name in the
 * run's own directory, written by `log.record`, and `isArtifactBasename` lets it
 * through like any other file the run wrote.
 */
const TRANSCRIPT = 'transcript.log';

/**
 * The id the core puts on the agent's own prose (#223).
 *
 * Matched on the **id** and never on the text, which is the whole seam: a line
 * the model wrote and a line the loop wrote are different kinds of claim, and
 * the only thing that can tell them apart without reading English is what the
 * narration called itself.
 */
const SAID = 'model_said';

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

/**
 * The colour a line's message takes, by the level the loop stamped on it. The
 * loop's own steps and headings read at emphasis, an `ok` in the live green, a
 * warning or an error at primary weight, and detail at the floor.
 */
const LEVEL: Readonly<Record<string, string>> = {
  heading: 'text-emphasis',
  step: 'text-emphasis',
  ok: 'text-live',
  warn: 'text-primary',
  error: 'text-primary',
  detail: 'text-tertiary',
};

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
    <div className="flex flex-none flex-wrap items-center gap-3 border-b border-rule-structure bg-column px-6 py-3">
      <span className="text-body-sm text-emphasis">
        {turn.role} · {turn.kind}
      </span>
      {turn.round !== null && <Badge className="font-mono normal-case tracking-normal">round {turn.round}</Badge>}
      {/* Not the config's role table. See above. */}
      <Badge className="normal-case tracking-normal">model, effort and permission mode — no turn frame carries them</Badge>
      {/* The design's `working · last activity 8s ago`, drawn from `7c`'s two
          clocks rather than from one. `outputMs` is how long the CHILD has been
          silent, which is the half a person is actually asking about; a beat
          fires on a timer whether or not the child said anything, so its
          arrival proves vibe is alive and proves nothing about the turn.
          Absent, with the reason, when the child has written nothing at all —
          which is a different fact from zero. Pushed right, and tabular because
          it re-renders every second. */}
      <span className="ml-auto flex items-center gap-2 font-mono text-mono-sm tabular-nums text-tertiary">
        <LivenessDot state={staleness.state === 'live' ? 'live' : 'quiet'} />
        {staleness.outputMs === null
          ? 'nothing written yet this turn'
          : `last output ${elapsed(staleness.outputMs)} ago`}
      </span>
    </div>
  );
}

/**
 * One round's lines, under a heading that opens and shuts.
 *
 * `flex-none`, for the reason the disclosure section has it: this is a flex item
 * inside a scrolling column, and a clipped overflow would otherwise resolve its
 * automatic minimum size to zero and let it clip instead of the pane scrolling.
 */
function Group({
  group,
  open,
  onToggle,
  last,
}: {
  group: OutGroup;
  open: boolean;
  onToggle: () => void;
  /** The newest group, which is the one a live run is writing into. */
  last: boolean;
}) {
  return (
    <section className="flex-none overflow-hidden border-b border-rule-inner">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent py-2 text-left text-inherit outline-none hover:bg-active-hdr focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="w-[1.2ch] flex-none text-label text-tertiary" aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className="text-body-sm font-semibold text-emphasis">{group.title}</span>
        <span className="ml-auto text-body-sm text-tertiary">
          {group.lines.length} line{group.lines.length === 1 ? '' : 's'}
        </span>
        {/* A shut group that holds a warning says so, because the reason to
            collapse a run is to find the part that went wrong in it. */}
        {group.alarming && !open && <Badge variant="alarm">warnings</Badge>}
        {last && <Badge>latest</Badge>}
      </button>
      {open && (
        <ol className="m-0 list-none p-0">
          {group.lines.map((line) => (
            <li
              key={line.n}
              className={cn(
                'py-1 font-mono text-mono-sm leading-relaxed text-secondary',
                line.id === SAID
                  // **The model's own words are drawn as the model's.** A line the
                  // agent wrote and a line the loop wrote are two different kinds
                  // of claim, and running them together at one weight is how a
                  // reader comes to believe vibe said something the model did. A
                  // rule down the left and the paragraph shape kept, because this
                  // is the one thing in the pane that is a quotation. The rule is
                  // set on `id`, never on the sentence.
                  ? 'my-2 block whitespace-pre-wrap border-l-2 border-rule-inner pl-3 text-primary [overflow-wrap:anywhere]'
                  : 'flex gap-3 whitespace-pre-wrap [overflow-wrap:anywhere]',
              )}
            >
              {/* The id beside the sentence, never instead of it. The seam is additive. */}
              {line.id !== null && line.id !== SAID && (
                <span className="min-w-29 flex-none text-tertiary">{line.id}</span>
              )}
              <span className={cn('min-w-0 flex-1', line.id === SAID ? undefined : LEVEL[line.level])}>
                {line.message}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function OutputPane({
  lines,
  turn,
  staleness,
  transcript,
}: {
  lines: readonly OutputLine[];
  /** The turn that is open, or null between turns. Never inferred from a line. */
  turn: Turn | null;
  /** `7c`'s two clocks, already computed once for the whole window. */
  staleness: Staleness;
  /**
   * A past run to read from disk instead, or null for the live one (#223).
   *
   * **A run this window did not narrate has no lines on the wire**, and the
   * frames that would have produced them were sent to a process that has since
   * exited. Its narration is in `transcript.log` in its own directory, which is
   * a file like any other — so opening a finished run shows what it said rather
   * than an empty pane, which is what *"EVERYTHING should repopulate"* asked for.
   */
  transcript?: { dir: string; runId: string } | null;
}) {
  const end = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  /** Groups the reader has shut. Open is the default, so a new one is visible. */
  const [closed, setClosed] = useState<ReadonlySet<number>>(() => new Set());

  const past = transcript ?? null;
  const { read, failure, loading } = useArtifact(
    past?.dir ?? '',
    past?.runId ?? null,
    past === null ? null : TRANSCRIPT,
  );
  const missing = past === null ? null : noText(read, failure);

  const source = useMemo(
    () => (past === null ? lines : read?.kind === 'text' ? readTranscript(read.text) : []),
    [past, lines, read],
  );
  const shown = useMemo(() => groups(source), [source]);

  useEffect(() => {
    // Only when the reader is already at the bottom. Yanking the view down while
    // somebody is reading back through a run is the reason log panes get muted.
    if (pinned.current) end.current?.scrollIntoView({ block: 'end' });
  }, [source.length]);

  // Who is running, from the last line that carried a role. Told rather than
  // inferred, and absent rather than guessed between turns.
  const role = [...source].reverse().find((l) => l.role !== null)?.role ?? null;
  const newest = shown[shown.length - 1]?.key ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Hi-fi 1 puts a turn strip above this pane. Absent between turns rather
          than showing the last role that ran, which is what `1c` means by
          *never inferred*. */}
      {turn !== null && <TurnStrip turn={turn} staleness={staleness} />}

      <div className="flex flex-none items-center gap-3 border-b border-rule-inner bg-chrome px-6 py-2 text-body-sm text-tertiary">
        <span>
          {source.length} line{source.length === 1 ? '' : 's'} in {shown.length} group
          {shown.length === 1 ? '' : 's'}
        </span>
        {/* Never inferred. A stretch with no turn open says so rather than
            naming the role that most recently ran under a different one. */}
        {role !== null && <Badge>{role} was running</Badge>}
        <Button variant="quiet" size="sm" onClick={() => setClosed(new Set())}>
          open all
        </Button>
        <Button
          variant="quiet"
          size="sm"
          onClick={() => setClosed(new Set(shown.map((g) => g.key)))}
        >
          collapse all
        </Button>
      </div>

      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-page px-6 py-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {shown.map((group) => (
          <Group
            key={group.key}
            group={group}
            open={!closed.has(group.key)}
            last={group.key === newest}
            onToggle={() =>
              setClosed((cur) => {
                const next = new Set(cur);
                if (!next.delete(group.key)) next.add(group.key);
                return next;
              })
            }
          />
        ))}
        {source.length === 0 && (
          <div className="p-3 text-body-sm text-tertiary">
            {past === null
              ? 'the run has not said anything yet'
              : missing !== null
                ? missing
                : loading
                  ? 'reading this run’s transcript…'
                  : 'this run’s transcript is empty'}
          </div>
        )}
        <div ref={end} />
      </div>

      {/* Named rather than left implied, the way the launching row names its
          missing ETA. Hi-fi 1 draws a tool timeline here and the data for one
          is on 34 of 265 recorded turns, so what would be drawn is 13% of a
          pane presented as all of it. A footnote tier: it is a statement about
          the pane rather than anything in it, so it takes the floor colour and
          sits under the scroll rather than in it. */}
      <div className="flex-none border-t border-rule-inner px-6 py-2 text-body-sm text-tertiary">
        These are the loop&apos;s own lines. What the agent <em>did</em> — each read, each edit
        and its size — is not here: the core records tool items on a minority of turns, and
        reconstructing a timeline by reading these sentences is the one thing this pane must
        never do.
      </div>
    </div>
  );
}
