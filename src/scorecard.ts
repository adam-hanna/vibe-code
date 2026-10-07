import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EXIT } from '@src/charge.js';
import { LINKED_STATUS, listRuns, RUNS_DIR, UNVERIFIED_STATUS } from '@src/run.js';
import type { RunSummary } from '@src/types.js';

/**
 * What twenty-six run records say about the loop, and what they do not.
 *
 * `.vibe/runs/` has been accumulating since the first release and nothing read
 * any of it: `vibe list` prints id, status, cost and time, and there was no
 * command that answered a question about the *loop*. The evidence that this was
 * needed is that it kept being done by hand - #66, #63 and #104 each needed a
 * throwaway script against the archive, and each script was deleted afterwards,
 * so the next question started from nothing.
 *
 * ## The one rule this module is built around
 *
 * **A rate is not a number, it is a fraction, and the denominator is part of the
 * answer.** Almost every field here was added to `RunState` at some point, so
 * most runs in any real archive predate most fields. The census that settled the
 * shape of this module: of 265 turns recorded across 26 runs, **34 carry
 * `toolItems`** - the per-turn item counts #66 added. A scorecard that reported
 * "1 of 27 review turns ran no tools" over a population where 26 of those 27
 * never recorded the fact would be the exact fabrication this codebase refuses
 * everywhere else, and it would look authoritative.
 *
 * So every derived count is a `Measure`: what matched, what could be asked, and
 * what could not. A dimension nothing recorded reports `measured: 0`, which
 * renders as absent rather than as zero.
 *
 * ## What it does not compute, and will not
 *
 * `UNMEASURABLE` names four dimensions the literature would expect and this
 * archive cannot support, each with the thing that would be needed. They are in
 * the output rather than omitted from it: a scorecard silently missing recall is
 * one a reader assumes was fine.
 *
 * ## What it never does
 *
 * Writes. `listRuns` promises never to throw and never to write, this reads what
 * that returned, and a stats pass leaves every byte under `.vibe/runs/` as it
 * found it.
 */

/** Bumped when a field here changes meaning, so a reader can refuse a shape it does not know. */
export const SCORECARD_VERSION = 1;

/**
 * A count and the population it was counted over.
 *
 * `matched <= measured`, and `measured + unmeasured` is the whole population -
 * so a reader can always tell "none of them did" from "none of them said".
 * Rendering divides by `measured` and never by the total, and prints nothing at
 * all when `measured` is zero.
 */
export interface Measure {
  matched: number;
  measured: number;
  unmeasured: number;
}

/** How many runs, of what, keyed by whatever the archive actually held. */
export type Tally = Record<string, number>;

/** Why an entry contributed nothing, in the vocabulary `vibe list` already uses. */
export interface SkippedEntry {
  id: string;
  reason: string;
}

/** One counter's shape across the archive: the histogram, not a mean. */
export interface RoundCensus {
  /** How many runs recorded this counter at all. */
  measured: number;
  unmeasured: number;
  total: number;
  max: number;
  /** `{"0": 12, "1": 9, "3": 1}` - the distribution, which is the thing #136 wants. */
  histogram: Tally;
}

export interface TurnCensus {
  turns: number;
  tokens: number;
  /**
   * Null where nothing reported one, which for every Codex turn is always.
   *
   * Not zero, and not derived from a price table: no `codex exec` output mode
   * returns a cost and no app-server endpoint returns money. A settled decision,
   * and this is the report that would otherwise be tempted to invent it.
   */
  costUsd: number | null;
  /** Turns whose `toolItems` was zero, over turns that recorded `toolItems` at all (#66). */
  inert: Measure;
}

