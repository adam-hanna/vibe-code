/**
 * Rendering numbers, and only numbers somebody measured.
 *
 * Split out from the components so the two rules that keep getting broken live
 * in one place: **elapsed is a duration, never a fraction**, and **a quantity
 * with no denominator is not a bar**.
 */

/** `9m12s`, `1h04m`, `8s` - the same shape `formatElapsed` prints in the terminal. */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (hours > 0) return `${hours}h${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m${pad(seconds)}s`;
  return `${seconds}s`;
}

/**
 * `14:52` — an instant, in the viewer's own locale (#202, hi-fi 17).
 *
 * **The counterpart to `elapsed`, and the two are not interchangeable.** A
 * relative time is a claim that has to keep being true: `activity 6s ago` is
 * right for one second and is a lie for every second after it, which is how a
 * card at a held gate came to read `last activity 5h39m ago` on a turn that had
 * taken a minute. An instant is true forever, so it is what a settled card uses.
 */
export function clock(ms: number): string {
  const at = new Date(ms);
  // A time from another process, so an unusable one is possible. `Invalid Date`
  // sitting where a timestamp goes would read as something somebody measured.
  if (Number.isNaN(at.getTime())) return 'an unrecorded time';
  return at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * `up 3h04m`, `up 12m30s`, `up 8s` — a host's uptime from a count of seconds.
 *
 * Its own function rather than `elapsed(secs * 1000)` at the call site, because
 * the two measurements arrive in different units and multiplying at every use is
 * how one of them eventually does not.
 */
export function uptime(seconds: number): string {
  return elapsed(Math.max(0, seconds) * 1000);
}

/**
 * `0.4.2 · 9f3ac81 · built 6 Sep, 18:22`, and less when less is known (#201).
 *
 * **Every part is dropped rather than filled in.** A tree with no git reports no
 * commit, and a version alone is still a true answer — what must never appear is
 * a placeholder that reads like a hash. The date is formatted here rather than
 * in Rust so it lands in the viewer's locale rather than the builder's.
 */
export function buildStamp(build: { version: string; commit: string | null; at: number | null }): string {
  const parts = [build.version];
  if (build.commit !== null) parts.push(build.commit);
  if (build.at !== null) {
    const at = new Date(build.at);
    // Guarded because a stamp is a number from another process: `new Date(NaN)`
    // renders as `Invalid Date`, which would sit in the panel looking like a
    // fact somebody measured.
    if (!Number.isNaN(at.getTime())) {
      parts.push(
        `built ${at.toLocaleString(undefined, {
          day: 'numeric',
          month: 'short',
          hour: '2-digit',
          minute: '2-digit',
        })}`,
      );
    }
  }
  return parts.join(' · ');
}

/** `2.14M`, `120k`, `47`. Matches the core's own `fmtTokens`. */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** `47 tool uses`, `1 event`. The unit travels with the count because they do not count the same thing. */
export function counted(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/**
 * The tree the loop measured, in the terminal's own words (#198).
 *
 * **A transcription of `formatWork` in `src/work.ts`, deliberately.** The same
 * measurement rendered two ways is two chances to say something different about
 * it, so this keeps that file's segments, that file's order and that file's
 * wording - including the clause that is load-bearing.
 *
 * That clause is the proxy: **`N of the M files the plan names`, never `step
 * N/M` and never a percentage.** `9/14` reads as a position in the plan's list
 * of steps, and this is a count of files that happen to be named there. It is
 * also why there is no bar: the plan's file count is not the amount of work the
 * turn has to do, so it is not a denominator, and *if you cannot name the
 * denominator it is not a bar*.
 *
 * A zero here is a real measurement and gets the sentence the loop uses for it.
 * `formatWork` returns null in that case because a log line saying nothing
 * happened is noise; a row that exists all turn has to say something, and the
 * something is what the orchestrator already writes at the end of the turn.
 */
export function work(w: {
  files: number;
  insertions: number | null;
  deletions: number | null;
  uncounted: number | null;
  plan: { named: number; touched: number } | null;
}): string {
  if (w.files === 0) return 'changed nothing in the tree';
  const parts: string[] = [`${counted(w.files, 'file')} changed`];
  // Both or neither, exactly as `formatWork` has it: one half of a diffstat is
  // not a diffstat, and supplying the other as zero would be a count nobody took.
  if (w.insertions !== null && w.deletions !== null) {
    parts.push(`+${w.insertions} -${w.deletions}`);
  }
  if (w.uncounted !== null && w.uncounted > 0) {
    // Named rather than folded in, because their absence is what makes the
    // figure above an undercount.
    parts.push(`${counted(w.uncounted, 'file')} whose lines were not counted`);
  }
  if (w.plan !== null) {
    parts.push(`${w.plan.touched} of the ${counted(w.plan.named, 'file')} the plan names`);
  }
  return parts.join(' · ');
}

/**
 * The boundary a gate is holding at, in words.
 *
 * A closed map rather than a prettifier over the string: a boundary this version
 * does not know is shown as itself, which is honest, where a
 * `replace(/-/g, ' ')` would quietly make up a phrase for it.
 */
const BOUNDARIES: Readonly<Record<string, string>> = {
  'plan-round': 'the end of a plan round',
  // Reachable since #140 gave it a row and `GateContext` the counter that makes
  // it answerable. #139 made it a checkpoint and left it ungateable.
  'question-round': 'a round of the planner answering itself',
  'plan-approved': 'the approved plan',
  implemented: 'the finished implementation',
  'verify-round': 'a verification round',
  'review-round': 'the end of a review round',
  'final-fix': 'the final carried-finding fix',
  complete: 'the end of the run',
};

export function boundary(name: string): string {
  return BOUNDARIES[name] ?? name;
}

/**
 * What a gate is actually asking, in three parts (#211).
 *
 * `boundary()` names where the loop stopped and that turned out not to be
 * enough. Reported from a manual pass at `plan-round`, and the question is the
 * whole of it: *"It's holding at the end of a plan round, why? What am I
 * supposed to do, what am I supposed to inspect?"* The footer said `holding at
 * the end of a plan round`, listed three round counters, and offered two
 * buttons. Everything a person needs in order to press one deliberately —
 * what just finished, where to look at it, what continuing buys — was absent
 * from every boundary.
 *
 * **`cost` is the part that stops a gate being a reflex.** Continuing is never
 * free: at `plan-approved` it starts writing code, at `review-round` it buys an
 * implement-sized fix turn. A card that says only *continue* is a card that gets
 * pressed without the decision being made.
 *
 * A closed map, and an unknown boundary gets **no card at all** rather than a
 * generic sentence — the rule `ending()` and `boundary()` already follow. A
 * confident description of a boundary this build does not know would be worse
 * than the silence it replaced.
 */
export interface Hold {
  /** What has just finished. The reason it is holding here rather than anywhere. */
  what: string;
  /** Where to look before deciding, in the words of the thing to open. */
  inspect: string;
  /** What pressing continue spends. Never "carries on". */
  cost: string;
}

const HOLDS: Readonly<Record<string, Hold>> = {
  'plan-round': {
    what: 'The planner has just rewritten the plan — because the critic objected, or because a question round came back with answers.',
    inspect:
      'PLAN.md is the plan as it now stands, plan-<round>.json is this revision on its own, and FOLLOW-UPS.md is what it decided to leave out. All three are in the run directory below.',
    cost: 'Continuing sends it to the critic, which is one Codex turn. The plan is not approved yet and this round counts against the plan-round cap.',
  },
  'question-round': {
    what: 'The planner raised questions it could not settle from the brief, and the answerer has already taken its turn on them.',
    inspect: 'The questions and what came back for each are listed below, and in the Questions tab.',
    cost: 'Continuing accepts those answers and spends a planner turn revising the plan with them.',
  },
  'plan-approved': {
    what: 'The critic cleared the plan. This is the last gate before anything is written.',
    inspect:
      'PLAN.md, and the last plan-critique-<round>.json beside it — that file is what the critic actually said, including what it let through.',
    cost: 'Continuing starts the implementer: it writes code in your worktree and commits it. This is the expensive one, and the only gate after which the tree changes.',
  },
  implemented: {
    what: 'The implementer finished writing and committing. Nothing has checked it yet.',
    inspect: 'The Diff tab has what changed, against the commit the phase started from.',
    cost: 'Continuing runs your verification gates, then hands the diff to the reviewer — a Codex turn over the whole change.',
  },
  'verify-round': {
    what: 'A verification gate did not pass.',
    inspect: 'The Verify tab has each gate, how many of its runs failed, and whether it was deterministic.',
    cost: 'Continuing sends the round to FIX, which is a full implement turn.',
  },
  'review-round': {
    what: 'The reviewer has reported on the diff.',
    inspect:
      'The Findings tab has this round\'s findings with their severities, and code-review-<round>.json in the run directory is the report itself.',
    cost: 'Continuing buys a fix round — an implement-sized turn — and counts against the review-round cap.',
  },
};

/** Null for a boundary this build has no description of. The caller draws nothing. */
export function hold(name: string): Hold | null {
  return HOLDS[name] ?? null;
}

/**
 * How a run ended, in the footer's words.
 *
 * `tone` follows the design's own reading of the three kickers: `alarm` for a
 * state that is wrong, `accent` for one that wants you but is not, `quiet` for a
 * verdict. `next` is the action, and it is null wherever there genuinely is not
 * one - an empty line is better than an invented instruction.
 */
export interface Ending {
  tone: 'alarm' | 'accent' | 'quiet';
  kicker: string;
  detail: string;
  next: string | null;
}

/**
 * The eight exit codes, one phrase each, and **they are not eight flavours of
 * failure** (#162).
 *
 * Two of them are cases where the word "failed" is simply wrong. `UNVERIFIED` is
 * documented in `src/charge.ts` as *"not an error and not a stall: the work is
 * done, reviewed and committed"* - a banner calling that a failure would send
 * somebody looking for a bug in finished work. `NEEDS_HUMAN` is the ordinary way
 * a long run ends: it wrote a file, it is waiting to be answered, and it resumes
 * onto the same run.
 *
 * A code this build has no phrase for renders as the number, the same way
 * `boundary()` shows an unknown boundary as itself. That is the honest answer;
 * a generic "the run failed" would be a claim about what happened, invented for
 * a code whose meaning this build does not know.
 */
const ENDINGS: Readonly<Record<number, Ending>> = {
  0: {
    tone: 'quiet',
    kicker: 'finished',
    // Not "every gate passed". `verificationIncomplete` returns null for a
    // plan-only run and for one with verification off, and neither of those ran
    // a gate at all - so this says what the exit code actually means.
    detail: 'the loop finished, and nothing it required was left unverified.',
    next: null,
  },
  1: {
    tone: 'alarm',
    kicker: 'failed',
    detail: 'the run stopped on an error.',
    next: null,
  },
  2: {
    tone: 'accent',
    kicker: 'needs you',
    detail: 'the run stopped on a question it could not answer for itself.',
    next: 'Answer the questions in NEEDS-INPUT.md, then resume the run — it picks up from here.',
  },
  3: {
    tone: 'alarm',
    kicker: 'no convergence',
    detail: 'the loop stopped making progress, and stopped rather than spend more on it.',
    next: 'The findings that would not clear are in the file it wrote. Resuming raises the caps.',
  },
  4: {
    tone: 'alarm',
    kicker: 'budget',
    detail: 'a ceiling in `budget` was reached before the run finished.',
    next: 'Raise the ceiling and resume, or narrow the task. The file it wrote says what was open.',
  },
  5: {
    tone: 'alarm',
    kicker: 'rate limited',
    detail: "an agent's rate limit left no window to continue in.",
    next: 'Resume once the window resets — nothing is lost, and the run continues where it stopped.',
  },
  6: {
    tone: 'alarm',
    kicker: 'preflight',
    detail: 'a precondition of the phases ahead was not satisfied. Nothing was implemented.',
    next: 'Fix what is named above, then start the run again.',
  },
  7: {
    tone: 'accent',
    kicker: 'unverified',
    detail: 'the work is done, reviewed and committed. What is missing is the evidence that it runs.',
    next: 'A required verification gate never ran. Run it yourself, or fix why it could not.',
  },
};

/** Null for a code this build has no phrase for. The caller shows the number. */
export function ending(exit: number): Ending | null {
  return ENDINGS[exit] ?? null;
}
