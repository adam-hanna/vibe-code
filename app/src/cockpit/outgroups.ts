import { title as phaseTitle } from './rounds';
import type { OutputLine } from './model';

/**
 * The output, cut into the rounds the loop announced (`1c`, #223).
 *
 * **The pane was one endless stream with a filter over it**, and a filter is a
 * different thing from a structure: it shows you one phase by hiding the rest,
 * so reading a run end to end means clicking through every phase in turn and
 * holding the order in your head. Reported as *"it should be grouped into Plan
 * N, Critique N, etc. These should be collapsible"*.
 *
 * ## The boundary is told, never read out of a sentence
 *
 * A group starts where `phase` **or** `round` changes, and both of those are
 * stamped on the line by `reduce` from `phase_started` — the id, not the prose.
 * Nothing here reads a message to decide where a round began, which is the
 * English-matching #133 exists to prevent and which would cut a group wherever a
 * sentence happened to contain the word *plan*.
 *
 * ## Consecutive, not gathered
 *
 * Groups are runs of adjacent lines, so a loop that re-enters `implementing`
 * after a review gets **two** code groups and they stay in the order they
 * happened. Gathering every `implementing` line under one heading would be the
 * merged-card mistake `rounds.ts` records: it reads as one long phase and hides
 * that the loop went round again.
 */

export interface OutGroup {
  /** Stable across renders: the `n` of the first line, which `reduce` never reuses. */
  key: number;
  /** `Plan 1`, `Critique 0`, `Code`. The loop's own vocabulary. */
  title: string;
  phase: string | null;
  round: number | null;
  lines: readonly OutputLine[];
  /** True when anything in the group was said at `warn` or `error`. */
  alarming: boolean;
}

/** Lines that belong to no phase at all — preflight, the run announcement. */
export const NO_PHASE = 'before the first phase';

/**
 * What a group is called.
 *
 * `title()` from `rounds.ts` rather than a second map, so a heading here and a
 * heading in the loop column cannot disagree about what `implementing` is
 * called. A phase this build has never heard of renders as its own name, which
 * is the rule that map already follows.
 */
export function groupTitle(phase: string | null, round: number | null): string {
  if (phase === null) return NO_PHASE;
  const name = phaseTitle(phase);
  return round === null ? name : `${name} ${String(round)}`;
}

export function groups(lines: readonly OutputLine[]): readonly OutGroup[] {
  const out: OutGroup[] = [];
  for (const line of lines) {
    const last = out[out.length - 1];
    const same = last !== undefined && last.phase === line.phase && last.round === line.round;
    if (same) {
      // Mutated in place rather than rebuilt: this runs over every line of a
      // long run on every render of the pane, and the array is one this
      // function owns and has not handed out yet.
      (last.lines as OutputLine[]).push(line);
      if (alarming(line)) last.alarming = true;
      continue;
    }
    out.push({
      key: line.n,
      title: groupTitle(line.phase, line.round),
      phase: line.phase,
      round: line.round,
      lines: [line],
      alarming: alarming(line),
    });
  }
  return out;
}

function alarming(line: OutputLine): boolean {
  return line.level === 'warn' || line.level === 'error';
}

/**
 * A past run's transcript, cut into the same groups.
 *
 * **`transcript.log` is prose and carries no ids**, which is the whole
 * difference between this and the live path. `log.record` writes `STEP  …`,
 * `INFO  …`, `WARN  …` with no phase and no round on the line, so the only
 * honest grouping is one group — and a pane that invented headings by looking
 * for the word *plan* in a sentence would be doing exactly what the live path is
 * built to avoid.
 *
 * So what is parsed is the **level**, which is a fixed prefix this repo writes
 * itself, and nothing else. A line whose prefix is not one of them keeps its
 * whole text and takes the neutral level: a continuation line of a stack trace
 * is still something a reader wants to see.
 */
const LEVELS: Readonly<Record<string, OutputLine['level']>> = {
  STEP: 'step',
  INFO: 'info',
  DEBUG: 'detail',
  OK: 'ok',
  WARN: 'warn',
  ERROR: 'error',
};

/**
 * `[2026-09-10T20:50:30.834Z] WARN  the sentence`.
 *
 * The stamp and the level are both written by `record()` in `src/log.ts`, which
 * is why they can be matched at all — this is not pattern-matching on prose, it
 * is reading back a format this repo controls. The timestamp is required,
 * because that is what makes a *continuation* line — a stack frame, a wrapped
 * paragraph — recognisable as belonging to the line above rather than as a
 * malformed one of its own.
 */
const LINE = /^\[[^\]]+\]\s(STEP|INFO|DEBUG|OK|WARN|ERROR)\s+(.*)$/;

/** `=== a heading ===`, which `log.heading` writes with no level in front. */
const HEADING = /^\[[^\]]+\]\s===\s(.*?)\s===$/;

export function readTranscript(text: string): readonly OutputLine[] {
  const out: OutputLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    const heading = HEADING.exec(raw);
    const match = heading === null ? LINE.exec(raw) : null;
    // A line matching neither is a continuation — a stack frame under an error,
    // or prose a child wrote across two lines. It is kept whole and given the
    // neutral level, because dropping it would silently shorten the one record
    // of a run nobody is narrating any more.
    out.push({
      n: out.length,
      level: heading !== null ? 'heading' : (LEVELS[match?.[1] ?? ''] ?? 'info'),
      message: (heading?.[1] ?? match?.[2] ?? raw).trimEnd(),
      // No id, no phase, no round: the file does not carry them, and a pane
      // saying otherwise would be inventing three fields at once. The id seam is
      // a live-wire feature and this is a file written for a person.
      id: null,
      phase: null,
      round: null,
      role: null,
    });
  }
  return out;
}
