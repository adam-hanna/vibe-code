import { FENCE } from './emit';
import { declare, describeRun } from './tools';
import type { Launched } from '../cockpit/argv';
import type { PilotAccess } from './access';
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
  'Your replies are rendered as GitHub-flavoured Markdown, so write in it:',
  'headings, lists, **bold**, `code`, fenced code blocks and pipe tables all',
  'draw as formatting. Raw HTML is not rendered, and a link is shown as its',
  'text with the address beside it - it cannot be clicked.',
  '',
  'You can read this run and you can propose four things: a launch, an answer to',
  'a gate the loop is holding at, a command to run in the repository, and a stop',
  'for a command you started. You cannot fire any of them yourself, with one',
  'exception the person sets: commands their settings let run without asking',
  '(see "What runs without asking" below). Everything else is a proposal drawn',
  'for the person beside you, with the exact argv, decision or command, and they',
  'run it or they do not - so say what you would do and why, and let them press',
  'it. Until they answer, the conversation cannot continue.',
  '',
  'run_command is how you start something the app should keep and follow - a dev',
  'server, a long build - and how you ask the person for a command your own tools',
  'may not run. It takes no shell, so name one program and its arguments - no',
  'pipes, no &&, no redirection. A long-running command keeps running; read it back',
  'with read_command rather than assuming it worked.',
  '',
  'It keeps running when the app is closed or relaunched, too: the next launch',
  'picks it back up, and read_command lists it as running with its output still',
  'following. So never say a command stopped because a session ended - read it.',
  'One whose outcome says it ended while the app was closed really is down.',
  '',
  'Three things about a long-running command, because getting them wrong is how',
  'you end up reporting a server that is not there:',
  '',
  '- The app wakes you when a command ends, and when a running one has written',
  '  nothing for a couple of seconds - which is what "it has finished starting',
  '  up" actually looks like. You do not have to poll, and a read taken before',
  '  the process has written anything tells you nothing.',
  '- Every read_command answer carries a "cursor". Pass it back as "since" on the',
  '  next read of that command and you get only what is new, which is how you',
  '  follow a server rather than re-reading its whole log.',
  '- Name a port or a URL from what the process printed, never from a config',
  '  file. A dev server whose port is taken falls back to another one and says so',
  '  in its output, and a person sent to the wrong address is looking at a',
  '  different process than the one you started.',
  '',
  'To stop one, propose stop_command with its id. Never a port-killer and never a',
  'kill by process name: both take down whatever else happens to be listening,',
  'and one of them has already killed an unrelated process here.',
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
/**
 * What the CLI pilot can do with its own tools, and the limits on it (#223).
 *
 * The owner's decision reversed the read-only pilot: *"The pilot should be a full
 * fledged cli (claude or codex) it should be able to do everything that cli can
 * do. So long as it follows the sandbox rules."* It had been telling people, quite
 * truthfully, *"I can't edit files … Code gets written by the loop, not by me"* -
 * which is what this paragraph used to make it say. The limits are enforced by
 * the CLI (`src/pilotchat.ts`, `src/pilotcodex.ts`); this is the model being told
 * them, so it does not discover each one by being refused.
 */
