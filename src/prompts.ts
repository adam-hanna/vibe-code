import { describedRole, ROLES } from '@src/roles.js';
import type { RoleTable } from '@src/roles.js';
import type { EnvironmentFacts } from '@src/runtime.js';
import type {
  Answer,
  Assumption,
  Finding,
  OpenQuestion,
  OutOfScopeItem,
  Plan,
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

  const verification =
    facts.verifyCommand === null
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
 * The plan as a standalone document: the prose plus the boundary it drew.
 *
 * `plan_md` alone is not the plan of record any more. Used for the PLAN.md
 * artifact and for the rehydration prefix a rotated session starts from, so a
 * fresh session cannot lose the boundary the previous one stated.
 */
export function renderPlanDoc(plan: Plan): string {
  return `${plan.plan_md}\n\n## Out of scope\n\n${formatOutOfScope(plan.out_of_scope)}\n`;
}

export function planPrompt(
  task: string,
  extraContext: string | null,
  environment?: EnvironmentFacts | null,
  roles: RoleTable = ROLES,
): string {
  return `You are planning an implementation. Do NOT write any code or modify any files - this is a planning pass only.

## Task
${task}
${extraContext ? `\n## Additional context\n${extraContext}\n` : ''}
${environmentBlock(environment, 'planner', roles)}## What to produce

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

${scopeGuidance(outOfScope, 'plan')}

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
  round: number;
}

export function revisePlanPrompt({ findings, answers, outOfScope, round }: RevisePlanArgs): string {
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
  return `- **${f.title}** \`${f.id}\`\n  ${f.detail}\n  *Suggested fix:* ${f.suggested_fix}`;
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

When you are done, report concisely: what you changed, what you verified and how, what you could not verify, and any deviations from the plan.

## The approved plan

${planMd}
${known}${notDoing}`;
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

${scopeGuidance(outOfScope, 'change')}

${REVIEW_BREADTH}

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

export function fixPrompt(findings: readonly Finding[], round: number): string {
  return `A code reviewer found issues in your implementation. This is fix round ${round}.

Resolve **every P1**. Address P2s where the fix is contained and low-risk; skip P3s unless trivial.

${findings.map(formatFinding).join('\n\n')}${deferralNote(findings, 'fixer')}

${FIX_BREADTH}

Re-run the project's tests after fixing. If you believe a finding is incorrect, fix nothing for it but explain why in your final message - do not silently skip it.

Do not commit - the orchestrator handles git.

Report what you changed for each finding.`;
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

function formatFinding(f: Finding): string {
  return `### [${f.severity}] ${f.title}  \`${f.id}\`
${f.detail}

*Suggested fix:* ${f.suggested_fix}${f.defer === true ? `\n\n${DEFERRED_MARK}` : ''}`;
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
