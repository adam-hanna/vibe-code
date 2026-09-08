import type { Frame, Level } from '../host';

/**
 * The run, assembled from frames and from nothing else (#159).
 *
 * **This is the only file in the app with logic, and it is pure on purpose.**
 * Every card the cockpit draws comes from a frame it was sent: no phase inferred
 * from a sentence, no default filled in for a field a frame did not carry, no
 * quantity computed out of two others. `src/protocol.ts` defines what arrives
 * and this follows it - the moment the cockpit starts computing what it thinks
 * the run is doing, there are two answers to that question and the wrong one is
 * the one on screen.
 *
 * The narration ids exist so this is possible. A cockpit that matched English
 * would break the next time somebody improved a sentence, which is the failure
 * #133 was written to prevent.
 *
 * ## Two clocks, and they are not the same measurement
 *
 * `heartbeat.elapsedMs` is the **loop's** measurement of the turn it is in, and
 * it is authoritative. It arrives every 30 seconds (`progress.intervalMs`), so a
 * display that only moved when one landed would look frozen for half a minute
 * at a time.
 *
 * So a turn carries `startedAt` on **our** clock, and every heartbeat re-anchors
 * it to `now - elapsedMs`. Between beats the display ticks locally; on each beat
 * it snaps back to what the loop says. Neither number is invented and the
 * authoritative one always wins.
 */

/** The three convergence cycles. Not three stages - see the domain model. */
export type CycleKind = 'plan' | 'code' | 'review';

/**
 * Which cycle a phase belongs to.
 *
 * `critique` is in the plan cycle rather than beside it because a plan round IS
 * the pair: the planner produces a version, the critic judges it. `verify` has
 * no `phase_started` of its own - it announces itself with `verify_started` -
 * and belongs to the code cycle.
 */
export const CYCLE_OF: Readonly<Record<string, CycleKind>> = {
  planning: 'plan',
  critique: 'plan',
  implementing: 'code',
  review: 'review',
};

/** What the heartbeat measured. Every field is a field the record carried. */
export interface Beat {
  /** The loop's own measurement of this turn, in ms. */
  elapsedMs: number;
  activities: number;
  /** 'tool use' or 'event' - they do not count the same thing. */
  unit: string;
  tokens: number;
  promptTokens: number;
  /** Absent when the stream supplied none. Never "" and never a guess. */
  lastActivity: string | null;
  /** Absent until some turn under this model has reported one. */
  contextWindow: number | null;
  /**
   * How far apart the beats are, as the loop's own timer reports it (#223).
   *
   * **What makes the staleness threshold derived rather than picked.** The design
   * leaves exactly one judgement open in `7c` - how stale is stale - and answers
   * it itself: that is a question about vibe's heartbeat cadence, so the answer
   * is a few missed ticks, and only the loop knows the cadence. Null on a core
   * that predates the field, and the pane says it cannot tell rather than
   * choosing a number here.
   */
  intervalMs: number | null;
  /**
   * How long since the CHILD last wrote a line, at the moment of this beat.
   *
   * The second of `7c`'s two clocks, and the one the first cannot substitute
   * for: a beat fires on a timer whether or not the child said anything, so its
   * arrival proves *vibe* is alive and proves nothing about the turn. Null when
   * the child has written nothing at all, which is a different fact from zero.
   */
  sinceOutputMs: number | null;
  /** When this beat reached us. The liveness signal, on our clock. */
  at: number;
}

/**
 * What a work reading measured (#198).
 *
 * The tree as git described it, sampled during a write turn. Every field is a
 * field the record carried, and the two kinds of missing are kept apart exactly
 * as `workData` sends them: `files: 0` is a measurement - the turn has changed
 * nothing yet - while an absent `insertions` means git could not be asked, and
 * rendering the second as `+0` would be a number nobody produced.
 */
export interface Work {
  /** How many paths the turn has changed. A real zero is possible and means it. */
  files: number;
  /** Absent when git could not count lines. Never zero for "unknown". */
  insertions: number | null;
  deletions: number | null;
  /** Files whose lines could not be counted, which is what makes the above an undercount. */
  uncounted: number | null;
  /**
   * The proxy, or null when the plan named no files to be a proxy over.
   *
   * **Not a denominator for a bar**, and `src/work.ts` says why in its own words:
   * `9/14` beside a bar reads as a position in the plan's list of steps and this
   * measurement is not one. It is rendered as a count of files, in a sentence
   * naming whose count it is.
   */
  plan: { named: number; touched: number } | null;
  /** When this reading reached us. */
  at: number;
}

export interface Turn {
  id: number;
  role: string;
  kind: string;
  /** The archive's round, which is the one that names the artifact. Null when the frame carried none. */
  round: number | null;
  /** Our clock, re-anchored by every beat to the loop's own figure. */
  startedAt: number;
  endedAt: number | null;
  beat: Beat | null;
  /** The most recent work reading, or null before one has arrived. */
  work: Work | null;
}

export interface PhaseGroup {
  id: number;
  phase: string;
  round: number | null;
  startedAt: number;
  turns: Turn[];
  /** Verification gates opened during this phase, by name, in order. */
  gates: string[];
}

export interface Cycle {
  kind: CycleKind;
  phases: PhaseGroup[];
}

/**
 * The step that runs before the first phase (#205).
 *
 * Preflight spawns a probe turn against each agent, and until #205 it narrated
 * nothing between starting and reporting - so the seconds after the one action
 * a new user knows how to take were seconds in which the window could say
 * nothing true. This is what it says instead.
 *
 * **Nothing here is a fraction of the run.** `agents` is the list preflight was
 * about to probe, in the order it will probe them, sent by the site that owns
 * that order; a position in a named list is not a proxy for how far through
 * anything is, and there is deliberately no bar.
 */
export interface Preflight {
  /** Who this run probes, in order. Empty when only a probe frame was seen. */
  agents: readonly string[];
  /** The agent being probed now. Null before the first and after the verdict. */
  probing: string | null;
  /** Set when the toolchain contract was satisfied. A failure is `reason`. */
  passed: boolean;
  /**
   * When preflight started, on our clock (hi-fi 16).
   *
   * **This is what makes it a live card rather than a spinner.** Preflight is a
   * real turn against a real CLI, so it gets the treatment a turn gets - a
   * pulsing dot and an elapsed time - and the elapsed time is measured from
   * here. A spinner would say the same thing while measuring nothing.
   */
  at: number;
}

/**
 * One gate, as the loop observed it (#223, `5d`).
 *
 * **A whole-gate verdict, and deliberately not a per-test table.** `vibe` reads
 * exit codes and parses nobody's reporter, and #135 chose that on purpose: a
 * per-test table means tracking TAP, JUnit XML and `node --test` output for
 * ever, a standing maintenance liability bought for a column in a UI. So this
 * carries what the loop actually measured and nothing more.
 */
