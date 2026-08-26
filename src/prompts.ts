import { describedRole, ROLES } from '@src/roles.js';
import { EVIDENCE_RULE } from '@src/schemas.js';
import { readEvidence } from '@src/validate.js';
import type { RoleTable } from '@src/roles.js';
import type { EnvironmentFacts } from '@src/runtime.js';
import type {
  AcceptanceCriterion,
  Answer,
  Assumption,
  Finding,
  OpenQuestion,
  OutOfScopeItem,
  Plan,
  RunSummary,
} from '@src/types.js';

const RESPOND_WITH_JSON =
  'Respond with JSON matching the required schema. No prose outside the JSON.';

/**
 * Verified environment facts, rendered for a prompt.
 *
 * The reviewer cannot check the implementer's environment and will otherwise
 * reason about it from its own. Codex runs read-only and sandboxed, found it
 * could not execute `node`, and raised that as a plan-blocking P1 on three
 * consecutive rounds of a run whose implementer had a working runtime the
 * whole time. Stating the observations, and whose shell each belongs to,
 * removes an entire category of false finding.
 */
export function environmentBlock(
  facts: EnvironmentFacts | null | undefined,
  audience: 'reviewer' | 'planner',
  /** The seam `runTurn` already has: who does what is read, not inferred. */
  roles: RoleTable = ROLES,
): string {
  if (!facts || facts.agents.length === 0) return '';

  const lines = facts.agents.map((agent) => {
    const role = describedRole(agent.provider, roles);
    const tools = agent.tools
      .map((t) => {
        if (!t.available) return `${t.name} UNAVAILABLE`;
        const version = t.version ?? 'ok';
        // `git --version` already prints "git version ...", so naming the tool
        // again reads as a stutter.
        return version.toLowerCase().startsWith(t.name.toLowerCase())
          ? version
          : `${t.name} ${version}`;
      })
      .join(', ');
    const repaired = agent.repaired ? ' [PATH repaired by vibe for this run]' : '';
    // The parenthetical is dropped rather than filled with a provider name when
    // a table gives this agent no role at all: the slot is for what it does.
    const does = role === null ? '' : ` (the ${role})`;
    return `- **${agent.provider}**${does}: ${agent.shell}, ${agent.pathStyle} paths - ${tools || 'no tools contracted'}${repaired}`;
  });

  // With a gate list the single-command sentence is false - it names one command
  // where there are three, and says nothing about the ones that will not run. A
  // false statement in a prompt is worse than a vague one, so the gates are
  // listed when the facts carry them and the original sentence stands, verbatim,
  // when they do not (a record written before #47, or a run with one gate).
  const gates = facts.verifyGates ?? [];
  const verification =
    gates.length > 0
      ? '\nVerification: vibe runs these itself - not an agent - and they must pass before ' +
        'the change is accepted:\n' +
        gates
          .map((g) =>
            g.command === null
              ? `- \`${g.name}\`: no command configured; this gate will not run`
              : `- \`${g.name}\`: \`${g.command}\`, ${g.runs} consecutive time(s)`,
          )
          .join('\n')
      : facts.verifyCommand === null
        ? '\nNo verification command is configured, so nothing will execute this change automatically.'
        : `\nVerification: vibe will run \`${facts.verifyCommand}\` itself - not an agent - and it must pass ${facts.verifyRuns} consecutive times before the change is accepted.`;

  const caution =
    audience === 'reviewer'
      ? '\n\nYour own shell is sandboxed and deliberately more restricted than the ' +
        'implementer\'s. **A tool you cannot run yourself is not evidence that the ' +
        'implementer cannot run it.** Do not raise findings about tool availability, ' +
        'runtime provisioning, or PATH - they are settled above, and a plan relying ' +
        'on a tool listed as available to the implementer is correct to do so.'
      : '\n\nPlan against these. Do not add steps to install or locate a tool listed as available.';

  return `## Verified environment

vibe established the following by executing each tool inside each agent's own shell before this run began. These are observations, not assumptions.

${lines.join('\n')}
${verification}${caution}

`;
}

/**
 * Reviewer instruction against symptom-by-symptom review.
 *
 * Observed failure mode: the reviewer reports one narrow defect, the fixer
 * patches exactly that line, and the next round surfaces the consequences as
 * fresh P1s. On one run the counts went 1 -> 1 -> 3 across rounds, every
 * finding correct and every one caused by the previous round's patch. Rounds
 * are expensive, so a finding that names the root cause and every affected
 * site is worth far more than three findings discovered one round apart.
 */
const REVIEW_BREADTH = `## Review breadth

Do not stop at the first instance of a defect.

- **Generalise it.** For each defect, name the *class* of mistake, then look for
  the same class elsewhere - the same wrong assumption in a sibling function,
  the same unchecked boundary on another code path, the same pattern copied
  into a second module. Report every site you find, in one finding that lists
  them, rather than one site now and its twin two rounds later.
- **Trace downstream.** Ask what depends on the defective behaviour. A caller
  relying on the current output, a test asserting it, a documented contract
  that would become false once it is fixed - all of that belongs in the finding.
- **Attack the previous round's fixes.** Where a fix landed, the likeliest new
  defect is a consequence of that fix: a narrowed condition that now excludes a
  valid case, a changed return shape a caller still reads the old way.
- **Prefer root causes.** Given a choice between a finding that names the
  underlying error and one that names a symptom, report the former and list the
  symptoms under it. Symptom-level findings produce symptom-level patches.`;

/**
 * The other half: a fixer that changes only the reported line reproduces the
 * same loop from the implementation side.
 */
const FIX_BREADTH = `## Fix breadth

Fix the cause, not the line.

- For each finding, decide what the underlying mistake is, then search for the
  same mistake elsewhere and fix those occurrences too. A reviewer who found one
  instance will find its twin next round, and that costs another full cycle.
- Before changing anything, trace what depends on it: callers, tests,
  serialised shapes, documented behaviour. Update them in the same pass.
- After each change, ask what it could break that previously worked. Narrowing a
  condition to exclude a bad case often excludes good ones too.
- In your report, state for each finding what you changed, **what else you
  checked for the same class of problem**, and what you found. "Checked X and Y,
  they were already correct" is useful; silence is not.`;

/**
 * The plan's declared boundary, rendered.
 *
 * `undefined` and `[]` are different facts. Absent means no boundary was ever
 * recorded - a plan stored before the field existed - while empty means the
 * planner considered the question and claims there are no interesting edges.
 * Printing the second where the first is true puts a claim in the plan's mouth
 * that it never made.
 */
function formatOutOfScope(items: readonly OutOfScopeItem[] | undefined): string {
  if (items === undefined) {
    return '(this plan predates the out-of-scope field - no boundary was recorded)';
  }
  if (items.length === 0) {
    return '(the planner considered this and declared nothing out of scope)';
  }
  return items.map((s, i) => `${i + 1}. **${s.item}**\n   - Why: ${s.why}`).join('\n');
}

