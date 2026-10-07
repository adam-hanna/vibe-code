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
export type ArtifactKind = 'plan' | 'critique' | 'review' | 'answers' | 'other';

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
  deferred: boolean;
  downgraded: { from: string; reason: string } | null;
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
        // `=== true`, so a report that does not carry the field is not read as
        // having said no. It means the same thing here, and the coercion is the
        // one that cannot become wrong later.
        deferred: row['defer'] === true,
        downgraded: from === null || reason === null ? null : { from, reason },
      });
    }
  }
  return { verdict: str(root['verdict']), summary: str(root['summary']), findings };
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
