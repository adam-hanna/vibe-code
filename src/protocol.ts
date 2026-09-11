import type { Level, Narration } from '@src/log.js';
import type { GateContext } from '@src/host.js';
import type { ArtifactRead, RunArtifact, RunSummary } from '@src/types.js';

/**
 * The wire between the loop and whatever is driving it (#153).
 *
 * A leaf, for the reason `@src/host.js` is one: this is the vocabulary two
 * processes agree on, and neither of them should have to import the other to
 * read it. `serve.ts` speaks it; the desktop app's Rust relay forwards it
 * without interpreting it; the webview renders from it.
 *
 * ## One object per line, both directions
 *
 * NDJSON over stdio, not a socket. This repo has no network code of its own and
 * should not grow a port, an allocation strategy and an auth story in order to
 * talk to itself - the process boundary already exists. Every frame is one JSON
 * object on one line, so a reader needs a newline split and `JSON.parse` and
 * nothing else.
 *
 * ## Every frame says what it is, and requests say which one they are
 *
 * `type` names the frame. `id` correlates a request with its reply, and it is
 * required on every frame that expects one, because **a run can reach two
 * boundaries before a slow host has answered the first**. Matching by arrival
 * order would answer the wrong question the moment the app hesitated.
 *
 * Narration carries no `id` and is never acknowledged. It is one-way by design:
 * a run that could block on a renderer is a run a hung window can stop.
 *
 * ## The version is a number, and it is checked
 *
 * `ready` states it once. A host built against a different one should say so
 * rather than guess which fields it still recognises - the same reason
 * `readDecision` refuses a `kind` it does not know instead of assuming
 * `continue`.
 */

/**
 * Bumped when an existing frame changes shape or leaves.
 *
 * Adding a new `type` is not a bump: an unrecognised frame is ignored by a
 * reader and refused by this one, and both of those are already the contract.
 */
export const PROTOCOL_VERSION = 1;