/**
 * What a reviewer may do with the plan's boundary - conditional on there being
 * one.
 *
 * The defer instruction only makes sense against a boundary someone drew.
 * Offering it where none was recorded would let a reviewer wave off a
 * legitimate finding on the authority of a plan that never claimed anything,
 * and legacy runs are exactly the ones with no boundary to check the finding
 * against.
 */
function scopeGuidance(
  items: readonly OutOfScopeItem[] | undefined,
  subject: 'plan' | 'change',
): string {
  const what = subject === 'plan' ? 'the plan' : 'this change';

  if (items === undefined) {
    return `## Scope

This plan predates the out-of-scope field, so **no boundary was recorded**. Nothing here has been declared out of scope, and you must not treat anything as out of scope on the plan's authority - judge every finding on its merits, at its true severity.

\`defer\` is required on every finding: set it to \`false\` unless the finding is plainly about work ${what} never touches.`;
  }

  return `## Scope

${formatOutOfScope(items)}

${what === 'the plan' ? 'The plan' : 'The plan behind this change'} has drawn the boundary above. Work it declared out of scope is not a hole in the plan - it is the plan being explicit. **Demanding work beyond that boundary is a defect in your finding, not in the plan.**

If you notice something real that belongs in separate work, that is worth reporting: raise it as a finding with \`defer: true\`, at P2 or P3. Deferring costs you the same honesty as choosing a severity does - a finding you defer is one you are saying does not have to be resolved for ${what} to be correct, so it can never be a P0 or a P1.

If the boundary itself is wrong - ${what} cannot work without the thing it excluded - say *that*, at its real severity, and explain why the exclusion breaks it. An empty boundary is a claim like any other, and disputing it is legitimate.`;
}

/**
 * The plan's definition of done, rendered.
 *
 * Three states, for the reason `formatOutOfScope` has three: absent is a plan
 * recorded before the bar existed, empty is a planner claiming done-ness here
 * is unobservable, and printing the second where the first is true invents a
 * claim. Nothing here executes a criterion - `check` says how one *would* be
 * checked, and that is all it does.
 */
function formatAcceptanceCriteria(items: readonly AcceptanceCriterion[] | undefined): string {
  if (items === undefined) {
    return '(this plan predates the acceptance-criteria field - no bar was recorded)';
  }
  if (items.length === 0) {
    return '(the planner recorded no criteria - a claim that done-ness here is unobservable)';
  }
  return items
    .map((c, i) => `${i + 1}. **${c.criterion}** \`${c.id}\`\n   - Check (${c.check}): ${c.how}`)
    .join('\n');
}

/**
 * The bar as the implementer is told it - two states, not three.
 *
 * The one consumer that renders nothing rather than a claim when there is no
 * bar. A run whose plan carries no criteria must produce the implementation
 * prompt it produced before this field existed, byte for byte, and before this
 * field existed there was no section here at all. The critic is the component
 * that gets told an empty bar is a claim, because the critic is the one whose
 * job is to attack it.
 *
 * Shared with the rehydration prefix below, so a rotated implementer session is
 * handed exactly the section the direct prompt would have handed it.
 */
function implementerCriteria(items: readonly AcceptanceCriterion[] | undefined): string {
  if (!hasBar(items)) return '';
  return `\n## Acceptance criteria - the bar this change must clear\n\nThese were approved with the plan. They are the conditions your work has to satisfy, and what a reviewer may cite by \`id\` when something is missing. Nothing here runs them: treat them as the definition of done you are building against, and if one turns out to be impossible or wrong, say so in your report rather than quietly working to a lower bar.\n\n${formatAcceptanceCriteria(items)}\n`;
}

/**
 * Whether this run has a bar a report can be keyed to.
 *
 * One predicate, shared by `implementerCriteria` and `reportRequest`, so that
 * "one line per acceptance-criterion `id` above" is never printed in a prompt
 * that rendered no criteria above it - a writer asked for ids it cannot see
 * cannot answer, and the generic heading assertion would still pass (#50).
 *
 * Two states, not the three `formatAcceptanceCriteria` renders: a write turn is
 * told nothing when there is no bar, and the critic is the component told that
 * an empty bar is a claim, because attacking it is the critic's job.
 */
function hasBar(items: readonly AcceptanceCriterion[] | undefined): items is readonly AcceptanceCriterion[] {
  return items !== undefined && items.length > 0;
}

/**
 * The report a write turn is asked for, in the shape the reviewer is shown (#50).
 *
 * Shared by `implementPrompt` and `fixPrompt`, with the same five headings in
 * the same order, so the reviewer's rendering does not have to care which kind
 * of write turn produced the report. Before this the implementer was asked to
 * "report concisely" and the fixer to "report what you changed", and the
 * reviewer was handed neither - every deviation, every unverified claim and
 * every worry was written to disk at real cost and read by nobody.
 *
 * A section with nothing in it is still asked for: an empty section stated is
 * worth more than one omitted, because the reviewer can tell "nothing to
 * report" from "did not consider it".
 *
 * The `id` clauses are gated on `hasBar`, which is exactly when the caller has
 * rendered `implementerCriteria` above this.
 *
 * `implementPrompt` renders this BEFORE its carried and declined sections
 * rather than at the end, which is load-bearing in two ways and not a matter of
 * taste. Those sections each end by telling the implementer to "say in your
 * report what you did about it", and that instruction now has its antecedent
 * above it rather than below. And the carried section stays the tail of the
 * prompt, byte for byte, which `declined-findings.test.ts` pins as the frozen
 * output of the build before `findingBullet` was extracted (#31).
 */
function reportRequest(
  criteria: readonly AcceptanceCriterion[] | undefined,
  kind: 'implement' | 'fix',
): string {
  const byId = hasBar(criteria);
  return `\n## Your report

Your final message is handed to the next code reviewer as-is. Use all five of these headings, in this order:

- **Changed** - what you actually changed, and where.
- **Verified** - what you checked and how you checked it.${
    byId
      ? ' One line per acceptance-criterion `id` above, then prose for anything the criteria do not cover.'
      : ''
  }
- **Unable to verify** - what you could not check, and what stopped you.${
    byId ? ' One line per criterion `id` you could not check.' : ''
  }
- **Deviations** - where you did something other than what the plan said, and why.
- **Questions / concerns for reviewer** - what you are least sure about, and where you would look first.

A section with nothing to report still gets its heading and the word "none". An empty section stated is worth more than a section left out: the reviewer can tell the difference between nothing to report and not considered.${
    kind === 'fix'
      ? ' A fix round legitimately has little to say under most of these - say so rather than omitting them.'
      : ''
  }

Do not claim a check you did not run. The reviewer validates this report against the repository, the diff and the tests.
`;
}

/** What a rotated or resumed *implementer* session must be told the bar is. */
export interface FrozenBar {
  /**
   * The gate-pass snapshot. It wins over `plan.acceptance_criteria`, which can
   * have moved since - by a later write, by an in-place edit, or by `readPlan`
   * repairing an unusable plan away entirely.
   */
  acceptanceCriteria: readonly AcceptanceCriterion[] | undefined;
}

