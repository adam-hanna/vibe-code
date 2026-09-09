import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { LivenessDot, MetaChip, StateKicker } from '../design';
import * as host from '../host';
import { Credentials } from '../pilot/Credentials';
import * as keys from '../pilot/keys';
import type { KeyStatus } from '../pilot/keys';
// `PilotPane`, not `Pilot`: `pilot.ts` beside it is the wire, and two files
// differing only in case is a compile error on Windows and macOS both.
import { PilotPane } from '../pilot/PilotPane';
import { Diagnostics } from './Diagnostics';
import { DiffPane } from './DiffPane';
import { FindingsPane } from './FindingsPane';
import { Footer } from './Footer';
import { Kickoff } from './Kickoff';
import { LoopColumn } from './LoopColumn';
import { NewWorkstream } from './NewWorkstream';
import { OutputPane } from './OutputPane';
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
import { blocking, emptyRun, nextRun, reduce, staleness } from './model';
import { readLaunchArgv, resumeArgv } from './argv';
import type { Launched, Raise } from './argv';
import type { Caps } from './Footer';
import type { Effect } from '../pilot/tools';
import type { Frame } from '../host';
import type { Run } from './model';

/**
 * The cockpit, at the slice #159 scopes it to.
 *
 * Three of `3a`'s four regions - loop column, output pane, footer - plus the
 * pilot, which since #211 is where you land and where a run is started from.
 *
 * ## The left rail is absent, and the reason has changed
 *
 * It used to be *"projects and workstreams need the archive reader (#114)"*, and
 * that stopped being true when the `archive` frame landed: the rail's data is
 * readable now.
 *
 * The reason it is still absent is the second half of that sentence, which is
 * the load-bearing one. **`serve.ts` runs one run at a time**, so there is never
 * more than one live workstream to switch between - and a rail over the
 * *archive* is `1b` in a sidebar. There are already two switchers over that data
 * and the design insisted on both for stated reasons: `1b` is triage, a reading
 * task with sorting and history, and ⌘K answers *"take me to
 * fix-ratelimit-wait"*. A third would be the third spelling #211 warns about, in
 * the region with the least room for it.
 *
 * What the rail uniquely carries in `3a` is the **needs-you dot** and `4e`'s
 * rule that waiting workstreams sort to the top. With one run per process that
 * is a single boolean about the run in front of you, and the footer is where the
 * design already puts it.
 *
 * This becomes worth building the day a host drives more than one run. Nothing
 * here should be read as it being hard.
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
    | 'verify'
    | 'findings'
    | 'spend'
    | 'questions'
    | 'runs'
    | 'settings'
    | 'diff'
    // **The pilot, not the output pane** (#211). The complaint was exact: *"I
    // thought my initial prompt would be given to the pilot and the pilot would
    // take control"*, and the app answered it with a form and a tab beside the
    // log. The composer is the front door, so this is where you land — and the
    // output pane has nothing in it before a run anyway.
  >('pilot');
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
   * Fire a proposal the user accepted.
   *
   * Nothing here decides anything: the effect was built by `tools.ts` from what
   * the model asked for, and a person pressed a button. This is the routing, and
   * it routes to the same two functions the buttons call.
   */
  const onEffect = useCallback(
    (effect: Effect) => {
      if (effect.kind === 'invoke') launch(effect.argv);
      else answer(effect.askId, effect.decision);
    },
    [launch, answer],
  );

  const outside = !host.inShell();

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
      <StalenessStrip state={staleness(run, now)} />

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
          <LoopColumn run={run} now={now} hostPid={wire.hostPid} />
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
            pausing={pausing}
          />
        </div>

        <div className="v-cockpit__pane">
          <div className="v-cockpit__tabs">
            <button
              className={`v-cockpit__tab ${tab === 'output' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => setTab('output')}
            >
              Output
            </button>
            {/* The pilot (#143, #144). It reads this run and proposes; the
                count is proposals waiting on a person, and it is here because a
                proposal nobody sees blocks the conversation silently. */}
            <button
              className={`v-cockpit__tab ${tab === 'pilot' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => setTab('pilot')}
            >
              Pilot{proposals > 0 ? ` · ${String(proposals)}` : ''}
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
            {/* The pilot's credentials, until Settings exists to put them in. */}
            <button
              className={`v-cockpit__tab ${tab === 'keys' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => setTab('keys')}
            >
              Keys
            </button>
            {/* `1e`. The count is blocking findings in the latest round, not
                all of them: that is the number that decides whether the loop
                fixes again, and a total would move for reasons that change
                nothing. */}
            <button
              className={`v-cockpit__tab ${tab === 'findings' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => setTab('findings')}
            >
              Findings{blocking(run) > 0 ? ` · ${String(blocking(run))}` : ''}
            </button>
            {/* `1b`. No count: the number of runs an archive holds is not
                something to act on, and a badge that grew for ever would be
                the tray-badge failure `4e` names - one that includes work
                needing nobody trains you to ignore it. */}
            <button
              className={`v-cockpit__tab ${tab === 'runs' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => setTab('runs')}
            >
              Runs
            </button>
            {/* `1f`. The count is blocking questions, not all of them: an
                advisory question the answerer handled needs nobody, and a
                badge that included it would train you to ignore the badge. */}
            <button
              className={`v-cockpit__tab ${tab === 'questions' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => setTab('questions')}
            >
              Questions
              {run.questions !== null && run.questions.blocking > 0
                ? ` · ${String(run.questions.blocking)}`
                : ''}
            </button>
            {/* `5e`. No count: a token total in a tab label is a number you
                cannot act on, and the design puts consumption in the tab BAR
                rather than on the tab - which is a different element this
                slice does not have. */}
            <button
              className={`v-cockpit__tab ${tab === 'spend' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => setTab('spend')}
            >
              Spend
            </button>
            {/* `1h`, and #140's payoff: the gate matrix has been configuration
                since it landed and there has been no way to configure it. */}
            <button
              className={`v-cockpit__tab ${tab === 'settings' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => setTab('settings')}
            >
              Settings
            </button>
            {/* `1d`. Enabled only once the run has a base to diff against: a
                diff with no base is the request that stages the whole working
                tree, so there is nothing to offer before then. */}
            <button
              className={`v-cockpit__tab ${tab === 'diff' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => setTab('diff')}
            >
              Diff
            </button>
            {/* Named rather than omitted, with the issue that would fill it. A
                tab bar that showed only what works reads as a finished app. */}
            <span className="v-cockpit__tab v-cockpit__tab--off" title="#137 — v1.5">
              Prompt
            </span>
          </div>
          {tab === 'output' && <OutputPane lines={run.output} />}
          {tab === 'verify' && <VerifyPane passes={run.verify} />}
          {tab === 'findings' && <FindingsPane censuses={run.censuses} />}
          {tab === 'spend' && <SpendPane run={run} />}
          {tab === 'questions' && <QuestionsPane questions={run.questions} />}
          {tab === 'settings' && <Settings dir={repoDir} />}
          {tab === 'diff' && <DiffPane dir={repoDir} baseSha={run.baseSha} />}
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
              onEffect={onEffect}
              onPending={setProposals}
              statuses={keyStatuses}
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
