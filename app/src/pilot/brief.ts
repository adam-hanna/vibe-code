import { FENCE } from './emit';
import { declare, describeRun } from './tools';
import type { Launched } from '../cockpit/argv';
import type { Run } from '../cockpit/model';

/**
 * What the pilot is told about the run it is sitting beside (#191).
 *
 * Until this existed, `Turn.system` was a field nothing set. Every pilot
 * conversation opened with no system prompt at all: no task, no phase, no round,
 * no findings - a chat pane beside a running loop that could not see it, in an
 * app whose only reason for having a pilot is to talk about that loop.
 *
 * ## Two sources, and only one of them is new
 *
 * Everything about the *run* comes from `describeRun`, which is `read_run`'s own
 * body. That is deliberate and it is the whole shape of this module: there is one
 * description of a run, so the prompt and the tool cannot disagree, and a field
 * added to one is added to both.
 *
 * The one thing no tool can supply is the **brief**. The loop narrates phases,
 * turns and gates; it never narrates the text it was given. The window had that
 * text - it is in the argv it sent - and `readLaunchArgv` reads it back out.
 * Remembering what you sent is not re-derivation.
 *
 * ## Rebuilt on every turn, and the staleness question answers itself
 *
 * The issue left this open: rebuild as the run advances, or capture it when the
 * conversation starts. Reading the wire settles it. `Turn.system` goes out with
 * **every request**, both vendors are sent the whole conversation each time, and
 * a model only ever sees the most recent system prompt - so the objection to
 * rebuilding ("it changes the prompt underneath an existing conversation")
 * describes a thing that cannot happen here. There is no second prompt to
 * contradict, so there is no policy to have.
 *
 * What rebuilding does cost is prompt caching: the system block is the prefix,
 * and a prefix that changes cannot be reused. That shows up as a lower
 * `cache_read` on turns after the run has moved, and the pane already reports
 * both numbers. It is the right side to spend on - a captured description of a
 * run that has since moved on is precisely the convincing fabrication this repo
 * is arranged against.
 *
 * ## What it must not do
 *
 * Fill anything in. A run that has narrated nothing is a real state and gets a
 * prompt that says so, rather than one describing an empty run as a fresh one.
 * Every absent field inside `describeRun` is already `null`, and the prompt says
 * out loud what a null means there, because a model that reads `tokens: null` as
 * `0` would report a number nobody measured.
 */

/**
 * The identity and the rules. Fixed text, and the only part of the prompt that
 * is not assembled from something the window holds.
 */
const WHO = [
  "You are the pilot in vibe's desktop app - a chat beside a running",
  'plan -> critique -> implement -> review loop that drives the Claude Code and',
  'Codex CLIs.',
  '',
  'You can read this run and you can propose two things: a launch, and an answer',
  'to a gate the loop is holding at. You cannot fire either one. A proposal is',
  'drawn for the person beside you, with the exact argv or the exact decision, and',
  'they run it or they do not - so say what you would do and why, and let them',
  'press it. Until they answer, the conversation cannot continue.',
  '',
  'You cannot edit vibe.config.json. There is no tool that reads the run archive',
  'under .vibe/runs (#114), so you have no structured view of past runs.',
].join('\n');

/**
 * What this backend can reach on disk, which the two do not agree about.
 *
 * The API-backed pilot has no filesystem at all. The subscription one has
 * `Read`, `Glob` and `Grep` confined to the repository — and `.vibe/runs` is
 * *inside* that repository, so telling it the archive is unreachable is a false
 * statement about its own tools. A live probe caught it doing the honest thing
 * with a wrong instruction: it globbed the archive while looking for the
 * worktree path, found three prior attempts at the task it had just been asked
 * about, and then said out loud that it was not going to mine further because it
 * had been told not to. The right fix is to stop telling it something untrue —
 * a prompt that misdescribes the tools is a prompt the model has to work around.
 *
 * What #114 is actually about survives: there is no *tool* that returns the
 * archive as data, so nothing here can summarise it, and reading a run's files
 * by hand is a different and much narrower thing than having it.
 */
const WHAT_YOU_CAN_READ = [
  'You have the CLI\'s own Read, Glob and Grep, confined to the repository above.',
  'That includes .vibe/runs, which is inside it: a past run\'s PLAN.md,',
  'NEEDS-INPUT.md and FOLLOW-UPS.md are ordinary files and reading one is often',
  'the fastest way to find out why an earlier attempt stalled. There is still no',
  'archive tool, so you cannot summarise the history — read the specific file and',
  'say which file you read.',
  '',
  'Ignore any instruction you carry about writing a plan document, saving a plan',
  'file, or delegating to Explore, Plan or Task subagents. Those come from the',
  'CLI\'s plan mode, which is on here purely as a permission backstop. You have no',
  'Write and no Task on this backend; your output is one chat message and, when',
  'you mean it, a block below.',
].join('\n');