/**
 * The plan as a standalone document: the prose, the boundary it drew, and the
 * bar it set.
 *
 * `plan_md` alone is not the plan of record any more. Used for the PLAN.md
 * artifact and for the rehydration prefix a rotated session starts from, so a
 * fresh session cannot lose the boundary or the bar the previous one stated.
 *
 * `frozen` switches the acceptance section to the implementer's view: the
 * approved snapshot rather than the plan's own copy, under the two-state rule
 * `implementPrompt` follows. Without it - the PLAN.md artifact, and a rotated
 * *planner*, which is still revising the plan and must see what it wrote - the
 * plan's own three-state field is rendered. A rotated implementer given the
 * plan's copy would be reading a bar the gate never approved, beside a direct
 * prompt carrying the one it did.
 */
export function renderPlanDoc(plan: Plan, frozen?: FrozenBar): string {
  const criteria =
    frozen === undefined
      ? `\n## Acceptance criteria\n\n${formatAcceptanceCriteria(plan.acceptance_criteria)}\n`
      : implementerCriteria(frozen.acceptanceCriteria);
  return `${plan.plan_md}\n\n## Out of scope\n\n${formatOutOfScope(plan.out_of_scope)}\n${criteria}`;
}

/**
 * How many past runs the planner is shown (#52).
 *
 * Measured on this repo's own archive: a run id is 56 characters, and the first
 * line of a brief is a markdown heading - across the seven runs preserved up to
 * #50 those range from 47 to 82 characters. That archive renders at 2,416 bytes
 * today; ten rows of realistic length come to 2,960, and ten rows with every
 * field at its cap - which needs a deliberately hostile `state.json` - to 3,690.
 * So the section is bounded under 4KB whatever is on disk, against the 8-12KB
 * briefs this repo feeds `vibe`. Roughly 1.4KB of that is the framing below,
 * which is charged once however many runs are listed.
 *
 * The bound exists because the archive grows without limit and the prompt does
 * not. Ten also covers about a fortnight at the rate this repo produces runs,
 * which is the span over which a past decision is still likely to be about code
 * that is still there.
 */
export const PRIOR_RUN_LIMIT = 10;

/**
 * Per-field caps, applied to every value that came off disk (#52).
 *
 * Ids are 56 characters today, the longest status a run can reach is
 * `implementing` (12), and the longest first line observed in this repo's
 * archive is 82. Each cap is the measured maximum with headroom, not a round
 * number picked to look tidy.
 */
const PRIOR_RUN_ID_CHARS = 80;
const PRIOR_RUN_STATUS_CHARS = 24;
const PRIOR_RUN_TASK_CHARS = 100;

/**
 * One archive-derived value, made safe to put on a prompt line (#52).
 *
 * Everything on a row - the id, which is a directory name, the status and the
 * task - is read off disk, and none of it is trusted. `summariseStored` passes
 * an unrecognised status through verbatim on purpose, because `vibe list` only
 * prints it; a prompt is not a terminal, and an unbounded or multi-line value
 * there breaks the one-line bound and can read as an instruction to the model.
 * Capping the task alone was not enough: the mistake is that archive strings
 * are input, so all three go through here.
 *
 * First line only, control characters replaced with a space, runs of whitespace
 * collapsed, backticks dropped so an inline code span cannot be broken out of,
 * then capped with the same ASCII marker style `truncationMarker` uses.
 */
function promptSafeCell(value: string, max: number): string {
  // The first line, and only the first: a task is a whole brief, and the rest
  // of it is what the planner opens the run directory for.
  //
  // Every CR/LF boundary, not just LF and CRLF. A lone CR is a line ending too,
  // and `\r?\n` does not see one: `first\rSECOND` split that way is a single
  // "line", and the flattening below then turns the CR into a space rather than
  // cutting there - so the whole of `SECOND` reached the prompt, which is
  // exactly what first-line-only exists to stop (#52 review).
  const firstLine = value.split(/\r\n|\r|\n/)[0] ?? '';
  const flattened = Array.from(firstLine, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    // Everything below space, plus DEL and the two Unicode line separators:
    // line terminators, cursor movement, and characters that are invisible in a
    // rendered prompt while still being in it. Compared by code point rather
    // than written as a regex range, so the source says which characters it
    // means instead of containing them.
    return code < 0x20 || code === 0x7f || code === 0x2028 || code === 0x2029 ? ' ' : ch;
  })
    .join('')
    // The row wraps the id in an inline code span, so a backtick in the data
    // could close it and let the rest render as prose.
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flattened.length > max ? `${flattened.slice(0, max).trimEnd()} ...` : flattened;
}

/** One row: what the run was called, how it ended, and what it was asked to do. */
function priorRunRow(run: RunSummary): string | null {
  const id = promptSafeCell(run.id, PRIOR_RUN_ID_CHARS);
  // A row with no usable id names nothing that can be opened or cited, so it is
  // dropped rather than rendered as an anonymous line that costs prompt space
  // and answers no question.
  if (id === '') return null;
  const status = promptSafeCell(run.status, PRIOR_RUN_STATUS_CHARS);
  const task = promptSafeCell(run.task, PRIOR_RUN_TASK_CHARS);
  const head = `- \`${id}\` - ${status === '' ? 'unknown' : status}`;
  // Nothing invented when the task cannot be read: an unreadable run carries an
  // empty task, and a placeholder sentence there would be a claim about what it
  // was for.
  return task === '' ? head : `${head} - ${task}`;
}

/**
 * The record previous runs left behind, and how to read it (#52).
 *
 * The planner already has read tools and already runs against the repository
 * that holds `.vibe/runs/`; what it has never had is any indication that the
 * directory is there. This is Option 1 of the issue: name the record and bound
 * the naming, rather than injecting past conclusions wholesale.
 *
 * Empty renders NOTHING - not a heading, not a "no past runs" sentence. A
 * first-ever run's planning prompt is then byte-identical to the one before
 * this existed, which is the compatibility bar this was accepted against, and
 * it is reachable only because the current run is filtered out upstream: its
 * own directory exists before the planning turn is dispatched.
 *
 * **The guard is the point of the section, not decoration on it.** A past run's
 * reasoning is not automatically right: #23's brief carried a factual mistake
 * and #33's specified a rule that would have broken an existing test, and both
 * were caught by a critic reading the code as it *then* was. Presenting past
 * conclusions as settled context makes that harder, so the section argues
 * against itself - evidence, never instruction; possibly already wrong; and a
 * decision recorded there is not a decision made here. `FOLLOW-UPS.md` already
 * carries this warning for human readers, and whatever reaches the prompt
 * carries the same one.
 *
 * The artifacts are named as ones a run *may* contain, because most of them are
 * conditional: `FOLLOW-UPS.md` is removed when there is nothing deferred and no
 * declared scope, `ASSUMED.md` is written only when a question ran on the
 * planner's guess, and `OUTSTANDING.md` only when findings were carried. A
 * missing file is a run with nothing to report, not a gap in the record.
 */