export interface Scorecard {
  version: number;
  archive: {
    root: string;
    /** Entries `vibe list` would show, which is the population this is honest about. */
    entries: number;
    read: number;
    /** Counted and named, never dropped: a scorecard that quietly ignored three runs is the overclaim this exists to prevent. */
    skipped: SkippedEntry[];
  };
  endings: {
    byStatus: Tally;
    /** Exit codes from `escalation` events - a run may have escalated more than once across resumes. */
    byExitCode: Tally;
    /** Runs that recorded at least one `resume_config`, over runs that could be read. */
    resumed: Measure;
    /** Turns a process died inside, recovered by the next one (#77). */
    interruptedTurns: number;
  };
  rounds: Record<'plan' | 'question' | 'review' | 'verify', RoundCensus>;
  /** How often the carried-P1 final round fired, over runs that got as far as reviewing. */
  finalFix: Measure;
  gates: {
    /** Runs carrying `gateOutcomes` at all (#47). */
    recorded: Measure;
    /**
     * The gate's state when the run ended, from `gateOutcomes`.
     *
     * Terminal, and that is the whole reason `attempts` exists beside it: a gate
     * that failed twice and then passed is recorded here as `passed`, because
     * that is what it finished as. Reading failure rates off this would say the
     * archive has never seen a gate fail, which is false.
     */
    byName: Record<string, Tally>;
    /**
     * Every execution, from the `verify_passed` / `verify_failed` events.
     *
     * The only place a gate's failures survive: `gateOutcomes` keeps one row per
     * gate and overwrites it, so "how often does a gate fail" is a question only
     * the event log can answer.
     */
    attempts: Record<string, Tally>;
    /** Runs where one named gate failed more than once - a run not converging, rather than two runs recovering. */
    repeatedFailure: Measure;
  };
  findings: {
    downgraded: number;
    /** The severity each was downgraded FROM. */
    byFrom: Tally;
    /** The evidence kinds each offered, as a sorted comma-joined key - `""` for a finding that offered none. */
    byKinds: Tally;
  };
  turns: {
    total: number;
    /** Keyed by the turn's label with its round number replaced by `N`: `critique-N`, `plan`. */
    byLabel: Record<string, TurnCensus>;
    inert: Measure;
  };
  questions: {
    /** Runs that asked the answerer anything, over runs that could be read. */
    asking: Measure;
    answered: number;
    deferred: number;
    /** Re-asks the rephrasing guard suppressed (#65) - `measured: 0` on any archive older than it. */
    suppressed: Measure;
    /** Questions a human answered in NEEDS-INPUT.md (#65). */
    resolvedByHuman: Measure;
  };
  unmeasurable: readonly { dimension: string; why: string }[];
}

/**
 * The four dimensions the obvious metric set would include and this archive
 * cannot support.
 *
 * Reported rather than omitted, and each names the thing that would supply it -
 * so the answer to "why is recall not here" is in the output instead of being a
 * question somebody asks and then re-derives.
 */
