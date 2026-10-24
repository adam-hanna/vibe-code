/**
 * The review seats as a form, and the patch a form edit becomes (#388).
 *
 * `gateform.ts`'s shape, for `gateform.ts`'s reasons: pure, so the decisions are
 * tested without a DOM; the whole list sent on every save, because
 * `writeConfigPatch` merges `review` one level deep and replaces a list whole;
 * and a new row not sent until it says something, so adding a row does not have
 * every save refused over it.
 *
 * What this never does is check a seat. The core's refusals - an effort outside
 * the enum, a quorum above the number of verifiers, an empty focus - arrive
 * through the refusal banner in the core's own words, and a second copy of
 * those rules here would be a second answer to *what is a legal seat*.
 *
 * Finders are run since #388 Part B, and the verifiers, the quorum and
 * `unconfirmedP0` since Part C. The plan critique's panel (#405) is the same
 * form saved under `critique` (`SeatSection`).
 */

/** A seat as the core holds it. Mirrors `RoleSetting` / `FinderSeat` in `src/`. */
export interface Seat {
  provider: string;
  model?: string;
  effort?: string;
  timeoutMs?: number;
  mcpServers?: string[];
  focus?: string;
}

export type SeatKind = 'finders' | 'verifiers';

/**
 * Which section a seat list is saved under: the review's (#388) or the plan
 * critique's (#405). The two take the same four keys, so one form serves both,
 * and every review call leaves it at its default.
 */
export type SeatSection = 'review' | 'critique';

/** One row as it is being typed - every field a string until it is sent. */
export interface SeatRow {
  /** Stable across edits, so React keeps focus in the row being typed in. */
  key: string;
  /** Empty until an agent is chosen; such a row is not sent. */
  provider: string;
  model: string;
  effort: string;
  /** In minutes, as the other timeouts on this screen are. Blank is the agent's own. */
  minutes: string;
  /** A finder's only. Blank means the shared prompt, and is never sent as `""`. */
  focus: string;
  /**
   * The saved seat this row came from, kept so a save does not drop what the
   * form does not edit (`mcpServers`) or round a timeout it did not touch.
   */
  saved: Seat | null;
}

const MINUTE = 60_000;

let counter = 0;
const nextKey = (): string => `s${String((counter += 1))}`;

/** Read whatever the effective config says a seat list is, refusing nothing. */
export function readSeats(value: unknown): Seat[] {
  if (!Array.isArray(value)) return [];
  const seats: Seat[] = [];
  for (const entry of value) {
    // The short form a role also takes: a provider name alone.
    if (typeof entry === 'string') {
      seats.push({ provider: entry });
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const seat: Seat = { provider: typeof e['provider'] === 'string' ? e['provider'] : '' };
    if (typeof e['model'] === 'string') seat.model = e['model'];
    if (typeof e['effort'] === 'string') seat.effort = e['effort'];
    if (typeof e['timeoutMs'] === 'number') seat.timeoutMs = e['timeoutMs'];
    if (typeof e['focus'] === 'string') seat.focus = e['focus'];
    if (Array.isArray(e['mcpServers'])) {
      seat.mcpServers = e['mcpServers'].filter((m): m is string => typeof m === 'string');
    }
    seats.push(seat);
  }
  return seats;
}

/** The minutes text a timeout is drawn as. */
function minutesOf(timeoutMs: number | undefined): string {
  return timeoutMs === undefined ? '' : String(Math.round(timeoutMs / MINUTE));
}

export function toRow(seat: Seat): SeatRow {
  return {
    key: nextKey(),
    provider: seat.provider,
    model: seat.model ?? '',
    effort: seat.effort ?? '',
    minutes: minutesOf(seat.timeoutMs),
    focus: seat.focus ?? '',
    saved: seat,
  };
}

export function blankRow(): SeatRow {
  return { key: nextKey(), provider: '', model: '', effort: '', minutes: '', focus: '', saved: null };
}

/**
 * Whether a row goes out on the next save. A saved row always does - clearing
 * it is an edit, and the core's refusal is the answer. A new row waits until it
 * names an agent, because `provider` is the one key a seat cannot go without.
 */
export function ready(row: SeatRow): boolean {
  return row.saved !== null || row.provider.trim() !== '';
}

/**
 * A row as a hand-written file would hold it: only the keys that say something.
 * A minutes field still showing what `toRow` drew keeps the saved figure, so a
 * timeout that is not a whole number of minutes is not rounded by a save of
 * some other field.
 */
export function toSeat(row: SeatRow, kind: SeatKind): Record<string, unknown> {
  const seat: Record<string, unknown> = { provider: row.provider.trim() };
  if (row.model.trim() !== '') seat['model'] = row.model.trim();
  if (row.effort !== '') seat['effort'] = row.effort;
  const minutes = row.minutes.trim();
  if (row.saved?.timeoutMs !== undefined && minutes === minutesOf(row.saved.timeoutMs)) {
    seat['timeoutMs'] = row.saved.timeoutMs;
  } else if (minutes !== '') {
    const n = Number(minutes);
    // Junk is sent as typed, so the core refuses it in its own words.
    seat['timeoutMs'] = Number.isFinite(n) ? n * MINUTE : minutes;
  }
  if (row.saved?.mcpServers !== undefined) seat['mcpServers'] = row.saved.mcpServers;
  if (kind === 'finders' && row.focus.trim() !== '') seat['focus'] = row.focus.trim();
  return seat;
}

/** The patch for one list: every ready row, in order. `[]` is legal and means none. */
export function seatsPatch(
  kind: SeatKind,
  rows: readonly SeatRow[],
  section: SeatSection = 'review',
): Record<string, unknown> {
  return { [section]: { [kind]: rows.filter(ready).map((r) => toSeat(r, kind)) } };
}

/** The quorum field's text as the core wants it: blank is a majority (`null`). */
export function quorumPatch(text: string, section: SeatSection = 'review'): Record<string, unknown> {
  const t = text.trim();
  if (t === '') return { [section]: { quorum: null } };
  const n = Number(t);
  return { [section]: { quorum: Number.isFinite(n) ? n : t } };
}

/** The three things an unconfirmed P0 may do, each with its one line (#388, owner 2026-10-20). */
export const UNCONFIRMED_P0_CHOICES: readonly { value: string; meaning: string }[] = [
  { value: 'block', meaning: 'it blocks anyway, with the votes recorded beside it' },
  { value: 'halt', meaning: 'the run stops and asks you, showing every vote and its reason' },
  { value: 'demote', meaning: 'it is moved to P2, as an unconfirmed P1 is' },
];