export interface GateRun {
  name: string;
  /** `running` until a verdict frame settles it. Never inferred from silence. */
  status: 'running' | 'passed' | 'failed' | 'unavailable' | 'disabled';
  /** The exact command, or null when nothing ran. `5d` prints it. */
  command: string | null;
  /** How many attempts were made. Zero on the paths where nothing ran. */
  runs: number;
  /** How many of them failed. Null unless the gate failed. */
  failed: number | null;
  /**
   * `verdictOf`'s answer, verbatim, or null.
   *
   * **`flaky` and `failing` are different findings about a suite and only one of
   * them is about the code**, which is why this is carried rather than derived
   * from the fraction: `runs: 1` that failed is `failing` and never `flaky`,
   * because one sample says nothing about determinism, and a window computing
   * `failed < runs` would call it flaky.
   */
  verdict: string | null;
  /** Why an unavailable gate was unavailable. Null otherwise. */
  reason: string | null;
  /**
   * What every attempt did, in order, or empty.
   *
   * **This is what makes `5d`'s run cards honest.** Without it the pane knew
   * only "1 of 3 failed" and would have had to place that failure among three
   * slots and guess at the other two - and which run failed is precisely the
   * information that separates a broken suite from a noisy one. Empty for a
   * gate that never ran, and for a core that predates the field.
   */
  attempts: readonly { run: number; ok: boolean; exitCode: number | null }[];
  startedAt: number;
  endedAt: number | null;
}

/** One pass of the verification gate, which is a list of gates in order. */
export interface VerifyPass {
  /** The archive's round, which is what the artifacts are keyed by. */
  round: number | null;
  gates: readonly GateRun[];
  at: number;
}

/**
 * One finding, at the density a frame carries it (#223, `1e`/`4c`).
 *
 * Deliberately not the whole `Finding`: the detail and the suggested fix stay in
 * the round's artifact, because a frame carrying every finding in full would put
 * a review's whole prose on the wire every round.
 */
export interface FindingRow {
  id: string;
  severity: string;
  title: string;
  /**
   * Who raised it, or null (#141).
   *
   * **Absent is not "an agent".** Every finding in every archive written before
   * that field existed has none, and `authorOf` narrows rather than guessing -
   * so a renderer that cannot name the author names nobody.
   */
  raisedBy: string | null;
  /**
   * How many places the finding cites. Zero is what `4c` flags as **ungrounded**.
   *
   * A count rather than the entries, because what the pane needs to know is that
   * there is nothing to open - not what would have been in it. The reviewer is
   * held to the same standard as the implementer, and a claim pointing nowhere
   * is the one the guards downgrade.
   */
  evidence: number;
  /**
   * A guard's downgrade, or null. **The guards' field, and theirs alone.**
   *
   * Never rewritten and never cleared, including by a person restoring the
   * severity - overwriting it on a restore would erase the fact the guard fired,
   * which is what #48 added it for.
   */
  downgraded: { from: string; reason: string; at?: string } | null;
  /**
   * What a person did to the severity, in order, or null (#142).
   *
   * The person's field, append-only, and beside `downgraded` rather than
   * instead of it. Two questions with two answers - *did a guard fire, and why*
   * and *how did this reach the severity it has* - rather than one field serving
   * both and eventually disagreeing with itself.
   */
  severityChanges: readonly { from: string; to: string; by?: string; reason?: string }[] | null;
}

/** A round's findings, and what the gate made of them. */
export interface Census {
  phase: 'plan' | 'review';
  /** All four, zeros included: where a gate decision is made, an absence is information. */
  counts: Readonly<Record<string, number>>;
  tolerance: number;
  pass: boolean;
  /** Why the loop stopped, or null when it may proceed. Null is an answer. */
  reason: string | null;
  /** P1s being carried into the next phase rather than fixed. */
  tolerated: readonly string[];
  findings: readonly FindingRow[];
  at: number;
}

/** One turn's charge, as the seam that charged it reported (#223, `5e`). */
export interface Charge {
  label: string;
  provider: string;
  tokens: number;
  /** The phase this turn was in, stamped the way an output line is. */
  phase: string | null;
  at: number;
}

/**
 * What the run has spent (`5e`/`6e`, #223).
 *
 * **Both accounts are subscriptions, so tokens are the only unit**, and that is
 * a settled decision rather than a gap: Codex returns no cost from any output
 * mode or endpoint, so a dollar view could only ever show half the run. The one
 * figure that exists is Claude-side and says so wherever it is drawn.
 *
 * The totals are read off the last charge rather than summed here. A pane adding
 * up a stream of turns would eventually disagree with `state.json`, and the
 * charge seam is holding the authoritative number at the moment it charges.
 */
export interface Spend {
  /** The run total, covering both agents. Null before any charge. */
  tokens: number | null;
  /** Claude-side dollars only, and never a total. Null before any charge. */
  costUsd: number | null;
  /** Codex's share of the tokens, or null when nothing has said. */
  codexTokens: number | null;
  /** Every charge, oldest first, so a per-phase breakdown is possible. */
  charges: readonly Charge[];
}

/**
 * A rate-limit wait (`7e`, #223).
 *
 * **This is `waiting`, not `halted`, and the distinction is the whole screen.**
 * It requires no decision from a person, so it must not look as though it does -
 * and other workstreams on the other provider keep running. The design demotes
 * *"run this phase on the other agent"* to a text link for the same reason it
 * exists at all: swapping providers mid-run is a fresh session with no memory of
 * the conversation so far, so it is a different run rather than a faster route
 * to the same one.
 */
export interface RateLimit {
  /** The turn that hit it. */
  label: string;
  /** Which account is out of headroom, so the other one's work is left alone. */
  provider: string | null;
  /** How long the loop said it would wait. */
  waitMs: number | null;
  /** When the window resets, as the provider stated it. Null when it did not. */
  resetsAt: string | null;
  /** When the wait began, on our clock. */
  at: number;
  /** Set once `rate_limit_resumed` said the wait was over. */
  resumedAt: number | null;
}

/** One open question, and the answer that came back for it (`1f`). */
export interface Question {
  kind: string;
  question: string;
  blocking: boolean;
  /** The adversary's draft, once one arrives. Null while the round is open. */
  answer: string | null;
  /** `high` / `medium` / `low`, as the answerer stated it. */
  confidence: string | null;
  rationale: string | null;
  /**
   * Set when the answerer refused to guess.
   *
   * A decline is not a missing answer: it is the adversary saying this is
   * product intent and it will not invent one, which `escalateOnDefer` then acts
   * on. Drawing it as "no answer yet" would hide the one outcome that ends the
   * run.
   */
  declined: boolean;
}

/** A boundary the loop is holding at, waiting to be told what to do. */
export interface Gate {
  /** The id to answer. Allocated by the host, not by us. */
  askId: number;
  boundary: string;
  planRound: number;
  reviewRound: number;
  verifyRound: number;
  /**
   * The turn that had just ended when this gate opened, or null (#202).
   *
   * A gate holds **between** things: every `GateableBoundary` is reached after a
   * turn completes and before the next starts, so nothing is executing while the
   * ask is outstanding. This is the turn whose result a person is deciding
   * about, and naming it is what lets the column keep that card open with its
   * measurements instead of collapsing it to a duration.
   *
   * An id rather than the turn itself: the turn lives in `cycles` and is the
   * same object the column is already drawing. Copying it here would be two
   * records of one turn, and the copy would be the stale one.
   */
  turnId: number | null;
}

