import type { ArtifactEntry } from '../host';

/**
 * What a run wrote, read from the run's own directory (#223).
 *
 * **The window had no filesystem until this, and that is what the tab bar was
 * admitting.** Two tabs were dashed and named rather than built — `Versions` had
 * *"this window cannot read a run's artifacts"* on its tooltip — and the pilot's
 * round cards linked to a Findings pane that could only ever show the four
 * counts and a title, because a frame carrying every finding in full would put a
 * review's whole report on the wire every round. The detail was always on disk;
 * nothing could open it.
 *
 * ## Nothing here predicts a filename
 *
 * The one dangerous shape this could have taken is composing `plan-${round}.json`
 * from a round number the column already has. That is a copy of the loop's naming
 * convention living in a process that cannot be kept in step with it, and it goes
 * wrong silently: a renamed artifact does not fail, it shows an empty pane.
 *
 * So the listing is asked for, and this module only **classifies what came
 * back**. A name it does not recognise is `other` and is still listed — the loop
 * is free to write an artifact this build has never heard of, and the honest
 * drawing of one is its own name, which is the rule `boundary()` and `ending()`
 * already follow.
 *
 * ## The patterns are duplicated on purpose, and there is a test that says so
 *
 * `src/orchestrator.ts` writes these names and this reads them, and the two are
 * not shared — the app and the core are two packages, and `app/src/cockpit/raise.ts`
 * already duplicates `src/raise.ts`'s markers for exactly this reason. What makes
 * that safe is the same thing that makes it safe there: the duplication is
 * pinned by a test that reads the core as source, so a rename fails in the
 * commit that makes it rather than in a pane somebody opens a week later.
 */

/** Which pane an artifact belongs behind. `other` is drawn, never hidden. */
export type ArtifactKind =
  | 'plan'
  | 'critique'
  | 'review'
  | 'answers'
  | 'dispositions'
  | 'plan-dispositions'
  | 'fix-report'
  | 'final-fix-confirm'
  | 'near-pairs'
  | 'other';

export interface Classified {
  name: string;
  kind: ArtifactKind;
  /**
   * The round in the name, or null.
   *
   * The archive's round, which is what pairs an artifact with the card that
   * produced it. Null for `PLAN.md` and for everything unclassified — those are
   * not round-numbered, and a zero here would file them under round 0.
   */
  round: number | null;
  bytes: number | null;
}

/**
 * The four shapes, most specific first.
 *
 * **Order is load-bearing.** `plan-critique-0.json` starts with `plan-`, so a
 * looser plan pattern tested first would claim every critique in the directory
 * and the critique pane would be empty. The patterns are anchored at both ends
 * for the same reason.
 */
const PATTERNS: readonly { kind: ArtifactKind; re: RegExp }[] = [
  { kind: 'critique', re: /^plan-critique-(\d+)\.json$/ },
  { kind: 'review', re: /^code-review-(\d+)\.json$/ },
  // A review fix round's dispositions (#393). Its round is the FIX round, so it
  // answers `code-review-<round - 1>.json`; no tab lists it on its own.
  { kind: 'dispositions', re: /^fix-dispositions-(\d+)\.json$/ },
  // A plan revision's dispositions (#453, #457). Its round is the REVISION's,
  // so it answers `plan-critique-<round - 1>.json`; no tab lists it on its own.
  { kind: 'plan-dispositions', re: /^plan-dispositions-(\d+)\.json$/ },
  // A review fix round's report: the evidence that the round ran, when it left
  // no dispositions file - an unreadable answer, or a run from before #393.
  { kind: 'fix-report', re: /^fix-report-(\d+)\.md$/ },
  // The final fix's confirmations (#489, read since #530). Its round is the
  // FINAL FIX round's, so it belongs with `code-review-<round - 1>.json`.
  { kind: 'final-fix-confirm', re: /^final-fix-confirm-(\d+)\.json$/ },
  // The near pairs a fix round's prompt named (#462, written since #530). Its
  // round is the FIX round's - `recordNearPairs` runs after the increment, in
  // the ordinary and the final fix alike - so it answers `code-review-<round - 1>.json`.
  { kind: 'near-pairs', re: /^fix-near-pairs-(\d+)\.json$/ },
  { kind: 'answers', re: /^answers-(\d+)\.json$/ },
  { kind: 'plan', re: /^plan-(\d+)\.json$/ },
];

/** `PLAN.md`: the approved plan, which is round-less because it is the last one. */
const APPROVED_PLAN = 'PLAN.md';

export function classify(entry: ArtifactEntry): Classified {
  const base: Omit<Classified, 'kind' | 'round'> = { name: entry.name, bytes: entry.bytes };
  // Only a plain file can be read, so a directory or a link is `other` whatever
  // it is called — offering `gate-artifacts-1/` behind the Plans tab because it
  // matched a pattern would be a row whose only outcome is a refusal.
  if (entry.kind !== 'file') return { ...base, kind: 'other', round: null };
  if (entry.name === APPROVED_PLAN) return { ...base, kind: 'plan', round: null };
  for (const { kind, re } of PATTERNS) {
    const found = re.exec(entry.name);
    if (found === null) continue;
    const round = Number(found[1]);
    // A round that is not a finite number is not a round. `\d+` cannot produce
    // one today; the guard is here because the alternative to checking is
    // `NaN` reaching a sort comparator, where it silently does nothing.
    return { ...base, kind, round: Number.isFinite(round) ? round : null };
  }
  return { ...base, kind: 'other', round: null };
}