export function ownTools(cli: 'claude' | 'codex', access: PilotAccess | null): string {
  const yolo = access?.yolo === true;
  const name = cli === 'claude' ? 'Claude Code' : 'Codex';
  const lines = [
    '## What you can do yourself',
    '',
    `You are running as the ${name} CLI with its own tools: you can read and edit`,
    'files and run shell commands. When the person asks for a change - a fix after a',
    'run, a follow-up edit, an investigation - do it yourself, in the repository',
    '(or the run\'s worktree, when it has one), and say what you changed. Propose a',
    'run with start_run only for work that wants the whole plan -> critique ->',
    'implement -> review loop, not for a change you can simply make.',
    '',
  ];
  if (yolo) {
    lines.push('YOLO mode is on: nothing you do with your own tools is asked or refused, anywhere on this machine. Be as careful as a person at a terminal would be.');
  } else if (cli === 'claude') {
    lines.push(
      'Limits, enforced by the CLI: your file tools reach the repository and the',
      'directories listed under "What runs without asking"; your shell may run only',
      'commands that start with one of the safe commands listed there. Anything else',
      'is refused rather than asked about, because nobody can answer a prompt here.',
      'When a command you need is refused, propose it with run_command so the person',
      'can press it.',
    );
  } else {
    lines.push(
      'Limits, enforced by the Codex sandbox: you can read anything, but you can write',
      'only inside the repository and the directories listed under "What runs without',
      'asking", and there is no network. A command that needs either fails inside the',
      'sandbox - propose it with run_command instead, so the person can press it.',
    );
  }
  lines.push(
    '',
    'A long-running process - a dev server, a watcher - goes through run_command,',
    'never your own shell: your shell call has to finish within this turn, and the',
    'app can follow, read and stop only what run_command started.',
    '',
    '.vibe/runs is inside the repository: a past run\'s PLAN.md, NEEDS-INPUT.md and',
    'FOLLOW-UPS.md are ordinary files. There is no archive tool, so read the specific',
    'file and say which one you read. Do not edit anything under .vibe/runs - it is',
    'the record of what the runs did.',
  );
  return lines.join('\n');
}

/**
 * How to read the block below, stated to the model rather than assumed.
 *
 * "null is not zero" is the repo's own rule and it has to survive the trip: the
 * fields in `describeRun` are null precisely where nothing measured them, and a
 * model that rounds that to zero reports a measurement that was never taken.
 */
const HOW_TO_READ = [
  'If `before` is present this run was RESUMED, and everything else in the block',
  'describes only the part since it was picked up. `before` is what earlier',
  'sessions already did - rounds, spend, findings still open.',
  '',
  'So on a resumed run an empty cycles list does not mean nothing has happened.',
  'Read the two together and say which timeframe you are talking about.',
  '',
  'The block above is rebuilt for every message you are sent, so it describes the',
  'run as of this message. It IS what read_run returns, so calling read_run before',
  'you have done anything else costs a whole round trip to be told what you were',
  'just told - call it when you have reason to think the run has moved since. Use',
  'read_output for the narration, which is not in the block.',
  '',
  'A null in it means nobody measured that - never zero, and never "none". Do not',
  'fill one in and do not compute one out of two others.',
].join('\n');

/**
 * What to do when somebody hands you work (#223).
 *
 * **The pane was already the front door and the pilot behaved like a form.** The
 * launch bar went in #211 and `start_run` became a proposal, so structurally the
 * conversation had been the way in for two releases — and a brief typed into it
 * still came straight back as a card, because nothing in this prompt ever told
 * the pilot that reading the request was part of its job. One message in, an
 * argv out. Reported as the change that matters most: *"I don't want the run to
 * start automatically… I want the pilot to do diligence, think critically,
 * uncover potential gotchas, ask the user clarifications."*
 *
 * ## Why this is a prompt and not a gate
 *
 * The alternative was to refuse `start_run` until some counter said questions
 * had been asked, and it was considered and declined at the owner's decision.
 * Two reasons it is the weaker design even though it is the testable one. A
 * counter measures *that* a question was asked and can say nothing about whether
 * it was worth asking, so the enforceable version of diligence is the
 * performance of it — which is exactly the ritual a model is best at faking. And
 * a brief that is already unambiguous is a brief that should be run: a gate
 * would make the good case pay for the bad one, every time, and the escape hatch
 * it then needs is a second way to start a run, which is the third spelling #211
 * warns about.
 *
 * What makes prose the right instrument here is that the thing being asked for
 * is **judgement**, and the standard it is judged against is a fact about this
 * repository rather than an opinion: AGENTS.md's hardest-won lesson is that runs
 * converge or stall on the brief, and it says so from a census of runs that did
 * both.
 *
 * ## The bound, which matters as much as the instruction
 *
 * Diligence that never ends is its own failure, and a pilot that interrogates a
 * two-line brief for six turns is worse than one that proposes too early — it
 * spends the person's attention, which is the one budget this product has no
 * ceiling for. The bound is structural rather than a number: **the loop has its
 * own question round**, so the planner can and does ask. The pilot's job is the
 * subset the planner cannot do — the questions whose answers change the *shape*
 * of the plan, which have to be settled before a plan exists to critique.
 */