/** One line for the output pane, at the density the terminal prints it. */
export interface OutputLine {
  n: number;
  level: Level;
  message: string;
  id: string | null;
  /**
   * The phase the loop had announced when this line arrived, or null (#223, `1c`).
   *
   * **Stamped, not inferred.** `1c` asks for output filtered by phase rather
   * than one endless stream, and the only honest way to say which phase a line
   * belongs to is to record the last one the loop *said* it was in. Nothing here
   * reads the sentence to work it out - that is the English-matching #133 exists
   * to prevent, and it would file a line under whatever word it happened to
   * contain.
   *
   * Null for every line before the first `phase_started`, which is a real state:
   * preflight and the run announcement genuinely belong to no phase.
   */
  phase: string | null;
  /** The role that was running, on the same terms. Null between turns. */
  role: string | null;
}

export interface Run {
  cycles: readonly Cycle[];
  /** The question loop, nested inside cycle 1. Null until one opens. */
  questions: { total: number; blocking: number; open: readonly Question[] } | null;
  /**
   * The rate-limit wait in flight, or the last one, or null (`7e`).
   *
   * Kept after it resolves rather than cleared: a run that waited forty minutes
   * did so, and a screen that forgets it cannot explain where the time went.
   */
  rateLimit: RateLimit | null;
  /**
   * Every pass of the verification gate, oldest first (#223, `5d`).
   *
   * A list rather than the latest, because the pane's failed-runs trend is a
   * comparison ACROSS passes and the round is what separates them. Empty until
   * a gate runs; a run with verification off gets one pass whose gates are all
   * `disabled`, which is a different fact from an empty list and must not be
   * drawn as the same thing.
   */
  verify: readonly VerifyPass[];
  /**
   * Every round's census, oldest first (#223, `1e`).
   *
   * A list rather than the latest, because the design's open-findings block
   * draws the **trend in words** - `blocking 2 → 0` - and a trend needs the
   * rounds behind it. Empty until a round reports one.
   */
  censuses: readonly Census[];
  /** What the run has spent, from the one seam every token goes through. */
  spend: Spend;
  /**
   * The commit every diff in this run is taken against, or null (#223, `1d`).
   *
   * Told, on the `phase_started` that establishes it, and there is no other way
   * to know it: `state.baseSha` is run state and this wire carries no run state
   * by design. Null before the implement phase and null on a repository that had
   * nothing to mark, and the pane says so rather than asking for a diff with no
   * base - which is the request `diffSince` would answer by staging the user's
   * whole working tree.
   */
  baseSha: string | null;
  /** The turn with no `endedAt`, if any. */
  running: Turn | null;
  gate: Gate | null;
  output: readonly OutputLine[];
  /** Set when the run ended, with how. Null while it is going. */
  ended: { how: 'approved' | 'stopped'; detail: string } | null;
  /**
   * Why the command is ending, in the core's own words (#162).
   *
   * **Told, never picked.** `run_failed` and `run_escalated` are narration ids
   * the core emits at the two places `execute` gives up, so this is the sentence
   * the CLI prints under `Failed` or `Stopped for input` - not the most recent
   * alarming-looking line in the output pane. Selecting by level would find the
   * wrong one: an escalation narrates at `warn`, and a healthy run is full of
   * warnings that are not the ending.
   *
   * `code` is what that site says its exit code will be, which is not the same
   * fact as `completed.exit` - the process may still fail on the way out - so
   * the two are kept apart rather than reconciled.
   */
  reason: { code: number | null; message: string } | null;
  /**
   * The exit code the command returned, once it has.
   *
   * Separate from `ended`, and the two are different facts. `ended` is what the
   * LOOP said about itself - review was clear, a host stopped it - and arrives
   * before the command has finished writing artifacts and printing a summary.
   * `completed` is the process being done with the request. Only the second one
   * means another run may be started.
   */
  completed: { exit: number } | null;
  /** The protocol version the host stated, or null before `ready`. */
  protocol: number | null;
  /**
   * Which run this is, once the loop has said so (#207).
   *
   * Null until `run_started` arrives, and null for ever on a core that predates
   * it - the window states what it was told or states nothing, and there is no
   * way to derive a run id from anything else on the wire.
   *
   * `dir` is the run's own directory, which is where `PLAN.md`, every critique
   * and every review report already live. Carrying it is not a viewer and does
   * not open one: the window has no filesystem, and #207 is explicit that
   * reading an artifact is a separate decision with `#129`'s link refusal
   * attached to it. It is here because "which run" and "where is it" are the
   * same question to the person asking, and the host is holding both.
   */
  identity: { runId: string; dir: string; resumed: boolean; at: number } | null;
  /** The step before the first phase, while it is running and after it (#205). */
  preflight: Preflight | null;
  /**
   * The next identity to hand out, carried in the run rather than in a module
   * variable.
   *
   * That is what keeps `reduce` genuinely pure: a module-level counter would
   * make the same frames produce different output depending on what had been
   * reduced earlier in the process, which is exactly the property a test needs
   * and a second window would violate.
   */
  seq: number;
}

export function emptyRun(): Run {
  return {
    cycles: [],
    questions: null,
    rateLimit: null,
    verify: [],
    censuses: [],
    spend: { tokens: null, costUsd: null, codexTokens: null, charges: [] },
    baseSha: null,
    running: null,
    gate: null,
    output: [],
    ended: null,
    reason: null,
    completed: null,
    protocol: null,
    identity: null,
    preflight: null,
    seq: 0,
  };
}

/**
 * Start a new run, keeping what belongs to the host rather than to the run.
 *
 * The protocol version came from `ready` and describes the process, not the
 * work. Everything else goes: a second run appending to the first one's cycles
 * would draw one column out of two runs, which is the wrong answer in a way
 * nobody would question on screen.
 */
export function nextRun(previous: Run): Run {
  return { ...emptyRun(), protocol: previous.protocol, seq: previous.seq };
}

/** How many output lines are kept. A run narrates thousands; a pane shows a tail. */
export const OUTPUT_KEEP = 500;

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * A list of strings, or an empty one.
 *
 * Every element has to be a usable string or the whole list is dropped: a
 * partly-readable list would be shown as though it were the whole of what the
 * frame carried, which is the absent-is-not-zero rule applied to a sequence.
 */
function strings(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v as unknown[]) {
    const s = str(item);
    if (s === null) return [];
    out.push(s);
  }
  return out;
}