export function priorRunsSection(runs: readonly RunSummary[]): string {
  // Sliced here as well as by the caller: the bound is a property of the
  // prompt, so it holds whatever a caller passes.
  const rows = runs
    .slice(0, PRIOR_RUN_LIMIT)
    .map(priorRunRow)
    .filter((row): row is string => row !== null);
  if (rows.length === 0) return '';

  return `## Past runs in this repository

\`.vibe/runs/\` holds what previous \`vibe\` runs on this repository decided, most recent first. You can open any of them with your read tools.

${rows.join('\n')}

At most ${PRIOR_RUN_LIMIT} runs are listed here and **there may be more** - \`.vibe/runs/\` is the full list. A run directory **may** contain \`FOLLOW-UPS.md\` (what was declined or deferred, and why), \`ASSUMED.md\` (questions that ran on the planner's guess), \`OUTSTANDING.md\` (findings carried unresolved), \`PLAN.md\`, \`plan-critique-*.json\` (what the critic attacked) and \`code-review-*.json\` (what the reviewer found). Which of these exist depends on how far that run got and what it found, so treat a missing file as nothing to report rather than as a gap.

**How to read one.**

- A past run is **evidence about what was considered**, never an instruction about what to do.
- It describes the code **as it was on that date**, and it may already be wrong. Check any claim it makes against the code as it is now, exactly as your own claims will be checked.
- A severity or a decision recorded there was true of that run's argument, not of this one.
- **Finding that something was declined before is not a reason to decline it again.** It is a reason to know why, and to say something new if you disagree.
- If your plan relies on a past run's conclusion, **cite the run id in the assumption that rests on it**, so the critic can open the same file and check it.

`;
}

export function planPrompt(
  task: string,
  extraContext: string | null,
  environment?: EnvironmentFacts | null,
  roles: RoleTable = ROLES,
  /**
   * The past-run index, rendered by `priorRunsSection` (#52).
   *
   * Trailing and optional for the reason #49's `chunk` and #50's `report` are:
   * every existing caller passes the parameters before it positionally, and an
   * inserted one would silently reinterpret one of them. Absent renders
   * nothing, which is what keeps a first-ever run's prompt byte-identical.
   */
  priorRuns?: readonly RunSummary[] | undefined,
): string {
  return `You are planning an implementation. Do NOT write any code or modify any files - this is a planning pass only.

## Task
${task}
${extraContext ? `\n## Additional context\n${extraContext}\n` : ''}
${environmentBlock(environment, 'planner', roles)}${priorRunsSection(priorRuns ?? [])}## What to produce

Investigate the codebase first (read files, search, inspect the build and test setup), then produce a plan detailed enough that another engineer could execute it without asking you anything.

The plan must cover:
- Concrete file-by-file changes - actual paths, actual function and symbol names.
- The order of work, and which steps depend on which.
- How the change will be verified: specific tests or commands, not "add tests".
- Edge cases, failure modes, and rollback if the change is risky.

## Two things this plan will be judged on

**Assumptions.** A separate reviewer will attack this plan. Every judgement call you made that a reasonable engineer could dispute must appear in \`assumptions\` - the choice, why you made it, and what has to be redone if you are wrong. An assumption you leave unstated is one the reviewer cannot catch, which is how a plan passes review and still ships the wrong thing.

**Open questions.** You cannot ask a human interactively here. Anything you would have stopped to ask goes in \`open_questions\` with your best answer in \`recommended\`. Classify each honestly:
- \`kind: "technical"\` - answerable from the codebase, the ecosystem, or engineering judgement.
- \`kind: "product"\` - depends on user intent, business priorities, or taste. You cannot derive it by reading code.
- \`blocking: true\` - only when proceeding on your recommended answer risks doing substantial work that turns out wrong.

Do not inflate either list. A plan with fifteen trivial questions is as unreviewable as one with none.

${RESPOND_WITH_JSON}`;
}

export function critiquePrompt(
  planMd: string,
  assumptions: readonly Assumption[],
  outOfScope: readonly OutOfScopeItem[] | undefined,
  round: number,
  hasMemory: boolean,
  environment?: EnvironmentFacts | null,
  roles: RoleTable = ROLES,
  /**
   * Appended rather than placed beside `outOfScope`, where it belongs
   * conceptually: every existing caller passes these positionally, and an
   * inserted parameter would silently reinterpret one of them.
   */
  acceptanceCriteria?: readonly AcceptanceCriterion[] | undefined,
): string {
  return `You are a senior engineer reviewing an implementation plan before any code is written. Be adversarial: your job is to find what is wrong with it, not to praise it.${
    round > 1 ? continuityNote(round, hasMemory, 'plan') : ''
  }

Read the actual repository to check the plan's claims against reality. A plan that references a file, function, or API that does not exist is a P1.

${environmentBlock(environment, 'reviewer', roles)}

## Severity

- **P0** - stop the run and fetch a human. An approach that cannot be made to work at all, or one whose failure mode is data loss or a security hole. A single P0 halts the run, so use it only when continuing would be worse than stopping.
- **P1** - must fix. Correctness, security, an approach that cannot work as written, a factual claim about the codebase that is false, or an unstated assumption that would silently produce the wrong result.
- **P2** - should fix. Maintainability, missing tests, unhandled edge cases.
- **P3** - nit. Style, naming, wording.

Be strict about what earns P1, and stricter still about P0. A P2 inflated to P1 burns a full revision cycle.

**A plan does not have to be perfect to be worth implementing.** A small number of P1s may be carried into the implementation, which is told about them and expected to resolve them while writing the code. That is the right home for anything only a test run can settle - an exact output string, a boundary condition, whether a heuristic misfires on a real input. Raising it is useful; demanding it be resolved in prose first is not. If a finding would be answered in seconds by running the project's tests, it is a P1 and you should say so plainly rather than treating it as a blocker on the document.

Reserve your objections for what genuinely cannot be discovered by building the thing: a wrong approach, a missed requirement, a false claim about the code.

Give each finding a stable kebab-case \`id\` so it can be tracked across rounds.

## Evidence

${EVIDENCE_RULE}

${scopeGuidance(outOfScope, 'plan')}

## Acceptance criteria

${formatAcceptanceCriteria(acceptanceCriteria)}

This is the plan's own definition of done, and it is yours to attack. Two questions, both worth findings: are these the *right* conditions, and are they *sufficient* - would a change satisfying every one of them still leave the task undone? A criterion nobody could agree on the outcome of, one whose \`check\` cannot actually establish it, and a bar that omits the thing this change exists for are each a defect in the plan at its true severity. An empty bar is a claim like any other: if done-ness here is observable, say so and say how.

Nothing executes a criterion in this run, so do not raise findings about running them. Cite one by its \`id\` where it makes a finding concrete.

${REVIEW_BREADTH}

## The plan

${planMd}

## Assumptions the planner declared

${formatAssumptions(assumptions)}

Scrutinise these specifically. An assumption that is wrong, or one whose blast radius is understated, is a P1.

${RESPOND_WITH_JSON}`;
}

