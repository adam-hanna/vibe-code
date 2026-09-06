import { detail } from '@src/log.js';
import type { Meta } from '@src/log.js';
import * as git from '@src/git.js';
import type { ChangeSet } from '@src/git.js';
import type { Plan } from '@src/types.js';

/**
 * How far through the longest phase of a run is - answered only with things
 * vibe measured (#136).
 *
 * An implement turn runs for up to ninety minutes against a plan with a known
 * number of steps, and nothing related the two. The heartbeat could say
 * `47 tool calls · editing src/auth.ts` and nothing could say *how far*, which
 * is the only question a watching human has.
 *
 * **The step counter the wireframes draw does not exist and is not invented
 * here.** `claude · step 9/14 · 61%` would be the most prominent fabricated
 * number in the product, on the primary screen, during the phase the user
 * spends the most time looking at. The issue lays out three options and this is
 * the second: report a *proxy*, measured from things that are true, and make
 * the words say it is a proxy.
 *
 * So: **the plan names fourteen files and nine of them have been changed.**
 * Every part of that is observed - git knows what changed, and the plan's own
 * text names the files - and none of it claims to be a position in a list of
 * steps. It needs nothing from the model, which is the whole point: #116
 * changed a design because a model's claim about its own identity matched 19 of
 * 21 while the claim *text* matched 21 of 21, and a self-reported step counter
 * would be wrong in exactly the way that is hardest to notice, because it looks
 * authoritative.
 *
 * The third option - asking the implementer to mark steps - is deliberately not
 * taken here, and the right order is this first: a self-report is only worth
 * having once there is a measurement to check it against.
 *
 * **Nothing here decides anything about the run.** It is display, like
 * `progress.ts`, and it fails silent: a git that could not be asked produces no
 * reading rather than a zero, and a plan that names no files produces no proxy
 * rather than `0 of 0`.
 */

/** One observation of how far a write turn has got. */
export interface WorkProgress {
  changed: ChangeSet;
  /**
   * The proxy, or null when the plan named no files to be a proxy over.
   *
   * Null and `{named: 0}` would be the same rendering and different claims:
   * this says the question could not be asked, not that the answer is none.
   */
  planned: PlanCoverage | null;
}

export interface PlanCoverage {
  /** Distinct repo paths the plan's own text names. */
  named: number;
  /** How many of those the run has actually changed. */
  touched: number;
}

/**
 * A backticked token in the plan, if it looks like a path in this repo.
 *
 * **Lexical, and deliberately so.** Reading prose for intent is the
 * English-matching #133 exists to prevent; this reads for a *shape*, which is a
 * different kind of claim: a path in backticks is a reference, a path in a
 * sentence is a mention, and the plans this runs against write every file they
 * name in backticks because the prompts ask for a plan a reader can follow.
 *
 * The rules, each of which exists to reject something real that was seen:
 *
 * - **No whitespace.** `npm run typecheck` is a command, not a file.
 * - **A slash, or a final extension that starts with a letter.** `src/git.ts`
 *   and `README.md` are paths; `1.2.0` is a version and `Config` is a type.
 * - **No scheme and no leading dash.** `https://…` is a link and `--gate` is a
 *   flag; both otherwise satisfy the rules above.
 *
 * Imprecise in both directions, and that is accepted rather than hidden - the
 * figure is reported as *files the plan names*, which is exactly and only what
 * this measures.
 */