/**
 * The attempts a gate made, or none.
 *
 * Whole-list-or-nothing, exactly as `strings` is and for the same reason: a
 * partly-readable list drawn as though it were the whole of what the frame
 * carried is the absent-is-not-zero rule broken on a sequence - and here it
 * would be worse than usual, because dropping one attempt from three is how a
 * flaky suite comes to look like a clean one.
 */
function readAttempts(v: unknown): { run: number; ok: boolean; exitCode: number | null }[] {
  if (!Array.isArray(v)) return [];
  const out: { run: number; ok: boolean; exitCode: number | null }[] = [];
  for (const item of v as unknown[]) {
    if (typeof item !== 'object' || item === null) return [];
    const row = item as Record<string, unknown>;
    const run = num(row['run']);
    if (run === null || typeof row['ok'] !== 'boolean') return [];
    out.push({ run, ok: row['ok'], exitCode: num(row['exitCode']) });
  }
  return out;
}

/** The four severities, in the order the design's chips are drawn. */
export const SEVERITIES: readonly string[] = ['P0', 'P1', 'P2', 'P3'];

/**
 * The four counts, or null.
 *
 * **All four or none.** The design's four-chip form shows zeros on purpose,
 * because where a gate decision is being made an absence is information - so a
 * record missing one severity is not a census this version understands, and
 * filling the gap with a zero would be a count nobody took presented as one.
 */
function readCounts(v: unknown): Record<string, number> | null {
  if (typeof v !== 'object' || v === null) return null;
  const row = v as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const severity of SEVERITIES) {
    const n = num(row[severity]);
    if (n === null) return null;
    out[severity] = n;
  }
  return out;
}

/** A guard's downgrade, or null. Both fields or neither. */
function readDowngrade(v: unknown): FindingRow['downgraded'] {
  if (typeof v !== 'object' || v === null) return null;
  const row = v as Record<string, unknown>;
  const from = str(row['from']);
  const reason = str(row['reason']);
  if (from === null || reason === null) return null;
  const at = str(row['at']);
  return at === null ? { from, reason } : { from, reason, at };
}

/**
 * The severity moves a person made, or null.
 *
 * Null rather than `[]`: "nobody moved this" and "this build could not read the
 * list" are different, and #142's whole point is that the record can say who
 * made which claim. An unreadable entry drops the list rather than the finding.
 */
function readChanges(v: unknown): FindingRow['severityChanges'] {
  if (!Array.isArray(v)) return null;
  const out: { from: string; to: string; by?: string; reason?: string }[] = [];
  for (const item of v as unknown[]) {
    if (typeof item !== 'object' || item === null) return null;
    const row = item as Record<string, unknown>;
    const from = str(row['from']);
    const to = str(row['to']);
    if (from === null || to === null) return null;
    const by = str(row['by']);
    const reason = str(row['reason']);
    out.push({ from, to, ...(by === null ? {} : { by }), ...(reason === null ? {} : { reason }) });
  }
  return out;
}

/**
 * The findings a census listed.
 *
 * Per-entry rather than whole-list, unlike `readAttempts`: a finding missing its
 * id or severity is one this version cannot place, and dropping the other
 * fifteen with it would lose a person's view of a round over one bad row. The
 * count of what was dropped is not reported, which is a real limit - but the
 * gate's own four counts are carried separately and are the number that decides
 * anything, so the pane can still tell you it is not showing everything.
 */
function readFindings(v: unknown): FindingRow[] {
  if (!Array.isArray(v)) return [];
  const out: FindingRow[] = [];
  for (const item of v as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const id = str(row['id']);
    const severity = str(row['severity']);
    if (id === null || severity === null) continue;
    out.push({
      id,
      severity,
      title: str(row['title']) ?? id,
      raisedBy: str(row['raisedBy']),
      evidence: num(row['evidence']) ?? 0,
      downgraded: readDowngrade(row['downgraded']),
      severityChanges: readChanges(row['severityChanges']),
    });
  }
  return out;
}

/** The questions a round opened, dropping any row this version cannot place. */
function readQuestions(v: unknown): Question[] {
  if (!Array.isArray(v)) return [];
  const out: Question[] = [];
  for (const item of v as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const question = str(row['question']);
    if (question === null) continue;
    out.push({
      question,
      kind: str(row['kind']) ?? 'unlabelled',
      // `blocking` decides whether a decline ends the run, so it fails **closed**:
      // anything but an explicit `false` is treated as blocking. An advisory
      // question shown as blocking is a person looking at it sooner than they
      // had to; the other way round is a run ending unexplained.
      blocking: row['blocking'] !== false,
      answer: null,
      confidence: null,
      rationale: null,
      declined: false,
    });
  }
  return out;
}

/** The answerer's replies, or its refusals - which are not the same outcome. */
function readAnswers(
  v: unknown,
  declined: boolean,
): { question: string; answer: string | null; confidence: string | null; rationale: string | null; declined: boolean }[] {
  if (!Array.isArray(v)) return [];
  const out: ReturnType<typeof readAnswers> = [];
  for (const item of v as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const question = str(row['question']);
    if (question === null) continue;
    out.push({
      question,
      answer: str(row['answer']),
      confidence: str(row['confidence']),
      rationale: str(row['rationale']),
      declined,
    });
  }
  return out;
}

/** Read a heartbeat's record. Every absent field stays absent. */
function readBeat(data: Record<string, unknown>, at: number): Beat | null {
  const elapsedMs = num(data['elapsedMs']);
  const activities = num(data['activities']);
  const unit = str(data['unit']);
  if (elapsedMs === null || activities === null || unit === null) return null;
  return {
    elapsedMs,
    activities,
    unit,
    tokens: num(data['tokens']) ?? 0,
    promptTokens: num(data['promptTokens']) ?? 0,
    // `heartbeatData` omits these rather than sending a zero, and the omission
    // is the fact: `lastActivity: null` is "nothing observed", not "nothing
    // happened", and an unmeasured window is not a window of zero.
    lastActivity: str(data['lastActivity']),
    contextWindow: num(data['contextWindow']),
    intervalMs: num(data['intervalMs']),
    sinceOutputMs: num(data['sinceOutputMs']),
    at,
  };
}

/**
 * Read a work reading's record. Every absent field stays absent.
 *
 * `files` is the one field that must be there: it is the count `workData` always
 * sends, so a record without it is not a reading this version understands and is
 * dropped rather than filled in.
 */
function readWork(data: Record<string, unknown>, at: number): Work | null {
  const files = num(data['files']);
  if (files === null) return null;
  const named = num(data['planNamed']);
  const touched = num(data['planTouched']);
  return {
    files,
    insertions: num(data['insertions']),
    deletions: num(data['deletions']),
    uncounted: num(data['uncounted']),
    // Both halves or neither. One without the other is not a coverage figure,
    // and choosing a value for the missing one would invent the very number the
    // proxy exists to avoid inventing.
    plan: named === null || touched === null ? null : { named, touched },
    at,
  };
}