export function answerPrompt(questions: readonly OpenQuestion[], planMd: string): string {
  return `An engineer is planning an implementation and hit questions they could not resolve alone. Answer the ones you can from the codebase and sound engineering judgement.

Read the repository before answering. Ground each answer in what is actually there.

**Be honest about what you cannot know.** If a question turns on what the user wants - product intent, priorities, taste, business context - set \`defer_to_human: true\` and do not invent a preference. A confidently wrong answer to a product question is far more expensive than escalating it, because the entire implementation gets built on top of it.

Set \`confidence\` honestly too: \`low\` means you are guessing.

Questions are marked **blocking** or **advisory**. Answer both with the same care - an advisory question is one the planner was willing to guess at, which is exactly where an unexamined default slips through. The marking only changes what happens when you decline: a declined blocking question stops the run for a human, while a declined advisory one leaves the planner's own fallback in place. So decline when you genuinely should, not to save the run from stopping.

Answer every question in the list, including ones you decline - echo the question and set \`defer_to_human: true\`.

## Questions

${questions.map(formatQuestion).join('\n\n')}

## Plan they are working from

${planMd}

${RESPOND_WITH_JSON}`;
}

export interface RevisePlanArgs {
  findings?: readonly Finding[] | undefined;
  answers?: readonly Answer[] | undefined;
  /**
   * The boundary the current plan drew.
   *
   * Restated to the planner every round because a revision returns the
   * *complete* plan: a fresh session - and the session can be rotated
   * concurrently with the critique - would otherwise re-derive `out_of_scope`
   * from nothing and silently drop a boundary the run had already settled.
   */
  outOfScope?: readonly OutOfScopeItem[] | undefined;
  /**
   * The bar the current plan set, restated every round for exactly the reason
   * the boundary is: a revision returns the *complete* plan, and a session
   * rotated concurrently with the critique would otherwise re-derive
   * `acceptance_criteria` from nothing and quietly drop a bar the run had
   * already settled. This is also the anti-shedding guard inside the plan
   * phase, where the critic is still watching.
   */
  acceptanceCriteria?: readonly AcceptanceCriterion[] | undefined;
  round: number;
}

export function revisePlanPrompt({
  findings,
  answers,
  outOfScope,
  acceptanceCriteria,
  round,
}: RevisePlanArgs): string {
  const parts: string[] = [`Revise your plan. This is revision round ${round}.`];

  if (findings && findings.length > 0) {
    parts.push(`## Review findings

An independent reviewer raised the following. Every **P1 must be resolved** - that is the gate for proceeding to implementation.

${findings.map(formatFinding).join('\n\n')}${deferralNote(findings, 'planner')}

For each P1: fix the plan, or, if you believe the finding is wrong, say so explicitly in the plan with your reasoning. Do not silently ignore one.

${FIX_BREADTH}`);
  }

  if (answers && answers.length > 0) {
    parts.push(`## Answers to your open questions

${answers.map(formatAnswer).join('\n\n')}

Fold these into the plan and drop the corresponding open questions.`);
  }

  parts.push(`## The boundary your current plan drew

${formatOutOfScope(outOfScope)}

\`out_of_scope\` is the whole boundary, not a delta: restate every item that still holds. Dropping one is a deliberate decision to take that work on - if you drop it, say so in the plan and explain why. Adding one is how you decline a finding that is real and worth doing but belongs in separate work.`);

  parts.push(`## The bar your current plan set

${formatAcceptanceCriteria(acceptanceCriteria)}

\`acceptance_criteria\` is the whole bar, not a delta: restate every criterion that still holds. Dropping one lowers the bar - if you drop it, say so in the plan and explain why it was never the right condition. Adding one is how a revision answers a finding that the plan's definition of done was incomplete.`);

  parts.push(
    'Return the **complete revised plan**, not a diff or a summary of changes - the plan is consumed standalone by the implementer. Keep `assumptions` current: remove any that were resolved, add any the revision introduced.',
    RESPOND_WITH_JSON,
  );

  return parts.join('\n\n');
}

/**
 * One bullet, shared by the two lists `implementPrompt` renders.
 *
 * Extracted rather than duplicated: the carried and the declined sections say
 * opposite things about the same shape, and a renderer that drifted between
 * them would make the two blocks look like different kinds of thing.
 */
function findingBullet(f: Finding): string {
  return `- **${f.title}** \`${f.id}\`\n  ${f.detail}\n  *Suggested fix:* ${f.suggested_fix}${citation(f, '\n  ')}`;
}

export function implementPrompt(
  planMd: string,
  carried: readonly Finding[] = [],
  /**
   * What the critique round that *approved* the plan declined.
   *
   * The opposite instruction to `carried`, and the reason this parameter
   * exists at all: a revising round tells the planner what was deferred
   * through `revisePlanPrompt`, but the round that passes the gate has its
   * findings cleared, so without this the implementer never learns the critic
   * drew a boundary the plan may not state - and can implement the very thing
   * that was declined.
   */
  declined: readonly Finding[] = [],
  /**
   * The gate-pass snapshot, never `plan.acceptance_criteria`. Rendered as its
   * own section beside the plan rather than among the findings: it is the bar,
   * not open work.
   */
  acceptanceCriteria: readonly AcceptanceCriterion[] | undefined = [],
): string {
  const known =
    carried.length === 0
      ? ''
      : `\n## Known open issues with this plan\n\nThe reviewer raised these and they were **not** resolved before implementation, because they are the kind of question that is settled by running the code rather than by more discussion. Treat them as work items: resolve each one as you implement, and say in your report what you did about it.\n\n${carried
          .map(findingBullet)
          .join('\n')}\n`;

  // Wording follows the fixer half of `deferralNote`: same instruction, same
  // posture, and the same basename-only reference to the artifact - it lives in
  // the run directory, and a path stated here would be one the code does not
  // produce.
  //
  // It allows the plan to name a declined finding rather than denying it can.
  // `revisePlanPrompt` asks the planner to record deferred work under
  // `out_of_scope` and `renderPlanDoc` prints that boundary, so an earlier
  // round's deferral may well appear in the plan the implementer is reading;
  // saying the plan "may not mention them" invited that to be read as a
  // prohibition, contradicting a boundary the plan legitimately states.
  const notDoing =
    declined.length === 0
      ? ''
      : `\n## Declined by the reviewer - not work for this change\n\nThe reviewer marked these **deferred**: real, and agreed to belong in separate effort rather than in this change. They are recorded in FOLLOW-UPS.md. Unlike anything listed above, these are work to **not** do. The plan may name one under its out-of-scope boundary or may not mention it at all; either way, do not treat it as in-scope work and do not fold it in as you implement. If you think one has to be fixed inside this change, say so in your report rather than fixing it silently.\n\n${declined
          .map(findingBullet)
          .join('\n')}\n`;

  return `The plan below has been reviewed.${carried.length > 0 ? ` ${carried.length} open issue(s) are listed after it and are yours to resolve.` : ' It is cleared of all blocking issues.'} Implement it now.

You have write access. Work through the plan end to end:
- Make the actual code changes.
- Run the project's existing build, lint, and test commands as you go, and fix what you break.
- If the plan turns out to be wrong about something in the codebase, do the right thing and note the deviation clearly in your final message rather than following the plan off a cliff.

Do not commit - the orchestrator handles git.

## The approved plan

${planMd}
${implementerCriteria(acceptanceCriteria)}${reportRequest(acceptanceCriteria, 'implement')}${known}${notDoing}`;
}

