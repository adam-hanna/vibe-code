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
 * The boundary a gate is holding at, in words.
 *
 * A closed map rather than a prettifier over the string: a boundary this version
 * does not know is shown as itself, which is honest, where a
 * `replace(/-/g, ' ')` would quietly make up a phrase for it.
 */
const BOUNDARIES: Readonly<Record<string, string>> = {
  'plan-round': 'the end of a plan round',
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