/** Append to a cycle, creating it in the order the phases arrived. */
function withPhase(cycles: readonly Cycle[], kind: CycleKind, phase: PhaseGroup): Cycle[] {
  const existing = cycles.find((c) => c.kind === kind);
  if (existing === undefined) return [...cycles, { kind, phases: [phase] }];
  return cycles.map((c) => (c === existing ? { ...c, phases: [...c.phases, phase] } : c));
}

/**
 * Apply `f` to the most recently opened phase, wherever it sits.
 *
 * By `id` rather than by array position: cycles are stored in the order they
 * first appeared, so the newest phase is not necessarily in the last cycle - the
 * review cycle re-opens verify, which lives in the code cycle.
 */
function mapLastPhase(cycles: readonly Cycle[], f: (p: PhaseGroup) => PhaseGroup): Cycle[] {
  let newest = -1;
  for (const cycle of cycles) {
    for (const phase of cycle.phases) if (phase.id > newest) newest = phase.id;
  }
  if (newest === -1) return [...cycles];
  return cycles.map((cycle) => ({
    ...cycle,
    phases: cycle.phases.map((p) => (p.id === newest ? f(p) : p)),
  }));
}

/**
 * Start a gate, opening a pass for it when its round is a new one.
 *
 * **The round is what separates two passes**, and it is told rather than
 * guessed: `state.gateOutcomes` is reset on every pass, so the stream alone
 * cannot distinguish the second gate of one pass from the first gate of the
 * next. A frame carrying no round joins the open pass, which is the honest
 * reading of a core that predates the field - one pass with everything in it,
 * rather than a pass invented per gate.
 */
function openGate(
  passes: readonly VerifyPass[],
  round: number | null,
  name: string,
  at: number,
): VerifyPass[] {
  const gate: GateRun = {
    name,
    status: 'running',
    command: null,
    runs: 0,
    failed: null,
    verdict: null,
    reason: null,
    attempts: [],
    startedAt: at,
    endedAt: null,
  };
  const last = passes[passes.length - 1];
  const samePass = last !== undefined && last.round === round;
  if (!samePass) return [...passes, { round, at, gates: [gate] }];
  return passes.map((p) => (p === last ? { ...p, gates: [...p.gates, gate] } : p));
}

/**
 * Settle the named gate in its pass.
 *
 * The **last unsettled** gate of that name, so a gate re-run in a later round is
 * not confused with the earlier one - and nothing is created if no
 * `verify_started` opened it, because a verdict with no gate under it cannot be
 * attributed and a measurement that cannot be attributed is not recorded.
 */
function settleGate(
  passes: readonly VerifyPass[],
  round: number | null,
  name: string,
  at: number,
  outcome: Omit<GateRun, 'name' | 'startedAt' | 'endedAt'>,
): VerifyPass[] {
  const pass = [...passes].reverse().find((p) => p.round === round && p.gates.some(unsettled(name)));
  if (pass === undefined) return [...passes];
  let done = false;
  return passes.map((p) =>
    p !== pass
      ? p
      : {
          ...p,
          gates: p.gates.map((g) => {
            if (done || !unsettled(name)(g)) return g;
            done = true;
            return { ...g, ...outcome, endedAt: at };
          }),
        },
  );
}

const unsettled =
  (name: string) =>
  (g: GateRun): boolean =>
    g.name === name && g.status === 'running';

/**
 * The most recently opened phase's name, or null.
 *
 * By `id` rather than array position, exactly as `mapLastPhase` is and for the
 * same reason: the review cycle re-opens verify, which lives in the code cycle,
 * so the newest phase is not necessarily in the last cycle.
 */
function currentPhase(run: Run): string | null {
  let newest = -1;
  let name: string | null = null;
  for (const cycle of run.cycles) {
    for (const phase of cycle.phases) {
      if (phase.id > newest) {
        newest = phase.id;
        name = phase.phase;
      }
    }
  }
  return name;
}

/** Close the running turn, if there is one. */
function endRunning(run: Run, at: number): Run {
  if (run.running === null) return run;
  const id = run.running.id;
  return {
    ...run,
    running: null,
    cycles: run.cycles.map((cycle) => ({
      ...cycle,
      phases: cycle.phases.map((phase) => ({
        ...phase,
        turns: phase.turns.map((t) => (t.id === id ? { ...t, endedAt: at } : t)),
      })),
    })),
  };
}

/**
 * Fold one frame into the run.
 *
 * `at` is when the frame reached us, injected rather than read from a clock so
 * this stays pure and testable. It is the only place our own clock enters the
 * model, and what it measures is stated at every use.
 */
