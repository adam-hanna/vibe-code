import type { Frame } from '../host';
import { CONFIG_WRITE_DURING_RUN, SERVICE_HOST } from '../host';
import { chatKey, chatMove, cleanupWrites, readChat, writable } from '../pilot/saved';
import type { Launched } from './argv';
import { settled } from './model';
import type { Run } from './model';
import { dirKey, nameOf, preview } from './projects';
import type { RunName } from './projects';
import type { Viewing } from './where';

/**
 * Which host a frame came from, and what that means for each live run (#246).
 *
 * The app runs one host process per run: a long-lived service host for
 * everything that is not a run, and a run host per `invoke`. The relay wraps
 * every event in the handle of the host that wrote it, and this is where the
 * window decides what to do with that handle. **Nothing here is matched by "the
 * current run"** - a run frame reaches a run's reducer because its handle is
 * that run's, and the window can be hosting several at once.
 *
 * Pure, for `model.ts`'s reason: the cockpit is the one place a routing mistake
 * would otherwise be invisible, and the app has no jsdom.
 */

/**
 * One run this window started, from the moment it was asked for (#246 part B).
 *
 * **Keyed by its handle until `run_started`, and by `(repo, runId)` after it** -
 * and both of those are read off the `Run` through `runIdOf` and `repoOf`, never
 * stored beside it, because a copy taken at launch is a copy `run_started` does
 * not update. `dir` and `asked` are only what the argv said, kept as the
 * fallback for the seconds before the run says who it is.
 */
export interface LiveRun {
  handle: string;
  /** The id the `invoke` was sent with, from `nextRequestId`. */
  invokeId: number;
  /** Gate ids already answered on this host. See `mayAnswer`. */
  answered: ReadonlySet<number>;
  /** Whether frames from this handle still reach this run. False once it has ended. */
  live: boolean;
  /** The invoke's `-C`. Read through `repoOf`. */
  dir: string;
  /** The run id a resume's argv names. Read through `runIdOf`. */
  asked: string | null;
  /** The brief, for a label before the run says its own. */
  task: string | null;
  /** The launch read back out of its argv, for the pilot (#191). Null for a resume. */
  sent: Launched | null;
  /** The draft whose proposal this is, so only its run claims it. */
  draft: { id: string; dir: string } | null;
  /** The conversation that proposed it, when that was not a draft's. */
  held: { dir: string; runId: string | null } | null;
  /** Whether the proposing conversation has been dealt with. Null until it has. */
  adopted: 'moved' | 'skipped' | null;
  /** Set when Rust's start resolves. */
  pid: number | null;
  /** Set by the first frame routed to it. */
  heard: boolean;
  /** A pause this window asked for and has not seen honoured (#210). */
  pausing: boolean;
  /** A stop this window asked for and the core has not answered (#253). */
  stopping: boolean;
  run: Run;
}

export type LiveRuns = readonly LiveRun[];

/** The run's id: what it said on `run_started`, else what a resume's argv asked for. */
export function runIdOf(e: LiveRun): string | null {
  return e.run.identity?.runId ?? e.asked;
}

/** The run's repository: what it said on `run_started`, else the invoke's `-C`. */
export function repoOf(e: LiveRun): string {
  return e.run.identity?.repo ?? e.dir;
}

/**
 * Whether Rust has started this run's host, so the window may draw it.
 *
 * **Routable is not drawable.** An entry routes from the moment it is added, so
 * a frame that beats the start's promise still lands; it is drawn only once
 * something proves the host exists. Two things do: the pid, when `host_start`
 * resolves, and any frame on its handle, because only a host Rust spawned can
 * write one - and Rust relays frames before its promise resolves, so the pid
 * alone was too late. A start Rust refuses produces neither, so a refused run
 * is never drawn.
 */
export function started(e: LiveRun): boolean {
  return e.pid !== null || e.heard;
}

/**
 * The directory and run id an argv names, positionally - or null where it does
 * not name a directory. `launch` refuses a null `dir`: a run whose repository the
 * window cannot read is a run it could not count, guard or label.
 */
export function launchMeta(argv: readonly string[]): { dir: string | null; asked: string | null } {
  const [command, first, dash, dir] = argv;
  const known = command === 'run' || command === 'plan' || command === 'resume';
  const at = known && dash === '-C' && dir !== undefined && dir.trim() !== '' ? dir : null;
  return { dir: at, asked: command === 'resume' && first !== undefined && first !== '' ? first : null };
}

