import { repoOf, runIdOf, sourceRef } from '../cockpit/hosts';
import type { LiveRun, LiveRuns } from '../cockpit/hosts';
import { isDraftId } from '../cockpit/pending';
import type { Draft } from '../cockpit/pending';
import { dirKey } from '../cockpit/projects';
import type { Run } from '../cockpit/model';

/**
 * Which run a pilot conversation reads (#438).
 *
 * The pane was handed `columnRun` - whatever the column was drawing - and the
 * read tools answered from it. The column is blank in three states that a
 * conversation can perfectly well be about a run in: a draft on screen, the
 * seconds before `run_started`, and an opened run whose replay has not come back
 * from the host yet. The third is the report. A conversation restored onto a
 * run that had just finished still owed a `read_output` from an hour before, and
 * the settle effect ran the moment the chat was restored, before the replay had
 * arrived. So the pilot was told the run had no narration, no cycles and no gate,
 * with no run id to tell it which run that was. The cards in the same chat came
 * from the replay a moment later, and the pilot guessed that setup was still
 * running.
 *
 * ## The rule
 *
 * A conversation reads, in this order:
 *
 * 1. **A run it started whose adoption has not settled.** This is the same rule
 *    `chatRun` uses for the log, so the cards and the tools agree while a
 *    launch holds the chat that proposed it.
 * 2. **Its own run**, when it is a run's conversation (the chat key names a run
 *    id). That holds for a live run, an ended one and an archived one alike.
 * 3. **The run its draft became**, for a draft's conversation: the id the draft
 *    was bound to, or the launch it made that has not said its id yet.
 * 4. **No run.** The answer then says so, and names the last run this
 *    conversation started and how it ended.
 *
 * The run is found **by id and repository**, never by what is on screen. With
 * several live runs in one window, a conversation therefore never reads another
 * run's narration.
 *
 * ## Where the run comes from
 *
 * No copy is kept here. A run this window is hosting is its `LiveRun`. An opened
 * run is the replay the column already draws (`useReplay`, which applies
 * #408's ending, so a lost run reads as lost). A run this window hosted and that
 * has since ended is the `LiveRun` it left. While an opened run's replay is still
 * being read the binding is `reading`, and the read tools wait instead of
 * answering. Answering then is how the blank answer got sent.
 *
 * Pure, because the app has no jsdom. The cockpit holds the state and asks here.
 */

/** Where the run is: the four states a model has to tell apart. */
export type RunState = 'starting' | 'live' | 'ended' | 'lost';

/** Why the conversation reads this run: it is the run's own chat, or it started it. */
export type Via = 'own' | 'started';

export type Binding =
  | {
      kind: 'run';
      /** Null only while a launch has not said its id yet (`starting`). */
      runId: string | null;
      via: Via;
      state: RunState;
      /** `window` is this window's own narration of it; `record` is a re-read of its archive. */
      source: 'window' | 'record';
      run: Run;
    }
  /** An opened run whose record is still being read. The read tools wait. */
  | { kind: 'reading'; runId: string; via: Via }
  /** A run the window holds no readable copy of, and the sentence saying why. */
  | { kind: 'unread'; runId: string; via: Via; why: string }
  | { kind: 'none'; last: LastStarted | null };

/** The last run a conversation started, for an answer that has no run to give. */
export interface LastStarted {
  runId: string | null;
  state: RunState;
  /** The exit code it returned, when it has. */
  exit: number | null;
  /** The host's sentence, when it was lost. */
  lost: string | null;
}

export interface BindArgs {
  /** The conversation: `chatKey`'s pair. */
  spot: { dir: string; runId: string | null };
  drafts: readonly Draft[];
  lives: LiveRuns;
  /** The opened run the column replays, if any, and its replay as `useReplay` gave it. */
  opened: { dir: string; runId: string; run: Run | null; failure: string | null } | null;
  /**
   * What this conversation read when it was last on screen. Used only for a
   * pane in the background whose run is neither hosted here nor still opened,
   * so it finishes its turn on the copy it had rather than on nothing.
   */
  kept?: Binding | null;
}

/** The state a `Run` is in, read off the fields the loop and the host set. */
export function stateOf(run: Run): RunState {
  if (run.lost !== null) return 'lost';
  if (run.completed !== null) return 'ended';
  if (run.identity === null) return 'starting';
  return 'live';
}

function same(a: string, b: string): boolean {
  return dirKey(a) === dirKey(b);
}

function startedBy(e: LiveRun, spot: BindArgs['spot']): boolean {
  const ref = sourceRef(e);
  return ref !== null && ref.runId === spot.runId && same(ref.dir, spot.dir);
}

function fromLive(e: LiveRun, via: Via): Binding {
  return { kind: 'run', runId: runIdOf(e), via, state: stateOf(e.run), source: 'window', run: e.run };
}