export function reduce(run: Run, frame: Frame, at: number): Run {
  if (frame.type === 'ready') return { ...run, protocol: frame.protocol };

  if (frame.type === 'ask') {
    // The turn is over. A gate holds between things - every `GateableBoundary`
    // is reached after a turn completes and before the next one starts - so an
    // `ask` is the same true statement `phase_started`, `turn_started`,
    // `gate_stopped` and `result` all make, arriving from the one boundary that
    // was missed (#202).
    //
    // Leaving it open was not cosmetic. A run held at `question-round` overnight
    // drew `5h40m / last activity 5h39m ago` on a turn that took a minute, two
    // inches above a footer correctly saying the loop was waiting for a human.
    // The reasonable response to the card is to kill the run; the reasonable
    // response to the footer is to press continue.
    const settled = run.running;
    return {
      ...endRunning(run, at),
      gate: {
        askId: frame.id,
        boundary: frame.context.boundary,
        planRound: frame.context.planRound,
        reviewRound: frame.context.reviewRound,
        verifyRound: frame.context.verifyRound,
        turnId: settled === null ? null : settled.id,
      },
    };
  }

  if (frame.type === 'result') {
    // The command returned. Whatever was running is not any more, whether it
    // finished or the process gave up on it.
    return { ...endRunning(run, at), gate: null, completed: { exit: frame.exit } };
  }

  if (frame.type !== 'narration') return run;

  // Every identity this frame hands out comes from here, and `seq` is written
  // back once at the bottom - so a branch that allocates two and a branch that
  // allocates none both leave the run consistent, without either remembering to
  // say so.
  let seq = run.seq;
  const id = (): number => (seq += 1);

  // Stamped from what the loop last announced, and **before** this frame is
  // folded. A `phase_started` line belongs to the phase it opens, so the stamp
  // is corrected below for that one id rather than every line being one phase
  // behind.
  const line: OutputLine = {
    n: id(),
    level: frame.level,
    message: frame.message,
    id: frame.id,
    phase:
      frame.id === 'phase_started'
        ? (str((frame.data ?? {})['phase']) ?? currentPhase(run))
        : currentPhase(run),
    role: run.running?.role ?? null,
  };
  const output = [...run.output, line].slice(-OUTPUT_KEEP);
  const next: Run = { ...run, output };
  const data = frame.data ?? {};

  const folded = ((): Run => {
    switch (frame.id) {
      case 'phase_started': {
        const phase = str(data['phase']);
        if (phase === null) return next;
        const kind = CYCLE_OF[phase];
        // A phase this version does not place in a cycle is left out of the
        // column rather than guessed into one. It is still in the output pane,
        // which is where an unrecognised thing belongs.
        if (kind === undefined) return next;
        // A new phase closes whatever turn was still open. The loop does not
        // narrate a turn ending, so the next thing starting is the signal - and
        // it is a true one, because turns within a run never overlap.
        const closed = endRunning(next, at);
        return {
          ...closed,
          // Kept when a later phase carries none, rather than cleared: the base
          // is established once, by the implement phase, and every phase after
          // it diffs against the same commit.
          baseSha: str(data['baseSha']) ?? closed.baseSha,
          cycles: withPhase(closed.cycles, kind, {
            id: id(),
            phase,
            round: num(data['round']),
            startedAt: at,
            turns: [],
            gates: [],
          }),
        };
      }

      case 'turn_started': {
        const role = str(data['role']);
        const kind = str(data['kind']);
        if (role === null || kind === null) return next;
        const turn: Turn = {
          id: id(),
          role,
          kind,
          round: num(data['round']),
          startedAt: at,
          endedAt: null,
          beat: null,
          work: null,
        };
        const closed = endRunning(next, at);
        return {
          ...closed,
          running: turn,
          cycles: mapLastPhase(closed.cycles, (p) => ({ ...p, turns: [...p.turns, turn] })),
        };
      }

      case 'heartbeat': {
        const beat = readBeat(data, at);
        // A heartbeat with no turn open is dropped from the column. It cannot be
        // attributed, and a measurement that cannot be attributed is not recorded.
        if (beat === null || next.running === null) return next;
        // Re-anchored to the loop's own measurement. See the header: our clock
        // ticks between beats, the loop's clock wins whenever it speaks.
        const turnId = next.running.id;
        const startedAt = at - beat.elapsedMs;
        const patch = (t: Turn): Turn => (t.id === turnId ? { ...t, beat, startedAt } : t);
        return {
          ...next,
          running: patch(next.running),
          cycles: next.cycles.map((cycle) => ({
            ...cycle,
            phases: cycle.phases.map((p) => ({ ...p, turns: p.turns.map(patch) })),
          })),
        };
      }

      /**
       * The tree, as the loop measured it (#198).
       *
       * **Two ids, because the loop emits two and they are not the same fact.**
       * `work_progress` is a sample during the turn, narrated every
       * `progress.workIntervalMs` and never recorded; `work_measured` is the
       * final reading, recorded once, and it arrives even when the turn changed
       * nothing. Both carry the record `workData` builds, so both land here -
       * the row wants whichever is most recent, and reading only the second
       * would leave it blank for the whole ninety minutes it exists for.
       */
      case 'work_progress':
      case 'work_measured': {
        const work = readWork(data, at);
        // Same rule the heartbeat follows, for the same reason: a reading with
        // no turn open cannot be attributed, and a measurement that cannot be
        // attributed is not recorded.
        if (work === null || next.running === null) return next;
        const turnId = next.running.id;
        const patch = (t: Turn): Turn => (t.id === turnId ? { ...t, work } : t);
        return {
          ...next,
          running: patch(next.running),
          cycles: next.cycles.map((cycle) => ({
            ...cycle,
            phases: cycle.phases.map((p) => ({ ...p, turns: p.turns.map(patch) })),
          })),
        };
      }

      case 'preflight_started':
        return {
          ...next,
          preflight: { agents: strings(data['agents']), probing: null, passed: false, at },
        };

      case 'probe_started': {
        const agent = str(data['agent']);
        if (agent === null) return next;
        // An older core narrates a probe without having announced the list, and
        // a `--skip-probe` run narrates neither. So the list is what was sent or
        // it is empty; it is never filled in from the agent in hand, which would
        // be the window deciding how many probes a run has.
        const before = next.preflight;
        return {
          ...next,
          // `at` is kept from the announcement where there was one, so the
          // elapsed clock measures preflight rather than restarting at each
          // probe. An older core that announced nothing starts it here.
          preflight: { agents: before?.agents ?? [], probing: agent, passed: false, at: before?.at ?? at },
        };
      }

      case 'preflight_passed': {
        const before = next.preflight;
        return {
          ...next,
          preflight: { agents: before?.agents ?? [], probing: null, passed: true, at: before?.at ?? at },
        };
      }

      case 'run_started': {
        const runId = str(data['runId']);
        const dir = str(data['dir']);
        // Both or neither. An identity holding a run id and no directory would
        // be a half-answer the window then has to explain, and the two always
        // travel together because the site that emits them has both in hand.
        if (runId === null || dir === null) return next;
        // `at` is when the core said this, which is the honest answer to *when
        // did the task reach the core* - the window's own send time would be
        // when it asked, not when anything happened (hi-fi 16).
        return { ...next, identity: { runId, dir, resumed: data['resumed'] === true, at } };
      }

      case 'verify_started': {
        const gate = str(data['gate']);
        if (gate === null) return next;
        return {
          ...next,
          cycles: mapLastPhase(next.cycles, (p) => ({ ...p, gates: [...p.gates, gate] })),
          verify: openGate(next.verify, num(data['round']), gate, at),
        };
      }

      /**
       * The three ways a gate settles, and the one way a pass never starts.
       *
       * All four land here because the pane's question is *what happened to this
       * gate*, and "the command could not run" is an answer to it. Only
       * `verify_disabled` opens a pass of its own: the other three always follow
       * a `verify_started` that opened one.
       */
      case 'verify_passed':
      case 'verify_failed':
      case 'verify_unavailable': {
        const gate = str(data['gate']);
        if (gate === null) return next;
        const status =
          frame.id === 'verify_passed'
            ? 'passed'
            : frame.id === 'verify_failed'
              ? 'failed'
              : 'unavailable';
        return {
          ...next,
          verify: settleGate(next.verify, num(data['round']), gate, at, {
            status,
            command: str(data['command']),
            runs: num(data['runs']) ?? 0,
            failed: num(data['failed']),
            // Carried, never derived. `runs: 1` that failed is `failing` and not
            // `flaky`, and a window computing `failed < runs` would disagree
            // with the loop about which of the two this is.
            verdict: str(data['verdict']),
            reason: str(data['reason']),
            attempts: readAttempts(data['attempts']),
          }),
        };
      }

      case 'verify_disabled': {
        // A pass whose gates are all `disabled`. Different from an empty list -
        // "verification is off" and "the gate has not come round yet" are two
        // facts, and until #223 the run said neither.
        const names = strings(data['gates']);
        const round = num(data['round']);
        return {
          ...next,
          verify: [
            ...next.verify,
            {
              round,
              at,
              gates: names.map((name) => ({
                name,
                status: 'disabled' as const,
                command: null,
                runs: 0,
                failed: null,
                verdict: null,
                reason: null,
                attempts: [],
                startedAt: at,
                endedAt: at,
              })),
            },
          ],
        };
      }

      /**
       * A turn's charge, under the event type that recorded it (#223, `5e`).
       *
       * Two ids because there are two providers and they are charged
       * differently, not because they are two facts: `codex_turn` carries no
       * cost at all, and that is a settled decision rather than a missing field.
       */
      case 'claude_turn':
      case 'codex_turn': {
        const label = str(data['label']);
        const tokens = num(data['tokens']);
        if (label === null || tokens === null) return next;
        return {
          ...next,
          spend: {
            // Read off the charge, never summed here. A pane adding up a stream
            // of turns would eventually disagree with `state.json`, and this is
            // the number that file holds.
            tokens: num(data['runTokens']) ?? next.spend.tokens,
            costUsd: num(data['runCostUsd']) ?? next.spend.costUsd,
            codexTokens: num(data['codexTokens']) ?? next.spend.codexTokens,
            charges: [
              ...next.spend.charges,
              {
                label,
                provider: str(data['provider']) ?? (frame.id === 'codex_turn' ? 'codex' : 'claude'),
                tokens,
                phase: line.phase,
                at,
              },
            ],
          },
        };
      }

      case 'findings_reported': {
        const phase = str(data['phase']);
        // Only the two the loop reports, and an unrecognised one is dropped
        // rather than filed under a guess: a critique census drawn as a review
        // one would put the plan cycle's argument in the review cycle's block.
        if (phase !== 'plan' && phase !== 'review') return next;
        const counts = readCounts(data['counts']);
        if (counts === null) return next;
        return {
          ...next,
          censuses: [
            ...next.censuses,
            {
              phase,
              counts,
              tolerance: num(data['tolerance']) ?? 0,
              pass: data['pass'] === true,
              reason: str(data['reason']),
              tolerated: strings(data['tolerated']),
              findings: readFindings(data['findings']),
              at,
            },
          ],
        };
      }

      case 'questions_opened':
        return {
          ...next,
          questions: {
            total: num(data['total']) ?? 0,
            blocking: num(data['blocking']) ?? 0,
            open: readQuestions(data['questions']),
          },
        };

      /**
       * The answers, matched back onto the questions by their text (#223, `1f`).
       *
       * **Matched, not appended.** The answerer is given the questions and
       * returns answers keyed by the question string - which is exactly how the
       * core pairs them, in `matches()` - so this is the same join rather than a
       * second one. A question with no matching answer keeps its null, because
       * an unanswered question and an answered one are the two states the pane
       * exists to distinguish.
       */
      case 'questions_answered': {
        const before = next.questions;
        if (before === null) return next;
        const answers = readAnswers(data['answers'], false);
        const declined = readAnswers(data['declined'], true);
        const found = [...answers, ...declined];
        return {
          ...next,
          questions: {
            ...before,
            open: before.open.map((q) => {
              const a = found.find((x) => x.question.trim() === q.question.trim());
              return a === undefined ? q : { ...q, ...a };
            }),
          },
        };
      }

      case 'rate_limited':
        return {
          ...next,
          rateLimit: {
            label: str(data['label']) ?? 'a turn',
            provider: str(data['provider']),
            waitMs: num(data['waitMs']),
            resetsAt: str(data['resetsAt']),
            at,
            resumedAt: null,
          },
        };

      case 'rate_limit_resumed': {
        const before = next.rateLimit;
        // Nothing is created here. A resume with no wait behind it cannot say
        // when the wait began, and a card claiming a wait it never measured is
        // worse than no card.
        if (before === null) return next;
        return { ...next, rateLimit: { ...before, resumedAt: at } };
      }

      case 'gate_released':
        return { ...next, gate: null };

      case 'gate_stopped':
        return {
          ...endRunning(next, at),
          gate: null,
          ended: { how: 'stopped', detail: str(data['reason']) ?? frame.message },
        };

      case 'review_approved':
        return { ...next, ended: { how: 'approved', detail: frame.message } };

      case 'run_escalated':
      case 'run_failed':
        // Deliberately not `endRunning`. This says why the run is ending; it is
        // not itself the end. The command still writes artifacts and a summary,
        // and `result` closes the open turn when it actually returns - which is
        // the same rule every other ending here follows.
        return {
          ...next,
          reason: {
            code: num(data['code']),
            // `run_failed` prints a stack and carries the sentence, so the two
            // are not interchangeable. `gate_stopped` reads its data the same
            // way, for the same reason.
            message: str(data['reason']) ?? frame.message,
          },
        };

      default:
        // Prose with no id, or an id from a newer core. Both reach the output
        // pane and neither moves the column - which is what makes adding a
        // narration id to the loop a safe change for an older app.
        return next;
    }
  })();

  return { ...folded, seq };
}

