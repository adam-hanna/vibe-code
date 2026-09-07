import { claudeBin, detectRateLimit, extractTokens } from '@src/claude.js';
import { attachEnding, describeEnding, run } from '@src/proc.js';
import type { ChildEnding, RunFn } from '@src/proc.js';
import type { TokenUsage } from '@src/types.js';

/**
 * One pilot chat turn, on the subscription (#193).
 *
 * The pilot needs an API key today, which is a second bill on top of a
 * subscription the user already pays for. This is the other way: **spawn the CLI
 * that owns the login**, which is the mechanism the rest of this repo uses for
 * everything. `README.md`'s defining sentence - *"every external call is a child
 * process"* - becomes true of the pilot as well.
 *
 * Nothing calls this yet. It ships as groundwork with no behaviour change, which
 * is the pattern the role table took four PRs to land under and the one AGENTS.md
 * names for anything near the loop.
 *
 * ## Why not `claudeTurn`
 *
 * It is the same CLI and it is deliberately not the same function, for three
 * reasons that are each disqualifying on their own:
 *
 * - **It narrates.** `detail()` and `warn()` go through `log.ts`, and in the host
 *   that sink is the run's narration stream - so a pilot turn would put its own
 *   prose in the run's output pane and, through `recordAndSay`, in `state.json`.
 *   A conversation about a run is not part of the run's record. This module
 *   imports nothing from `log.ts` and that is the enforcement.
 * - **It charges through a run's books.** Not directly - `applyCharge` is the
 *   dispatch layer's - but every caller of `claudeTurn` is a role turn, and
 *   growing a fourth kind of caller is how the pilot's tokens end up inside
 *   `budget.maxTokens`. #145 settled that they are two sets of books; this keeps
 *   them two functions.
 * - **It carries the run's session apparatus.** `sessionArgs`, the fork/resume
 *   dispatch, `--json-schema`, a heartbeat that reports into the run's progress.
 *   A chat turn wants none of it and would have to opt out of each one.
 *
 * What it *does* share is the parts where two answers would be one answer too
 * many: `claudeBin` resolves the same executable, `extractTokens` reads the same
 * envelope, and `detectRateLimit` decides the same question.
 *
 * ## What this turn may do, and the four layers that decide it
 *
 * **It may read the repository and it may do nothing else.** That is a decision
 * taken on #193 rather than a consequence of a flag: a pilot that can read
 * `PLAN.md` and the diff is the thing somebody asking *"what is this doing"*
 * actually wants, and it is the capability that makes this better than a generic
 * assistant. It does mean the two providers are asymmetric - the API-backed
 * pilot has no filesystem at all - and that asymmetry is accepted and written
 * down rather than discovered.
 *
 * Granting it deliberately is what makes the *closed* form possible, and that is
 * the real change. Before the decision this file denied seven built-ins by name,
 * which is open at the top: a tool a future release adds would not have been on
 * the list. Knowing exactly what to permit means naming it instead.
 *
 * - **`--tools Read Glob Grep`** - the CLI's built-in allow-list. Anything not
 *   named is unavailable, including tools that do not exist yet.
 * - **`--restricted`** - removes the built-ins that run commands or code, and
 *   **confines the file tools to the working directory**, so "read the
 *   repository" means that repository and not the rest of the disk. It also
 *   ignores user, project and local settings files, so what this turn can do is
 *   decided here rather than by whatever the machine happens to be configured
 *   with.
 * - **`--strict-mcp-config`**, with no `--mcp-config` beside it, which means **no
 *   MCP servers at all**. #138 is open precisely because every role reaches
 *   whatever MCP servers the user configured globally, and a read-only seat can
 *   end up holding a write tool that way. The pilot is the last surface that
 *   should inherit that, so it does not.
 * - **`--permission-mode plan`** - the permission layer underneath all of it,
 *   which refuses an edit even if the layers above were wrong.
 *
 * **`Bash` is deliberately absent, and this list is narrower than
 * `READ_ONLY_TOOLS` in `roles.ts` because of it.** That toolset is read-only in
 * the sense a *run's* seats are - a shell under a sandbox, in work a person
 * launched. This is a chat surface the model drives turn by turn, and the app's
 * standing rule is written about exactly this case: *"'run this program' must
 * never be in reach of it"* (#144). A shell is not what "read the repo" means.
 *
 * ## What it costs, and what it does not
 *
 * A subscription turn **bills nothing at all**, so `PilotChatResult` carries no
 * money field and there is nowhere for one to be invented. That is not a new
 * rule: it is exactly why Codex cost is not reported, and it is the same
 * distinction #145 draws when it says the pilot's price table is not a
 * counter-example. The tokens are real and are reported; the dollars have no
 * quantity to be an estimate of.
 *
 * **The cost that is real is contention.** These tokens come out of the same
 * subscription window the run draws on, so a long conversation beside a long run
 * can push that run into a `ratelimits.ts` wait. Today the pilot cannot do that,
 * because it spends different money. Whoever wires this up owes that decision an
 * answer; this module's part is to surface a `RateLimitError` as itself rather
 * than as a generic failure, so the answer has something to act on.
 */

