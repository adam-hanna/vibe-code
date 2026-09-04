import { useCallback, useEffect, useRef, useState } from 'react';
import { Gallery } from './Gallery';
import { Button, LivenessDot, MetaChip, StateKicker } from './design';
import type { Liveness } from './design';
import * as host from './host';
import type { Frame } from './host';

/**
 * What the window renders until the cockpit exists (#154).
 *
 * The gallery is the content, because it is the thing that either draws
 * correctly or visibly does not - a launch that produced a blank window would
 * tell nobody whether the bundle worked. Above it sits the one strip this issue
 * is actually about: the host process, whether it is running, and what it has
 * said.
 *
 * **This is not the cockpit and must not grow into one.** Every frame is shown
 * as what it is, with no interpretation: no run assembled out of narration, no
 * phase inferred, no card built. That is the next issue, and building half of it
 * here would mean building it twice.
 */

/** The most recent frames, so the strip stays a strip. */
const KEEP = 12;

interface Line {
  n: number;
  kind: 'frame' | 'log' | 'unknown' | 'exit';
  text: string;
}

function describe(frame: Frame): string {
  switch (frame.type) {
    case 'ready':
      return `ready · protocol ${frame.protocol} · pid ${frame.pid}`;
    case 'narration':
      // The id where there is one, because that is the half a host acts on, and
      // the sentence beside it because a human still has to read something.
      return `${frame.id ?? frame.level} · ${frame.message}`;
    case 'ask':
      return `ask ${frame.id} · holding at ${frame.context.boundary}`;
    case 'result':
      return `result ${frame.id} · exit ${frame.exit}`;
    case 'error':
      return `error ${frame.id ?? '—'} · ${frame.message}`;
  }
}

export function Shell() {
  const [running, setRunning] = useState(false);
  const [pid, setPid] = useState<number | null>(null);
  const [protocol, setProtocol] = useState<number | null>(null);
  const [lines, setLines] = useState<readonly Line[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [uncontained, setUncontained] = useState<string | null>(null);
  const counter = useRef(0);

  const push = useCallback((kind: Line['kind'], text: string) => {
    counter.current += 1;
    const line: Line = { n: counter.current, kind, text };
    setLines((prev) => [...prev, line].slice(-KEEP));
  }, []);

  useEffect(() => {
    if (!host.inShell()) return;
    let stop: (() => void) | null = null;
    let cancelled = false;

    void (async () => {
      stop = await host.connect({
        frame: (frame) => {
          if (frame.type === 'ready') {
            setProtocol(frame.protocol);
            setPid(frame.pid);
          }
          push('frame', describe(frame));
        },
        unknown: (raw) => push('unknown', `unrecognised frame: ${JSON.stringify(raw).slice(0, 160)}`),
        log: (text) => push('log', text),
        exit: (code) => {
          // Never hidden. The run is resumable and the user is the one who has
          // to be told that is what happened.
          setRunning(false);
          setPid(null);
          push('exit', code === null ? 'the host was signalled and reported no code' : `the host exited ${code}`);
        },
      });
      if (cancelled) {
        stop();
        return;
      }
      try {
        // The host is already running - Rust started it at launch, because its
        // lifetime is not the window's to own. So this asks what happened rather
        // than making it happen, and picks up the `ready` frame that went past
        // before there was anything here to hear it.
        const status = await host.status();
        setRunning(status.running);
        setPid(status.pid);
        setProtocol(status.ready?.protocol ?? null);
        // Reported in the window rather than swallowed to a console nobody has
        // open. A bundle whose sidecar is missing is exactly the failure the
        // staging step exists to prevent, and it must be visible when it happens.
        setFailure(status.failure);
        setUncontained(status.uncontained);
      } catch (err) {
        setFailure(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [push]);

  const liveness: Liveness = failure !== null ? 'absent' : running ? 'live' : 'quiet';
  const outside = !host.inShell();

  return (
    <>
      <div className="v-hoststrip">
        <div className="v-hoststrip__head">
          <LivenessDot state={outside ? 'absent' : liveness} />
          <span className="v-hoststrip__title">host</span>
          {outside ? (
            <MetaChip>browser · no shell</MetaChip>
          ) : (
            <>
              {/* `checkable` because these are observed, not asserted: the pid
                  came back from the spawn and the version off the wire. */}
              {pid !== null && <MetaChip kind="checkable">pid {pid}</MetaChip>}
              {protocol !== null && (
                // Checked rather than displayed and trusted. A mismatch is a
                // bundle whose two halves were built apart, and saying so beats
                // rendering fields that may not be there.
                <MetaChip kind={protocol === host.EXPECTED_PROTOCOL ? 'checkable' : 'default'}>
                  protocol {protocol}
                  {protocol === host.EXPECTED_PROTOCOL ? '' : ` · expected ${host.EXPECTED_PROTOCOL}`}
                </MetaChip>
              )}
            </>
          )}
          <span className="v-hoststrip__spacer" />
          {/* `doctor` because it is the one command that proves the whole stack
              and spends nothing: it probes both agents for real and returns. */}
          <Button
            level="secondary"
            disabled={outside || !running}
            onClick={() => {
              void host
                .send({ type: 'invoke', id: host.nextRequestId(), argv: ['doctor'] })
                .catch((err: unknown) => push('log', String(err)));
            }}
          >
            run doctor
          </Button>
          {/* Only offered when there is something to retry. A restart button
              beside a running host would be a way to make a second writer. */}
          {!outside && !running && (
            <Button
              level="secondary"
              onClick={() => {
                void host
                  .start()
                  .then((started) => {
                    setPid(started);
                    setRunning(true);
                    setFailure(null);
                  })
                  .catch((err: unknown) => setFailure(String(err)));
              }}
            >
              retry
            </Button>
          )}
        </div>

        {failure !== null && (
          <div className="v-hoststrip__failure">
            <StateKicker tone="alarm">no host</StateKicker> {failure}
          </div>
        )}

        {/* Only when the guarantee is NOT being kept. On Windows this is silent,
            because the kernel is enforcing it and there is nothing to say (#157). */}
        {uncontained !== null && running && (
          <div className="v-hoststrip__failure">
            <StateKicker tone="quiet">uncontained</StateKicker> {uncontained} — the run stays
            resumable, but it keeps spending until you stop it.
          </div>
        )}

        <ol className="v-hoststrip__lines">
          {lines.map((line) => (
            <li key={line.n} className={`v-hoststrip__line v-hoststrip__line--${line.kind}`}>
              {line.text}
            </li>
          ))}
          {lines.length === 0 && (
            <li className="v-hoststrip__line v-hoststrip__line--log">
              {outside ? 'open this in the desktop app to see the wire' : 'nothing said yet'}
            </li>
          )}
        </ol>
      </div>
      <Gallery />
    </>
  );
}