/** Where a frame from `host` goes: the service host's listeners, a run, or nowhere. */
export function routeFrame(lives: LiveRuns, host: string): 'service' | 'run' | 'stale' {
  if (host === SERVICE_HOST) return 'service';
  return lives.some((e) => e.live && e.handle === host) ? 'run' : 'stale';
}

function liveAt(lives: LiveRuns, host: string): LiveRun | undefined {
  return lives.find((e) => e.live && e.handle === host);
}

/**
 * Whether this frame ends a live run's invoke, and how.
 *
 * `completed` is the `result` carrying the invoke's id: the command returned.
 * `failed` is an `error` carrying it: the invoke was refused or escaped
 * `main()`'s own handling, so no `result` is coming.
 *
 * **An `error` with that id is always the invoke's**, and the reason is
 * `mayAnswer`: `serve.ts` refuses an answer only when its gate is not in `asks`,
 * a gate leaves `asks` only by being answered or by the clear that runs after
 * the invoke's own outcome has been sent, and the window answers each gate once.
 * So no answer refusal can arrive on a live handle while its run is live, even
 * when a gate's id happens to equal the invoke's - the two counters are the
 * host's and the window's, and neither range can be fenced off from the other.
 */
export function invokeOutcome(lives: LiveRuns, host: string, frame: Frame): 'completed' | 'failed' | null {
  const e = liveAt(lives, host);
  if (e === undefined) return null;
  if (frame.type === 'result' && frame.id === e.invokeId) return 'completed';
  if (frame.type === 'error' && frame.id === e.invokeId) return 'failed';
  return null;
}

/**
 * Whether the window may answer this gate on this host: its run is live, the
 * gate is the one that run is holding, and it has not been answered already.
 */
export function mayAnswer(lives: LiveRuns, host: string, askId: number): boolean {
  const e = liveAt(lives, host);
  return e !== undefined && !e.answered.has(askId) && e.run.gate?.askId === askId;
}

/**
 * What a host's exit means.
 *
 * The service host going is what "the host exited" has always meant. A run
 * host going while its run is live is THAT run lost, and no other. Any other
 * run host going is the expected close after its `result` - not an alarm.
 */
export function exitMeans(lives: LiveRuns, host: string): 'service' | 'run-lost' | 'expected' {
  if (host === SERVICE_HOST) return 'service';
  return liveAt(lives, host) !== undefined ? 'run-lost' : 'expected';
}

/** The sentence for a host that ended, moved verbatim from the cockpit. */
export function hostExitWording(code: number | null): string {
  return code === null
    ? 'the host was signalled and reported no exit code'
    : `the host exited ${String(code)}`;
}

/** A new run, added before its host is started. Appends and nothing else. */
export function addRun(lives: LiveRuns, entry: LiveRun): LiveRuns {
  return [...lives, entry];
}

/** `addRun`'s exact inverse, for a start Rust refused. */
export function dropRun(lives: LiveRuns, handle: string): LiveRuns {
  return lives.filter((e) => e.handle !== handle);
}

/**
 * Let go of runs that are over, once nothing is still owed to them: not live,
 * their proposing conversation dealt with, and not the one being kept on screen.
 * Called after a start succeeds, never before - pruning ahead of a start that
 * Rust then refused would have erased the finished run the window was showing.
 */
export function pruneEnded(lives: LiveRuns, keep: string | null): LiveRuns {
  return lives.filter((e) => e.live || e.adopted === null || e.handle === keep);
}

function edit(lives: LiveRuns, handle: string, change: (e: LiveRun) => LiveRun): LiveRuns {
  return lives.map((e) => (e.handle === handle ? change(e) : e));
}

/**
 * Fold a frame into the run its handle names, through the unchanged `reduce`.
 *
 * Any frame proves Rust spawned the host, so `heard` is set. A gate opening
 * means a pause was honoured; a run that has settled or is giving up holds
 * neither a pause nor a stop any more (#253) - so the two flags clear here
 * rather than in effects keyed on whichever run happens to be on screen.
 */
export function updateRun(lives: LiveRuns, handle: string, step: (run: Run) => Run): LiveRuns {
  return edit(lives, handle, (e) => {
    const run = step(e.run);
    const over = settled(run) || run.reason !== null;
    return {
      ...e,
      run,
      heard: true,
      pausing: over || run.gate !== null ? false : e.pausing,
      stopping: over ? false : e.stopping,
    };
  });
}

/** The run's invoke is over: nothing more is routed to it. */
export function endRun(lives: LiveRuns, handle: string): LiveRuns {
  return edit(lives, handle, (e) => ({ ...e, live: false, pausing: false, stopping: false }));
}