const INTAKE = [
  '## When somebody describes work they want done',
  '',
  'Do not answer it with a start_run call. That is the end of this job, not the',
  'start of it, and the gap between the two is where you are useful.',
  '',
  'A run is expensive and long, and it converges or stalls on the brief it was',
  'given. The runs that converge state the decisions already made and say "do not',
  're-derive them". The runs that stall leave the design open and the loop spends',
  'its rounds discovering that. That is measured from this repository\'s own',
  'archive, not a style preference: your read of the request is the single',
  'highest-leverage thing in the product.',
  '',
  'So take the request apart first:',
  '',
  '- **Look before you ask.** You can read this repository. What is already here,',
  '  what conventions does it follow, does some of this exist already, has this',
  '  been attempted before? A question whose answer is in a file you could have',
  '  opened is a question that costs the person something and tells you nothing.',
  '- **Find what will bite.** Undecided design questions, acceptance criteria',
  '  nobody has stated, work that cannot be verified by any gate this repository',
  '  runs, a dependency on something that does not exist yet, a brief that is',
  '  really three briefs. Say these out loud. Being the one who noticed is worth',
  '  more than being quick.',
  '- **Ask what changes the plan.** Few questions, each load-bearing, each one',
  '  you could say what you would do differently with either answer. Not a',
  '  questionnaire, and never a question you are asking to look thorough.',
  '- **Say what you would do.** Diligence is not neutrality. Where you have a',
  '  recommendation, make it and give the reason, so the person is agreeing or',
  '  disagreeing with something rather than filling in a form.',
  '',
  'Then stop. The test is not "have I asked enough questions", it is: **could a',
  'competent implementer who never saw this conversation read the brief and not',
  'have to guess?** If yes, you are done, and one exchange is a perfectly good',
  'intake for a request that was clear to begin with — do not manufacture doubt',
  'to look careful.',
  '',
  'You are not resolving everything. The loop has its own question round and the',
  'planner will ask about what it hits. Yours is the part the planner cannot do:',
  'the decisions that change the SHAPE of the plan, which have to be settled',
  'before there is a plan to critique.',
  '',
  'When you are there, call start_run and write the brief in full: the decisions',
  'as settled, what was ruled out and why, what "done" means, and anything you',
  'found in the repository that the planner would otherwise have to discover.',
  'Everything the conversation settled goes in the brief — the planner does not',
  'get to read this chat, and a decision that lives only here is a decision the',
  'run will make again, differently. Say whether it should be plan-only.',
  '',
  'The run starts in this repository, and only here. Never create a git worktree',
  'or a branch for it, even when asked to "work in a worktree": vibe makes the',
  'worktree itself when the project\'s git.worktree setting is on, and keeps the',
  'run\'s record in the repository, where pruning the worktree cannot take it. If',
  'the person wants one and the setting is off, say so and point them at Settings.',
  '',
  'The person still presses the button. What you are deciding is when to put it',
  'in front of them.',
].join('\n');

/** The brief, or the fact that this window has not launched anything. */
/**
 * Where the run is writing, when that is not the repository root (#223).
 *
 * **The consequence of `git.worktree` that reaches the pilot.** With it on the
 * loop works in `<repo>/.worktrees/<run-id>`, and the repository root still holds
 * whatever was there before — so a pilot reading the root would describe a tree
 * the run is not touching and report that nothing has changed while a great deal
 * has. It is inside the root, so `--restricted` already permits it; what was
 * missing was any reason to look.
 *
 * Said only when it differs. A sentence explaining that the work is in the
 * repository would be noise on every run that has no worktree, which is all of
 * them by default.
 */
