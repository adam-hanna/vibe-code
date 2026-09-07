import { describeRun } from './tools';
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
  'You cannot edit vibe.config.json and you cannot read the run archive under',
  '.vibe/runs (#114). Say so rather than answering from nothing when somebody asks',
  'whether something has been tried before.',
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
  'run as of this message. read_run returns the same shape if you want it again',
  'part-way through a turn, and read_output has the narration.',
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
 * The system prompt for one turn.
 *
 * Pure, and takes everything it needs as arguments for the same reason `reduce`
 * does: this is the file where a wrong answer would be invisible, because it goes
 * out over a wire and comes back as prose.
 */
export function systemPrompt(run: Run, launched: Launched | null): string {
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
  ].join('\n');
}