/**
 * How old what is on screen is, and whether it is still live (`7c`, #223).
 *
 * **A comparison between two clocks, not a threshold on one.** That distinction
 * is the whole of `7c`, and it replaced `5b` precisely because a single timer
 * cannot tell the two cases apart:
 *
 * - A beat fires on the loop's own timer **whether or not the child said
 *   anything**, so its arrival proves *vibe* is alive and proves nothing about
 *   the turn.
 * - `sinceOutputMs` is measured from the child's last line, so it proves the
 *   opposite thing.
 *
 * One stale and one fresh is a turn **thinking**, and the design is emphatic
 * that this is *"stated as a fact, not a worry"* - a turn emitting nothing for
 * twelve minutes is a healthy turn, and an indicator that fires on healthy turns
 * is one people stop reading. That is also why the middle state is named
 * `thinking` rather than `quiet`: reporting a state, not reporting an absence.
 *
 * Both stale is `not-live`: everything on screen is however old it is, and vibe
 * cannot confirm the phase is still running. **That one must not look normal.**
 */
export type Liveness = 'live' | 'thinking' | 'not-live' | 'unknown';

export interface Staleness {
  state: Liveness;
  /** Since the child last wrote, or null when it never has. */
  outputMs: number | null;
  /** Since the loop's own tick, or null before the first beat. */
  activityMs: number | null;
  /** The instant of that tick, for a card that has stopped moving (hi-fi 17). */
  lastBeatAt: number | null;
  /** Why the state cannot be told, or null. Never a guess in its place. */
  why: string | null;
}

/**
 * How many missed ticks make a run not-live.
 *
 * **Three, and the number is a shape rather than a duration.** The design's one
 * open judgement in `7c` is how stale is stale, and its own answer is that this
 * is a question about vibe's heartbeat cadence - so the threshold is expressed
 * in ticks and multiplied by the cadence the loop reported. At the default
 * 30-second interval that is 90 seconds; a run configured slower moves with it,
 * which a hardcoded 90_000 would not.
 */
export const MISSED_TICKS = 3;