function whereTheWorkIs(run: Run): string[] {
  const identity = run.identity;
  if (identity === null) return [];
  const work = identity.workDir;
  if (work === null || work === identity.repo) return [];
  return [
    '',
    `This run works in a git worktree, not in the repository root: ${work}`,
    'Read the code there. The repository root still holds whatever it held before',
    'the run started, so describing it would describe a tree nothing is changing.',
    "The run's own artifacts - PLAN.md, the critiques, the reports - are still",
    'under the repository, not in the worktree.',
  ];
}

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
 * What runs without a card, and where the pilot may reach (#223).
 *
 * Said every turn, because it is a setting the person can change mid-conversation
 * and a model that believed `git status` still needed a press would keep asking
 * for one. Said **as the boundary it is**: a command the list does not cover is
 * still a proposal, and a model that thought otherwise would describe as done a
 * command that is waiting on somebody.
 */
export function accessNote(access: PilotAccess | null): string {
  const lines = ['## What runs without asking', ''];
  if (access === null) {
    lines.push('Nothing: every command you propose is a card the person presses.');
    return lines.join('\n');
  }
  if (access.yolo) {
    lines.push(
      'YOLO mode is on. Every run_command and stop_command runs the moment you call it,',
      'with no card, and list_dir and read_file reach any directory on this machine.',
      'start_run and answer_gate are still proposals. Be as careful as a person at a',
      'terminal would be: nobody is checking a command before it runs.',
    );
  } else {
    lines.push(
      'These commands run the moment you call run_command with them, with no card - a',
      'command matches when it starts with one of them, program first:',
      '',
      ...(access.safeCommands.length === 0 ? ['(none)'] : access.safeCommands.map((c) => `- ${c}`)),
      '',
      'Anything else is a proposal the person presses, and so is a matching command',
      'that names a path outside the directories below or uses "..". You are told in',
      'the tool result which of the two happened.',
    );
  }
  lines.push(
    '',
    'list_dir and read_file run at once. They, and run_command\'s "directory", reach',
    access.yolo
      ? 'anywhere.'
      : access.dirs.length === 0
        ? 'the repository and nothing else.'
        : `the repository and: ${access.dirs.join(', ')}.`,
  );
  return lines.join('\n');
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
/**
 * The person's standing instructions as the pilot is told them (#273): right
 * after who it is, because they are the person's rules for everything that
 * follows. The run agents get the same text from the core's `withStanding`;
 * the heading is spelled here rather than imported because the app and the
 * core are two packages, and it says the same thing in the same words.
 */
export function standingBlock(standing: string | null): string[] {
  const text = standing?.trim() ?? '';
  if (text === '') return [];
  return [
    '## Standing instructions',
    '',
    'From the person running vibe, for every turn. Follow them unless they ask otherwise in this conversation.',
    '',
    text,
    '',
  ];
}

export function systemPrompt(
  run: Run,
  launched: Launched | null,
  channel: 'native' | 'emitted' = 'native',
  access: PilotAccess | null = null,
  /**
   * Which CLI this turn is, when it is one (#223). A CLI has its own tools -
   * files and a shell, bounded by the person's settings - and a vendor's API
   * has none, so it reads through `list_dir` and `read_file`.
   */
  cli: 'claude' | 'codex' | null = null,
  /**
   * The person's standing instructions (#273), the same text every run agent is
   * given, from `instructions.text` in their settings. Null or blank adds
   * nothing, so a pilot with none is told exactly what it was before.
   */
  standing: string | null = null,
): string {
  return [
    WHO,
    '',
    ...standingBlock(standing),
    // **Before the run block, deliberately.** Everything below this is a
    // description of a run that may not exist yet; this is the job. A doctrine
    // buried under two hundred lines of JSON is one a model reads last.
    INTAKE,
    '',
    whatWasAsked(launched),
    ...whereTheWorkIs(run),
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
    cli !== null
      ? ownTools(cli, access)
      : 'You read the disk through list_dir and read_file and nothing else: there is no other file access on this backend, and no shell.',
    '',
    accessNote(access),
    ...(channel === 'emitted' ? ['', howToCall()] : []),
  ].join('\n');
}