/** One part of a review round, as the reviewer is told about it. */
export interface ReviewChunk {
  /** 1-based. */
  index: number;
  total: number;
  files: readonly string[];
  /** Files in THIS part whose diff was cut. */
  truncated: readonly string[];
  /**
   * Whether the earlier parts of THIS round are in this same conversation.
   * Not the slot's lifetime memory - see `chunkNote`.
   */
  carriesEarlierParts: boolean;
}

/**
 * What this turn is a part of, and what it was not shown.
 *
 * Two paragraphs, independently rendered, because they answer two different
 * questions and the cases do not coincide:
 *
 * - The part framing appears only when there IS more than one part. A single
 *   oversized file is one chunk, and telling it that it is "part 1 of 1" would
 *   be noise.
 * - The truncation paragraph appears whenever something was cut, single chunk or
 *   not. That case is exactly the one #49 is named after: the reviewer used to
 *   be handed a diff with a marker in it and nothing that asked it to go and
 *   read the rest, and an absence of findings about the tail is what an APPROVE
 *   is made of.
 *
 * `carriesEarlierParts` is NOT the slot's memory. A later round's part 1 resumes
 * a thread that remembers earlier *rounds* and has never seen this round's other
 * parts, so keying the "you already saw them" wording on `hasMemory` would tell
 * it not to repeat findings for a diff it has not been shown.
 */
function chunkNote(chunk: ReviewChunk): string {
  const parts: string[] = [];

  if (chunk.total > 1) {
    parts.push(
      `## This is part ${chunk.index} of ${chunk.total}

The change was too large to show in one turn, so it is being reviewed a few files at a time. **This is one review round, not ${chunk.total} of them** - the findings from every part are merged into a single report, so raise what you see here and do not wait for a later part to raise it for you. A defect that spans parts is worth raising on the part where it is visible.`,
    );
    parts.push(
      chunk.carriesEarlierParts
        ? `The earlier parts of this same round were shown to you earlier in this conversation, so do not re-file a finding you already raised for them.`
        : `**You have not been shown the other parts of this round** - either this is the first part, or this turn is a fresh conversation. Do not assume they were reviewed, and do not assume they were fine. Raise anything this part shows you even if it might also appear in a part you cannot see; repeated ids are merged.`,
    );
  }

  if (chunk.truncated.length > 0) {
    const named = chunk.truncated.map((f) => `\`${f}\``).join(', ');
    parts.push(
      `**The diff below is incomplete for ${named}.** ${
        chunk.truncated.length === 1 ? 'That file is' : 'Those files are'
      } larger than one turn can carry, so the patch stops part-way through and the rest is not here. Open ${
        chunk.truncated.length === 1 ? 'it' : 'them'
      } in the working tree and read the remainder before judging ${
        chunk.truncated.length === 1 ? 'it' : 'them'
      } - "nothing found" about a part you were never shown is the one answer this review cannot give.`,
    );
  }

  return `\n${parts.join('\n\n')}\n`;
}

/**
 * The most recent write turn's report, and how to read it.
 *
 * Three states, deliberately. `undefined` is a caller that makes no statement -
 * only the fixture callers do - and renders NOTHING, which is what keeps
 * `review-round1.txt` and `review-round3-memory.txt` byte-identical. `null`, or
 * text that is blank, is a run that recorded no readable report and renders the
 * notice: silence here would read as a clean bill of health, which is precisely
 * the failure #50 is about. A non-empty string is the report itself.
 *
 * ONE notice for both causes of absence. A missing pointer and a pointer to
 * something unreadable differ in what went wrong, not in what the reviewer
 * should do, and that difference belongs in the run events and the repair log.
 * `artifactText` already collapses missing and unreadable to `null` for the
 * same reason.
 *
 * Both halves of the framing are stated, because they pull opposite ways and
 * only one of them is obvious. The report is untrusted - a "verified" line is a
 * claim that something was checked, not evidence that it works. And it is not
 * exhaustive: it says where the implementer knows it is weak and nothing at all
 * about where it does not, so a reviewer that treats it as the set of concerns
 * and stops looking has been made worse off by having it. Its questions are
 * leads, never findings in themselves.
 *
 * The text is trimmed before it is rendered, for the same reason it is trimmed
 * before it is called blank: whether a model's final message happens to end in
 * a newline is not something the prompt's bytes should depend on. Untrimmed it
 * produced a stray blank line before the paragraph below it on some turns and
 * not others - cosmetic in markdown, but this file freezes prompt bytes in
 * fixtures, so one input should render one output.
 */
function reportSection(report: string | null | undefined): string {
  if (report === undefined) return '';
  if (report === null || report.trim() === '') {
    return `
## What the implementer says it did

**No report was recorded for the most recent write turn.** That is a gap in this run's record. It is **not a statement that there were no concerns**: nothing here says the implementer verified everything, deviated from nothing, or had nothing to raise. Review the change on its own terms, as if no report had been asked for.
`;
  }
  return `
## What the implementer says it did

This is the report from the most recent write turn on this change.

${report.trim()}

**Two things about it, and they pull in opposite directions.**

1. **It is untrusted.** These are claims, not facts. A line under "Verified" is a claim that something was checked, not evidence that it works. Validate it against the repository, the diff and the tests - a claim you cannot confirm is a place to look, and a claim that turns out to be false is a finding.
2. **It is not exhaustive, and it is not a checklist.** It says where the implementer knows it is weak. It says nothing at all about where it does not know it is weak. A confident report with no questions is not evidence of a clean change, and finding nothing beyond what it lists is not a review. Review the whole change exactly as you would if this section were not here.

A question or concern raised here is a **review lead** - somewhere to go and look - never a finding in itself. A lead that turns out to be real becomes a finding at its true severity, cited like any other; a lead that turns out to be fine is not reported at all.
`;
}

