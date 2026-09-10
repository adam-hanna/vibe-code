import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { LivenessDot, MetaChip, StateKicker } from '../design';
import * as host from '../host';
import { Credentials } from '../pilot/Credentials';
import * as keys from '../pilot/keys';
import type { KeyStatus } from '../pilot/keys';
// `PilotPane`, not `Pilot`: `pilot.ts` beside it is the wire, and two files
// differing only in case is a compile error on Windows and macOS both.
import { PilotPane } from '../pilot/PilotPane';
import { noCommands, reduceCommands, running } from './commands';
import { CommandsPane } from './CommandsPane';
import { CodePane } from './CodePane';
import { Diagnostics } from './Diagnostics';
import { Footer } from './Footer';
import { PlansPane } from './PlansPane';
import { ReportPane } from './ReportPane';
import { Kickoff } from './Kickoff';
import { LoopColumn } from './LoopColumn';
import { NewWorkstream } from './NewWorkstream';
import { OutputPane } from './OutputPane';
import { Rail } from './Rail';
import { QuestionsPane } from './QuestionsPane';
import { RateLimitStrip } from './RateLimit';
import { Settings } from './Settings';
import { SpendPane } from './SpendPane';
import { StopConfirm } from './StopConfirm';
import { Summary } from './Summary';
import { Switcher } from './Switcher';
import { Workstreams } from './Workstreams';
import { VerifyPane } from './VerifyPane';
import { StalenessStrip } from './Staleness';
import { tokens as fmtTokens } from './format';
import { blockingIn, emptyRun, nextRun, reduce, staleness } from './model';
import { rounds } from './rounds';
import { readLaunchArgv, resumeArgv } from './argv';
import type { Launched, Raise } from './argv';
import type { Caps } from './Footer';
import type { Effect } from '../pilot/tools';
import type { Frame } from '../host';
import type { Run } from './model';

/**
 * The cockpit, at the slice #159 scopes it to.
 *
 * All four of `3a`'s regions — rail, loop column, output pane, footer — plus the
 * pilot, which since #211 is where you land and where a run is started from.
 *
 * ## The left rail, and what changed about the argument against it
 *
 * It was absent for two stated reasons and only one of them survived. The first
 * — *"projects and workstreams need the archive reader (#114)"* — stopped being
 * true when the `archive` frame landed. The second was that **`serve.ts` runs
 * one run at a time**, so there is never a second live workstream to switch
 * between, and a rail over the *archive* is `1b` in a sidebar.
 *
 * That is still true, and it is why the rail's squares **navigate rather than
 * reopen** (see `Rail.tsx`). What it does not justify is having no rail: the
 * design puts `＋`, ⌘K and `⚙` on it in every frame, and with nowhere for them
 * to live they were pushed into the tab bar — which is how that bar came to have
 * twelve tabs against the design's seven. `design/AUDIT.md` §1.1 and §1.2 are
 * one finding, and this is the half that fixes both.
 *
 * Everything on screen comes from a frame. There is no state here that was
 * inferred: `reduce` is the only thing that decides what the run looks like, and
 * it decides it from ids.
 */

/** How often the elapsed clock re-renders between heartbeats. */
const TICK_MS = 1000;

/** Where the last repository is remembered. See `repoDir` below. */
const REPO_KEY = 'vibe.repo';

interface Wire {
  connected: boolean;
  hostPid: number | null;
  uncontained: string | null;
  failure: string | null;
  /**
   * The whole status, kept for the diagnostics panel (#201).
   *
   * The fields above are read on nearly every render and stay unpacked; this is
   * the same object they came from, held so the panel can show the build stamp
   * and the uptime without a second shape to keep in step.
   */
  status: host.Status | null;
  /** Prose from the host's stderr and any stdout line the relay could not parse. */
  log: readonly string[];
  /** A frame this version does not recognise. Shown, never discarded. */
  unknown: readonly string[];
}