/**
 * Everything of one kind, oldest round first.
 *
 * `PLAN.md` sorts last among the plans, which is where it belongs: it is written
 * once the plan is approved, so it is the newest thing in that group and it is
 * the one a reader usually wants.
 */
export function ofKind(
  entries: readonly ArtifactEntry[],
  kind: ArtifactKind,
): readonly Classified[] {
  return entries
    .map(classify)
    .filter((c) => c.kind === kind)
    .sort((a, b) => (a.round ?? Number.POSITIVE_INFINITY) - (b.round ?? Number.POSITIVE_INFINITY));
}

// ---- what is inside one -----------------------------------------------------

/**
 * Reading a model's own JSON, at the density a pane needs.
 *
 * **Per-field, and every absence stays absent.** These files were written by an
 * older release as often as by this one — an archive holds runs going back
 * months — so a reader that required a field would show a run's whole review as
 * unreadable over one addition. Each `read*` below drops what it cannot place
 * and keeps the rest, which is `readFindings` in `model.ts` applying the same
 * rule to the same objects arriving by a different road.
 */
function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function record(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** One place a finding points at, as `src/types.ts` defines it. */
export interface Citation {
  kind: string;
  path: string | null;
  line: number | null;
  excerpt: string | null;
  ref: string | null;
}

/**
 * One finding, with the prose the wire does not carry.
 *
 * This is the whole reason the artifact is read at all. `FindingRow` on the wire
 * is deliberately thin — id, severity, title and provenance — and everything a
 * person actually needs in order to *judge* a finding is here: what is wrong, what
 * would fix it, and the places it says to look.
 */
export interface FullFinding {
  id: string;
  severity: string;
  title: string;
  detail: string | null;
  suggestedFix: string | null;
  citations: readonly Citation[];
  raisedBy: string | null;
  /**
   * Which review finders raised it (#388 Part B), or null - which is every
   * finding of a run that seated no additional finder, and must render as
   * exactly what it did before.
   */
  foundBy: readonly FoundBy[] | null;
  /**
   * What the review verifiers voted (#388 Part C), or null - every finding that
   * was not put to a vote, which must render as exactly what it did before.
   */
  votes: Votes | null;
  deferred: boolean;
  downgraded: { from: string; reason: string } | null;
}

/** One finder's share of a finding's provenance, as the report file has it. */
export interface FoundBy {
  seat: string;
  provider: string;
  model: string;
  id: string;
  /**
   * The earlier finding this seat declared it the same as (#498): an id, or
   * null when it declared none. Absent unless `loop.findingsLedger` was on, and
   * absent too when the value is not one this build can read - that drops the
   * key alone, never the entry.
   */
  priorId?: string | null;
}

/**
 * The finders a report says raised a finding, dropping an entry this build
 * cannot read rather than the list - the rule `readCitations` follows. Null when
 * there is no list, or nothing in it survives: a caption naming no finder is
 * not one to draw.
 */
function readFoundBy(v: unknown): FoundBy[] | null {
  if (!Array.isArray(v)) return null;
  const out: FoundBy[] = [];
  for (const item of v as unknown[]) {
    const row = record(item);
    if (row === null) continue;
    const seat = str(row['seat']);
    const provider = str(row['provider']);
    const model = str(row['model']);
    const id = str(row['id']);
    if (seat === null || provider === null || model === null || id === null) continue;
    const prior: unknown = row['priorId'];
    out.push({
      seat,
      provider,
      model,
      id,
      ...(prior === null ? { priorId: null } : str(prior) === null ? {} : { priorId: str(prior) }),
    });
  }
  return out.length === 0 ? null : out;
}

/**
 * The provenance sentence: *"found by 2 of 3 finders: codex/gpt-5.5, claude/default"*.
 *
 * `reported` is the number of finders that reported that round, off the
 * round's `review_finders_merged` frame - never the configured count, which
 * would count a seat that failed as one that looked and saw nothing. Without
 * a frame (a replay of an older core) the sentence states the numerator only.
 */
export function foundByLine(foundBy: readonly FoundBy[], reported: number | null): string {
  const who = foundBy.map((f) => `${f.provider}/${f.model}`).join(', ');
  const n = String(foundBy.length);
  return reported === null
    ? `found by ${n} finder${foundBy.length === 1 ? '' : 's'}: ${who}`
    : `found by ${n} of ${String(reported)} finders: ${who}`;
}

/**
 * What each seat declared a finding the same as (#498), one line per seat that
 * named an earlier id: *"review.finders[0]: same as earlier finding a-1"*.
 *
 * The ledger the seat was shown names rounds, but `priorId` is the bare id and
 * no round travels with it, so the line names none rather than guessing which
 * earlier round held that id. Empty when no seat declared one, which is every
 * run without `loop.findingsLedger`.
 */
export function priorLines(foundBy: readonly FoundBy[]): string[] {
  return foundBy.flatMap((f) =>
    typeof f.priorId === 'string' ? [`${f.seat}: same as earlier finding ${f.priorId}`] : [],
  );
}

/** One verifier's ballot, as the report file has it. */
export interface Ballot {
  seat: string;
  provider: string;
  model: string;
  /** As cast. */
  vote: string;
  /** As counted - a `not-real` that pointed at nothing is counted `cannot-tell`. */
  counted: string;
  reason: string;
  countedReason: string | null;
}

/** The vote on one finding, as the report file has it. */
export interface Votes {
  quorum: number;
  n: number;
  real: number;
  notReal: number;
  cannotTell: number;
  outcome: string;
  ballots: readonly Ballot[];
}

/**
 * A finding's vote, or null when there is none or its counts cannot be read - a
 * tally this window would have to fill in is one it would be inventing. A
 * ballot this build cannot read is dropped alone, as `readFoundBy` drops an
 * entry.
 */
function readVotes(v: unknown): Votes | null {
  const row = record(v);
  if (row === null) return null;
  const quorum = num(row['quorum']);
  const n = num(row['n']);
  const real = num(row['real']);
  const notReal = num(row['notReal']);
  const cannotTell = num(row['cannotTell']);
  const outcome = str(row['outcome']);
  if (quorum === null || n === null || real === null || notReal === null || cannotTell === null || outcome === null) {
    return null;
  }
  const ballots: Ballot[] = [];
  for (const item of Array.isArray(row['ballots']) ? (row['ballots'] as unknown[]) : []) {
    const b = record(item);
    if (b === null) continue;
    const seat = str(b['seat']);
    const provider = str(b['provider']);
    const model = str(b['model']);
    const vote = str(b['vote']);
    const counted = str(b['counted']);
    const reason = str(b['reason']);
    if (seat === null || provider === null || model === null || vote === null || counted === null || reason === null) {
      continue;
    }
    ballots.push({ seat, provider, model, vote, counted, reason, countedReason: str(b['countedReason']) });
  }
  return { quorum, n, real, notReal, cannotTell, outcome, ballots };
}

/**
 * The vote's sentence: *"vote: 1 of 3 real, 2 not real (quorum 2), unconfirmed"*.
 *
 * Every number is the report's own, counted by the core as each ballot was
 * counted. `cannot tell` is said only when there was one, so the common
 * sentence stays the short one.
 */
export function votesLine(v: Votes): string {
  const unsure = v.cannotTell > 0 ? `, ${String(v.cannotTell)} cannot tell` : '';
  return (
    `vote: ${String(v.real)} of ${String(v.n)} real, ${String(v.notReal)} not real${unsure} ` +
    `(quorum ${String(v.quorum)}), ${v.outcome}`
  );
}

/** One ballot's line: who, what it voted (and how that was counted), and why. */
export function ballotLine(b: Ballot): string {
  const counted = b.counted === b.vote ? '' : ` (counted as ${b.counted})`;
  return `${b.seat}: ${b.vote}${counted} — ${b.reason}`;
}

function readCitations(v: unknown): Citation[] {
  if (!Array.isArray(v)) return [];
  const out: Citation[] = [];
  for (const item of v as unknown[]) {
    const row = record(item);
    if (row === null) continue;
    const kind = str(row['kind']);
    if (kind === null) continue;
    out.push({
      kind,
      path: str(row['path']),
      line: num(row['line']),
      excerpt: str(row['excerpt']),
      ref: str(row['ref']),
    });
  }
  return out;
}

/**
 * One finding's disposition, as `fix-dispositions-<n>.json` has it (#393), and
 * `plan-dispositions-<n>.json` in the same shape (#453).
 */
export interface RecordedDisposition {
  disposition: string;
  reason: string;
}

/** A review fix round's dispositions file, at the density the findings pane needs. */
export interface DispositionsFile {
  round: number | null;
  label: string | null;
  /** A `final-fix-<n>` round, which by design nothing reviews again. */
  final: boolean;
  byId: ReadonlyMap<string, RecordedDisposition>;
}

/**
 * The dispositions a fix round recorded, or null when the file is not JSON. An
 * entry this build cannot read is dropped alone, as `readReport` drops a
 * finding; the finding it was about then simply says nothing.
 */
export function readDispositions(text: string): DispositionsFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const root = record(parsed);
  if (root === null) return null;
  const byId = new Map<string, RecordedDisposition>();
  const list: unknown = root['dispositions'];
  for (const item of Array.isArray(list) ? (list as unknown[]) : []) {
    const row = record(item);
    if (row === null) continue;
    const id = str(row['id']);
    const disposition = str(row['disposition']);
    if (id === null || disposition === null || byId.has(id)) continue;
    // `str` reads `''` as absent, and an empty reason is what a left-out finding has.
    byId.set(id, { disposition, reason: typeof row['reason'] === 'string' ? row['reason'] : '' });
  }
  const label = str(root['label']);
  return { round: num(root['round']), label, final: label?.startsWith('final-') ?? false, byId };
}