export function setPid(lives: LiveRuns, handle: string, pid: number): LiveRuns {
  return edit(lives, handle, (e) => ({ ...e, pid }));
}

export function markAnswered(lives: LiveRuns, handle: string, askId: number): LiveRuns {
  return edit(lives, handle, (e) => ({ ...e, answered: new Set([...e.answered, askId]) }));
}

export function setFlag(lives: LiveRuns, handle: string, flag: 'pausing' | 'stopping', value: boolean): LiveRuns {
  return edit(lives, handle, (e) => ({ ...e, [flag]: value }));
}

export function markAdopted(lives: LiveRuns, handle: string, adopted: 'moved' | 'skipped'): LiveRuns {
  return edit(lives, handle, (e) => ({ ...e, adopted }));
}

/** The conversation that proposed this run, as a pane position, or null. */
export function sourceRef(e: LiveRun): { dir: string; runId: string | null } | null {
  if (e.draft !== null) return { dir: e.draft.dir, runId: e.draft.id };
  return e.held;
}

/** The same, as the key it is stored under. */
export function sourceOf(e: LiveRun): string | null {
  const ref = sourceRef(e);
  return ref === null ? null : chatKey(ref.dir, ref.runId);
}

function sameRun(e: LiveRun, at: { dir: string; runId: string }): boolean {
  return runIdOf(e) === at.runId && dirKey(repoOf(e)) === dirKey(at.dir);
}

/**
 * The live run the window draws, or null.
 *
 * With a run opened, the live run that IS it - same id, same repository - so
 * opening a run this window is hosting draws its live `Run` rather than a replay
 * of its archive. A run that has ended, or one not started yet, is null here,
 * which means replay. With nothing opened, the run last started, once started,
 * including after it ends.
 */
export function onScreen(lives: LiveRuns, viewing: Viewing | null, focus: string | null): LiveRun | null {
  if (viewing !== null) return lives.find((e) => e.live && started(e) && sameRun(e, viewing)) ?? null;
  return lives.find((e) => e.handle === focus && started(e)) ?? null;
}

/**
 * Where the pilot pane is held until a run's proposing conversation has been
 * dealt with, or null.
 *
 * **However the run reached the screen.** A run drawn because it was just
 * started, and a run somebody clicked in the sidebar the moment it appeared, are
 * the same run with the same conversation in flight: pointing the pane at the
 * run's own key before adoption had settled restored an empty chat there and
 * saved it over the one about to arrive. A draft on screen holds itself.
 */
export function heldChat(
  lives: LiveRuns,
  shown: LiveRun | null,
  viewing: Viewing | null,
  drafting: unknown,
): { dir: string; runId: string | null } | null {
  if (drafting === null && shown !== null && shown.adopted === null && sourceRef(shown) !== null) {
    return sourceRef(shown);
  }
  if (viewing !== null) {
    const e = lives.find((x) => x.adopted === null && sourceRef(x) !== null && sameRun(x, viewing));
    if (e !== undefined) return sourceRef(e);
  }
  return null;
}

/** Changes whenever a run starts or ends, for the archive's scorecard to re-read. */
export function livesEpoch(lives: LiveRuns): string {
  return lives.map((e) => `${runIdOf(e) ?? e.handle}:${settled(e.run) ? 'ended' : 'open'}`).join('|');
}

/** A run as the sidebar names it: its rename, else its brief, previewed. */
export function runLabel(e: LiveRun, names: readonly RunName[]): string {
  const id = runIdOf(e);
  const task = e.task ?? e.run.identity?.task ?? '';
  const text = preview(id !== null ? nameOf(names, repoOf(e), id, task) : task);
  return text !== '' ? text : 'a run still starting';
}

/**
 * `runs.maxConcurrent` as the window read it: no limit, a limit, or a value it
 * cannot use. Mirrors `readMaxConcurrent` in `src/config.ts` sentence for
 * sentence; the two packages do not share code, and `hosts.test.ts` reads that
 * file as source and fails on the commit that rewords one.
 */
export type CapRead = { cap: number } | { problem: string };

export function capOf(globalRaw: Readonly<Record<string, unknown>>): CapRead {
  const section = globalRaw['runs'];
  if (section === undefined) return { cap: 0 };
  if (typeof section !== 'object' || section === null || Array.isArray(section)) {
    return { problem: 'runs must be an object' };
  }
  const runs = section as Record<string, unknown>;
  for (const key of Object.keys(runs)) {
    if (key !== 'maxConcurrent') return { problem: `runs.${key} is not a setting; the one is maxConcurrent` };
  }
  const value = runs['maxConcurrent'];
  if (value === undefined) return { cap: 0 };
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return { problem: 'runs.maxConcurrent must be 0 (no limit) or a whole number of runs' };
  }
  return { cap: value };
}