/** What the loop's process says. */
export type Outbound =
  /** First frame, before anything else. `pid` so a supervisor can act on it. */
  | { type: 'ready'; protocol: number; pid: number }
  /**
   * One `Narration`, spread rather than nested.
   *
   * Flat because everything that reads it - `state.events`, the heartbeat
   * record - is flat, and a host switching on `type` then on `id` should not
   * have to reach through a wrapper to find the second one.
   */
  | ({ type: 'narration' } & Narration)
  /** The loop is holding at a boundary. Answered by an `answer` carrying this `id`. */
  | { type: 'ask'; id: number; context: GateContext }
  /** A request finished. `exit` is the exit code the same command would have returned. */
  | { type: 'result'; id: number; exit: number }
  /**
   * A request could not be run at all.
   *
   * Distinct from a `result` with a non-zero exit, and the distinction matters:
   * a non-zero exit is a run that happened and failed, an `error` is a frame
   * this process would not act on. Only the second one means "nothing was
   * started".
   */
  | { type: 'error'; id: number | null; message: string }
  /**
   * A command started, or was refused (#211).
   *
   * `refused` and `command` are exclusive: a refusal never started anything, so
   * there is no id to report output against, and a started command always has
   * one. A window drawing a card from a refusal would be drawing a process that
   * does not exist.
   */
  | {
      type: 'command_started';
      id: number;
      command: {
        id: string;
        program: string;
        args: readonly string[];
        resolved: string;
        dir: string;
        startedAt: number;
      } | null;
      refused: string | null;
    }
  /** Output from a running command, in the order it arrived. */
  | { type: 'command_output'; commandId: string; chunk: string }
  /**
   * A command ended.
   *
   * `stopped` is the fact the exit code cannot carry: on Windows a killed
   * process closes with a code and no signal, so *"a person stopped this"* and
   * *"it exited"* are indistinguishable from the outside (#131).
   */
  | {
      type: 'command_ended';
      commandId: string;
      code: number | null;
      signal: string | null;
      stopped: boolean;
      endedAt: number;
    }
  /** A fragment of a pilot reply, in order (#193). */
  | { type: 'pilot_delta'; id: number; text: string }
  /**
   * A pilot turn finished.
   *
   * **There is no money on it and there is nowhere to put any.** A subscription
   * turn bills nothing at all, so a dollar figure would have no quantity to be
   * an estimate *of* - the same sentence that makes Codex cost unreportable.
   * The tokens are real and are reported.
   *
   * `sessionId` is what the CLI says the conversation is, which is authoritative
   * over whatever the caller proposed.
   */
  | {
      type: 'pilot_reply';
      id: number;
      text: string;
      sessionId: string;
      tokens: { input: number; output: number; cacheRead: number; cacheCreation: number; total: number };
    }
  /**
   * The archive, in reply to an `archive` request (#223, `1b`).
   *
   * **A reply, and deliberately not narration.** Every other outbound frame
   * describes a run in progress; this describes runs that are over, and it is
   * asked for rather than pushed - a window that wanted the history would
   * otherwise have to wait for something to happen before it could learn that
   * nothing had.
   *
   * `runs` is `RunSummary[]` verbatim, because `listRuns` is **the** definition
   * of what an archive entry is: a real directory, a symlink it refused to
   * follow (#53), something `lstat` could not classify. A second classifier here
   * would eventually disagree with `vibe list` about which runs exist, and the
   * one that disagreed would be the one on screen.
   */
  | { type: 'archive'; id: number; dir: string; runs: RunSummary[] }
  /**
   * The configuration in force, and what the file itself claims (#223, `1h`).
   *
   * **Both, and they are not the same thing.** `effective` is `DEFAULTS` merged
   * with the file, which is what a run will actually do; `raw` is what
   * `vibe.config.json` says on its own. A form given only the first would bake
   * every current default into the file the moment it saved, so the next
   * release's improved default would never reach this repository - and nobody
   * could tell which values were chosen from which were merely observed.
   *
   * `path` is null when there is no file, which is a different fact from an
   * empty one and is what tells a form whether saving creates or edits.
   */
  | {
      type: 'config';
      id: number;
      dir: string;
      effective: unknown;
      raw: Record<string, unknown>;
      path: string | null;
      /** The boundaries that can hold, and the modes they may take (#140). */
      gateable: readonly string[];
      modes: readonly string[];
      /** The two boundaries with no row, each with its own reason. */
      ungateable: Readonly<Record<string, string>>;
      /**
       * The role table's vocabulary (#223, `1i`).
       *
       * Sent for the same reason `gateable` is: a form built from a list it
       * wrote itself can offer a role the loop does not have or a provider it
       * cannot seat, and the refusal would arrive as a validator error on save
       * instead of as a control that was never offered.
       */
      roleNames: readonly string[];
      providers: readonly string[];
      efforts: readonly string[];
    }
  /**
   * The diff a run has produced, in reply to a `diff` request (#223, `1d`).
   *
   * `patch` is `git diff` output verbatim, tail-trimmed by `diffSince` at its own
   * ceiling - so `truncated` is what stops a window presenting a partial diff as
   * a whole one. The band the design draws over a truncated diff is a judgement
   * about what the reviewer *read*, and it cannot be drawn without knowing that
   * this happened.
   */
  | { type: 'diff'; id: number; dir: string; patch: string; truncated: boolean }
  /**
   * What is in a run's directory, in reply to an `artifacts` request.
   *
   * **The listing is the half that keeps the reader from guessing.** A window
   * showing a plan round's plan has to name a file, and the alternative to being
   * told is `plan-${round}.json` composed on the far side of this wire - a copy
   * of the loop's naming convention, in a process that cannot be kept in step
   * with it, going stale on the release that renames one. `listRunArtifacts`
   * reads the directory instead, and every entry says what `lstat` made of it
   * rather than being filtered down to the ones that are files.
   */
  | { type: 'artifacts'; id: number; dir: string; runId: string; entries: RunArtifact[] }
  /**
   * One artifact's contents, in reply to an `artifact` request.
   *
   * `read` is `ArtifactRead` verbatim, for the reason `archive` carries
   * `RunSummary[]` verbatim: those three answers are the whole of what this
   * repo has decided an artifact read can be, and collapsing `absent` and
   * `linked` into one nullable string here would tell a reader a file was
   * unreadable when vibe never looked inside it (#129).
   */
  | {
      type: 'artifact';
      id: number;
      dir: string;
      runId: string;
      name: string;
      read: ArtifactRead;
    }
  /**
   * A run that is gone, in reply to a `delete_run` request (#223).
   *
   * **The only frame in this union that reports a destruction**, and it carries
   * the directory that was removed rather than a byte count or a file list.
   * Those would be measurements taken so they could be shown once, and what a
   * caller actually needs to say is *what is gone* - a path is checkable and a
   * size is not.
   *
   * A refusal is an `error` frame, as it is for every read: `deleteRun` throws
   * a `StoredStateError` naming which of the three guards stopped it, and that
   * sentence is the whole answer. There is deliberately no "deleted: false"
   * shape - a window that had to read a boolean to find out whether its own
   * request happened is one that will eventually forget to.
   */
  | { type: 'run_deleted'; id: number; dir: string; runId: string; removed: string };