/**
 * Who answered a round's findings: the fixer answers a review (#393), the
 * planner's revision answers a critique (#457).
 */
export type Answerer = 'fixer' | 'planner';

/** What the fixer or the planner did with one finding, as far as the run's files can say. */
export type FixOutcome =
  | {
      kind: 'recorded';
      /** The answering round's own number: the fix round, or the revision's plan round, raw. */
      fixRound: number;
      final: boolean;
      entry: RecordedDisposition;
      /** Absent is the fixer, which is every outcome before #457. */
      by?: Answerer;
    }
  /** The round ran and its dispositions could not be read, so none were recorded. */
  | { kind: 'not-recorded' }
  | null;

/**
 * The outcome badges for a finding's provenance: *"fixer: rebutted - <reason>
 * (fix round 2)"*, then *"same id raised again next round"* or *"not reviewed
 * again"* when either is true. Nothing at all when there is nothing to say.
 *
 * The two later facts are their own badges, never folded into the
 * disposition, and neither is ever "regressed" or "not fixed": a finding the
 * next review did not raise is not confirmed fixed, so that says nothing.
 */
export function outcomeLine(
  outcome: FixOutcome,
  next: 'raised-again' | 'not-reviewed-again' | null,
): string[] {
  const out: string[] = [];
  if (outcome?.kind === 'not-recorded') out.push('dispositions not recorded for this round');
  else if (outcome?.kind === 'recorded') {
    const what = outcome.entry.disposition.replace(/-/g, ' ');
    const why = outcome.entry.reason === '' ? '' : ` - ${outcome.entry.reason}`;
    out.push(`${outcome.by ?? 'fixer'}: ${what}${why} (${roundWords(outcome)})`);
  }
  if (next === 'raised-again') out.push('same id raised again next round');
  else if (next === 'not-reviewed-again') out.push('not reviewed again');
  return out;
}

