import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { LivenessDot, MetaChip, StateKicker } from '../design';
import * as host from '../host';
import { Credentials } from '../pilot/Credentials';
// `PilotPane`, not `Pilot`: `pilot.ts` beside it is the wire, and two files
// differing only in case is a compile error on Windows and macOS both.
import { PilotPane } from '../pilot/PilotPane';
import { Footer } from './Footer';
import { Launch } from './Launch';
import { LoopColumn } from './LoopColumn';
import { OutputPane } from './OutputPane';
import { emptyRun, nextRun, reduce } from './model';
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
    log: [],
    unknown: [],
  });
  const [busy, setBusy] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [tab, setTab] = useState<'output' | 'pilot' | 'keys'>('output');
  /** Pilot proposals waiting on a person, so a hidden tab can say so (#144). */
  const [proposals, setProposals] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const requests = useRef(0);

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
            {wire.hostPid !== null && <MetaChip kind="checkable">host {wire.hostPid}</MetaChip>}
            {run.protocol !== null && (
              <MetaChip kind={run.protocol === host.EXPECTED_PROTOCOL ? 'checkable' : 'default'}>
                protocol {run.protocol}
                {run.protocol === host.EXPECTED_PROTOCOL
                  ? ''
                  : ` · expected ${String(host.EXPECTED_PROTOCOL)}`}
              </MetaChip>
            )}
          </>
        )}
      </header>

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
          <LoopColumn run={run} now={now} />
          <Footer run={run} busy={busy} onDecide={answer} />
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
            {/* The pilot's credentials, until Settings exists to put them in. */}
            <button
              className={`v-cockpit__tab ${tab === 'keys' ? 'v-cockpit__tab--on' : ''}`}
              onClick={() => setTab('keys')}
            >
              Keys
            </button>
            {/* Named rather than omitted, each with the issue that would fill
                it. A tab bar that showed only what works reads as a finished
                app with three tabs. */}
            <span className="v-cockpit__tab v-cockpit__tab--off" title="#141, #113">
              Diff
            </span>
            <span className="v-cockpit__tab v-cockpit__tab--off" title="#142">
              Findings
            </span>
            <span className="v-cockpit__tab v-cockpit__tab--off" title="#137">
              Prompt
            </span>
          </div>
          {tab === 'output' && <OutputPane lines={run.output} />}
          {/* Mounted whatever tab is showing, and hidden rather than unmounted.
              A conversation is state nobody can get back, and a proposal waiting
              on a person would be destroyed by a glance at the output pane -
              which is the one thing this tab must not do. The other two panes
              hold nothing, so they stay conditional. */}
          <div className="v-cockpit__hidden" hidden={tab !== 'pilot'}>
            <PilotPane run={run} onEffect={onEffect} onPending={setProposals} />
          </div>
          {tab === 'keys' && <Credentials />}
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