/** What the thing driving the loop says. */
export type Inbound =
  /**
   * Start or resume a run, as argv.
   *
   * **Argv rather than a structured request**, and this is the load-bearing
   * decision in the file. `main(argv)` is already the one definition of what a
   * legal invocation is: which flags exist, which combinations are refused, how
   * a run directory is allocated, when the lock is taken relative to the first
   * state write. A structured `{task, model, maxTokens, ...}` request would be a
   * second definition of all of it, drifting from the first on the next flag
   * anybody adds - which is the failure #134 settled for run state and this is
   * the same failure one layer up.
   *
   * It also means the app gains every future flag for free, with no version
   * bump: the GUI's job is a form to an argv, which is a pure function it can
   * test on its own side.
   */
  | { type: 'invoke'; id: number; argv: readonly string[] }
  /** The decision for the `ask` carrying this `id`. Shape checked by `readDecision`. */
  | { type: 'answer'; id: number; decision: unknown }
  /**
   * Stop accepting requests and exit once the current one settles.
   *
   * Not a kill: an in-flight run is left to reach its own next boundary. A host
   * that wants it stopped sooner answers the next `ask` with `stop`, which is
   * the resumable ending; killing the process is the supervisor's job and is a
   * different, more expensive thing (see `@src/host.js` on pause).
   */
  | { type: 'shutdown'; id: number }
  /**
   * Hold at the next boundary, whatever the gate matrix says about it (#210).
   *
   * **One hold, not a mode.** `cfg.gates` is the run's standing answer to where
   * control comes back and is decided before the run starts; this is a person
   * mid-run saying *hold at the next one*, and it is consumed by the boundary
   * that honours it. A second `pause` before that boundary is the same request
   * again, not a second hold.
   *
   * It costs nothing, which is the whole reason it is separate from stopping:
   * a hold is an `await` at a boundary the loop was crossing anyway, the process
   * stays alive and both agent sessions stay warm. Answered immediately, because
   * the frame says the request was accepted rather than that a hold has happened
   * - the `ask` that follows is what says the second thing.
   */
  | { type: 'pause'; id: number }
  /**
   * Kill the turn in flight and end the run, resumably (#209).
   *
   * **The other half of `pause`, and they must never be confused.** A pause
   * holds at the next boundary and costs nothing; this kills a child that may be
   * forty minutes in, and that turn is redone from the top. Its spend is charged
   * either way - the tokens were used - which is what a confirmation has to say
   * out loud.
   *
   * Not a kill of the *process*: the run ends the way a round cap ends it, with
   * `NEEDS-INPUT.md` written and `vibe resume` able to pick it up from the last
   * checkpoint. That is what keeps this from being a second definition of how a
   * run ends - it takes the one that already exists.
   */
  | { type: 'cancel'; id: number; reason?: string }
  /**
   * One pilot chat turn, on the subscription (#193).
   *
   * **Deliberately not an `invoke`.** An invoke starts a *run*: it takes the
   * lock, writes state, and `serve.ts` allows one at a time. A pilot turn does
   * none of that - it spawns a read-only `claude` child through
   * `src/pilotchat.ts`, writes nothing, and has to be able to happen *while* a
   * run is going, because a conversation about a run is most useful during one.
   *
   * The API-backed pilot never comes through here at all: it is Rust talking to
   * a vendor, and the two providers stay asymmetric on purpose. What this one
   * buys is that **no key is needed** - it runs on the subscription the user
   * already pays for.
   */
  /**
   * Run a command a person pressed (#211).
   *
   * **`program` and `args` are separate and are never joined.** The one
   * invariant of `src/commands.ts` is that what runs is what was displayed, and
   * a single string would put a `;` and a backtick back in reach of text a
   * model wrote. There is deliberately no `shell` field: there is no shell.
   *
   * Reversing part of a rule this file's own neighbours state, so the narrowness
   * is worth restating: the model cannot send this. It proposes, the proposal is
   * drawn with the exact program and arguments, and the window sends this only
   * when somebody presses it - the same road `invoke` takes from `start_run`.
   */
  | {
      type: 'command';
      id: number;
      dir: string;
      program: string;
      args: readonly string[];
    }
  /** Stop a running command. `commandId` is one this session started. */
  | { type: 'command_stop'; id: number; commandId: string }
  | {
      type: 'pilot';
      id: number;
      prompt: string;
      system: string;
      model: string;
      /**
       * The repository the turn runs in, and the only one it can read.
       *
       * **Required, and the reason is the whole of `--restricted`.** That flag
       * confines `Read`, `Glob` and `Grep` to the child's working directory, so
       * the cwd is not incidental here the way it is for a process that writes
       * nothing - it *is* the permission boundary. Before this rode on the
       * frame, `serve.ts` passed `process.cwd()`, which under the app is
       * whatever Rust happened to spawn the host in: a manual pass got a pilot
       * searching a home directory, timing out at 20s on every `Glob`, and
       * reporting that it could not see the workspace.
       *
       * Refused rather than defaulted for the same reason `diff` refuses a
       * missing base: a directory this process picked is a directory nobody
       * chose, and pointing a filesystem tool at one is not a repair.
       */
      dir: string;
      /** The conversation to continue, or to create on the first turn. */
      sessionId: string;
      resume: boolean;
    }
  /**
   * Ask what runs the archive holds (#223, `1b`).
   *
   * **A read, and the only inbound frame that changes nothing.** `listRuns` is
   * documented as never throwing and never writing, which is what makes this
   * safe to answer while a run is going - and it has to be answerable then,
   * because *"triage after a night of unattended work"* is the moment the screen
   * exists for.
   *
   * `dir` is the repository to look in, sent rather than assumed: the host's own
   * cwd is where it was spawned, and a window that has been pointed at a
   * different checkout would otherwise be shown the wrong archive with no way to
   * tell.
   */
  | { type: 'archive'; id: number; dir: string }
  /**
   * Read the configuration, or write a patch into it (#223, `1h`).
   *
   * One frame with an optional `patch` rather than two, because they are the
   * same question asked twice: **a write answers with the config that resulted**,
   * so a form never has to assume its own save took effect. That is what keeps
   * *"the form and the raw file are the same file the CLI reads"* true rather
   * than hoped for.
   *
   * The patch is merged **one level deep, per section** into the raw file and
   * refused as a whole if the result does not validate - `writeConfigPatch`'s
   * rule, not this frame's, so there is one definition of a legal config and it
   * is the CLI's.
   */
  | { type: 'config'; id: number; dir: string; patch?: Record<string, unknown> }
  /**
   * Read the diff a run has produced (#223, `1d`).
   *
   * **A read, and it must stay one.** `diffSince` has two paths and only one of
   * them is safe here: given a base it runs `git diff <base>..HEAD`, and given
   * none it runs `git add -A` first, which stages the user's whole working tree.
   * So `baseSha` is **required** - a diff request that could not name its base
   * would be refused rather than fall into the staging path, because a read frame
   * that modified the index would be the worst kind of surprise.
   *
   * The base comes from `phase_started`, which carries it from the moment the
   * implement phase marks it. A window that never saw that frame has no base and
   * cannot ask, which is the honest state rather than a reason to guess one.
   *
   * `headSha` closes the range, and only a request that names both ends gets a
   * per-round answer (#223). With it this is one round's diff, from
   * `round_committed`'s own two shas; without it, it is everything since the
   * base, which is what `1d` has always shown. They are different questions and
   * the frame says which one is being asked rather than defaulting into either.
   */
  | { type: 'diff'; id: number; dir: string; baseSha: string; headSha?: string }
  /**
   * Ask what a run's directory holds (#223).
   *
   * **A read, beside `archive`, `config` and `diff`, and the same rule applies:**
   * `listRunArtifacts` reads a directory and writes nothing, so it is answerable
   * while a run is going - and it has to be, because the run whose plan somebody
   * wants to read is usually the one that is running.
   *
   * `runId` is separate from `dir` and both are required. `dir` is the
   * repository and `runId` names a directory under its `.vibe/runs`, which is
   * the pair `assertUsableRunId` is written to check; a single path would be a
   * caller handing this process somewhere to read, which is the thing the split
   * exists to prevent.
   */
  | { type: 'artifacts'; id: number; dir: string; runId: string }
  /**
   * Read one of that run's artifacts.
   *
   * **A separate type rather than an optional `name` on the frame above.** A
   * `name` that could be absent would make "list everything" and "read this
   * file" one request with two meanings, and a decoder cannot refuse a missing
   * field it is also allowed to do without - which is how `config` earns its
   * optional `patch` and why this does not have one: there, absence is a *read*
   * and the refusal is on the shape of what is present.
   */
  | { type: 'artifact'; id: number; dir: string; runId: string; name: string }
  /**
   * Delete a run from the archive (#223).
   *
   * **The one inbound frame that destroys something a run wrote**, and it is
   * deliberately not a `Decision`: a decision answers an `ask` that a gate is
   * holding open, about the run in flight. This is about a run that is over,
   * asked when nothing is holding, and `src/host.ts`'s rule is the reason the
   * distinction is kept - every `Decision` member that mutates run state needs
   * its own validator, and this mutates no run state at all. It removes a
   * directory.
   *
   * It is **not** exempt from anything on the strength of being small. What
   * makes it answerable beside a run is the same thing that makes a delete safe
   * at all: `deleteRun` refuses a run whose lock names a live process, and
   * refuses one whose lock it cannot read. So the run in flight is the one run
   * this frame can never reach, and every other run in the archive is inert.
   *
   * `dir` and `runId` are separate and both required, exactly as they are for
   * `artifacts` - `dir` is the repository and `runId` names one entry under its
   * `.vibe/runs`, which is the pair `assertUsableRunId` is written to check. A
   * single joined path would be a caller handing this process somewhere to
   * delete, which is the thing the split exists to prevent.
   */
  | { type: 'delete_run'; id: number; dir: string; runId: string };