/**
 * The answering round in words. A plan round is counted from one, as the Plans
 * and Plan critique tabs count it (`shownRound`); a fix round keeps the number
 * in its label.
 */
function roundWords(outcome: Extract<FixOutcome, { kind: 'recorded' }>): string {
  return outcome.by === 'planner'
    ? `plan round ${String(outcome.fixRound + 1)}`
    : `${outcome.final ? 'final fix round' : 'fix round'} ${String(outcome.fixRound)}`;
}

/**
 * What the files beside one review round say about the fix round that answered
 * it, or beside one critique round about the revision that answered it.
 */
export interface AnsweringRound {
  /** Absent is the fixer. */
  by?: Answerer;
  /** The round of the listed `fix-dispositions-<n>.json`, or null when none is listed. */
  listed: number | null;
  /** That file, read; null while it is loading or when it cannot be read. */
  file: DispositionsFile | null;
  /** The fix round ran and recorded none: an unreadable answer, or a run from before #393. */
  unrecorded: boolean;
  /** The ids the next review raised, or null when there is no next review to read. */
  raised: ReadonlySet<string> | null;
}

/**
 * Whether the revision answering `plan-critique-<round>.json` ran (#457): its
 * `plan-<round + 1>.json` is listed. A findings revision writes that plan after
 * its dispositions, and removes a stale dispositions file when its answer could
 * not be read, so a listed plan with no dispositions file beside it recorded
 * none - an unreadable answer, or a run from before #453. An answers-only
 * revision rewrites `plan-<round>.json` and opens no round, so it never counts.
 */
export function revisionRan(entries: readonly ArtifactEntry[], round: number): boolean {
  return ofKind(entries, 'plan').some((c) => c.round === round + 1);
}

/**
 * The outcome badges for one finding of a review round: a read-time join,
 * never written back onto the finding.
 *
 * "Not recorded" only when no dispositions file is listed at all - a listed
 * file that is still loading, or cannot be read, says nothing rather than
 * claiming the round recorded nothing.
 */
export function outcomeFor(id: string, a: AnsweringRound): string[] {
  return outcomeEntries(id, a).map((e) => e.line);
}

/**
 * The same outcome as `outcomeFor`, with the fixer's or planner's reason split
 * off so the pane can draw it as the prose it is (#530): `head` is the line
 * without the reason, `reason` is the reason or null. `line` is `outcomeFor`'s
 * string, byte for byte.
 */
export function outcomeEntries(
  id: string,
  a: AnsweringRound,
): { line: string; head: string; reason: string | null }[] {
  const lines = outcomeLinesFor(id, a);
  const recorded = recordedOutcome(id, a);
  return lines.map((line, i) => {
    if (i !== 0 || recorded === null || recorded.entry.reason === '') return { line, head: line, reason: null };
    const what = recorded.entry.disposition.replace(/-/g, ' ');
    return { line, head: `${recorded.by ?? 'fixer'}: ${what} (${roundWords(recorded)})`, reason: recorded.entry.reason };
  });
}

function recordedOutcome(id: string, a: AnsweringRound): Extract<FixOutcome, { kind: 'recorded' }> | null {
  const entry = a.file?.byId.get(id);
  return entry !== undefined && a.listed !== null
    ? { kind: 'recorded', fixRound: a.listed, final: a.file?.final ?? false, entry, ...(a.by === undefined ? {} : { by: a.by }) }
    : null;
}

function outcomeLinesFor(id: string, a: AnsweringRound): string[] {
  const entry = a.file?.byId.get(id);
  const outcome: FixOutcome =
    entry !== undefined && a.listed !== null
      ? { kind: 'recorded', fixRound: a.listed, final: a.file?.final ?? false, entry, ...(a.by === undefined ? {} : { by: a.by }) }
      : a.unrecorded && a.listed === null
        ? { kind: 'not-recorded' }
        : null;
  if (outcome === null) return [];
  const after = a.file?.final === true ? 'not-reviewed-again' : a.raised?.has(id) === true ? 'raised-again' : null;
  return outcomeLine(outcome, after);
}