const CODE_SPAN = /`([^`\n]+)`/g;
const FINAL_EXTENSION = /\.[A-Za-z][A-Za-z0-9]*$/;

function looksLikePath(token: string): boolean {
  if (token === '' || /\s/.test(token)) return false;
  if (token.startsWith('-') || token.includes('://')) return false;
  return token.includes('/') || FINAL_EXTENSION.test(token);
}

/** Repo-relative, forward slashes, no `./` - the spelling git hands back. */
function normalisePath(token: string): string {
  return token.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/** Every repo path the plan's own text names, deduplicated. */
export function planNamedFiles(planMd: string): string[] {
  const found = new Set<string>();
  for (const match of planMd.matchAll(CODE_SPAN)) {
    const token = match[1];
    if (token === undefined) continue;
    const trimmed = token.trim();
    if (!looksLikePath(trimmed)) continue;
    found.add(normalisePath(trimmed));
  }
  return [...found];
}

/**
 * How much of what the plan named has been touched.
 *
 * Matched on the **trailing path segments**, not on equality: a plan writes
 * `src/orchestrator.ts` and git, run in a worktree, hands back
 * `src/orchestrator.ts` too - but a plan is also entitled to write
 * `app/src/pilot/tools.ts` where the run is rooted at `app/`, and a plain
 * equality test would score that as untouched while the file is being edited.
 * One-sided containment either way, so the looser spelling of the same file
 * counts once.
 *
 * Null when the plan named nothing. Reporting `0 of 0` would be a proxy over an
 * empty set presented as a measurement of progress.
 */
export function planCoverage(named: readonly string[], changed: readonly string[]): PlanCoverage | null {
  if (named.length === 0) return null;
  const touchedSet = changed.map(normalisePath);
  let touched = 0;
  for (const file of named) {
    const hit = touchedSet.some(
      (actual) => actual === file || actual.endsWith(`/${file}`) || file.endsWith(`/${actual}`),
    );
    if (hit) touched += 1;
  }
  return { named: named.length, touched };
}

/**
 * One reading of the tree, or null when there was nothing measurable to say.
 *
 * `plan` is optional because three of the four write turns run with a plan in
 * hand and the fourth may not - and a reading without the proxy is still a
 * reading, where a reading with an invented proxy would not be.
 */
export async function measureWork(
  cwd: string,
  baseSha: string | null,
  plan: Plan | null,
): Promise<WorkProgress | null> {
  const changed = await git.changeSet(cwd, baseSha);
  if (changed === null) return null;
  const named = plan === null ? [] : planNamedFiles(plan.plan_md);
  return { changed, planned: planCoverage(named, changed.paths) };
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? '' : 's'}`;
}

/**
 * The reading as a sentence.
 *
 * The proxy's clause names *files*, never steps, and says whose count it is -
 * "of the 14 files the plan names". That phrasing is the labelling the issue
 * asks for, and it is load-bearing: `9/14` beside a bar reads as a position in
 * the plan, and this measurement is not one.
 *
 * Every segment is omitted when its number was not measured, exactly as
 * `formatHeartbeat` omits its own - so a run in a repo git could not be asked
 * about degrades to nothing rather than to zeroes.
 */
export function formatWork(work: WorkProgress): string | null {
  const { changed, planned } = work;
  // Nothing has been touched, so there is nothing to describe. The zeroes are
  // real measurements and `workData` sends them - a cockpit drawing "0 files
  // changed" is telling the truth - but `implement: +0 -0` as a log line is
  // noise wearing the shape of a reading, and the caller turns this null into
  // the sentence that actually means something: the turn changed nothing.
  if (changed.paths.length === 0) return null;
  const parts: string[] = [plural(changed.paths.length, 'file') + ' changed'];
  if (changed.insertions !== null && changed.deletions !== null) {
    parts.push(`+${changed.insertions} -${changed.deletions}`);
  }
  if (changed.uncounted > 0) {
    // Named rather than folded in, because their absence is what makes the
    // figure above an undercount.
    parts.push(`${plural(changed.uncounted, 'file')} whose lines were not counted`);
  }
  if (planned !== null) {
    parts.push(
      `${planned.touched} of the ${plural(planned.named, 'file')} the plan names`,
    );
  }

  return parts.length === 0 ? null : parts.join(' · ');
}

/**
 * The same reading as a record, for a host that draws a row (#133).
 *
 * Absent fields rather than zeroes, and the same omission rule as
 * `heartbeatData`: a count of zero is a fact and is sent; a measurement that
 * was not taken is left out, so a cockpit drawing this can tell "nothing has
 * changed yet" from "nobody could say".
 */