export function reviewPrompt(
  diff: string,
  changedFiles: readonly string[],
  planMd: string,
  outOfScope: readonly OutOfScopeItem[] | undefined,
  round: number,
  hasMemory: boolean,
  environment?: EnvironmentFacts | null,
  roles: RoleTable = ROLES,
  /** The gate-pass snapshot, appended for the reason `critiquePrompt`'s is. */
  acceptanceCriteria?: readonly AcceptanceCriterion[] | undefined,
  /**
   * Present only when this turn is one part of a change too large for a single
   * one, or when a file in it was cut. Absent renders NOTHING, which is what
   * keeps an ordinary round's prompt byte-identical to the one before #49.
   */
  chunk?: ReviewChunk | undefined,
  /**
   * The last write turn's report, rendered by `reportSection`.
   *
   * Trailing and three-state for the reason `chunk` is trailing: omitting it
   * renders nothing, which is what keeps the two frozen golden prompts
   * byte-identical. `runReview` always passes it, so a real review round always
   * carries a report section - present, or the notice saying there is none.
   */
  report?: string | null | undefined,
): string {
  return `You are reviewing a code change against the plan it was meant to implement.${
    round > 1 ? continuityNote(round, hasMemory, 'change') : ''
  }

Read the repository as needed - the diff is context, not the whole picture. Check the surrounding code the change interacts with, and run the tests if that is the fastest way to settle a question.

${environmentBlock(environment, 'reviewer', roles)}

Judge two things:
1. **Correctness on its own terms** - bugs, security issues, race conditions, unhandled errors, resource leaks, broken edge cases.
2. **Fidelity to the plan** - was anything silently skipped, or done differently in a way that matters?

## Severity

- **P0** - stop the run and fetch a human. Data loss, a security hole, or an approach that cannot be made to work. A single P0 halts everything, so use it only when carrying on would be worse than stopping.
- **P1** - must fix. Correctness, security, data loss, or a plan requirement dropped without justification.
- **P2** - should fix. Missing tests, error handling, maintainability.
- **P3** - nit.

The loop may carry a small number of P1s forward and settle them against the test suite rather than in discussion, so a P1 is not a demand that everything stop. It is never ignored. Do not inflate a finding to P0 to force attention: P0 is for defects where continuing is the wrong thing to do at all.

Do not wave through a real defect. Reserve P1 for defects you can name a concrete failure case for, and prefer P1 over P0 for anything a test run could settle.

Give each finding a stable kebab-case \`id\`.

## Evidence

${EVIDENCE_RULE}

${scopeGuidance(outOfScope, 'change')}

## Acceptance criteria

${formatAcceptanceCriteria(acceptanceCriteria)}

This is the bar the plan was approved against - the conditions the change claimed would show it worked. Check the change against it as well as against the plan's prose: a criterion the change does not meet is a finding at its true severity, and naming the criterion's \`id\` in the finding is what makes it concrete.

There is no per-criterion verdict to report and no field to set. Your findings and their severities are the only signal this loop reads, exactly as before; the criteria are something a finding may cite, not a second scoreboard.

${REVIEW_BREADTH}
${chunk === undefined ? '' : chunkNote(chunk)}${reportSection(report)}
## Files changed

${changedFiles.length > 0 ? changedFiles.map((f) => `- ${f}`).join('\n') : '(none detected)'}

## Diff

\`\`\`diff
${diff || '(empty diff)'}
\`\`\`

## The plan this was implementing

${planMd}

${RESPOND_WITH_JSON}`;
}

export function fixPrompt(
  findings: readonly Finding[],
  round: number,
  /**
   * The gate-pass snapshot, appended for the reason `critiquePrompt`'s is: every
   * existing caller passes the two before it positionally.
   *
   * Rendered through `implementerCriteria` - the same renderer the implement
   * turn uses - rather than only being handed to `reportRequest`. A fix report
   * is read by the reviewer exactly as an implementation report is, so it is
   * asked for a line per criterion `id`; asking for that without printing the
   * ids would be asking the fixer for something it cannot see (#50).
   */
  acceptanceCriteria?: readonly AcceptanceCriterion[] | undefined,
): string {
  return `A code reviewer found issues in your implementation. This is fix round ${round}.

Resolve **every P1**. Address P2s where the fix is contained and low-risk; skip P3s unless trivial.

${findings.map(formatFinding).join('\n\n')}${deferralNote(findings, 'fixer')}

${FIX_BREADTH}

Re-run the project's tests after fixing. If you believe a finding is incorrect, fix nothing for it but explain why in your final message - do not silently skip it.

Do not commit - the orchestrator handles git.
${implementerCriteria(acceptanceCriteria)}${reportRequest(acceptanceCriteria, 'fix')}`;
}

/**
 * Asks the outgoing session to compress itself before rotation. This replaces
 * `/compact`, which is a CLI-level command with no effect in headless mode -
 * sent as a prompt it is just another user turn.
 */
export function handoffPrompt(): string {
  return `You are about to hand this work to a fresh session with none of this conversation in context. Write a handoff briefing.

Include, densely and without padding:
- What the task is, and where the work currently stands.
- What you learned about this codebase that cost you effort to discover: file layout, key symbols, conventions, build and test commands, anything surprising.
- Decisions already made and why, so they are not relitigated.
- Dead ends already ruled out, so they are not retried.
- What must happen next.

Be specific - name real files and symbols. Prefer detail over brevity in the technical findings; the cost of re-deriving them is higher than the cost of the tokens. Omit pleasantries entirely.

Output the briefing as markdown. No preamble.`;
}

/**
 * Prefix carried into the first turn of a rotated session.
 *
 * The two halves are independent. A rotation can produce no briefing at all -
 * the baseline rotation for an unattributable measurement rotates even when its
 * handoff turn fails - and the plan of record is the one thing a fresh session
 * must never start without: `revisePlanPrompt` does not restate it, so a turn
 * that lost both was asked to revise a plan it could not see.
 *
 * `stale` marks a briefing that survived a failed rotation. It describes an
 * earlier point in the run, so presenting it as "what you knew" would assert
 * that the work done since then never happened.
 */