/**
 * Whether a start is refused by the cap, and the sentence if it is.
 *
 * Counts every live run this window hosts, started or not - a start still in
 * flight holds a slot, or two quick presses would both get one. Three states:
 * a value that cannot be used refuses every start, because guessing *no limit*
 * from a value somebody wrote is the silent revert the cap exists to prevent; a
 * cap not read yet refuses only while runs are live, since with none live no
 * cap can be exceeded; and 0 is no limit.
 */
export function capRefusal(lives: LiveRuns, read: CapRead | null, label: (e: LiveRun) => string): string | null {
  const holding = lives.filter((e) => e.live);
  if (read !== null && 'problem' in read) {
    return `runs.maxConcurrent cannot be read (${read.problem}), so no run is started until it is fixed in Settings for all projects.`;
  }
  if (read === null) {
    return holding.length === 0
      ? null
      : `runs.maxConcurrent has not been read yet, and this window is already hosting ${String(holding.length)}: ${holding.map(label).join('; ')}. Try again in a moment.`;
  }
  if (read.cap === 0 || holding.length < read.cap) return null;
  return `runs.maxConcurrent is ${String(read.cap)}, and this window is already hosting ${String(holding.length)}: ${holding.map(label).join('; ')}. Stop one, or raise the cap in Settings for all projects.`;
}

/** Whether a patch touches `runs.maxConcurrent` and nothing else. */
function onlyTheCap(patch: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(patch);
  if (keys.length !== 1 || keys[0] !== 'runs') return false;
  const runs = patch['runs'];
  if (typeof runs !== 'object' || runs === null || Array.isArray(runs)) return false;
  const inner = Object.keys(runs);
  return inner.length === 1 && inner[0] === 'maxConcurrent';
}

/**
 * Whether a config write is refused while runs are going, and by whom.
 *
 * A run reads its configuration once, when it starts, so a write mid-run would
 * leave the settings screen and the running loop describing different
 * configurations. A **project** write is refused only while one of that
 * project's runs is live. A **global** write reaches every project, so any live
 * run refuses it - except a patch touching only `runs.maxConcurrent`, which no
 * run reads, and which is wanted exactly while runs are going. `auth` and `cli`
 * are read for every agent child a run spawns, so neither is exempt. A read
 * (no patch) is never refused.
 */
export function writeRefusal(
  lives: LiveRuns,
  patch: Readonly<Record<string, unknown>> | undefined,
  scope: 'project' | 'global',
  dir: string,
  label: (e: LiveRun) => string,
): string | null {
  if (patch === undefined) return null;
  if (scope === 'global' && onlyTheCap(patch)) return null;
  const holding = lives.filter((e) => e.live && (scope === 'global' || dirKey(repoOf(e)) === dirKey(dir)));
  if (holding.length === 0) return null;
  return `${CONFIG_WRITE_DURING_RUN}. Held by: ${holding.map(label).join('; ')}`;
}

/**
 * Every run a quit would stop, started or not.
 *
 * Quit asks *which hosts will this kill*, and any live entry may have one - Rust
 * can be running a host whose start has not resolved and that has said nothing
 * yet. Filtering by what the window draws once let a quit skip its own
 * confirmation while a run host was going.
 *
 * An entry stops being live only once its run is over: its invoke's `result`
 * or `error` came back (`serve.ts` sends both after `main()` has settled), or
 * its host exited. Rust may still hold that host for the few seconds it takes
 * to leave, and an empty list then quits at once - correctly, because nothing
 * is running in it and `stop()` closes it the way Rust was already closing it.
 * The same holds for a host Rust closed because its invoke could not be
 * written: it never received a run. What this list guarantees is that no RUN
 * is stopped unasked, not that no process is.
 */
export function quitList(lives: LiveRuns, label: (e: LiveRun) => string): readonly string[] {
  return lives.filter((e) => e.live).map(label);
}

/** The runs this window hosts in one project, for its sidebar rows. */
export interface HostedMarks {
  /** Run ids live here, started. */
  live: ReadonlySet<string>;
  /** Run ids live here holding a gate, and not on screen. */
  gates: ReadonlySet<string>;
  /**
   * Run ids live here with a turn running and no gate held (#307) - the rows
   * whose dot pulses. A pulse means *a turn is running*, so several can.
   */
  working: ReadonlySet<string>;
}