export function workData(work: WorkProgress): Record<string, unknown> {
  const { changed, planned } = work;
  const data: Record<string, unknown> = {
    files: changed.paths.length,
    added: changed.added,
    uncounted: changed.uncounted,
  };
  if (changed.insertions !== null) data['insertions'] = changed.insertions;
  if (changed.deletions !== null) data['deletions'] = changed.deletions;
  if (planned !== null) {
    data['planNamed'] = planned.named;
    data['planTouched'] = planned.touched;
  }
  return data;
}

export interface WorkSamplerOptions {
  cwd: string;
  baseSha: string | null;
  plan: Plan | null;
  label: string;
  intervalMs: number;
  emit?: ((line: string, meta?: Meta) => void) | undefined;
  /** The last reading taken, handed over when the turn ends. */
  onReading?: ((work: WorkProgress) => void) | undefined;
}

/**
 * Run `turn` with the tree sampled underneath it.
 *
 * A timer of its own rather than a hook on the heartbeat, for one reason that
 * settles it: the heartbeat's emit is synchronous and asking git is not.
 * Sharing the cadence would either block the heartbeat on three child processes
 * or leave it reporting a reading from some earlier tick, and neither is worth
 * the saved timer.
 *
 * **Narrated, not recorded.** A sample every thirty seconds through a
 * ninety-minute turn is 180 observations, and `state.events` is explicitly
 * protected from becoming a transcript (#133). These go out at `detail`, the
 * heartbeat's level, carrying the record beside the line - so a host draws the
 * row and the terminal prints the sentence, from one call. The turn's *final*
 * reading is handed to `onReading` for the caller to record once, which is the
 * durable fact worth keeping.
 *
 * Sampling never delays the turn: a sample still in flight when the turn
 * finishes is dropped, and a sample that throws is swallowed - losing a
 * progress reading must never cost a run.
 */
export async function withWorkProgress<T>(
  options: WorkSamplerOptions,
  turn: () => Promise<T>,
): Promise<T> {
  const { cwd, baseSha, plan, label, intervalMs, emit = detail, onReading } = options;
  let done = false;
  let last: WorkProgress | null = null;

  const sample = async (): Promise<void> => {
    try {
      const work = await measureWork(cwd, baseSha, plan);
      // The `done` check is after the await as well as before the timer fires:
      // a sample in flight when the turn ended describes a tree the turn has
      // stopped changing, and reporting it would put a line after the phase.
      if (work === null || done) return;
      last = work;
      const line = formatWork(work);
      // Silent while the turn has changed nothing. The record still carries the
      // zeroes at the end of the turn, where they mean something; a line every
      // sixty seconds saying nothing has happened yet is the silence this whole
      // area exists to fill being refilled with noise.
      if (line !== null) emit(`${label}: ${line}`, { id: 'work_progress', data: workData(work) });
    } catch {
      // Display. See the module comment.
    }
  };

  const timer = setInterval(() => {
    if (done) return;
    void sample();
  }, intervalMs);
  // Never holds the event loop open, exactly as the heartbeat's does not.
  timer.unref();

  try {
    return await turn();
  } finally {
    done = true;
    clearInterval(timer);
    // The final reading is taken after `done`, deliberately: it is the one the
    // caller records, and it must describe the tree as the turn left it rather
    // than as some throttled tick found it. Taken outside the sampler so the
    // suppression above cannot swallow it.
    //
    // Reached on the failure path too, and that is the point rather than an
    // oversight: the work a failed or killed write turn did is still in the
    // tree, a resume is about to be handed it, and what it left is exactly the
    // fact v1.3's recovery work exists to preserve.
    if (onReading !== undefined) {
      let final: WorkProgress | null = null;
      try {
        final = await measureWork(cwd, baseSha, plan);
      } catch {
        // Fall back to the last sample below rather than reporting nothing.
      }
      // The last sample is second-best and better than silence: it describes
      // this turn's tree a minute earlier, where nothing describes it at all.
      const reading = final ?? last;
      if (reading !== null) {
        try {
          onReading(reading);
        } catch {
          // Never out of a `finally`. This runs while an error may already be
          // in flight, and a failed state write must not replace the failure
          // that was actually worth reporting.
        }
      }
    }
  }
}