export function staleness(run: Run, now: number): Staleness {
  const turn = run.running;
  const beat = turn?.beat ?? null;

  if (turn === null) {
    return {
      state: 'unknown',
      outputMs: null,
      activityMs: null,
      lastBeatAt: null,
      why: 'no turn is running, so there is nothing whose liveness to report',
    };
  }
  if (beat === null) {
    // A fresh turn never flickers through the middle state, which is
    // `turnStartedAt`'s job in the design. Before the first beat there is
    // nothing to compare, and saying so is better than calling a turn that
    // started three seconds ago stale.
    return {
      state: 'unknown',
      outputMs: null,
      activityMs: null,
      lastBeatAt: null,
      why: 'the turn has not reported a heartbeat yet',
    };
  }
  if (beat.intervalMs === null) {
    // Fail closed: an unmeasurable threshold is reported as unmeasurable rather
    // than replaced with a number picked here. That would be the invented
    // denominator this repo refuses everywhere else.
    return {
      state: 'unknown',
      outputMs: beat.sinceOutputMs,
      activityMs: Math.max(0, now - beat.at),
      lastBeatAt: beat.at,
      why: 'this build was not told how often the loop beats, so it cannot say what is overdue',
    };
  }

  const overdue = beat.intervalMs * MISSED_TICKS;
  const activityMs = Math.max(0, now - beat.at);
  // The child's gap, advanced by our own clock since the beat: the loop measured
  // it at the instant it spoke, and it has been growing since.
  const outputMs = beat.sinceOutputMs === null ? null : beat.sinceOutputMs + activityMs;

  if (activityMs > overdue) {
    return { state: 'not-live', outputMs, activityMs, lastBeatAt: beat.at, why: null };
  }
  // No output at all yet is not thinking and not live - the turn has produced
  // nothing to be recent or stale. It reads as live because vibe is beating,
  // which is the honest half of what is known.
  if (outputMs === null || outputMs <= beat.intervalMs) {
    return { state: 'live', outputMs, activityMs, lastBeatAt: beat.at, why: null };
  }
  return { state: 'thinking', outputMs, activityMs, lastBeatAt: beat.at, why: null };
}

/**
 * How many findings are blocking in the most recent round, or zero.
 *
 * **In the model rather than in the tab bar**, which is the rule this file
 * exists for: the components draw and this decides. It is a count over counts
 * the loop sent - P0 plus P1 - and never a re-judgement of the gate, which
 * already told us `pass`.
 *
 * The *latest* round rather than a total across all of them, because that is the
 * number that decides whether the loop fixes again; a running total would move
 * for reasons that change nothing.
 */
export function blocking(run: Run): number {
  const latest = run.censuses[run.censuses.length - 1];
  if (latest === undefined) return 0;
  return (latest.counts['P0'] ?? 0) + (latest.counts['P1'] ?? 0);
}

/**
 * What the running row can say, and what it cannot.
 *
 * One of `6a`'s six lines still has no source on the wire and is reported as
 * absent with the issue that would supply it. Drawing a zero or a blank for it
 * would be the invented denominator that element has failed on three times.
 *
 * **The diffstat line was the other one until #198.** `6a` shipped with both
 * lines naming the issue that would fill them, on the promise that *"the row
 * completes when they land instead of being redesigned"* - and #136 landed, and
 * the row went on saying the loop reported no file counts while the loop was
 * narrating them. The mechanism was right and nothing connected the two halves,
 * which is worth remembering the next time a line names an issue: the naming is
 * what makes the gap legible, not what closes it.
 */
export interface RunningRow {
  elapsedMs: number;
  activities: { count: number; unit: string } | null;
  lastActivity: string | null;
  /** Time since the last heartbeat. Null before the first one. */
  quietMs: number | null;
  /**
   * When that heartbeat landed, as an instant. Null before the first one.
   *
   * Beside `quietMs` rather than instead of it, because the two are for the two
   * states of the card (#202, hi-fi 17). A **live** card says `last activity 20s
   * ago`, which is what somebody watching wants and is true for as long as it is
   * on screen. A **settled** one says `last activity 14:52`, because a relative
   * time on a card that has stopped moving keeps aging into a lie — which is
   * exactly how a held gate came to read `5h39m ago` about a turn that took a
   * minute.
   */
  lastBeatAt: number | null;
  /** When the turn ended, as an instant, or null while it is still running. */
  endedAt: number | null;
  /**
   * Turn spend so far, or null at zero.
   *
   * **Null at zero on purpose**, and it is the formatter's own rule:
   * `formatHeartbeat` drops the `tok` segment below one, so the terminal already
   * shows nothing here. Codex is why - it reports no usage at all until
   * `turn.completed`, so its heartbeat carries a literal `tokens: 0` throughout
   * a turn that is spending the whole time. Rendering that as `0 tok` would be
   * the one thing this repo never does: an absence drawn as a measurement.
   */
  tokens: number | null;
  /**
   * `promptTokens` over `contextWindow`, or null.
   *
   * **Both halves have to be real**, which is the same condition
   * `formatHeartbeat` puts on printing the `ctx N%` segment. A known window with
   * a prompt size of zero would draw a bar at 0% - and a bar at 0% and a bar
   * that cannot be measured look identical while meaning opposite things, which
   * is the reason this is the only bar in the app in the first place.
   */
  context: { used: number; window: number } | null;
  /**
   * The tree as the loop last measured it, or null before any reading.
   *
   * Never both this and `noWork`: a measurement is present, or it is absent with
   * a reason, and the two are one question with one answer.
   */
  work: Work | null;
  /** Why there is no reading. Null once one has arrived. */
  noWork: string | null;
  /** Why the comparable-turns line is missing. Always set until a frame carries the archive. */
  comparable: string;
}

export function runningRow(turn: Turn, now: number): RunningRow {
  const beat = turn.beat;
  // Both clocks stop when the turn does. A turn drawn after it ended - which is
  // every turn a held gate is showing the result of - has a final elapsed and a
  // final quiet period, and ticking either against `now` would report the wait
  // for a human as time the turn spent (#202).
  const end = turn.endedAt ?? now;
  return {
    elapsedMs: Math.max(0, end - turn.startedAt),
    activities: beat === null ? null : { count: beat.activities, unit: beat.unit },
    lastActivity: beat?.lastActivity ?? null,
    quietMs: beat === null ? null : Math.max(0, end - beat.at),
    lastBeatAt: beat?.at ?? null,
    endedAt: turn.endedAt,
    tokens: beat === null || beat.tokens <= 0 ? null : beat.tokens,
    context:
      beat === null || beat.contextWindow === null || beat.promptTokens <= 0
        ? null
        : { used: beat.promptTokens, window: beat.contextWindow },
    work: turn.work,
    // Only the write turns are sampled - `withWorkProgress` wraps those and
    // nothing else - so this says which turns have a reading rather than
    // implying one is late. A planning turn never gets one and should not look
    // as though it is still waiting.
    noWork:
      turn.work === null
        ? 'no reading yet — the loop measures the tree during write turns'
        : null,
    // Narrowed rather than left as it was. `nothing reads the run archive yet`
    // stopped being true when `scorecard.ts` landed; what is still true is that
    // no frame carries it here, which is a different sentence and the one a
    // reader of this row needs.
    comparable:
      'no comparable turns — vibe scorecard reads the archive, but no frame carries it here (#114)',
  };
}