/**
 * A findings report, as the critic or the reviewer wrote it.
 *
 * `verdict` and `summary` are the two things the wire has never carried at all,
 * and the summary is the reviewer's own account of the round — the paragraph a
 * person reads before any individual finding.
 */
export interface Report {
  verdict: string | null;
  summary: string | null;
  findings: readonly FullFinding[];
  /**
   * The judge files the round's diff touched and each seat's word on them
   * (#112, #404), or empty: a round that touched none, or a report from before
   * either.
   */
  testChanges: readonly JudgedFile[];
}

/** One seat's word on one judge file, as `testChanges.files[].verdicts` has it (#404). */
export interface SeatVerdict {
  seat: string;
  provider: string;
  model: string;
  /** `justified`, `not justified` or `unjudged`. */
  verdict: string;
  reason: string | null;
}

/** One judge file, with the combined verdict and every seat's own. */
export interface JudgedFile {
  path: string;
  /**
   * The combined verdict as the core stored it (`justified`, `not justified`,
   * `unjudged`), or null when this build cannot read it. Never recomputed from
   * `seats` (#460): the core keeps the stored one when entries were dropped.
   */
  verdict: string | null;
  /** The reason stored with the combined verdict; null for `unjudged`. */
  reason: string | null;
  /** Empty in a round with no finders, whose verdict is the reviewer's alone. */
  seats: readonly SeatVerdict[];
}

/** A verdict as the core stores it - `'unjudged'` or `{ justified, reason }` - in words. */
function readVerdict(v: unknown): { verdict: string; reason: string | null } | null {
  if (v === 'unjudged') return { verdict: 'unjudged', reason: null };
  const row = record(v);
  if (row === null || typeof row['justified'] !== 'boolean') return null;
  return { verdict: row['justified'] ? 'justified' : 'not justified', reason: str(row['reason']) };
}

/** `testChanges.files`, each file and each seat dropped alone when it cannot be read. */
function readTestChanges(v: unknown): JudgedFile[] {
  const files = record(v)?.['files'];
  if (!Array.isArray(files)) return [];
  const out: JudgedFile[] = [];
  for (const item of files as unknown[]) {
    const row = record(item);
    const path = row === null ? null : str(row['path']);
    if (row === null || path === null) continue;
    const seats: SeatVerdict[] = [];
    for (const s of Array.isArray(row['verdicts']) ? (row['verdicts'] as unknown[]) : []) {
      const seat = record(s);
      if (seat === null) continue;
      const name = str(seat['seat']);
      const provider = str(seat['provider']);
      const model = str(seat['model']);
      const said = readVerdict(seat['verdict']);
      if (name === null || provider === null || model === null || said === null) continue;
      seats.push({ seat: name, provider, model, ...said });
    }
    const combined = readVerdict(row['verdict']);
    out.push({ path, verdict: combined?.verdict ?? null, reason: combined?.reason ?? null, seats });
  }
  return out;
}

/**
 * The judge files the seats disagreed on (#404): one seat said justified and
 * another said not justified. The core's `disagreements` rule, so the window's
 * count is the number the terminal's warning prints (#460): an unjudged seat
 * beside a justified one is an omission, not a disagreement. Empty in a round
 * without finders.
 */
export function disagreedFiles(files: readonly JudgedFile[]): readonly JudgedFile[] {
  return files.filter((f) => {
    const said = new Set(f.seats.map((s) => s.verdict));
    return said.has('justified') && said.has('not justified');
  });
}

/**
 * A judge file a person should look at (#460): anything the stored combined
 * verdict did not call justified - `not justified`, `unjudged`, or a verdict
 * this build could not read, which fails closed rather than passing as fine.
 */
export function needsLook(file: JudgedFile): boolean {
  return file.verdict !== 'justified';
}

/** Whether any seat's own verdict is on record: a round that seated finders (#404). */
export function seated(files: readonly JudgedFile[]): boolean {
  return files.some((f) => f.seats.length > 0);
}

/** `code-review-<n>.json`: the review round's report, which holds its `testChanges`. */
export function reviewReportName(round: number): string {
  return `code-review-${String(round)}.json`;
}

export function readReport(text: string): Report | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const root = record(parsed);
  if (root === null) return null;
  const raw: unknown = root['findings'];
  const findings: FullFinding[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw as unknown[]) {
      const row = record(item);
      if (row === null) continue;
      const id = str(row['id']);
      const severity = str(row['severity']);
      // Same rule the wire's reader follows: a finding missing its id or its
      // severity is one this build cannot place, and dropping the other fifteen
      // with it would lose a person's view of a round over one bad row.
      if (id === null || severity === null) continue;
      const down = record(row['downgraded']);
      const from = down === null ? null : str(down['from']);
      const reason = down === null ? null : str(down['reason']);
      findings.push({
        id,
        severity,
        title: str(row['title']) ?? id,
        detail: str(row['detail']),
        suggestedFix: str(row['suggested_fix']),
        citations: readCitations(row['evidence']),
        raisedBy: str(row['raisedBy']),
        foundBy: readFoundBy(row['foundBy']),
        votes: readVotes(row['votes']),
        // `=== true`, so a report that does not carry the field is not read as
        // having said no. It means the same thing here, and the coercion is the
        // one that cannot become wrong later.
        deferred: row['defer'] === true,
        downgraded: from === null || reason === null ? null : { from, reason },
      });
    }
  }
  return {
    verdict: str(root['verdict']),
    summary: str(root['summary']),
    findings,
    testChanges: readTestChanges(root['testChanges']),
  };
}