export interface PilotChatOptions {
  /** What the person typed. Over stdin, never argv - Claude's variadic flags eat positionals. */
  prompt: string;
  /**
   * The system prompt, **replacing** Claude Code's default rather than appending
   * to it.
   *
   * `--system-prompt`, not `--append-system-prompt`. The default prompt describes
   * a coding agent with a repository and a task, and a pilot is neither - keeping
   * it would leave the model reconciling two jobs, and the one it would pick is
   * the one with tools it has been denied.
   */
  system: string;
  /** A uuid the caller allocated, so the id is known before the first turn. */
  sessionId: string;
  /** Continue `sessionId` rather than create it. The second turn onward. */
  resume: boolean;
  model: string;
  /**
   * Where the child runs.
   *
   * A chat turn writes nothing, so this is not the run's working directory in any
   * meaningful sense - but a child process has one whatever we do, and naming it
   * beats inheriting whatever the host happened to be started in.
   */
  cwd: string;
  timeoutMs: number;
  /**
   * Called with each fragment of the reply as it arrives, in order.
   *
   * A progress signal in the same sense `RunOptions.onLine` is one: the full text
   * is returned either way, a throwing hook must never cost the turn, and nothing
   * is called after the promise settles.
   */
  onDelta?: ((text: string) => void) | undefined;
}

export interface PilotChatResult {
  /** The reply, from the `result` envelope - the same single message `-p` prints. */
  text: string;
  /** What the CLI says the conversation is, which is authoritative over ours. */
  sessionId: string;
  /**
   * What the turn moved.
   *
   * There is deliberately no `costUsd` beside it. The envelope carries one and it
   * is not read: on a subscription nothing is billed, so a figure here would be a
   * number with no quantity behind it, which is the one thing this repo never
   * ships.
   */
  tokens: TokenUsage;
}

/**
 * Everything this turn may reach, named.
 *
 * A closed list, which is the whole reason it replaced a deny-list: a tool a
 * future CLI release adds is not on it and therefore is not available, where a
 * deny-list would have silently gained it.
 *
 * Narrower than `READ_ONLY_TOOLS` in `roles.ts` on purpose - see the module
 * comment. That set includes `Bash`, `WebSearch` and `WebFetch`, which are right
 * for a run's read-only seats and wrong for a chat the model drives.
 */
const READS: readonly string[] = ['Read', 'Glob', 'Grep'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The argv for one turn. Split out so a test can read it without a child. */
export function pilotChatArgs(options: PilotChatOptions): readonly string[] {
  const args: string[] = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    // The reason a CLI-backed pilot can feel like a chat rather than a wait.
    // Without it the stream carries whole assistant messages and the pane would
    // sit blank for the length of a reply.
    '--include-partial-messages',
    // The three layers above the permission mode. Each is independent, each is
    // stated in the module comment, and all three are visible in a process list
    // - which is the point of putting them in the argv rather than in a settings
    // file this turn would then have to be trusted to have.
    '--restricted',
    '--strict-mcp-config',
    '--permission-mode',
    'plan',
    '--system-prompt',
    options.system,
  ];
  // Two of exactly two. There is no fork here: a fork copies a conversation's
  // history into a new id, which is a thing a run does when it branches and a
  // thing a chat has no use for.
  args.push(options.resume ? '--resume' : '--session-id', options.sessionId);
  args.push('--model', options.model);
  // Variadic, so last: it greedily consumes the tokens after it. Note this also
  // re-admits anything `--restricted` removed that it names - which is why it
  // names only reads.
  args.push('--tools', ...READS);
  return args;
}