export function Cockpit() {
  const [run, dispatch] = useReducer(
    // `Date.now()` here rather than inside `reduce`: the model takes the arrival
    // time as an argument so it stays pure and testable, and this is the one
    // place a real clock is read.
    (state: Run, action: Frame | { type: 'reset' }) =>
      action.type === 'reset' ? nextRun(state) : reduce(state, action, Date.now()),
    undefined,
    emptyRun,
  );
  const [wire, setWire] = useState<Wire>({
    connected: false,
    hostPid: null,
    uncontained: null,
    failure: null,
    status: null,
    log: [],
    unknown: [],
  });
  /** Whether the diagnostics popover is open (#201, #204). ⌘⇧D toggles it. */
  const [diagnostics, setDiagnostics] = useState(false);
  /** Whether the ⌘K switcher is open (`5f`, #223). */
  const [switching, setSwitching] = useState(false);
  /** Whether `4a`'s modal is open. The only modal in the product. */
  const [composing, setComposing] = useState(false);
  /**
   * The repository this window is pointed at (#223).
   *
   * **App-side state, and it belongs nowhere else.** It is not run state - a run
   * carries its own directory and always has - and it is not `vibe.config.json`,
   * which is a project file meant to be committed and would be the wrong place
   * for one machine's path. `localStorage` is where the pilot's spend ceiling
   * lives for the same reason.
   *
   * It is persisted because `1b` and ⌘K are most useful **before** a launch, and
   * a path the user has to retype every time the app starts is a path they stop
   * using the screen rather than retype.
   */
  const [repoDir, setRepoDir] = useState(() => {
    try {
      return localStorage.getItem(REPO_KEY) ?? '';
    } catch {
      // Storage can be unavailable or full. A repository field that starts empty
      // is a smaller failure than a window that will not render.
      return '';
    }
  });
  const rememberRepo = useCallback((dir: string) => {
    setRepoDir(dir);
    try {
      localStorage.setItem(REPO_KEY, dir);
    } catch {
      // See above. Nothing here is worth failing a render over.
    }
  }, []);
  /**
   * A pause this window has asked for and not yet seen honoured (#210).
   *
   * The window's own memory of its own outbound message, like `sentLaunch` — not
   * a re-derivation. The loop is the one that decides when a pause is taken, and
   * it says so with `requested` on `gate_waiting`; this only stops the button
   * being pressed twice while nothing appears to happen.
   */
  const [pausing, setPausing] = useState(false);
  /** Whether the stop confirmation is up. Hi-fi 18: a stop confirms first. */
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [launched, setLaunched] = useState(false);
  /**
   * The launch this window sent, kept so the pilot can be told about it (#191).
   *
   * **Not a re-derivation.** Every other thing on this screen comes from a frame,
   * and the brief is the one fact no frame carries - the loop narrates phases,
   * turns and gates, never the text it was given. This is the window remembering
   * its own outbound message, read back through `readLaunchArgv` so the reader
   * and the builder cannot drift. An argv it does not recognise leaves this null,
   * which the prompt says out loud rather than papering over.
   */
  const [sentLaunch, setSentLaunch] = useState<Launched | null>(null);
  // There is deliberately no `opening` here any more (#211). It existed to
  // prefill a launch bar with the first thing said to the pilot, and the launch
  // bar is gone: the pilot proposes the run itself, so nothing in this window
  // needs to remember the conversation on its behalf.
  /**
   * The round and token caps in force, or null (#223, `4d`).
   *
   * Read here because a halt banner offering *"+2 rounds and resume"* has to
   * know what it is adding two to. Written as an absolute `7` it would assume
   * the default of 5 and **silently lower** a project configured to 10 — so the
   * offer does not exist until this does, which is the fail-closed direction.
   */
  const [caps, setCaps] = useState<Caps | null>(null);
  /** The gate matrix in force, so `3a`'s footer can say where the run holds. */
  const [gates, setGates] = useState<Readonly<Record<string, string>> | null>(null);
  /**
   * The boundaries in the loop's own order, as `src/gates.ts` declares them.
   *
   * Carried rather than written here, and that is what makes the footer's *next
   * hold* a fact rather than a guess: `GATEABLE`'s comment says *"Order is the
   * loop's, not the alphabet's"*, so a copy on this side would be a second
   * sequence that could disagree with the one the run actually walks.
   */
  const [order, setOrder] = useState<readonly string[]>([]);
  useEffect(() => {
    if (repoDir.trim() === '' || !host.inShell()) return;
    let cancelled = false;
    void host
      .config(repoDir)
      .then((frame) => {
        const effective = frame.effective as {
          loop?: Partial<Caps>;
          gates?: Record<string, string>;
        };
        if (cancelled) return;
        if (effective.gates !== undefined) setGates(effective.gates);
        setOrder(frame.gateable);
        const loop = effective.loop;
        if (loop === undefined) return;
        const { maxPlanRounds, maxReviewRounds, maxTokens } = loop;
        // All three or none: a partial set would let one button be relative and
        // another be a guess, which is the worse of the two failures.
        if (
          typeof maxPlanRounds === 'number' &&
          typeof maxReviewRounds === 'number' &&
          typeof maxTokens === 'number'
        ) {
          setCaps({ maxPlanRounds, maxReviewRounds, maxTokens });
        }
      })
      // Left null. The banner says it did not read them rather than offering a
      // raise against a number it invented.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [repoDir]);
  const [tab, setTab] = useState<
    | 'output'
    | 'pilot'
    | 'keys'
    // The four artifact panes (#223). `plans`, `critique` and `review` are what
    // the dashed `Versions` tab was standing in for, and `code` is what `diff`
    // became once a round's own range was on the wire.
    //
    // **`findings` and `diff` are gone rather than kept beside them.** The
    // Findings tab showed the latest round of whichever judge spoke last, from
    // the four counts and a title the wire carries - so a reader asking *why did
    // the loop fix again* got half the evidence and no way to reach the rest. It
    // is one round of `critique` or `review`, both of which now read the report
    // itself. The Diff tab is `code`'s first section, unchanged and still first,
    // because *what has this changed altogether* is a real question - it was
    // just the wrong answer to *what did this round do*.
    | 'plans'
    | 'critique'
    | 'review'
    | 'code'
    | 'verify'
    | 'spend'
    | 'questions'
    | 'runs'
    | 'commands'
    | 'settings'
    // **The pilot, not the output pane** (#211). The complaint was exact: *"I
    // thought my initial prompt would be given to the pilot and the pilot would
    // take control"*, and the app answered it with a form and a tab beside the
    // log. The composer is the front door, so this is where you land — and the
    // output pane has nothing in it before a run anyway.
  >('pilot');
  /**
   * The round a navigation asked for, or null (#223).
   *
   * **Beside the tab rather than folded into it**, because they answer two
   * different questions and one of them is allowed to be absent: pressing the
   * `Plans` tab is *show me the plans* and the pane's own answer to which one is
   * right — the newest. Clicking a round card is *show me round 2*, and the pane
   * has to be told which.
   *
   * A round number rather than a filename, for the reason on `OpenAt`: both ends
   * already hold the round, and a filename would be a third copy of the loop's
   * naming convention in the one process that cannot be kept in step with it.
   */
  const [openAt, setOpenAt] = useState<number | null>(null);
  const open = useCallback((next: string, round?: number | null) => {
    setTab(next as typeof tab);
    setOpenAt(round ?? null);
  }, []);
  /** Pilot proposals waiting on a person, so a hidden tab can say so (#144). */
  const [proposals, setProposals] = useState(0);
  /**
   * Which providers have a key, read here and nowhere else (#188).
   *
   * Two panes need this fact and each used to fetch its own. The pilot pane is
   * mounted for the whole session and hidden rather than unmounted, so its copy
   * was taken at launch and never taken again: entering a key updated the Keys
   * form, and the pilot went on refusing to let anybody type, correctly
   * according to a snapshot from before the key existed. One reader, one fact.
   */
  const [keyStatuses, setKeyStatuses] = useState<readonly KeyStatus[] | null>(null);
  const [keyFailure, setKeyFailure] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const requests = useRef(0);

  const refreshKeys = useCallback(() => {
    void keys
      .status()
      .then((next) => {
        setKeyStatuses(next);
        setKeyFailure(null);
      })
      // The Keys tab shows this and the pilot pane treats it as "no key", which
      // is the fail-closed direction: a request made on an unreadable keychain
      // fails anyway, later, with a worse explanation.
      .catch((err: unknown) => {
        setKeyStatuses([]);
        setKeyFailure(err instanceof Error ? err.message : String(err));
      });
  }, []);
  useEffect(refreshKeys, [refreshKeys]);

  // A local tick, because the heartbeat lands every 30 seconds
  // (`progress.intervalMs`) and a clock that only moved when one arrived would
  // look frozen for half a minute at a time. Every beat re-anchors the turn to
  // the loop's own figure, so this can never drift away from the truth.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const note = useCallback((key: 'log' | 'unknown', text: string) => {
    setWire((w) => ({ ...w, [key]: [...w[key], text].slice(-200) }));
  }, []);

  // ⌘⇧D / Ctrl+Shift+D, and Escape to close. Hi-fi 15 gives the panel a
  // shortcut because it is what somebody reaches for while writing a bug report,
  // and `event.code` rather than `event.key` so it survives a keyboard layout
  // where shift+d is not "D".
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setDiagnostics(false);
        setSwitching(false);
        setComposing(false);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'KeyD') {
        event.preventDefault();
        setDiagnostics((open) => !open);
        return;
      }
      // ⌘K / Ctrl+K, and `code` rather than `key` for the reason ⌘⇧D uses it:
      // it survives a keyboard layout where the K position is not "k".
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.code === 'KeyK') {
        event.preventDefault();
        setSwitching((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Re-asked when the panel opens. Uptime is the one fact in it that moves, and
  // a figure measured at connect would be however long ago that was - stated as
  // though it were now.
  useEffect(() => {
    if (!diagnostics || !host.inShell()) return;
    let cancelled = false;
    void host
      .status()
      .then((status) => {
        if (!cancelled) setWire((w) => ({ ...w, status }));
      })
      // Left as it was. A refresh that failed is not a reason to blank four
      // facts the window already has; the panel says when it has none.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [diagnostics]);

  useEffect(() => {
    if (!host.inShell()) return;
    let stop: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      stop = await host.connect({
        frame: (frame) => dispatch(frame),
        unknown: (raw) => note('unknown', JSON.stringify(raw).slice(0, 300)),
        log: (text) => note('log', text),
        exit: (code) => {
          // Never hidden. The run is resumable and the user is the one who has
          // to be told that is what happened.
          setWire((w) => ({
            ...w,
            connected: false,
            hostPid: null,
            failure:
              code === null
                ? 'the host was signalled and reported no exit code'
                : `the host exited ${String(code)}`,
          }));
        },
      });
      if (cancelled) {
        stop();
        return;
      }
      try {
        const status = await host.status();
        setWire((w) => ({
          ...w,
          connected: status.running,
          hostPid: status.pid,
          failure: status.failure,
          uncontained: status.uncontained,
          status,
        }));
        if (status.ready !== null) dispatch(status.ready);
      } catch (err) {
        setWire((w) => ({ ...w, failure: err instanceof Error ? err.message : String(err) }));
      }
    })();

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [note]);

  const send = useCallback(
    async (request: object) => {
      setBusy(true);
      try {
        await host.send(request);
      } catch (err) {
        note('log', String(err));
      } finally {
        setBusy(false);
      }
    },
    [note],
  );

  /**
   * Start a run. **The one place this window does that**, and the pilot's
   * `start_run` proposal comes through here rather than sending its own frame
   * (#144) - so the request-id allocation, the column reset and the "one at a
   * time" rule have exactly one definition each. A pilot capability the UI does
   * not also have would be a missing control, which is a design bug rather than
   * a pilot feature.
   */
  const launch = useCallback(
    (argv: readonly string[]) => {
      // A new run is a new column. Appending to the previous one's cycles would
      // draw a single loop out of two runs.
      dispatch({ type: 'reset' });
      setLaunched(true);
      setSentLaunch(readLaunchArgv(argv));
      requests.current += 1;
      void send({ type: 'invoke', id: requests.current, argv });
    },
    [send],
  );

  /**
   * Pick a halted run back up (`4d`).
   *
   * Through `launch`, not beside it: the request-id allocation, the column reset
   * and the one-at-a-time rule keep exactly one definition each, which is the
   * same reason the pilot's `start_run` proposal comes through there (#144).
   */
  const resume = useCallback(
    // `force` last and defaulting to false, so every existing caller sends the
    // ordinary resume: taking a lock somebody may still hold is a decision, and
    // the one screen that can see the lock's verdict is the one that offers it.
    (runId: string, dir: string, raise?: Raise, force = false) =>
      launch(resumeArgv(runId, dir, raise ?? {}, force)),
    [launch],
  );

  /**
   * Answer a waiting gate.
   *
   * The decision goes over the wire as the host gave us the id, and unnarrowed:
   * `readDecision` in the core is where that vocabulary is defined, and checking
   * it here as well would be a second definition of a legal decision. A
   * pilot-proposed answer carries an `origin` alongside it, which `readOrigin`
   * reads and `state.events` records - the same frame, one field further.
   */
  const answer = useCallback(
    (askId: number, decision: object) => {
      void send({ type: 'answer', id: askId, decision });
    },
    [send],
  );

  /**
   * The two controls hi-fi 18 draws together (#209, #210).
   *
   * Kept side by side here as well as on screen, because the difference is the
   * whole point: `pause` holds at the next boundary and costs nothing, `stop`
   * kills a child that may be forty minutes in. Neither is a kill of the
   * process, and both leave the run resumable.
   */
  const pause = useCallback(() => {
    setPausing(true);
    void host.pause().catch((err: unknown) => {
      // Un-armed on failure. A button that stayed disabled after a request that
      // never landed would be a window claiming a hold it has not asked for.
      setPausing(false);
      note('log', String(err));
    });
  }, [note]);

  const stop = useCallback(
    (reason: string) => {
      setConfirmStop(false);
      void host.cancel(reason).catch((err: unknown) => note('log', String(err)));
    },
    [note],
  );

  // The loop honoured the pause, so the window stops saying it is armed. Told,
  // not guessed: `gate_waiting` carries `requested` precisely so this is not the
  // window deciding a hold must have been the one it asked for.
  useEffect(() => {
    if (run.gate !== null) setPausing(false);
  }, [run.gate]);

  /**
   * Commands this window started (#211).
   *
   * **Held here rather than on `Run`, and the reason is lifetime.** A command is
   * not part of a run: it is started when there is no run at all - *"does the
   * thing you just built start"* is asked after one finishes - and a dev server
   * left up outlives several. On `Run` it would be destroyed by `nextRun`, which
   * would take the card of a process still listening on 5173 with it.
   */
  const [commands, setCommands] = useState(noCommands);
  useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      stop = await host.onCommandFrame((frame) => {
        setCommands((prev) => reduceCommands(prev, frame));
      });
      if (cancelled) stop?.();
    })();
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  /**
   * Run one, in the repository this window is pointed at.
   *
   * The **one** sender, exactly as `launch` is: the pilot's accepted proposal
   * and the command bar's own button both arrive here, so a pilot capability the
   * window lacks would be a missing control rather than a special ability
   * (#144). The directory is not a parameter - a command runs where the window
   * is pointed, and letting a caller name one would be a second answer to which
   * repository this is.
   */
  const runCommand = useCallback(
    (program: string, args: readonly string[]) => {
      if (repoDir.trim() === '') {
        note('log', 'no repository is set, so there is nowhere to run a command');
        return;
      }
      void host
        .runCommand(repoDir, program, args)
        .then((frame) => setCommands((prev) => reduceCommands(prev, frame)))
        .catch((err: unknown) => note('log', String(err)));
    },
    [repoDir, note],
  );

  const stopCommand = useCallback(
    (commandId: string) => {
      void host.stopCommand(commandId).catch((err: unknown) => note('log', String(err)));
    },
    [note],
  );

  /**
   * Fire a proposal the user accepted.
   *
   * Nothing here decides anything: the effect was built by `tools.ts` from what
   * the model asked for, and a person pressed a button. This is the routing, and
   * it routes to the same two functions the buttons call.
   */
  const onEffect = useCallback(
    (effect: Effect) => {
      if (effect.kind === 'invoke') launch(effect.argv);
      else if (effect.kind === 'command') runCommand(effect.program, effect.args);
      else answer(effect.askId, effect.decision);
    },
    [launch, answer, runCommand],
  );

  const outside = !host.inShell();
  // The round cards, built once here and handed to the surfaces that draw them.
  // `rounds()` is a re-shaping of what is already on `Run` - it measures nothing
  // and infers nothing - and one call is what keeps the pilot's log, the report
  // panes and the Code tab from disagreeing about which round a thing arrived in.
  const cards = rounds(run);

  return (
    <div className="v-cockpit">
      <header className="v-cockpit__bar">
        <LivenessDot state={outside ? 'absent' : wire.connected ? 'live' : 'quiet'} />
        <span className="v-cockpit__title">vibe</span>
        {outside ? (
          <MetaChip>browser · no shell</MetaChip>
        ) : (
          <>
            {/* Hi-fi 15: a chip **only when a value is wrong**, and it names the
                disagreement rather than the value. `HOST 43804` and
                `PROTOCOL 1` sat here permanently and a manual pass reported
                that they mean nothing to a user (#204) - which is true right up
                until one of them is wrong, which is why they moved into the
                panel instead of being deleted. */}
            {run.protocol !== null && run.protocol !== host.EXPECTED_PROTOCOL && (
              <MetaChip kind="alarm">
                protocol {run.protocol} · expected {host.EXPECTED_PROTOCOL}
              </MetaChip>
            )}
            <button
              className="v-cockpit__diag"
              onClick={() => setDiagnostics((open) => !open)}
              aria-label="diagnostics"
              aria-expanded={diagnostics}
              title="Diagnostics (Ctrl+Shift+D)"
            >
              •••
            </button>
          </>
        )}
      </header>

      {confirmStop && (
        <StopConfirm
          turn={run.running}
          busy={busy}
          onStop={() => stop('stopped from the window')}
          onPause={() => {
            setConfirmStop(false);
            pause();
          }}
          onKeep={() => setConfirmStop(false)}
        />
      )}

      {composing && (
        <NewWorkstream
          dir={repoDir}
          onDir={rememberRepo}
          onLaunch={launch}
          onClose={() => setComposing(false)}
          busy={busy || !wire.connected}
        />
      )}

      {/* `5f`. A switcher, not a screen: it answers "take me to
          fix-ratelimit-wait" and nothing else, which is why it is an overlay
          over the cockpit rather than a tab beside `1b`. The two are different
          features, and the design resolved to build both. */}
      {switching && (
        <Switcher
          dir={repoDir}
          onPick={(runId) => resume(runId, repoDir)}
          onClose={() => setSwitching(false)}
        />
      )}

      {diagnostics && (
        <Diagnostics
          status={wire.status}
          expected={host.EXPECTED_PROTOCOL}
          identity={run.identity}
          onClose={() => setDiagnostics(false)}
        />
      )}

      {/* `7c`, above everything and below the titlebar. It is a statement about
          the whole window - everything under it is as old as the strip says -
          so it cannot sit inside one column. */}
      <StalenessStrip state={staleness(run, now)} hostPid={wire.hostPid} />

      {/* `7e`, above the columns for the same reason: an agent with no headroom
          is a statement about the whole run, not about one pane. Quiet, and
          with no action, because a rate limit asks nobody anything. */}
      <RateLimitStrip wait={run.rateLimit} now={now} />

      {wire.failure !== null && (
        <div className="v-cockpit__alarm">
          <StateKicker tone="alarm">no host</StateKicker> {wire.failure}
        </div>
      )}
      {wire.uncontained !== null && wire.connected && (
        <div className="v-cockpit__alarm">
          <StateKicker tone="quiet">uncontained</StateKicker> {wire.uncontained} — the run stays
          resumable, but it keeps spending until you stop it.
        </div>
      )}

      <div className="v-cockpit__body">
        {/* Hi-fi 1's rail, in every frame that shows the whole window. It is
            what `Settings`, `Runs` and the ⌘K switcher hang off, which is why
            the tab bar below is nine tabs and a readout rather than twelve. */}
        <Rail
          dir={repoDir}
          currentId={run.identity?.runId ?? null}
          onNew={() => setComposing(true)}
          onSwitch={() => setSwitching(true)}
          onSettings={() => setTab('settings')}
          onRuns={() => setTab('runs')}
        />

        <div className="v-cockpit__loop">
          {/* `4h`. While there is no run, this column is three not-started
              cycles and a sentence saying what it is waiting for — and what it
              is waiting for is a brief, which is composed next door.

              The launch form used to live here (#211). It has moved into the
              pilot pane, because two forms building the same argv is the third
              spelling that issue warns against, and because the front door
              being a form beside the conversation is the complaint itself.

              Offered again once the command has RETURNED, not once the loop
              said it was done: `serve.ts` runs one at a time and refuses a
              second invoke until the first settles. */}
          {(!launched || run.completed !== null) && !outside && (
            <>
              <div className="v-loop__waiting">
                <StateKicker tone="quiet">waiting for the brief</StateKicker>
                <p>
                  Say what you want in the conversation — that is the front door. There is no
                  start button: when the pilot has enough, it <strong>proposes</strong> the exact
                  command and you press that.
                </p>
              </div>
              {/* `4a`, for the one moment somebody is deciding how THIS run
                  should differ from the project's defaults. */}
              <button
                className="v-launch__more"
                onClick={() => setComposing(true)}
                disabled={busy || !wire.connected}
              >
                or set this run&apos;s overrides…
              </button>
            </>
          )}
          {/* The counts in the column are controls, and this is where they go.
              The same setter the pilot's round cards use, so a severity chip
              means one thing wherever it is drawn. */}
          <LoopColumn run={run} now={now} hostPid={wire.hostPid} onOpen={open} />
          {/* `4g`, and only on the ending that means the loop finished. Every
              other exit is a halt, and a halt gets the footer's banner and its
              one action rather than a summary of work that stopped early. */}
          {run.completed?.exit === 0 && <Summary run={run} />}
          <Footer
            run={run}
            busy={busy}
            onDecide={answer}
            onPause={pause}
            onStop={() => setConfirmStop(true)}
            onResume={resume}
            caps={caps}
            gates={gates}
            order={order}
            pausing={pausing}
          />
        </div>

        <div className="v-cockpit__pane">
          {/*
            Hi-fi 1's bar, in the design's own order. It had twelve tabs against
            the design's seven, and `design/AUDIT.md` traced most of that to the
            missing rail rather than to a decision anybody made: `Settings` is
            the rail's `⚙`, `Runs` is the rail plus ⌘K, and `Spend` is a
            right-aligned readout in this bar rather than a tab of its own.

            `Pilot` is first and is where the window lands, which hi-fi 5 says in
            as many words. `Verify`, `Commands` and `Keys` follow the seven: they
            postdate the artwork, so the design cannot be consulted about where
            they go, and putting them after the frames it does name is the least
            it can be wrong by.
          */}
          <div className="v-cockpit__tabs">
            {/* The pilot (#143, #144), and hi-fi 5's first tab. The count is
                proposals waiting on a person, and it is here because a proposal
                nobody sees blocks the conversation silently. */}
            <button
              className={`v-cockpit__tab ${tab === 'pilot' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => setTab('pilot')}
            >
              Pilot chat{proposals > 0 ? ` · ${String(proposals)}` : ''}
            </button>
            <button
              className={`v-cockpit__tab ${tab === 'output' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => setTab('output')}
            >
              Output
            </button>
            {/* Hi-fi 3, and it is built now (#223). The tooltip on the tab it
                replaces said *"this window cannot read a run's artifacts"*,
                which was true until the `artifacts` frame landed - a version
                history of an artifact needs the artifacts, and #207 was right
                that reading one is its own decision with #129's link refusal
                attached to it. Both are now on the core side, where they belong. */}
            <button
              className={`v-cockpit__tab ${tab === 'plans' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => open('plans')}
            >
              Plans
            </button>
            {/* The four artifact tabs are in `CycleKind`'s order — plan,
                critique, code, review — which is the loop's own and is the
                order the column beside them draws. Hi-fi 1 names four positions
                here (`Versions · Diff · Findings`) and this build has six, so
                something had to decide the interleaving; making the bar read in
                the same order as the column is a rule, where "keep Diff where
                the artwork put it" would be a coincidence to maintain.

                The count on `Code review` is blocking findings in the LATEST
                round, not all of them: that is the number that decides whether
                the loop fixes again, and a total would move for reasons that
                change nothing. */}
            <button
              className={`v-cockpit__tab ${tab === 'critique' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => open('critique')}
            >
              Plan critique
              {blockingIn(run, 'plan') > 0 ? ` · ${String(blockingIn(run, 'plan'))}` : ''}
            </button>
            {/* `1d`, per round. The whole-run diff is this pane's first section
                and is still what it opens on before any round has committed. */}
            <button
              className={`v-cockpit__tab ${tab === 'code' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => open('code')}
            >
              Code{run.commits.length > 0 ? ` · ${String(run.commits.length)}` : ''}
            </button>
            <button
              className={`v-cockpit__tab ${tab === 'review' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => open('review')}
            >
              Code review
              {blockingIn(run, 'review') > 0 ? ` · ${String(blockingIn(run, 'review'))}` : ''}
            </button>
            {/* `1f`. The count is blocking questions, not all of them: an
                advisory question the answerer handled needs nobody, and a
                badge that included it would train you to ignore the badge. */}
            <button
              className={`v-cockpit__tab ${tab === 'questions' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => open('questions')}
            >
              Questions
              {run.questions !== null && run.questions.blocking > 0
                ? ` · ${String(run.questions.blocking)}`
                : ''}
            </button>
            {/* `5d`. The count is verification passes, not gates: the pane's
                subject is the decision in front of you and its trend, and a
                gate count would move for a reason nobody cares about. */}
            <button
              className={`v-cockpit__tab ${tab === 'verify' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => setTab('verify')}
            >
              Verify{run.verify.length > 0 ? ` · ${String(run.verify.length)}` : ''}
            </button>
            {/* The count is what is still RUNNING, not how many have been run
                (#211). A dev server left up is the fact worth a badge - it is
                holding a port and it will not stop by itself - and a total that
                only grew would be the tray-badge failure `4e` names. */}
            <button
              className={`v-cockpit__tab ${tab === 'commands' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => setTab('commands')}
            >
              Commands
              {running(commands).length > 0 ? ` · ${String(running(commands).length)}` : ''}
            </button>
            {/* The pilot's credentials. Postdates the artwork (#143), so it
                takes a place after the frames the design names. */}
            <button
              className={`v-cockpit__tab ${tab === 'keys' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => setTab('keys')}
            >
              Keys
            </button>
            {/* Named rather than omitted. The issue that would fill it is in the
                source and not in the tooltip: an end user cannot act on a
                number, and "not built yet" is the whole of what this says. */}
            <span className="v-cockpit__tab v-cockpit__tab--off" title="Not built yet">
              Prompt
            </span>

            {/*
              `5e`, in the place hi-fi 1 puts it: right-aligned in this bar,
              always visible, rather than costing a tab. It is the **readout**
              the design draws and it is also the way in — the pane behind it is
              the per-phase breakdown, and losing that to match a frame would be
              deleting a screen to fix a bar.

              Absent rather than `0 tok` before anything is charged. A run that
              has spent nothing yet has not spent zero; it has not been measured.
            */}
            <button
              className={`v-cockpit__readout ${tab === 'spend' ? 'v-cockpit__readout--on' : ''}`}
              onClick={() => setTab('spend')}
              title="what this run has spent"
            >
              {run.spend.tokens === null
                ? 'spend · nothing charged yet'
                : `${fmtTokens(run.spend.tokens)} tok${
                    run.spend.codexTokens === null
                      ? ''
                      : ` · codex ${fmtTokens(run.spend.codexTokens)}`
                  }`}
            </button>
          </div>
          {tab === 'output' && (
            <OutputPane lines={run.output} turn={run.running} staleness={staleness(run, now)} />
          )}
          {tab === 'verify' && <VerifyPane passes={run.verify} />}
          {tab === 'spend' && <SpendPane run={run} />}
          {tab === 'questions' && (
            <QuestionsPane
              questions={run.questions}
              dir={repoDir}
              runId={run.identity?.runId ?? null}
            />
          )}
          {tab === 'settings' && <Settings dir={repoDir} />}
          {/* The four artifact panes. Every one of them reads the run's own
              directory, so all four take the run id the core stated on
              `run_started` - there is no way to derive one, and a pane with no
              run says so rather than showing an empty list. */}
          {tab === 'plans' && (
            <PlansPane dir={repoDir} runId={run.identity?.runId ?? null} openAt={openAt} />
          )}
          {tab === 'critique' && (
            <ReportPane
              dir={repoDir}
              runId={run.identity?.runId ?? null}
              kind="critique"
              rounds={cards}
              openAt={openAt}
            />
          )}
          {tab === 'review' && (
            <ReportPane
              dir={repoDir}
              runId={run.identity?.runId ?? null}
              kind="review"
              rounds={cards}
              openAt={openAt}
            />
          )}
          {tab === 'code' && <CodePane run={run} dir={repoDir} openAt={openAt} />}
          {tab === 'commands' && (
            <CommandsPane
              commands={commands}
              dir={repoDir}
              onRun={runCommand}
              onStop={stopCommand}
            />
          )}
          {tab === 'runs' && (
            <Workstreams
              dir={repoDir}
              onResume={(runId, force) => resume(runId, repoDir, undefined, force)}
            />
          )}
          {/* Mounted whatever tab is showing, and hidden rather than unmounted.
              A conversation is state nobody can get back, and a proposal waiting
              on a person would be destroyed by a glance at the output pane -
              which is the one thing this tab must not do. The other two panes
              hold nothing, so they stay conditional. */}
          <div className="v-cockpit__hidden" hidden={tab !== 'pilot'}>
            <PilotPane
              run={run}
              launched={sentLaunch}
              dir={repoDir}
              commands={commands}
              onEffect={onEffect}
              onPending={setProposals}
              statuses={keyStatuses}
              // Hi-fi 5's `open verify`. A round card is the round's summary
              // and the pane beside it holds the detail, so the card links to
              // it rather than growing a second copy of that screen - and it
              // names its own round, so the pane opens at the card you clicked
              // rather than at whichever round happens to be newest (#223).
              onOpen={open}
              // The repository, whenever there is no run to watch. Once one is
              // going the pane is a conversation *about* it, and the field is
              // settled — the run is already using that directory, and changing
              // it underneath would point the pilot at a repository the run is
              // not in.
              kickoff={
                (!launched || run.completed !== null) && !outside ? (
                  <Kickoff dir={repoDir} onDir={rememberRepo} busy={busy || !wire.connected} />
                ) : undefined
              }
            />
          </div>
          {tab === 'keys' && (
            <Credentials statuses={keyStatuses} failure={keyFailure} onChanged={refreshKeys} />
          )}
          {wire.unknown.length > 0 && (
            <div className="v-cockpit__unknown">
              {wire.unknown.length} unrecognised frame(s): {wire.unknown[wire.unknown.length - 1]}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
