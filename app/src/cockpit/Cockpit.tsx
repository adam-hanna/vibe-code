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
import { FindingsPane } from './FindingsPane';
import { Footer } from './Footer';
import { Launch } from './Launch';
import { LoopColumn } from './LoopColumn';
import { OutputPane } from './OutputPane';
import { StopConfirm } from './StopConfirm';
import { VerifyPane } from './VerifyPane';
import { blocking, emptyRun, nextRun, reduce } from './model';
import { readLaunchArgv } from './argv';
import type { Launched } from './argv';
import type { Effect } from '../pilot/tools';
import type { Frame } from '../host';
import type { Run } from './model';

/**
 * The cockpit, at the slice #159 scopes it to.
 *
 * Three of `3a`'s four regions - loop column, output pane, footer - plus the
 * minimum launch input needed to have anything to watch. **The left rail is
 * absent** because projects and workstreams need the archive reader (#114), and
 * `serve.ts` allows one run at a time anyway.
 *
 * Everything on screen comes from a frame. There is no state here that was
 * inferred: `reduce` is the only thing that decides what the run looks like, and
 * it decides it from ids.
 */

/** How often the elapsed clock re-renders between heartbeats. */
const TICK_MS = 1000;

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
  const [tab, setTab] = useState<'output' | 'pilot' | 'keys' | 'verify' | 'findings'>('output');
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
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'KeyD') {
        event.preventDefault();
        setDiagnostics((open) => !open);
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

      {diagnostics && (
        <Diagnostics
          status={wire.status}
          expected={host.EXPECTED_PROTOCOL}
          identity={run.identity}
          onClose={() => setDiagnostics(false)}
        />
      )}

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
          {/* Offered again once the command has RETURNED, not once the loop
              said it was done: `serve.ts` runs one at a time and refuses a
              second invoke until the first settles, so a form shown any earlier
              would only produce a rejection. */}
          {(!launched || run.completed !== null) && !outside && (
            <Launch busy={busy || !wire.connected} onLaunch={launch} />
          )}
          <LoopColumn run={run} now={now} hostPid={wire.hostPid} />
          <Footer
            run={run}
            busy={busy}
            onDecide={answer}
            onPause={pause}
            onStop={() => setConfirmStop(true)}
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
            {/* Named rather than omitted, each with the issue that would fill
                it. A tab bar that showed only what works reads as a finished
                app with three tabs. */}
            <span className="v-cockpit__tab v-cockpit__tab--off" title="#113">
              Diff
            </span>
            <span className="v-cockpit__tab v-cockpit__tab--off" title="#137 — v1.5">
              Prompt
            </span>
          </div>
          {tab === 'output' && <OutputPane lines={run.output} />}
          {tab === 'verify' && <VerifyPane passes={run.verify} />}
          {tab === 'findings' && <FindingsPane censuses={run.censuses} />}
          {/* Mounted whatever tab is showing, and hidden rather than unmounted.
              A conversation is state nobody can get back, and a proposal waiting
              on a person would be destroyed by a glance at the output pane -
              which is the one thing this tab must not do. The other two panes
              hold nothing, so they stay conditional. */}
          <div className="v-cockpit__hidden" hidden={tab !== 'pilot'}>
            <PilotPane
              run={run}
              launched={sentLaunch}
              onEffect={onEffect}
              onPending={setProposals}
              statuses={keyStatuses}
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