export function encode(msg: Outbound): string {
  return `${JSON.stringify(msg)}\n`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A correlation id: a finite non-negative integer, and nothing else. */
function readId(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * What a line was, or why it was not a frame.
 *
 * A discriminated result rather than a throw or a null, because the caller owes
 * the sender an `error` frame naming the reason - and "the id, if we could find
 * one" is part of that. A frame with a readable `id` and an unreadable body can
 * still be refused *to the request that sent it*, which is the difference
 * between a host seeing its request rejected and a host waiting for ever.
 */
export type Decoded =
  | { ok: true; message: Inbound }
  | { ok: false; id: number | null; reason: string };

/**
 * Read one line into the closed inbound vocabulary, or refuse it.
 *
 * **Refuse, never repair.** Every branch below that could plausibly guess -
 * an `argv` with one non-string entry, a missing `id`, a `type` from a newer
 * protocol - reports instead. The direction is the one `readDecision` already
 * points: acting on a request nobody could parse spends tokens and writes code
 * on the strength of a message that may have said the opposite.
 *
 * The decision inside an `answer` is deliberately NOT checked here. It is passed
 * through as `unknown` and narrowed by `readDecision`, which is the one place
 * that vocabulary is defined; checking it twice would be two definitions of a
 * legal decision, in two files, disagreeing eventually.
 */
export function decode(line: string): Decoded {
  const trimmed = line.trim();
  if (trimmed === '') return { ok: false, id: null, reason: 'empty line' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return { ok: false, id: null, reason: 'not JSON' };
  }
  if (!isRecord(parsed)) return { ok: false, id: null, reason: 'not a JSON object' };

  const id = readId(parsed['id']);
  const type = parsed['type'];
  if (typeof type !== 'string') return { ok: false, id, reason: 'no type' };
  if (id === null) {
    return { ok: false, id: null, reason: `"${type}" carried no id, so it cannot be answered` };
  }

  switch (type) {
    case 'invoke': {
      const argv = parsed['argv'];
      if (!Array.isArray(argv)) return { ok: false, id, reason: 'invoke carried no argv' };
      // Every entry, not just the array: one number among the strings would
      // reach `parseArgs` as a value it never has to handle today.
      if (!argv.every((a): a is string => typeof a === 'string')) {
        return { ok: false, id, reason: 'invoke argv held something that was not a string' };
      }
      return { ok: true, message: { type: 'invoke', id, argv } };
    }
    case 'answer':
      return { ok: true, message: { type: 'answer', id, decision: parsed['decision'] } };
    case 'shutdown':
      return { ok: true, message: { type: 'shutdown', id } };
    case 'pause':
      return { ok: true, message: { type: 'pause', id } };
    case 'command': {
      // Every field checked here, for `pilot`'s reason: there is no `parseArgs`
      // below this to catch a missing one, and this frame spawns a process.
      const dir = parsed['dir'];
      const program = parsed['program'];
      if (typeof dir !== 'string' || dir === '') {
        return { ok: false, id, reason: 'command carried no dir' };
      }
      if (typeof program !== 'string' || program === '') {
        return { ok: false, id, reason: 'command carried no program' };
      }
      const args: unknown = parsed['args'] ?? [];
      // An array of strings or nothing. A number where a string was declared is
      // the shape `tools.ts` documents a model actually sending, and coercing it
      // would run an argument nobody wrote.
      if (!Array.isArray(args) || !args.every((a): a is string => typeof a === 'string')) {
        return { ok: false, id, reason: 'command args held something that was not a string' };
      }
      return { ok: true, message: { type: 'command', id, dir, program, args } };
    }
    case 'command_stop': {
      const commandId = parsed['commandId'];
      if (typeof commandId !== 'string' || commandId === '') {
        return { ok: false, id, reason: 'command_stop named no command' };
      }
      return { ok: true, message: { type: 'command_stop', id, commandId } };
    }
    case 'pilot': {
      // Every field required and every one checked, because this one is not
      // argv: an `invoke` hands its strings to `parseArgs`, which is the single
      // definition of a legal invocation, and there is no equivalent below this
      // to catch a missing model or an empty prompt.
      const fields = ['prompt', 'system', 'model', 'sessionId', 'dir'] as const;
      for (const field of fields) {
        const value = parsed[field];
        if (typeof value !== 'string' || value === '') {
          return { ok: false, id, reason: `pilot carried no ${field}` };
        }
      }
      const resume = parsed['resume'];
      if (typeof resume !== 'boolean') {
        return { ok: false, id, reason: 'pilot did not say whether it resumes' };
      }
      return {
        ok: true,
        message: {
          type: 'pilot',
          id,
          prompt: parsed['prompt'] as string,
          system: parsed['system'] as string,
          model: parsed['model'] as string,
          sessionId: parsed['sessionId'] as string,
          dir: parsed['dir'] as string,
          resume,
        },
      };
    }
    case 'archive': {
      // Required and checked, for the reason `pilot`'s fields are: there is no
      // `parseArgs` below this to catch it. An empty `dir` would resolve to the
      // host's cwd, which is a *different repository's* archive presented as
      // this one's - the worst possible way for this to fail, because it
      // succeeds and shows somebody else's runs.
      const dir = parsed['dir'];
      if (typeof dir !== 'string' || dir === '') {
        return { ok: false, id, reason: 'archive carried no dir' };
      }
      return { ok: true, message: { type: 'archive', id, dir } };
    }
    case 'artifacts':
    case 'artifact':
    case 'delete_run': {
      // Both fields required and both checked here, for `archive`'s reason:
      // there is no `parseArgs` below this to catch a missing one, and an empty
      // `dir` would resolve to the host's cwd - a *different repository's*
      // archive answered as though it were this one, which is the worst way for
      // a read to fail because it succeeds.
      const dir = parsed['dir'];
      const runId = parsed['runId'];
      if (typeof dir !== 'string' || dir === '') {
        return { ok: false, id, reason: `${type} carried no dir` };
      }
      if (typeof runId !== 'string' || runId === '') {
        return { ok: false, id, reason: `${type} carried no runId` };
      }
      if (type === 'artifacts') {
        return { ok: true, message: { type: 'artifacts', id, dir, runId } };
      }
      // Here rather than in a case of its own: the two fields it needs are the
      // two checked above, and the checks are the point. A separate case would
      // be a second copy of "an empty dir resolves to the host's cwd" - which
      // for a delete would be the wrong repository's run, removed successfully.
      if (type === 'delete_run') {
        return { ok: true, message: { type: 'delete_run', id, dir, runId } };
      }
      // Refused rather than defaulted to a listing. The two requests are
      // different types precisely so that a `name` nobody sent is a refusal
      // with a sentence and never a silently different answer.
      const name = parsed['name'];
      if (typeof name !== 'string' || name === '') {
        return { ok: false, id, reason: 'artifact named no artifact' };
      }
      return { ok: true, message: { type: 'artifact', id, dir, runId, name } };
    }
    case 'diff': {
      const dir = parsed['dir'];
      if (typeof dir !== 'string' || dir === '') {
        return { ok: false, id, reason: 'diff carried no dir' };
      }
      // Required, and refused rather than defaulted to null. `diffSince(cwd,
      // null)` runs `git add -A` before it diffs, which stages the user's whole
      // working tree - a read frame must never reach that path.
      const baseSha = parsed['baseSha'];
      if (typeof baseSha !== 'string' || baseSha === '') {
        return { ok: false, id, reason: 'diff carried no baseSha, and there is no safe default' };
      }
      // Optional, and refused rather than ignored when present but unusable. A
      // `headSha: 0` silently dropped would answer a request for one round with
      // the whole run's diff - the same shape as the truncation flag it sits
      // beside, where presenting a partial answer as a complete one is the
      // failure the field exists to prevent.
      const headSha = parsed['headSha'];
      if (headSha !== undefined && (typeof headSha !== 'string' || headSha === '')) {
        return { ok: false, id, reason: 'diff carried a headSha that was not a commit' };
      }
      return {
        ok: true,
        message:
          headSha === undefined
            ? { type: 'diff', id, dir, baseSha }
            : { type: 'diff', id, dir, baseSha, headSha },
      };
    }
    case 'config': {
      const dir = parsed['dir'];
      if (typeof dir !== 'string' || dir === '') {
        return { ok: false, id, reason: 'config carried no dir' };
      }
      const patch = parsed['patch'];
      // Absent is a read. Present-but-not-an-object is refused rather than
      // treated as one: a `patch: null` that read as "no patch" would answer a
      // save with the unchanged config and look like it had worked.
      if (patch === undefined) return { ok: true, message: { type: 'config', id, dir } };
      if (!isRecord(patch)) {
        return { ok: false, id, reason: 'config carried a patch that was not an object' };
      }
      return { ok: true, message: { type: 'config', id, dir, patch } };
    }
    case 'cancel': {
      // Optional, and refused rather than coerced when present but unusable.
      // The reason reaches `NEEDS-INPUT.md` and the run record, so a number
      // there would be a sentence nobody wrote.
      const why = parsed['reason'];
      if (why !== undefined && (typeof why !== 'string' || why === '')) {
        return { ok: false, id, reason: 'cancel carried a reason that was not a sentence' };
      }
      return {
        ok: true,
        message: why === undefined ? { type: 'cancel', id } : { type: 'cancel', id, reason: why },
      };
    }
    default:
      return {
        ok: false,
        id,
        reason: `"${type}" is not a request this version understands`,
      };
  }
}

/**
 * Split a byte stream into lines.
 *
 * A frame is not a chunk: a pipe splits wherever it likes, and a 4KB plan
 * summary in a narration message arrives in pieces. The remainder is held until
 * its newline arrives, which is the whole job.
 *
 * A line longer than `maxLineBytes` is dropped along with the buffer, and the
 * drop is reported rather than silently swallowed. Without a ceiling, a sender
 * that never emits a newline is an unbounded allocation on the receiving side,
 * and the receiving side here is the process holding the run.
 */
export function createLineReader(
  onLine: (line: string) => void,
  onOverflow?: (bytes: number) => void,
  maxLineBytes = 1_000_000,
): (chunk: string) => void {
  let buffer = '';
  return (chunk: string): void => {
    buffer += chunk;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      onLine(line);
      nl = buffer.indexOf('\n');
    }
    if (buffer.length > maxLineBytes) {
      const dropped = buffer.length;
      buffer = '';
      onOverflow?.(dropped);
    }
  };
}

/** Narration levels, so a host can be exhaustive over them without importing the loop. */
export const LEVELS: readonly Level[] = [
  'heading',
  'step',
  'info',
  'detail',
  'ok',
  'warn',
  'error',
];