// ---- the panel, at a glance (#530) -------------------------------------------

/**
 * The round's panel in one line: *"3 seats · 2 reported · 14 findings merged
 * into 9 · 5 put to a vote: 4 confirmed, 1 unconfirmed"*.
 *
 * The seat and merge counts are the merge frame's and the vote counts are the
 * report's own `votes` - never the configured count, `foundByLine`'s rule. A
 * part neither source says is left out rather than filled in. Null when there
 * is nothing to say: a round with one seat and no vote, which is every default
 * round before #447, draws exactly what it drew before.
 */
export function panelLine(
  merge: { finders: number; reported: number; findings: number | null; merged: number | null } | null,
  findings: readonly FullFinding[],
): string | null {
  const parts: string[] = [];
  if (merge !== null && merge.finders > 1) {
    parts.push(`${String(merge.finders)} seats`, `${String(merge.reported)} reported`);
    if (merge.findings !== null && merge.merged !== null) {
      parts.push(`${String(merge.findings)} findings merged into ${String(merge.merged)}`);
    }
  }
  const voted = findings.filter((f) => f.votes !== null);
  if (voted.length > 0) {
    const outcomes = new Map<string, number>();
    for (const f of voted) {
      const o = f.votes?.outcome ?? '';
      outcomes.set(o, (outcomes.get(o) ?? 0) + 1);
    }
    const order = ['confirmed', 'unconfirmed', 'undecided'];
    const named = [...outcomes.keys()].sort(
      (a, b) => (order.indexOf(a) + 1 || order.length + 1) - (order.indexOf(b) + 1 || order.length + 1),
    );
    parts.push(
      `${String(voted.length)} put to a vote: ${named.map((o) => `${String(outcomes.get(o) ?? 0)} ${o}`).join(', ')}`,
    );
  }
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The ways the findings list can be narrowed to the panel's agreement (#530). */
export type Consensus = 'all' | 'one-seat' | 'every-seat' | 'voted-on' | 'voted-down';

/** What each filter is called on its button. */
export const CONSENSUS_WORDS: Record<Consensus, string> = {
  all: 'all',
  'one-seat': 'found by one seat',
  'every-seat': 'found by every seat',
  'voted-on': 'voted on',
  'voted-down': 'voted down',
};

/**
 * Whether one finding passes a filter. *Every seat* is measured against the
 * seats that reported (`reported`), never the configured count; *voted down*
 * is a vote whose outcome was `unconfirmed`.
 */
export function inConsensus(f: FullFinding, c: Consensus, reported: number | null): boolean {
  switch (c) {
    case 'all':
      return true;
    case 'one-seat':
      return f.foundBy?.length === 1;
    case 'every-seat':
      return reported !== null && f.foundBy !== null && f.foundBy.length >= reported;
    case 'voted-on':
      return f.votes !== null;
    case 'voted-down':
      return f.votes?.outcome === 'unconfirmed';
  }
}

/**
 * The filters worth offering for a round, `all` first, or empty when the round
 * had neither finders nor a vote - then the list is drawn as it always was.
 * *Every seat* needs the merge frame's denominator, so it is offered only with
 * one; the vote filters only when something was voted on.
 */
export function consensusFilters(findings: readonly FullFinding[], reported: number | null): Consensus[] {
  const found = findings.some((f) => f.foundBy !== null);
  const voted = findings.some((f) => f.votes !== null);
  if (!found && !voted) return [];
  const out: Consensus[] = ['all'];
  if (found) out.push('one-seat');
  if (found && reported !== null) out.push('every-seat');
  if (voted) out.push('voted-on', 'voted-down');
  return out;
}

// ---- the final fix's confirmations (#489, #530) -----------------------------

/** One carried finding's confirmation, as `final-fix-confirm-<n>.json` has it. */
export interface Confirmation {
  id: string;
  /** As said, and as counted: a `fixed` whose evidence resolved to nothing counts `cannot-tell`. */
  verdict: string;
  counted: string;
  /** `seat`, `reproducer` or `unread-diff`. */
  source: string;
  seat: { provider: string; model: string; sharesImplementerVendor: boolean } | null;
  reason: string | null;
  countedReason: string | null;
}

export interface Confirmations {
  /** The final fix round's number: it answers `code-review-<round - 1>.json`. */
  round: number | null;
  /** `since-last-review` or `whole-run`, or null when the file did not say. */
  scope: string | null;
  findings: readonly Confirmation[];
}

/**
 * A final fix's confirmations, or null when the file is not JSON. An entry
 * this build cannot read is dropped alone, as `readDispositions` drops one.
 */
export function readConfirmations(text: string): Confirmations | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const root = record(parsed);
  if (root === null) return null;
  const findings: Confirmation[] = [];
  for (const item of Array.isArray(root['findings']) ? (root['findings'] as unknown[]) : []) {
    const row = record(item);
    if (row === null) continue;
    const id = str(row['id']);
    const verdict = str(row['verdict']);
    const counted = str(row['counted']);
    const source = str(row['source']);
    if (id === null || verdict === null || counted === null || source === null) continue;
    const s = record(row['seat']);
    const provider = s === null ? null : str(s['provider']);
    const model = s === null ? null : str(s['model']);
    findings.push({
      id,
      verdict,
      counted,
      source,
      seat:
        s === null || provider === null || model === null
          ? null
          : { provider, model, sharesImplementerVendor: s['sharesImplementerVendor'] === true },
      reason: str(row['reason']),
      countedReason: str(row['countedReason']),
    });
  }
  return { round: num(root['round']), scope: str(root['scope']), findings };
}

