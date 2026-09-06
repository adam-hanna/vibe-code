import { groundFindings } from '@src/evidence.js';
import { artifact, mergePendingFindings, recordAndSay } from '@src/run.js';
import type {
  Evidence,
  Finding,
  FindingsReport,
  PendingFindings,
  RunPhase,
  RunState,
  Severity,
} from '@src/types.js';
import { slug } from '@src/validate.js';

/**
 * A finding a human raised, and the file they raise it in (#141).
 *
 * Until this existed the human's position in the loop was asymmetric in a way
 * nobody decided. They could **dispose** of a finding - accept it into the next
 * fix round, defer it, let `p1Tolerance` carry it - and they could answer a
 * question. They could not **raise** one. Every `Finding` came from
 * `parseFindings` reading a model's structured output, so a person who read the
 * diff and saw a defect both agents missed had no way to put it in front of the
 * fixer except by writing prose into a resumed run and hoping.
 *
 * That is the case this tool most needs to handle. The adversarial split is the
 * product - one agent writes, a different agent objects - and the human is the
 * judge of that argument but was not a party to it. #66 exists because a reviewer
 * that ran no commands still produced blocking findings; the complement, a
 * reviewer that ran everything and still missed what a person sees in ten
 * seconds, had no remedy at all. It is also the cheapest review round there is: a
 * human finding costs no tokens and no turn.
 *
 * ## The file, not a new command
 *
 * A run that stops for input already writes a file a human edits and resumes
 * from, and `NEEDS-INPUT.md` already has a parser for answers written under a
 * `### ` heading as `> ` blockquote lines. This is the same shape, in the same
 * file, read on the same resume - so the CLI grows no diff-comment surface it
 * has no business having, and the feature is not reachable only through the app.
 * The two front ends would otherwise diverge in what a run can *contain*, which
 * is a worse divergence than one in what it can display.
 *
 * **No host frame, deliberately.** `src/host.ts` says in as many words that
 * every member of `Decision` that mutates run state "needs its own validator
 * before it is offered". A `raise` member is exactly that, and it is not this
 * issue: what ships here is the vocabulary, the parser and the acceptance path,
 * with `acceptRaised` as the one seam a later host member would call. The
 * alternative - a decision that carries findings, validated inside `serve.ts` -
 * would be a second definition of what a raised finding is.
 *
 * ## What the guards do with one
 *
 * - **Grounding runs** (decision 1). A comment anchored to `file:line` *is* an
 *   `Evidence` entry of kind `code`, so it passes `checkEvidence` by
 *   construction and the check is nearly a no-op - but running it keeps one path
 *   instead of two, and it catches a citation typed by hand at a line that does
 *   not exist. A blocking finding that cites nothing is carried as P2 with the
 *   reason on it, exactly as the reviewer's would be.
 * - **The inert guard does not** (decision 2). See `downgradeInert`.
 * - **The gate counts it** (decision 3). `gate` reads severity alone and gains no
 *   exception here: a person can block their own run, which means `p1Tolerance`
 *   is no longer purely a judgement about the reviewer.
 * - **The oscillation census does not** (decision 4). The guard fires when two
 *   models will not converge, and its remedies - decide it yourself, swap the
 *   reviewer - do not fit a fixer failing to satisfy a person. That exclusion is
 *   structural rather than a filter: the census is taken from the review report,
 *   and a raised finding is never in one. What this module does instead is say
 *   the sentence - `finding_reraised` names an id a human has raised before.
 */

/**
 * The heading that marks a raise, and the two markers a filled-in block needs.
 *
 * A `### ` heading is shared with `parseHumanAnswers`, which takes any block
 * carrying `**Your answer:**` - so the two parsers cannot collide as long as
 * neither marker appears in the other's template. Both are checked here rather
 * than only the heading, because "the block is meant to be a finding" and "the
 * block was filled in" are different questions and only the first is decided by
 * a heading.
 */
const HEADING = 'Finding:';
const DETAIL = '**What is wrong:**';
const FIX = '**Suggested fix:**';

/** `*Severity:* P1` and `*File:* src/run.ts:120`, both on their own line. */
const SEVERITY_LINE = /^\*Severity:\*\s*(.+)$/im;
const FILE_LINE = /^\*File:\*\s*(.+)$/im;

const SEVERITIES: readonly Severity[] = ['P0', 'P1', 'P2', 'P3'];

/**
 * Every id a human raises carries this.
 *
 * Not the attribution - `raisedBy` is - and nothing ever reads authorship back
 * out of an id. It is here so that the ids the oscillation guard, the round
 * history and every artifact key on can never collide with a slug the reviewer
 * derived from the same words, which would silently merge two claims into one.
 */
const ID_PREFIX = 'human-';

/**
 * The block appended to every `NEEDS-INPUT.md`.
 *
 * Present whether or not the stop was about questions, because the thing a
 * person most wants to raise a finding about - the diff - exists at every stop
 * after the plan. Left untouched it parses to nothing: `parseRaised` treats a
 * block whose title is still the placeholder and whose blockquotes are empty as
 * the template, and a run where nobody filled it in behaves exactly as it does
 * today.
 */