/**
 * Read one line of the stream, returning the text fragment it carried, if any.
 *
 * Exported because it is the whole of the streaming behaviour and a test that had
 * to spawn a child to reach it would not be written.
 *
 * Two shapes carry text and only one of them is a fragment. A
 * `content_block_delta` with a `text_delta` is a piece of the reply arriving; an
 * `assistant` message is the same text again, whole, once the block closes. Only
 * the first is emitted, or every reply would be delivered twice.
 */
export function readDelta(line: string): string | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let event: unknown;
  try {
    event = JSON.parse(trimmed) as unknown;
  } catch {
    // Non-JSON noise on stdout is not worth failing a turn over, and it is not
    // worth guessing at either. `claudeTurn` takes the same position.
    return null;
  }
  if (!isRecord(event) || event['type'] !== 'stream_event') return null;
  const inner = event['event'];
  if (!isRecord(inner) || inner['type'] !== 'content_block_delta') return null;
  const delta = inner['delta'];
  if (!isRecord(delta) || delta['type'] !== 'text_delta') return null;
  const text = delta['text'];
  return typeof text === 'string' && text !== '' ? text : null;
}

/** The final `result` event, or null if the stream carried none. */
function finalResult(stdout: string): Record<string, unknown> | null {
  let result: Record<string, unknown> | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed) as unknown;
    } catch {
      continue;
    }
    if (isRecord(event) && event['type'] === 'result') result = event;
  }
  return result;
}

/**
 * Run one turn.
 *
 * `exec` is injected for the same reason it is on `claudeTurn`: spawning the real
 * CLI needs a logged-in account and costs a turn's quota per case, so the
 * boundary is tested and the child is not.
 *
 * **What counts as a failure is the envelope, not the exit status** - the rule
 * `claude.ts` states and the reason it states it. A complete successful result
 * alongside a non-zero exit means teardown failed after the work was done, and
 * the work is what the caller asked for. Unlike a run turn there is nothing to
 * warn *into* here, so it is simply accepted; the ending still rides out on any
 * error through `attachEnding`, so a caller can tell a killed child from a
 * refused one (#131).
 */
export async function pilotChat(
  options: PilotChatOptions,
  exec: RunFn = run,
): Promise<PilotChatResult> {
  const args = pilotChatArgs(options);
  const ended: { seen: ChildEnding | null } = { seen: null };

  try {
    const { code, signal, stdout, stderr } = await exec(claudeBin(), [...args], {
      input: options.prompt,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      onLine: (line: string) => {
        const delta = readDelta(line);
        if (delta === null) return;
        try {
          options.onDelta?.(delta);
        } catch {
          // A progress signal. Losing one must never cost a turn that has
          // already been paid for.
        }
      },
    });
    ended.seen = { code, signal };

    const result = finalResult(stdout);
    if (result === null) {
      // Both the empty-stdout and the no-result cases, in one sentence, because
      // they are one finding from a caller's side: the child produced nothing it
      // could act on. `stderr` is where the CLI puts the reason.
      throw new Error(
        `the pilot's claude turn produced no result (${describeEnding({ code, signal })}). ` +
          `stderr:\n${stderr.slice(-2000)}`,
      );
    }

    if (result['is_error'] === true || result['subtype'] !== 'success') {
      const subtype = typeof result['subtype'] === 'string' ? result['subtype'] : 'unknown';
      const status = result['api_error_status'];
      const said = result['result'];
      const detail = `${String(status ?? '')} ${String(said ?? '')}`.trim();
      // The contention case, surfaced as itself. A pilot turn and a run turn draw
      // on one subscription window, so this is the failure a caller has to be
      // able to act on differently - and `attachSpend` is deliberately not used,
      // because there is no run to charge it to.
      const limit = detectRateLimit(`${detail}\n${stderr}`);
      if (limit !== null) throw limit;
      throw new Error(`the pilot's claude turn failed (${subtype}): ${detail}`);
    }

    return {
      text: typeof result['result'] === 'string' ? result['result'] : '',
      // The CLI's id wins over ours. It is the one that will resume.
      sessionId:
        typeof result['session_id'] === 'string' ? result['session_id'] : options.sessionId,
      tokens: extractTokens(result),
    };
  } catch (err: unknown) {
    throw ended.seen === null ? err : attachEnding(err, ended.seen);
  }
}
