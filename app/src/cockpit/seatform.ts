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
 * `quorumReading` (#448) says the quorum's two refusals where it is typed, and
 * still sends what was typed; `keepQuorumLegal` keeps a remove from tripping
 * one. Neither replaces the core's answer.
 *
 * Finders are run since #388 Part B, and the verifiers, the quorum and
 * `unconfirmedP0` since Part C.
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
export function seatsPatch(kind: SeatKind, rows: readonly SeatRow[]): Record<string, unknown> {
  return { review: { [kind]: rows.filter(ready).map((r) => toSeat(r, kind)) } };
}

/** The quorum field's text as the core wants it: blank is a majority (`null`). */
export function quorumPatch(text: string): Record<string, unknown> {
  const t = text.trim();
  if (t === '') return { review: { quorum: null } };
  const n = Number(t);
  return { review: { quorum: Number.isFinite(n) ? n : t } };
}

/** The three things an unconfirmed P0 may do, each with its one line (#388, owner 2026-10-20). */
export const UNCONFIRMED_P0_CHOICES: readonly { value: string; meaning: string }[] = [
  { value: 'block', meaning: 'it blocks anyway, with the votes recorded beside it' },
  { value: 'halt', meaning: 'the run stops and asks you, showing every vote and its reason' },
  { value: 'demote', meaning: 'it is moved to P2, as an unconfirmed P1 is' },
];

/**
 * What a blank minutes field means for a seat on `provider` (#448), read from
 * the effective config rather than written here.
 *
 * The rule is `seatResolved`'s in `src/roles.ts`, which is what a run and
 * `vibe doctor` use: a seat's own `timeoutMs`, or else the limit a read-only
 * turn on its provider gets - `claude.planTimeoutMs` for Claude and
 * `codex.timeoutMs` for Codex. The placeholder said `agent's`, which named
 * neither the key nor the number. When the number cannot be read the key is
 * still named and the figure is left out, never guessed.
 */
export interface InheritedTimeout {
  /** The config key a blank field takes, or null when no agent is chosen yet. */
  key: string | null;
  /** That key's value in minutes, or null when it could not be read. */
  minutes: number | null;
  /** What the empty field shows. */
  placeholder: string;
}

/** The two limits `inheritedTimeout` reads, as the effective config holds them. */
export interface TimeoutSettings {
  claude?: { planTimeoutMs?: unknown };
  codex?: { timeoutMs?: unknown };
}

/** Minutes as a person would type them: whole when whole, else to two places. */
function shownMinutes(ms: number): number {
  return Math.round((ms / MINUTE) * 100) / 100;
}

export function inheritedTimeout(provider: string, effective: TimeoutSettings): InheritedTimeout {
  if (provider === '') return { key: null, minutes: null, placeholder: "agent's" };
  const key = provider === 'claude' ? 'claude.planTimeoutMs' : provider === 'codex' ? 'codex.timeoutMs' : null;
  const ms: unknown =
    provider === 'claude' ? effective.claude?.planTimeoutMs : provider === 'codex' ? effective.codex?.timeoutMs : undefined;
  if (key === null || typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) {
    return { key, minutes: null, placeholder: `${provider}'s` };
  }
  const minutes = shownMinutes(ms);
  return { key, minutes, placeholder: `${String(minutes)} (${provider}'s)` };
}

/** The line under a minutes column: what blank means for each agent on offer (#448). */
export function minutesHint(providers: readonly string[], effective: TimeoutSettings): string {
  const parts = providers.map((p) => {
    const t = inheritedTimeout(p, effective);
    if (t.key === null) return `${p}'s own limit`;
    return t.minutes === null
      ? `${t.key} for ${p}, which this screen could not read`
      : `${t.key} for ${p}, ${String(t.minutes)} min`;
  });
  return `Blank minutes takes the agent's limit for a read-only turn: ${parts.join('; ')}.`;
}

/**
 * The quorum as it comes out, said beside the field (#448) - `quorumFor` in
 * `src/vote.ts`, which is `floor(n / 2) + 1` when blank - and the two quorums
 * the core refuses (`validateReview` in `src/config.ts`), said where they are
 * typed. Only said: the patch still sends what was typed, and the core's
 * refusal is what decides.
 */
export function quorumReading(text: string, verifiers: number): { text: string; problem: boolean } {
  const t = text.trim();
  if (t === '') {
    if (verifiers === 0) return { text: 'no verifiers, so nothing is voted on', problem: false };
    return { text: `${String(Math.floor(verifiers / 2) + 1)} of ${String(verifiers)} (a majority)`, problem: false };
  }
  const q = Number(t);
  if (!Number.isInteger(q) || q < 1) {
    return { text: 'a quorum is a whole number of verifiers, at least 1, or blank for a majority', problem: true };
  }
  if (verifiers === 0) {
    return { text: 'there are no verifiers to count; add one, or leave this blank', problem: true };
  }
  if (q > verifiers) {
    return {
      text: `${String(q)} is more than the ${String(verifiers)} verifier${verifiers === 1 ? '' : 's'} there are; the core refuses it`,
      problem: true,
    };
  }
  return { text: `${String(q)} of ${String(verifiers)}`, problem: false };
}

/**
 * A verifiers save that would leave the saved quorum above the verifiers left
 * (#448). The core checks the quorum against the list in the same config, so
 * removing a verifier under `quorum: 3` was refused, and the row came back as
 * if the remove had not happened. The quorum goes back to a majority in the
 * same patch instead: two saves would have the first refused, and blocking the
 * remove would make a person clear a field before they could take a row away.
 * `reset` says it happened, so the screen can say so rather than change a
 * setting silently.
 */
export function keepQuorumLegal(
  patch: Record<string, unknown>,
  quorum: number | null,
): { patch: Record<string, unknown>; reset: boolean } {
  const review = patch['review'];
  if (quorum === null || typeof review !== 'object' || review === null) return { patch, reset: false };
  const verifiers = (review as Record<string, unknown>)['verifiers'];
  if (!Array.isArray(verifiers) || quorum <= verifiers.length) return { patch, reset: false };
  return { patch: { ...patch, review: { ...review, quorum: null } }, reset: true };
}

/**
 * Phrases a finder's focus can start from (#448). Examples, not a vocabulary:
 * the field stays free text, because the core hands it to the finder as prose.
 */
export const FOCUS_EXAMPLES: readonly string[] = [
  'security',
  'concurrency and races',
  'error handling and fail-closed paths',
  'test coverage of the claim',
  'performance',
];

/** A focus with an example phrase added: the phrase alone if blank, after a comma if not, once. */
export function appendFocus(text: string, phrase: string): string {
  const t = text.trimEnd();
  if (t === '') return phrase;
  if (t.toLowerCase().includes(phrase.toLowerCase())) return text;
  return /[.,;:]$/.test(t) ? `${t} ${phrase}` : `${t}, ${phrase}`;
}