export function raiseSection(runId: string): string {
  return `## Raise a finding

Anything the review missed. Fill in one block per finding and resume with:

\`\`\`
vibe resume ${runId}
\`\`\`

Leave the block exactly as it is and nothing is raised. A block you have *partly*
filled in is reported rather than guessed at - the resume stops and says which
part is missing, and nothing is spent.

A P0 or P1 that cites no \`*File:*\` line that resolves is carried as a P2 with
the reason recorded, which is the same rule the reviewer's findings are held to.

### ${HEADING} <one line saying what is wrong>

*Severity:* P2
*File:* <path/to/file.ts:120, or delete this line>

${DETAIL}

>

${FIX}

>
`;
}

/** A block a person began and did not finish. Reported, never guessed at. */
export interface RaiseProblem {
  /** The heading as written, so the reader can find the block. */
  heading: string;
  reason: string;
}

export interface RaisedFindings {
  findings: Finding[];
  problems: RaiseProblem[];
}

/** The `> ` lines under a marker, joined - the same shape `parseHumanAnswers` reads. */
function quoted(block: string, marker: string): string {
  const idx = block.indexOf(marker);
  if (idx === -1) return '';
  return block
    .slice(idx + marker.length)
    .split('\n')
    // Stop at the next marker or heading, so the detail block cannot swallow the
    // suggested fix when a person deletes the blank line between them.
    .reduce<{ lines: string[]; done: boolean }>(
      (acc, raw) => {
        const line = raw.trim();
        if (acc.done) return acc;
        if (line.startsWith('>')) {
          acc.lines.push(line.replace(/^>\s?/, '').trim());
          return acc;
        }
        if (line !== '' && acc.lines.length > 0) acc.done = true;
        return acc;
      },
      { lines: [], done: false },
    )
    .lines.join(' ')
    .trim();
}

/**
 * Placeholders are angle-bracketed, and a leftover one means the line was not
 * filled in. Stripped rather than refused on its own so that a title of
 * `<one line saying what is wrong>` reduces to nothing, which is how an
 * untouched template is recognised.
 */
function withoutPlaceholders(s: string): string {
  return s.replace(/<[^>\n]*>/g, '').trim();
}

/**
 * One `*File:*` line as an `Evidence` entry, or null.
 *
 * `path:line` is the form people already write and the form the reviewer's
 * citations are rendered in, so it is the one accepted. A trailing `:120` is a
 * line number; anything else is the whole path, because a Windows path is full
 * of colons that are not line numbers.
 */
function citedFile(raw: string): Evidence | null {
  const text = withoutPlaceholders(raw);
  if (text === '') return null;
  const m = /^(.*?):(\d+)$/.exec(text);
  if (m !== null && m[1] !== undefined && m[2] !== undefined && m[1].trim() !== '') {
    return { kind: 'code', path: m[1].trim(), line: Number(m[2]) };
  }
  return { kind: 'code', path: text };
}

/**
 * Every finding a human wrote in a `NEEDS-INPUT.md`, and every block they began
 * and did not finish.
 *
 * **Refuse, never repair**, and the direction is worth stating. A block missing
 * its severity could be defaulted to P2 - it would resume, and it would put a
 * severity nobody chose into the record that exists to say who chose what. It
 * could be dropped - it would resume, and a person's work would vanish with no
 * sign. So it is reported, the resume stops, and nothing has been spent: the
 * file is still there and the run is still at its checkpoint.
 *
 * Pure, and exported for the reason `parseHumanAnswers` is: the acceptance path
 * writes state, and the parse has to be testable without one.
 */