/**
 * The sidebar's marks for one project's rows.
 *
 * **Scoped to the project**, because a run id is unique only inside one
 * repository's `.vibe/runs`: a set keyed by id alone marked, and badged, a row
 * with the same id in another project. A gate is badged only off screen: the
 * run on screen draws its own gate in the footer.
 */
export function hostedMarks(lives: LiveRuns, dir: string, shownHandle: string | null): HostedMarks {
  const live = new Set<string>();
  const gates = new Set<string>();
  const working = new Set<string>();
  const key = dirKey(dir);
  for (const e of lives) {
    const id = runIdOf(e);
    if (!e.live || !started(e) || id === null || dirKey(repoOf(e)) !== key) continue;
    live.add(id);
    if (e.run.gate !== null && e.handle !== shownHandle) gates.add(id);
    if (e.run.running !== null && e.run.gate === null && !settled(e.run)) working.add(id);
  }
  return { live, gates, working };
}

export function gatesWaiting(marks: HostedMarks): boolean {
  return marks.gates.size > 0;
}

/** A chat write and what each run's proposing conversation came to. */
export interface AdoptionPlan {
  writes: readonly { key: string; value: string | null }[];
  marks: readonly { handle: string; adopted: 'moved' | 'skipped' }[];
}

/**
 * Who adopts which conversation, decided in one pass over every run (#246).
 *
 * The rule is `chatMove`'s, unchanged: a run that has just said who it is takes
 * the conversation that proposed it, unless it already has one of its own. What
 * several runs add is that two of them can be proposed by one conversation
 * before either has an id, and three things follow from it:
 *
 * - **Every run that adopts gets the exchange**, but no two get the CLI session:
 *   two chats resuming one session would each answer from the other's messages.
 *   Shared means more than one undecided run had that source when this pass
 *   began; a sole one keeps the session, as a single run always did.
 * - **The source is cleaned up once**, and only when this pass moved something
 *   out of it and nothing proposed from it is still waiting for an id - cleaning
 *   a draft's key while a sibling still needs it would hand the sibling nothing.
 * - **A run with no id stays undecided while it is live**, and is skipped once it
 *   has ended without one: there is nothing to adopt into.
 *
 * `stored` is passed in, for `chatMove`'s reason.
 */
export function adoptionPlan(lives: LiveRuns, stored: (key: string) => string | null): AdoptionPlan {
  const pending = lives.filter((e) => e.adopted === null);
  const groups = new Map<string, LiveRun[]>();
  for (const e of pending) {
    const source = sourceOf(e);
    if (source === null) continue;
    groups.set(source, [...(groups.get(source) ?? []), e]);
  }
  const writes: { key: string; value: string | null }[] = [];
  const marks: { handle: string; adopted: 'moved' | 'skipped' }[] = [];
  const decided = new Set<string>();
  const movedFrom = new Set<string>();
  for (const e of pending) {
    const source = sourceOf(e);
    const id = runIdOf(e);
    if (source === null || (id === null && !e.live)) {
      marks.push({ handle: e.handle, adopted: 'skipped' });
      decided.add(e.handle);
      continue;
    }
    if (id === null) continue;
    const target = chatKey(repoOf(e), id);
    const from = stored(source);
    const move = chatMove({
      from: source,
      to: target,
      intoRun: true,
      // Started here, never pointed at: every entry is a launch.
      opened: false,
      stored: stored(target) !== null,
      holding: from !== null,
    });
    decided.add(e.handle);
    if (move !== 'adopt' || from === null) {
      marks.push({ handle: e.handle, adopted: 'skipped' });
      continue;
    }
    const conversation = readChat(from);
    const shared = (groups.get(source)?.length ?? 0) > 1;
    writes.push({
      key: target,
      value: writable(shared ? { ...conversation, session: null, carry: null } : conversation),
    });
    marks.push({ handle: e.handle, adopted: 'moved' });
    movedFrom.add(source);
  }
  for (const source of movedFrom) {
    const group = groups.get(source) ?? [];
    if (group.some((e) => !decided.has(e.handle))) continue;
    const ref = group[0] === undefined ? null : sourceRef(group[0]);
    const from = stored(source);
    if (ref === null || from === null) continue;
    writes.push(...cleanupWrites(source, chatKey(ref.dir, null), readChat(from)));
  }
  return { writes, marks };
}