export const UNMEASURABLE: readonly { dimension: string; why: string }[] = [
  {
    dimension: 'defect recall',
    why: 'needs the defects nobody reported, which needs a seeded-defect suite',
  },
  {
    dimension: 'finding precision',
    why: 'finding_downgraded gives the UNGROUNDED rate, not the WRONG rate - a finding can be perfectly grounded and false, which is #44',
  },
  {
    dimension: 'reviewer uplift',
    why: 'needs the same task run without a reviewer',
  },
  {
    dimension: 'correlated miss rate',
    why: 'needs the misses',
  },
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function counter(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

function bump(tally: Tally, key: string, by = 1): void {
  // `Object.create(null)` would be cleaner but does not survive `JSON.stringify`
  // round-tripping as a plain object, and this shape IS the JSON contract.
  tally[key] = (tally[key] ?? 0) + by;
}

function measure(): Measure {
  return { matched: 0, measured: 0, unmeasured: 0 };
}

/** Record one observation: matched, measured-and-did-not-match, or unmeasurable. */
function observe(m: Measure, value: boolean | null): void {
  if (value === null) {
    m.unmeasured += 1;
    return;
  }
  m.measured += 1;
  if (value) m.matched += 1;
}

function census(): RoundCensus {
  return { measured: 0, unmeasured: 0, total: 0, max: 0, histogram: {} };
}

function countRound(c: RoundCensus, v: unknown): void {
  const n = counter(v);
  if (n === null) {
    c.unmeasured += 1;
    return;
  }
  c.measured += 1;
  c.total += n;
  c.max = Math.max(c.max, n);
  bump(c.histogram, String(n));
}

/**
 * A turn label with its round number folded away: `critique-3` -> `critique-N`.
 *
 * Grouped because the question is what a *kind* of turn costs, and a label
 * carrying a round number would make 61 critique turns into 61 groups of one.
 * The trailing-number rule is the labels' own convention - see the `label`
 * arguments in `runTurn`'s callers - and a label that does not follow it is
 * grouped under itself rather than forced into a shape it never had.
 */
function labelFamily(label: string): string {
  return label.replace(/-\d+$/, '-N');
}

/**
 * Read every run the archive will show, and count what it recorded.
 *
 * **`listRuns` does the walking, and this does not do it again.** That matters
 * for more than duplication: `listRuns` is the one thing that decides what an
 * archive entry *is* - a real directory, a symlink (#53), something `lstat`
 * could not classify - and a scorecard that classified entries itself could
 * disagree with `vibe list` about which runs exist. The cost is that a readable
 * run's `state.json` is opened twice, once there for the row and once here for
 * the counts, which is one extra read per run on a command nobody runs in a
 * loop.
 */
export function scoreArchive(targetDir: string): Scorecard {
  const rows = listRuns(targetDir);
  const card: Scorecard = {
    version: SCORECARD_VERSION,
    archive: { root: path.join(targetDir, RUNS_DIR), entries: rows.length, read: 0, skipped: [] },
    endings: { byStatus: {}, byExitCode: {}, resumed: measure(), interruptedTurns: 0 },
    rounds: { plan: census(), question: census(), review: census(), verify: census() },
    finalFix: measure(),
    gates: { recorded: measure(), byName: {}, attempts: {}, repeatedFailure: measure() },
    findings: { downgraded: 0, byFrom: {}, byKinds: {} },
    turns: { total: 0, byLabel: {}, inert: measure() },
    questions: {
      asking: measure(),
      answered: 0,
      deferred: 0,
      suppressed: measure(),
      resolvedByHuman: measure(),
    },
    unmeasurable: UNMEASURABLE,
  };

  for (const row of rows) {
    const skip = skipReason(row);
    if (skip !== null) {
      card.archive.skipped.push({ id: row.id, reason: skip });
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(
        readFileSync(path.join(targetDir, RUNS_DIR, row.id, 'state.json'), 'utf8'),
      );
    } catch {
      // Reachable even though `listRuns` just read the same file: it is a second
      // open, and the run may have been removed between them. Counted as
      // skipped rather than as a read that produced nothing.
      card.archive.skipped.push({ id: row.id, reason: 'state.json could not be read' });
      continue;
    }
    // Defence in depth rather than the usual path: `summariseStored` already
    // calls a non-record `unreadable`, so `skipReason` above catches this first
    // for anything that came through `listRuns`. Kept because the alternative is
    // `countRun` indexing an array.
    if (!isRecord(raw)) {
      card.archive.skipped.push({ id: row.id, reason: 'state.json is not an object' });
      continue;
    }
    card.archive.read += 1;
    countRun(card, raw);
  }
  return card;
}

/**
 * Why this row contributes no counts, or null if it does.
 *
 * The three verdicts `listRuns` already produces, kept in its vocabulary rather
 * than re-derived: `linked` is measured (#53), `unverified` failed closed
 * because nothing under an entry `lstat` could not classify may be followed, and
 * `unreadable` means a `state.json` that WAS opened and did not parse.
 */
function skipReason(row: RunSummary): string | null {
  if (row.status === LINKED_STATUS) return 'the entry is a symlink and is not followed';
  if (row.status === UNVERIFIED_STATUS) return 'the entry could not be classified, so it is not opened';
  if (row.status === 'unreadable') return 'state.json could not be read';
  return null;
}

function countRun(card: Scorecard, raw: Record<string, unknown>): void {
  const status = raw['status'];
  bump(card.endings.byStatus, typeof status === 'string' ? status : 'unrecorded');

  countRound(card.rounds.plan, raw['planRound']);
  countRound(card.rounds.question, raw['questionRound']);
  countRound(card.rounds.review, raw['reviewRound']);
  countRound(card.rounds.verify, raw['verifyRound']);

  const events = Array.isArray(raw['events']) ? raw['events'] : [];
  let resumed = false;
  let reviewed = false;
  let attempted = false;
  // Per run, so a gate that failed once in each of two runs reads as two runs
  // recovering and a gate that failed twice in one run reads as a run that is
  // not converging - which are the two different things #114 asks to tell apart.
  const failures: Tally = {};
  for (const e of events) {
    if (!isRecord(e)) continue;
    const type = e['type'];
    if (type === 'escalation') {
      const code = e['code'];
      bump(card.endings.byExitCode, typeof code === 'number' ? String(code) : 'unrecorded');
    } else if (type === 'resume_config') {
      resumed = true;
    } else if (type === 'interrupted_turn') {
      card.endings.interruptedTurns += 1;
    } else if (type === 'finding_downgraded') {
      countDowngrade(card, e);
    } else if (type === 'verify_passed' || type === 'verify_failed') {
      // Named gates arrived with #47, so an event from before it carries no
      // `gate` and is grouped under the fact rather than under a name invented
      // for it - those runs had one gate and never said so.
      const gate = e['gate'];
      const name = typeof gate === 'string' && gate !== '' ? gate : 'gate not recorded';
      bump((card.gates.attempts[name] ??= {}), type === 'verify_passed' ? 'passed' : 'failed');
      attempted = true;
      if (type === 'verify_failed') bump(failures, name);
    } else if (type === 'claude_turn' || type === 'codex_turn') {
      const label = e['label'];
      if (labelFamily(typeof label === 'string' ? label : '').startsWith('review-')) reviewed = true;
      countTurn(card, type, e);
    }
  }
  observe(card.endings.resumed, resumed);
  // Only a run that ran a gate can say whether one failed twice. A run with
  // verification off, or one recorded before these events existed, is unmeasured
  // rather than a confident "no" - which over an archive of them would report a
  // 0% failure rate the runs never claimed.
  observe(card.gates.repeatedFailure, attempted ? Object.values(failures).some((n) => n > 1) : null);

  // The denominator is runs that got as far as reviewing, detected from a review
  // turn actually happening rather than from `phase`: a plan-only run and a run
  // that stalled in planning never had the opportunity to run a final fix, and
  // counting them would make the rate say something about the wrong population.
  observe(card.finalFix, reviewed ? raw['finalFixDone'] === true : null);

  countGates(card, raw['gateOutcomes']);
  countQuestions(card, raw);
}

function countDowngrade(card: Scorecard, e: Record<string, unknown>): void {
  card.findings.downgraded += 1;
  const from = e['from'];
  bump(card.findings.byFrom, typeof from === 'string' ? from : 'unrecorded');
  // The kinds it OFFERED, joined and sorted so `["code","absence"]` and
  // `["absence","code"]` are one key. `reason` is deliberately NOT tallied: it
  // is prose assembled per finding - "the excerpt does not appear in src/cli.ts"
  // - so grouping it would mean matching English, which is the thing #133 exists
  // to stop the product doing anywhere.
  const kinds = e['kinds'];
  const list = Array.isArray(kinds) ? kinds.filter((k): k is string => typeof k === 'string') : [];
  bump(card.findings.byKinds, [...new Set(list)].sort().join(','));
}

function countTurn(card: Scorecard, type: string, e: Record<string, unknown>): void {
  card.turns.total += 1;
  const label = e['label'];
  const key = labelFamily(typeof label === 'string' && label !== '' ? label : 'unlabelled');
  const seen = (card.turns.byLabel[key] ??= { turns: 0, tokens: 0, costUsd: null, inert: measure() });
  seen.turns += 1;

  const tokens = e['tokens'];
  if (typeof tokens === 'number' && Number.isFinite(tokens)) seen.tokens += tokens;

  // Accumulated only where a figure exists, and left null where none ever did -
  // which is every `codex_turn`. A zero here would say a Codex turn was free.
  const cost = e['costUsd'];
  if (type === 'claude_turn' && typeof cost === 'number' && Number.isFinite(cost)) {
    seen.costUsd = (seen.costUsd ?? 0) + cost;
  }

  // The measure this module was shaped around. `toolItems` arrived with #66, so
  // most turns in any archive older than it carry none - and "this turn used no
  // tools" and "nothing counted this turn's tools" are the two answers that must
  // never be added together.
  const toolItems = e['toolItems'];
  const inert = typeof toolItems === 'number' ? toolItems === 0 : null;
  observe(seen.inert, inert);
  observe(card.turns.inert, inert);
}

function countGates(card: Scorecard, raw: unknown): void {
  if (!Array.isArray(raw)) {
    observe(card.gates.recorded, null);
    return;
  }
  observe(card.gates.recorded, true);
  for (const g of raw) {
    if (!isRecord(g)) continue;
    const name = g['name'];
    const status = g['status'];
    if (typeof name !== 'string' || typeof status !== 'string') continue;
    bump((card.gates.byName[name] ??= {}), status);
  }
}

function countQuestions(card: Scorecard, raw: Record<string, unknown>): void {
  const answered = raw['answeredQuestions'];
  const deferred = raw['deferredQuestions'];
  const answeredCount = Array.isArray(answered) ? answered.length : null;
  card.questions.answered += answeredCount ?? 0;
  card.questions.deferred += Array.isArray(deferred) ? deferred.length : 0;
  observe(card.questions.asking, answeredCount === null ? null : answeredCount > 0);

  // Both optional fields, and both genuinely absent from every run recorded
  // before #65 - which on the archive that motivated this issue is all of them.
  // `measured: 0` is the whole point: it renders as "not recorded by any run"
  // rather than as a confident zero.
  const suppressed = raw['suppressedQuestions'];
  observe(card.questions.suppressed, Array.isArray(suppressed) ? suppressed.length > 0 : null);
  const byHuman = raw['humanAnswered'];
  observe(card.questions.resolvedByHuman, Array.isArray(byHuman) ? byHuman.length > 0 : null);
}

/**
 * The scorecard as lines for a terminal.
 *
 * A function over the document rather than printing as it counts, so `--json`
 * and the table are the same measurement rendered twice and cannot drift - and
 * so this is testable, which a `console.log` in `cli.ts` would not be.
 */
export function renderScorecard(card: Scorecard): string[] {
  const out: string[] = [];
  const { archive } = card;
  out.push(`${archive.read} run(s) read of ${archive.entries} in ${archive.root}`);
  for (const s of archive.skipped) out.push(`  skipped ${s.id}: ${s.reason}`);
  if (archive.read === 0) {
    out.push('  nothing to report - no run record could be read');
    return out;
  }

  out.push('', 'How runs ended');
  for (const [status, n] of sorted(card.endings.byStatus)) out.push(`  ${pad(status)} ${n}`);
  out.push(`  ${pad('resumed')} ${rate(card.endings.resumed, 'run', 'runs')}`);
  if (card.endings.interruptedTurns > 0) {
    out.push(`  ${pad('turns interrupted')} ${card.endings.interruptedTurns}`);
  }
  // Below the statuses and labelled as events, because they are not the same
  // fact: a run can escalate, be resumed past it and finish `done`, so these
  // count places the loop gave up rather than runs that ended there.
  if (Object.keys(card.endings.byExitCode).length > 0) {
    out.push('  escalations (a run may be resumed past one):');
    for (const [code, n] of sorted(card.endings.byExitCode)) {
      out.push(`    ${pad(exitName(code))} ${n}`);
    }
  }

  // The counters' own names, which are not the words a reader would guess:
  // `reviewRound` counts FIX rounds rather than reviews, and the run summary
  // already prints it as "fix round(s)". Two vocabularies for one number is how
  // a report gets misread.
  out.push('', 'Rounds per run');
  const ROUND_NAMES: Record<string, string> = {
    plan: 'plan revisions',
    question: 'question rounds',
    review: 'fix rounds',
    verify: 'verify fix rounds',
  };
  for (const [name, c] of Object.entries(card.rounds)) {
    out.push(`  ${pad(ROUND_NAMES[name] ?? name)} ${describeRounds(c)}`);
  }
  out.push(`  ${pad('final fix round')} ${rate(card.finalFix, 'reviewed run', 'reviewed runs')}`);

  out.push('', 'Turns  (cost is Claude-side and API-equivalent; Codex reports none)');
  for (const [label, t] of Object.entries(card.turns.byLabel).sort((a, b) => b[1].turns - a[1].turns)) {
    const cost = t.costUsd === null ? 'cost not reported' : `~$${t.costUsd.toFixed(2)}`;
    out.push(`  ${pad(label)} ${String(t.turns).padStart(4)}  ${fmt(t.tokens).padStart(11)} tok  ${cost}`);
  }
  out.push(`  ${pad('ran no tools')} ${rate(card.turns.inert, 'turn', 'turns')}`);

  out.push('', 'Verification gates');
  out.push(`  ${pad('runs recording outcomes')} ${rate(card.gates.recorded, 'run', 'runs')}`);
  for (const [name, statuses] of Object.entries(card.gates.attempts)) {
    out.push(`  ${pad(`${name} (every run)`)} ${sorted(statuses).map(([s, n]) => `${n} ${s}`).join(', ')}`);
  }
  for (const [name, statuses] of Object.entries(card.gates.byName)) {
    out.push(`  ${pad(`${name} (at the end)`)} ${sorted(statuses).map(([s, n]) => `${n} ${s}`).join(', ')}`);
  }
  out.push(
    `  ${pad('failed twice in one run')} ${rate(card.gates.repeatedFailure, 'run that ran a gate', 'runs that ran a gate')}`,
  );

  out.push('', 'Findings downgraded');
  out.push(`  ${pad('total')} ${card.findings.downgraded}`);
  for (const [from, n] of sorted(card.findings.byFrom)) out.push(`  ${pad(`from ${from}`)} ${n}`);
  for (const [kinds, n] of sorted(card.findings.byKinds)) {
    out.push(`  ${pad(`evidence ${kinds === '' ? 'none' : kinds}`)} ${n}`);
  }

  out.push('', 'Questions');
  out.push(`  ${pad('runs that asked')} ${rate(card.questions.asking, 'run', 'runs')}`);
  out.push(`  ${pad('answered')} ${card.questions.answered}`);
  out.push(`  ${pad('deferred to a human')} ${card.questions.deferred}`);
  out.push(`  ${pad('re-asks suppressed')} ${rate(card.questions.suppressed, 'run', 'runs')}`);
  out.push(`  ${pad('answered by a human')} ${rate(card.questions.resolvedByHuman, 'run', 'runs')}`);

  out.push('', 'Not measured, and not estimated');
  for (const u of card.unmeasurable) out.push(`  ${pad(u.dimension)} ${u.why}`);
  return out;
}

function pad(s: string): string {
  return `${s}:`.padEnd(26);
}

/**
 * An exit code with the name `EXIT` gives it, or the bare number.
 *
 * Derived from the map rather than restated beside it, so a code added to
 * `EXIT` is named here without anyone remembering to - and a code this build
 * does not know renders as itself rather than as a phrase invented for it, which
 * is the rule `app/src/cockpit/format.ts` already follows for the same eight
 * numbers.
 */
function exitName(code: string): string {
  const found = Object.entries(EXIT).find(([, v]) => String(v) === code);
  return found === undefined ? code : `${code} ${found[0].toLowerCase().replace(/_/g, '-')}`;
}

function sorted(t: Tally): [string, number][] {
  return Object.entries(t).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * A fraction, or the reason there is not one.
 *
 * The whole module in one function: when nothing recorded the fact there is no
 * percentage to print, and printing `0%` over an unmeasured population is the
 * failure this exists to prevent. The unmeasured count rides along even when
 * there IS a fraction, because "3 of 5, 21 could not say" and "3 of 5" are
 * different confidences in the same number.
 */
function rate(m: Measure, one: string, many: string): string {
  if (m.measured === 0) {
    return `not recorded by any ${one} (${m.unmeasured} could not say)`;
  }
  const pct = Math.round((m.matched / m.measured) * 100);
  const caveat = m.unmeasured === 0 ? '' : `, ${m.unmeasured} could not say`;
  return `${m.matched} of ${m.measured} ${m.measured === 1 ? one : many} - ${pct}%${caveat}`;
}

function describeRounds(c: RoundCensus): string {
  if (c.measured === 0) return `not recorded by any run (${c.unmeasured} could not say)`;
  // The histogram is the answer, not the mean: "2.7 plan rounds" describes no run
  // that ever happened, and the shape - one run at ten, most at one or two - is
  // the thing #136 wants and the thing a mean hides.
  const shape = sorted(c.histogram)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([n, runs]) => `${n}x${runs}`)
    .join(' ');
  const caveat = c.unmeasured === 0 ? '' : `, ${c.unmeasured} could not say`;
  return `${c.total} over ${c.measured} ${c.measured === 1 ? 'run' : 'runs'}, max ${c.max}  [${shape}]${caveat}`;
}