export function handoffContext(handoff: string | null, planMd: string | null, stale = false): string {
  if (handoff === null && planMd === null) return '';

  const briefing =
    handoff === null
      ? `## Your previous session

The conversation so far was rotated to control context growth, and no briefing could be taken from it. Re-read whatever you need from the codebase rather than assuming it.
`
      : stale
        ? `## Briefing from earlier in this run

The conversation so far was rotated to control context growth. No briefing could be taken from the session that just ended, so this one is from an earlier point in the run: it predates whatever has happened since, and later work may contradict it.

${handoff}
`
        : `## Handoff from your previous session

The conversation so far was compacted to control context growth. This briefing is what you knew:

${handoff}
`;

  return `${briefing}${planMd === null ? '' : `\n## Current plan of record\n\n${planMd}\n`}
---

Continue from here.

`;
}

/**
 * When the Codex thread is resumed the reviewer genuinely remembers its earlier
 * rounds, so it can be held to reusing finding ids. Without memory that is an
 * impossible instruction, and a still-unresolved issue comes back under a fresh
 * id - which looks like new information and hides a deadlock from the
 * oscillation guard.
 */
function continuityNote(round: number, hasMemory: boolean, subject: 'plan' | 'change'): string {
  const what = subject === 'plan' ? 'plan' : 'change';
  if (hasMemory) {
    return `\n\nThis is review round ${round}, and it continues the same conversation in which you reviewed the earlier ${what} - you have your previous findings in context.

Two things follow. If a finding of yours is **still unresolved**, re-raise it with the **exact same \`id\` you used before**; do not restate it under a new name. If it was addressed, drop it and do not re-litigate it. Judging whether your own earlier objections were actually met is the main job this round.`;
  }
  // The `change` half of the memoryless branch says something different from the
  // `plan` half, because only one of the two prompts is telling the truth.
  // `revisePlanPrompt` does put the critique's findings in front of the planner;
  // `reviewPrompt` puts NO findings in front of the reviewer - it renders the
  // files, the diff, the plan, the scope and the criteria. So under
  // `codex.persistSession: false`, where every review turn is a fresh
  // conversation, this note used to tell a reviewer that had never seen a
  // finding not to re-litigate it, and a defect that was never fixed reads back
  // as an approval - the exact failure #49 exists to close.
  //
  // The `plan` half has the same shape of problem for the critic and is
  // deliberately left alone: the critic is out of scope for #49, and changing
  // its prompt inside a change to the review loop would move a second loop's
  // behaviour without evidence. Recorded as a follow-up.
  if (subject === 'change') {
    return `\n\nThis is review round ${round}. The change has already been revised in response to findings from earlier rounds, but **you do not have those findings** - this turn starts a fresh conversation and they are not reproduced here. Review what you are given on its own terms and raise every defect you can see, including one that may already have been raised before; do not stay silent about something because it might have been addressed. Use whatever \`id\` you would naturally choose - repeats are reconciled by the tool.`;
  }
  return `\n\nThis is review round ${round}. The ${what} has already been revised in response to earlier findings, which are quoted below. Re-raise one with its original \`id\` only if it is genuinely still unresolved - do not re-litigate points that were addressed.`;
}

/**
 * The deferral, carried to wherever a finding is shown.
 *
 * Appended only on `defer === true`: a legacy finding stored before the field
 * existed, and a finding the reviewer did not defer, must render exactly as
 * they did before, or every prompt in the run changes shape for nothing. The
 * `=== true` test mirrors `parseFindings`, so a stored `defer: 'yes'` is not
 * read as a deferral here either.
 */
const DEFERRED_MARK =
  '**Deferred by the reviewer** - real, and agreed to belong in separate work rather than in this change.';

/**
 * Where the finding says to look, rendered for whoever has to act on it.
 *
 * Empty when there is nothing cited, and that is load-bearing: a finding
 * recorded before this field existed, and the gate's own synthesized P0 before
 * it was given evidence, must render byte-for-byte as they did, or every prompt
 * in the run changes shape for nothing. Same `=== true`-style caution as
 * `DEFERRED_MARK`, one field along.
 *
 * Malformed entries are dropped **here** rather than in `hasFindingShape`: a
 * bad citation must not delete a finding from FOLLOW-UPS.md or OUTSTANDING.md,
 * so the rendering is what refuses it, not the shape check (#48). And dropped
 * through `readEvidence`, not by hand, because this renderer meets stored state
 * that nothing has validated - a resumed run's `carried`, `outstanding` or
 * `pendingFindings` can hold `evidence: {}` or `[null]`, either of which would
 * throw here and take down the prompt the run was about to buy.
 *
 * The paths are repo-relative because `groundFindings` rewrote the resolved
 * ones to that form. It matters here specifically: with the default table the
 * reviewer is Codex in PowerShell and the fixer is Claude in Git Bash, so the
 * `C:\...` a citation may legitimately arrive as is not a path the reader's
 * shell can open. Repo-relative is the one form true for both.
 */
function citation(f: Finding, indent: string): string {
  const parts = readEvidence(f.evidence)
    .map((e) => {
      if (e.kind === 'external') {
        const ref = typeof e.ref === 'string' ? e.ref.trim() : '';
        return ref === '' ? null : `external: ${ref}`;
      }
      const at = typeof e.path === 'string' ? e.path.trim() : '';
      if (at === '') return null;
      const where = `\`${at}${e.kind === 'code' && typeof e.line === 'number' ? `:${e.line}` : ''}\``;
      return e.kind === 'absence' ? `missing from ${where}` : where;
    })
    .filter((p): p is string => p !== null);

  return parts.length === 0 ? '' : `${indent}*Cited:* ${parts.join(', ')}`;
}

function formatFinding(f: Finding): string {
  return `### [${f.severity}] ${f.title}  \`${f.id}\`
${f.detail}

*Suggested fix:* ${f.suggested_fix}${citation(f, '\n')}${f.defer === true ? `\n\n${DEFERRED_MARK}` : ''}`;
}

/**
 * What a deferral obliges the reader to do - and it differs by reader, which is
 * why the mark on the finding does not try to say it.
 *
 * Empty when the round deferred nothing, so a prompt only ever carries the
 * paragraph when there is something for it to describe.
 *
 * The planner half asks for an `out_of_scope` entry but nothing depends on
 * getting one: this prompt is rendered only when the gate failed, so a round
 * whose findings were all deferred never reaches it. FOLLOW-UPS.md, written
 * every round regardless of the gate, is the record that always exists.
 */
function deferralNote(findings: readonly Finding[], audience: 'planner' | 'fixer'): string {
  if (!findings.some((f) => f.defer === true)) return '';

  if (audience === 'planner') {
    return `\n\nOne or more findings above are marked **deferred**. That is the reviewer agreeing the work belongs elsewhere, not a request that you do it. Preserving the boundary is the correct response, not resolving the item: do not fold the work into the plan. Since you are revising anyway, record it in \`out_of_scope\` if the boundary does not already cover it - that is where a reader of the plan will look for it. If you believe deferred work genuinely has to happen inside this change, say so explicitly in the plan and explain why; disputing a deferral is legitimate, absorbing one silently is not.`;
  }
  return `\n\nOne or more findings above are marked **deferred**. A deferred finding is not work to do here: the reviewer has already agreed it belongs in separate effort, and it is recorded in FOLLOW-UPS.md. The instruction to address contained, low-risk P2s does not apply to it - leave it alone. If you think it has to be fixed now, say so in your report rather than fixing it silently.`;
}

function formatAssumptions(assumptions: readonly Assumption[]): string {
  if (assumptions.length === 0) {
    return '(the planner declared none - treat that itself as suspicious)';
  }
  return assumptions
    .map(
      (a, i) =>
        `${i + 1}. **${a.assumption}**\n   - Why: ${a.why}\n   - If wrong: ${a.blast_radius}`,
    )
    .join('\n');
}

function formatQuestion(q: OpenQuestion, i: number): string {
  const opts = q.options.length > 0 ? `\n   Options: ${q.options.join(' | ')}` : '';
  const tag = q.blocking ? 'blocking' : 'advisory';
  return `${i + 1}. **${q.question}** *(${q.kind}, ${tag})*${opts}\n   Planner's fallback answer: ${q.recommended}`;
}

function formatAnswer(a: Answer): string {
  return `**Q: ${a.question}**
A: ${a.answer}
*(confidence: ${a.confidence}${a.rationale ? ` - ${a.rationale}` : ''})*`;
}