/** A run id, found where the window holds it. */
function resolve(args: BindArgs, dir: string, runId: string, via: Via): Binding {
  const entries = args.lives.filter((e) => runIdOf(e) === runId && same(repoOf(e), dir));
  // The last entry is the newest: a run resumed in this window has its ended
  // session and the live one, and the live one is the run as it now is.
  const hosted = [...entries].reverse().find((e) => e.live);
  if (hosted !== undefined) return fromLive(hosted, via);
  const opened = args.opened;
  if (opened !== null && opened.runId === runId && same(opened.dir, dir)) {
    if (opened.run !== null) {
      return { kind: 'run', runId, via, state: stateOf(opened.run), source: 'record', run: opened.run };
    }
    const ended = entries[entries.length - 1];
    if (ended !== undefined) return fromLive(ended, via);
    if (opened.failure !== null) {
      return { kind: 'unread', runId, via, why: `its record could not be read: ${opened.failure}` };
    }
    return { kind: 'reading', runId, via };
  }
  const ended = entries[entries.length - 1];
  if (ended !== undefined) return fromLive(ended, via);
  const kept = args.kept;
  if (kept !== undefined && kept !== null && kept.kind === 'run' && kept.runId === runId) return kept;
  return {
    kind: 'unread',
    runId,
    via,
    why: 'this window is not running it and does not have it open, so it holds no copy of its narration. Opening the run reads its record.',
  };
}

function lastStarted(args: BindArgs): LastStarted | null {
  const mine = args.lives.filter((e) => startedBy(e, args.spot));
  const e = mine[mine.length - 1];
  if (e !== undefined) {
    return {
      runId: runIdOf(e),
      state: stateOf(e.run),
      exit: e.run.completed?.exit ?? null,
      lost: e.run.lost,
    };
  }
  return null;
}

export function bindingOf(args: BindArgs): Binding {
  const { spot } = args;
  // 1. A launch this conversation made, still holding it.
  const holding = [...args.lives].reverse().find((e) => e.adopted === null && startedBy(e, spot));
  if (holding !== undefined) {
    const id = runIdOf(holding);
    return id === null ? fromLive(holding, 'started') : resolve(args, repoOf(holding), id, 'started');
  }
  // 2. Its own run.
  if (spot.runId !== null && !isDraftId(spot.runId)) return resolve(args, spot.dir, spot.runId, 'own');
  // 3. The run its draft became.
  if (spot.runId !== null) {
    const draft = args.drafts.find((d) => d.id === spot.runId && same(d.dir, spot.dir));
    if (draft !== undefined && draft.runId !== null) return resolve(args, draft.dir, draft.runId, 'started');
    const launch = [...args.lives].reverse().find((e) => startedBy(e, spot));
    if (launch !== undefined) {
      const id = runIdOf(launch);
      return id === null ? fromLive(launch, 'started') : resolve(args, repoOf(launch), id, 'started');
    }
  }
  // 4. None.
  return { kind: 'none', last: lastStarted(args) };
}

/** The Run the pane's prompt and gate tools read: the bound one, or `blank`. */
export function boundRun(binding: Binding, blank: Run): Run {
  return binding.kind === 'run' ? binding.run : blank;
}

/**
 * The header every run read carries: which run this is, why this conversation
 * reads it, and where it stands. For a finished run, how it ended.
 */
export function bindingHeader(binding: Binding): Record<string, unknown> {
  const about = (via: Via): string =>
    via === 'own' ? 'this conversation is this run’s own' : 'this conversation started this run';
  switch (binding.kind) {
    case 'run': {
      const run = binding.run;
      return {
        id: binding.runId,
        about: about(binding.via),
        state: binding.state,
        source:
          binding.source === 'window'
            ? 'narrated live in this window'
            : 'read back from the run’s record in .vibe/runs',
        // How it ended, from the fields that say so. Null while it has not.
        ending:
          binding.state === 'ended'
            ? { exit: run.completed?.exit ?? null, verdict: run.ended, reason: run.reason }
            : binding.state === 'lost'
              ? { lost: run.lost, verdict: run.ended, reason: run.reason }
              : null,
      };
    }
    case 'reading':
      return { id: binding.runId, about: about(binding.via), state: null, reading: true };
    case 'unread':
      return { id: binding.runId, about: about(binding.via), state: null, unreadable: binding.why };
    case 'none':
      return {
        id: null,
        none:
          binding.last === null
            ? 'No run is open for this conversation, and it has not started one in this window.'
            : `No run is open for this conversation. The last run it started was ${binding.last.runId ?? '(one that has not said its id yet)'}, and it is ${binding.last.state}${binding.last.exit !== null ? ` (exit ${String(binding.last.exit)})` : ''}${binding.last.lost !== null ? `: ${binding.last.lost}` : ''}.`,
        lastStarted: binding.last,
      };
  }
}

/**
 * Whether two bindings say the same thing, so the cockpit can hand a pane the
 * same object across renders. The pane's turn starter and tool loop depend on
 * it, and a fresh object on every cockpit render would re-run them all.
 */
export function sameBinding(a: Binding, b: Binding): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'run':
      return (
        b.kind === 'run' &&
        a.runId === b.runId &&
        a.via === b.via &&
        a.state === b.state &&
        a.source === b.source &&
        a.run === b.run
      );
    case 'reading':
      return b.kind === 'reading' && a.runId === b.runId && a.via === b.via;
    case 'unread':
      return b.kind === 'unread' && a.runId === b.runId && a.via === b.via && a.why === b.why;
    case 'none': {
      if (b.kind !== 'none') return false;
      const x = a.last;
      const y = b.last;
      if (x === null || y === null) return x === y;
      return x.runId === y.runId && x.state === y.state && x.exit === y.exit && x.lost === y.lost;
    }
  }
}