/** What the confirmation's diff covered, in a sentence. */
export function scopeLine(scope: string | null): string {
  if (scope === 'since-last-review') return 'Checked against the final fix’s own change, from the commit before it to the working tree.';
  if (scope === 'whole-run') {
    return 'Checked against the whole run’s diff: the final fix’s own change could not be told apart from the earlier rounds’.';
  }
  return scope === null ? 'The file does not say what the check was shown.' : `Checked against: ${scope}.`;
}

/**
 * Who settled one confirmation: *"checked by codex/gpt-5.5"*, *"its reproducer
 * passed"*, or *"no check ran"* when the diff could not be read and no turn was
 * bought - which must never read as a check.
 */
export function confirmedBy(c: Confirmation): string {
  if (c.source === 'reproducer') return 'its reproducer passed after the fix';
  if (c.source === 'unread-diff') return 'no check ran';
  if (c.seat === null) return `source: ${c.source}`;
  const same = c.seat.sharesImplementerVendor ? ', on the implementer’s own vendor' : '';
  return `checked by ${c.seat.provider}/${c.seat.model}${same}`;
}

/**
 * One question and what came back for it, out of `answers-<n>.json`.
 *
 * The same four facts `Question` on the wire carries, and they are deliberately
 * the same four: this is the *record* of a round the window may not have been
 * watching, and a round read from disk must not be drawable in a way a live one
 * is not. `QuestionsPane` renders both through one component for that reason.
 */
export interface RecordedAnswer {
  question: string;
  answer: string | null;
  confidence: string | null;
  rationale: string | null;
  /** The answerer refusing to guess, which is an outcome and not a gap. */
  declined: boolean;
}

/**
 * The answers a question round produced.
 *
 * **A bare array, and an object with an `answers` key, both.** The orchestrator
 * writes the array - `artifact(state, 'answers-<n>.json', answers)` - while the
 * model's own report is `{answers: [...]}`, and an archive holds files written
 * by releases either side of every change to that. Accepting both costs one
 * line and is the difference between a readable round and an empty pane.
 */
export function readAnswers(text: string): readonly RecordedAnswer[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const root = record(parsed);
  const list: unknown = Array.isArray(parsed) ? parsed : root === null ? null : root['answers'];
  if (!Array.isArray(list)) return null;
  const out: RecordedAnswer[] = [];
  for (const item of list as unknown[]) {
    const row = record(item);
    if (row === null) continue;
    const question = str(row['question']);
    // The question is what identifies the row. One without it is an answer to
    // nothing, and there is nowhere to draw it.
    if (question === null) continue;
    out.push({
      question,
      answer: str(row['answer']),
      confidence: str(row['confidence']),
      rationale: str(row['rationale']),
      // `=== true`, so a file that does not carry the field is not read as
      // having said no.
      declined: row['defer_to_human'] === true,
    });
  }
  return out;
}

/**
 * A plan's markdown, out of `plan-<n>.json`.
 *
 * `PLAN.md` is already markdown and needs none of this, which is why this
 * returns null rather than throwing on a file that is not JSON: the caller hands
 * whatever it read to `planText`, and a `.md` falls through to being itself.
 */
export function readPlanMarkdown(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const root = record(parsed);
  return root === null ? null : str(root['plan_md']);
}

/**
 * What to show for a plan artifact: the markdown inside it, or the file itself.
 *
 * One function so the two shapes in the plan group — `plan-<n>.json` and
 * `PLAN.md` — are one case at the call site. A `plan-<n>.json` this build cannot
 * parse falls back to its raw text rather than to an empty pane: unparseable
 * JSON is still the thing the run wrote, and showing it is how somebody finds
 * out what went wrong with it.
 */
export function planText(name: string, text: string): string {
  if (name.endsWith('.json')) return readPlanMarkdown(text) ?? text;
  return text;
}

// ---- what each seat said on its own (#530) ----------------------------------

/**
 * One seat of a panel round, as the pane offers it: the seat's own report file
 * when the listing has one, and the failure the merge frame closed for it when
 * there is one.
 *
 * `k` is the core's `FinderReport.k`: 0 is `roles.reviewer` (or `roles.critic`),
 * and a finder is its place in `review.finders` (or `critique.finders`) plus
 * one. A seat with neither a file nor a failure is still a slot, so a seat the
 * merge counted is never silently left out.
 */
export interface SeatSlot {
  k: number;
  /** `code-review-<n>.seat-<k>.json`, or null when the listing has no such file. */
  name: string | null;
  failure: { seat: string; provider: string | null; model: string | null; label: string | null; error: string | null } | null;
}

/** The seat file's name, as `writeSeatReports` writes it: `<report base>.seat-<k>.json`. */
const SEAT_FILE = /^(plan-critique|code-review)-(\d+)\.seat-(\d+)\.json$/;