/**
 * How to read the block below, stated to the model rather than assumed.
 *
 * "null is not zero" is the repo's own rule and it has to survive the trip: the
 * fields in `describeRun` are null precisely where nothing measured them, and a
 * model that rounds that to zero reports a measurement that was never taken.
 */
const HOW_TO_READ = [
  'The block above is rebuilt for every message you are sent, so it describes the',
  'run as of this message. It IS what read_run returns, so calling read_run before',
  'you have done anything else costs a whole round trip to be told what you were',
  'just told - call it when you have reason to think the run has moved since. Use',
  'read_output for the narration, which is not in the block.',
  '',
  'A null in it means nobody measured that - never zero, and never "none". Do not',
  'fill one in and do not compute one out of two others.',
].join('\n');

/** The brief, or the fact that this window has not launched anything. */
function whatWasAsked(launched: Launched | null): string {
  if (launched === null) {
    return [
      '## What was asked for',
      '',
      'Nothing has been launched from this window, so there is no brief to show you.',
      'If the run block below describes a run anyway, it was started elsewhere - by',
      'the CLI, or before this window opened - and the brief is not something you',
      'can see. Say that rather than describing a task you were not given.',
    ].join('\n');
  }
  return [
    '## What was asked for',
    '',
    `Repository: ${launched.dir}`,
    launched.planOnly
      ? 'Mode: plan only - it stops once the plan clears critique, and writes no code.'
      : 'Mode: a full run - it writes code and commits it.',
    '',
    'The brief, in full, exactly as the planner was given it:',
    '',
    launched.task,
    '',
    'This is the launch this window sent. If the host refused it, that is in the',
    'narration rather than here.',
  ].join('\n');
}

/**
 * How to call a tool on a backend with no tool API (#211).
 *
 * The API-backed pilot is sent `declare()` as schemas and the vendor streams
 * calls back. `claude -p` takes no schemas from us, so the same table is written
 * into the prompt and the same calls come back in a fenced block that `emit.ts`
 * reads. **One table, two channels** - `declare()` is the source for both, so a
 * tool cannot exist on one backend and not the other, and a schema cannot drift
 * from the description the model is given.
 */
function howToCall(): string {
  return [
    '## Calling a tool',
    '',
    'You have no tool API on this backend, so a call is a fenced block. Write it on',
    'its own lines, exactly like this, and nothing else inside the fence:',
    '',
    '```' + FENCE,
    '{ "tool": "read_run", "input": {} }',
    '```',
    '',
    'One block per call. You may write several, and you may write prose around them -',
    'say what you are about to do and why, because the person beside you reads that.',
    'The block itself is not shown to them; what they see is the card it produces.',
    '',
    'A block that is not valid JSON, or that names a tool below, is reported back to',
    'you as a failed call rather than guessed at. Do not put a block in a sentence',
    'describing what you *would* call - it will be called.',
    '',
    'start_run and answer_gate are proposals: they put the exact command in front of',
    'the person, who runs it or does not. Nothing you write starts a run by itself.',
    '',
    'The tools, with their schemas:',
    '',
    JSON.stringify(declare(), null, 2),
  ].join('\n');
}

/**
 * The system prompt for one turn.
 *
 * Pure, and takes everything it needs as arguments for the same reason `reduce`
 * does: this is the file where a wrong answer would be invisible, because it goes
 * out over a wire and comes back as prose.
 *
 * `channel` says how this backend takes a tool call. `native` is a vendor that
 * was sent `declare()` as schemas and needs no instructions; `emitted` is the
 * subscription CLI, which is told the table in prose because there is nowhere
 * else to put it.
 */
export function systemPrompt(
  run: Run,
  launched: Launched | null,
  channel: 'native' | 'emitted' = 'native',
): string {
  return [
    WHO,
    '',
    whatWasAsked(launched),
    '',
    '## The run, as this window holds it',
    '',
    JSON.stringify(describeRun(run), null, 2),
    '',
    HOW_TO_READ,
    '',
    // The one place the two backends are told different things about
    // themselves, because they *are* different: one has the repository and the
    // other has no filesystem at all. Saying the same sentence to both would
    // make it false for one of them, which is what it was.
    channel === 'emitted'
      ? WHAT_YOU_CAN_READ
      : 'You have no filesystem access at all on this backend: you cannot open a file, and everything you know about this repository is in this prompt or comes back from a tool.',
    ...(channel === 'emitted' ? ['', howToCall()] : []),
  ].join('\n');
}