export function parseRaised(md: string): RaisedFindings {
  const findings: Finding[] = [];
  const problems: RaiseProblem[] = [];

  for (const block of md.split(/^### /m).slice(1)) {
    const firstLine = block.split('\n')[0] ?? '';
    if (!firstLine.trim().startsWith(HEADING)) continue;

    const heading = firstLine.trim();
    const title = withoutPlaceholders(firstLine.trim().slice(HEADING.length));
    const detail = quoted(block, DETAIL);
    const fix = quoted(block, FIX);
    const severityRaw = withoutPlaceholders(SEVERITY_LINE.exec(block)?.[1] ?? '');
    const fileRaw = FILE_LINE.exec(block)?.[1] ?? '';

    // The untouched template: nothing anybody typed. Silent, because reporting
    // it would make every resume of every stopped run report a problem.
    if (title === '' && detail === '' && fix === '') continue;

    const missing: string[] = [];
    if (title === '') missing.push('a title on the `### Finding:` heading');
    if (detail === '') missing.push('a `**What is wrong:**` blockquote');
    if (!(SEVERITIES as readonly string[]).includes(severityRaw)) {
      missing.push(
        severityRaw === ''
          ? 'a `*Severity:*` line'
          : `a \`*Severity:*\` of P0, P1, P2 or P3 - not "${severityRaw}"`,
      );
    }
    if (missing.length > 0) {
      problems.push({ heading, reason: `it needs ${missing.join(', and ')}` });
      continue;
    }

    const id = `${ID_PREFIX}${slug(title)}`;
    if (findings.some((f) => f.id === id)) {
      // Two blocks whose titles reduce to one id. Reported rather than merged or
      // dropped, because an id is the key everything downstream uses - the
      // carry, the round history, the artifact - so the second can only be lost
      // or can silently overwrite the first. Both outcomes are worse than
      // saying so while the file is still open.
      problems.push({ heading, reason: `it repeats the id \`${id}\` of an earlier block` });
      continue;
    }

    const cited = citedFile(fileRaw);
    findings.push({
      id,
      severity: severityRaw as Severity,
      title,
      detail,
      // Empty rather than invented when a person did not offer one. They are
      // reporting a defect, not designing the repair, and `formatFinding` omits
      // the label rather than printing it with nothing after it.
      suggested_fix: fix,
      raisedBy: 'human',
      ...(cited === null ? {} : { evidence: [cited] }),
    });
  }

  return { findings, problems };
}

/**
 * Which loop a raised finding joins, or null when there is no loop left.
 *
 * Taken from the run's own resume point rather than asked for, because the
 * phase tag on `pendingFindings` is what stops one loop's findings reaching the
 * other's turn, and a person filling in a markdown file is not the right place
 * to decide that. A completed run gets null: there is no next turn to hand it
 * to, and recording one would be a claim that something will act on it.
 */
export function raisePhase(phase: RunPhase): PendingFindings['phase'] | null {
  return phase === 'planning' ? 'plan' : phase === 'complete' ? null : 'review';
}

export interface Accepted {
  /** What is now carried, in the order the next turn will read it. */
  added: Finding[];
  /** Blocking findings grounding carried as P2, with the reason on each. */
  downgraded: Finding[];
  /** Ids this run has seen a human raise before (#141, decision 4). */
  repeated: string[];
}

/**
 * Ids a human has already raised on this run, from the durable event log.
 *
 * No new state field: `finding_raised` is recorded through `recordEvent`, which
 * is the run's memory and is already read by `vibe list` and the scorecard. A
 * second array holding the same fact would be a second thing to keep in step.
 */
function raisedBefore(state: RunState): Set<string> {
  const ids = new Set<string>();
  for (const e of state.events ?? []) {
    if (e.type !== 'finding_raised') continue;
    const id: unknown = e['id'];
    if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

/**
 * Take findings a human raised into the run: ground them, merge them, record
 * them.
 *
 * The one seam. The CLI's resume calls it and a later host member would call the
 * same function - the alternative is two definitions of what a raised finding
 * costs and what it is checked against.
 *
 * `style` is null on purpose where the reviewer's would be its agent's: a person
 * types a path in their own shell, and the run is happening in it.
 * `resolveInside` documents null as "read host-native", which is exactly right
 * for the one author whose shell *is* the host's.
 */
export function acceptRaised(
  state: RunState,
  cwd: string,
  phase: PendingFindings['phase'],
  raised: readonly Finding[],
): Accepted {
  const before = raisedBefore(state);
  const report: FindingsReport = { verdict: 'REVISE', summary: '', findings: [...raised] };
  const { report: grounded, downgraded } = groundFindings(report, cwd, state.dir, null);

  // Written before the merge, so a process that dies between the two leaves the
  // record of what a person wrote rather than only the fact that they wrote it.
  artifact(state, `raised-${phase}-${state.planRound}-${state.reviewRound}.json`, grounded.findings);

  const added = mergePendingFindings(state, phase, grounded.findings);
  const repeated: string[] = [];

  for (const f of grounded.findings) {
    const wasRaised = before.has(f.id);
    if (wasRaised) repeated.push(f.id);
    recordAndSay(
      state,
      'ok',
      'finding_raised',
      `Raised by hand: [${f.severity}] ${f.title} \`${f.id}\``,
      {
        id: f.id,
        severity: f.severity,
        phase,
        // Whether the merge took it. A repeat of an id already carried is one
        // claim, not two, and saying so is more useful than silently recording
        // a raise nothing acted on.
        carried: added.some((a) => a.id === f.id),
      },
    );
  }

  for (const f of downgraded) {
    const d = f.downgraded;
    if (d === undefined) continue;
    recordAndSay(
      state,
      'warn',
      'finding_downgraded',
      `Downgraded ${f.id} from ${d.from} to P2 - ${d.reason}`,
      { id: f.id, from: d.from, reason: d.reason, raisedBy: 'human' },
    );
  }

  // The sentence decision 4 asks for, and the reason it is a sentence rather
  // than a census entry: a finding a person keeps re-raising after each fix is
  // not two models failing to converge, so `oscillationThreshold` and its
  // remedies - decide it yourself, swap the reviewer - describe the wrong
  // situation. What is true and worth saying is that this has come back.
  if (repeated.length > 0) {
    recordAndSay(
      state,
      'warn',
      'finding_reraised',
      `Raised by hand before and back again: ${repeated.join(', ')}. The fixer is not ` +
        'satisfying a person, which is a different problem from two models failing to agree - ' +
        'the oscillation guard does not count these and its remedies do not fit them.',
      { ids: repeated },
    );
  }

  return { added, downgraded, repeated };
}