/**
 * The seats of one round, `k` ascending, or empty when the listing holds no
 * seat file for it - a round without finders, or a run from before the core
 * kept them - so such a round draws exactly what it drew before.
 *
 * Classified here rather than by `classify`, which keeps one round number per
 * name: a seat file classified as a review would add a section of its own.
 * The seats a file is missing for come from the merge frame's `finders`, the
 * count of seats that sat (never the configured count), each with the failure
 * the frame closed for it when it has one.
 */
export function seatSlots(
  entries: readonly ArtifactEntry[],
  kind: 'review' | 'critique',
  round: number,
  merge: {
    finders: number;
    failed: readonly { finder: number | null; seat: string; provider?: string | null; model?: string | null; label: string | null; error: string | null }[];
  } | null,
): SeatSlot[] {
  const base = kind === 'review' ? 'code-review' : 'plan-critique';
  const files = new Map<number, string>();
  for (const e of entries) {
    if (e.kind !== 'file') continue;
    const m = SEAT_FILE.exec(e.name);
    if (m === null || m[1] !== base || Number(m[2]) !== round) continue;
    const k = Number(m[3]);
    if (Number.isFinite(k)) files.set(k, e.name);
  }
  if (files.size === 0) return [];
  const ks = new Set(files.keys());
  if (merge !== null) for (let k = 0; k < merge.finders; k++) ks.add(k);
  return [...ks]
    .sort((a, b) => a - b)
    .map((k) => {
      const f = merge?.failed.find((x) => x.finder === k) ?? null;
      return {
        k,
        name: files.get(k) ?? null,
        failure:
          f === null
            ? null
            : { seat: f.seat, provider: f.provider ?? null, model: f.model ?? null, label: f.label, error: f.error },
      };
    });
}

/** One seat's own report: who it was, and the report as `readReport` reads it. */
export interface SeatReport {
  seat: string | null;
  provider: string | null;
  model: string | null;
  report: Report;
}

/**
 * A seat file, or null when it is not JSON or not a report. The seat's own
 * keys (`seat`, `provider`, `model`) drop alone when unreadable, as every
 * other reader here drops a field.
 */
export function readSeatReport(text: string): SeatReport | null {
  const report = readReport(text);
  if (report === null) return null;
  let root: Record<string, unknown> | null = null;
  try {
    root = record(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
  return {
    seat: str(root?.['seat']),
    provider: str(root?.['provider']),
    model: str(root?.['model']),
    report,
  };
}

/**
 * A seat's name on its tab: `<seat> <provider>/<model>` where the file or the
 * failure says them, the seat's config path alone where only that is known,
 * and its finder number where nothing is - never a vendor guessed from a path.
 */
export function seatLabel(slot: SeatSlot, read: SeatReport | null): string {
  const seat = read?.seat ?? slot.failure?.seat ?? null;
  const provider = read?.provider ?? slot.failure?.provider ?? null;
  const model = read?.model ?? slot.failure?.model ?? null;
  if (seat === null) return slot.k === 0 ? 'first seat' : `finder ${String(slot.k)}`;
  return provider !== null && model !== null ? `${seat} ${provider}/${model}` : seat;
}

/**
 * The merged finding a seat's own finding went into, by the `foundBy` entry
 * naming that seat and that id - the seat's own ids are the ids `foundBy`
 * names. Null when no merged finding names it.
 */
export function mergedAs(merged: readonly FullFinding[], seat: string | null, id: string): string | null {
  if (seat === null) return null;
  return merged.find((f) => f.foundBy?.some((b) => b.seat === seat && b.id === id) === true)?.id ?? null;
}

// ---- the near pairs the fixer was told about (#462, #530) -------------------

/** One pair of findings the fix prompt named as possibly one defect. */
export interface NearPair {
  first: string;
  second: string;
  path: string | null;
  gap: number | null;
}

/**
 * `fix-near-pairs-<n>.json`, or null when it is not JSON. A pair this build
 * cannot read (no two ids) is dropped alone; a missing `path` or `gap` drops
 * that key's words, not the pair.
 */
export function readNearPairs(text: string): { answers: number | null; pairs: readonly NearPair[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const root = record(parsed);
  if (root === null) return null;
  const pairs: NearPair[] = [];
  for (const item of Array.isArray(root['pairs']) ? (root['pairs'] as unknown[]) : []) {
    const row = record(item);
    if (row === null) continue;
    const first = str(row['first']);
    const second = str(row['second']);
    if (first === null || second === null) continue;
    pairs.push({ first, second, path: str(row['path']), gap: num(row['gap']) });
  }
  return { answers: num(root['answers']), pairs };
}

/**
 * What one finding's fold says about the pairs it is in: *"may be the same
 * defect as b, the fixer was told (both cite src/a.ts, 1 line apart)"*. Both
 * findings of a pair get a line, each naming the other. Empty for a finding in
 * no pair.
 */
export function nearLines(id: string, pairs: readonly NearPair[]): string[] {
  return pairs.flatMap((p) => {
    const other = p.first === id ? p.second : p.second === id ? p.first : null;
    if (other === null) return [];
    const where =
      p.path === null
        ? ''
        : p.gap === null
          ? ` (both cite ${p.path})`
          : ` (both cite ${p.path}, ${p.gap === 0 ? 'on the same line' : `${String(p.gap)} line${p.gap === 1 ? '' : 's'} apart`})`;
    return [`may be the same defect as ${other}, the fixer was told${where}`];
  });
}
