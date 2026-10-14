import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '../design';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { inShell } from '../host';
import { Confirm } from '../cockpit/Confirm';
import { clock, loginSentence, offNeedsConfirm, phoneRows, qrRects } from './pairing';
import type { PhoneRow } from './pairing';
import * as remote from './remote';

/**
 * Remote access, in the settings for all projects (#341, #344).
 *
 * **Always drawn.** With remote access off it is the switch, its sentence and
 * keep awake, and nothing that pairs; the rest arrives with the switch. Every
 * change goes through `remote_set`, which writes `remote.json` - Rust's file,
 * not vibe's config - applies it, and answers with the status that follows,
 * so this draws from one source.
 */

const NOTE = 'm-0 max-w-[78ch] text-body-sm text-tertiary';
const H = 'm-0 font-bold text-label uppercase tracking-label text-tertiary';
const REFUSED = 'flex items-baseline gap-3 rounded-sm bg-alarm px-3 py-2 text-body-sm text-primary';
const CHECK = 'flex cursor-pointer items-baseline gap-2 text-body-sm text-secondary';
const TEXT =
  'w-full max-w-[52ch] rounded-sm border border-rule-control bg-card p-2 font-mono text-mono-sm text-primary outline-none focus-visible:ring-1 focus-visible:ring-accent-border disabled:border-dashed disabled:text-tertiary';
const TABLE =
  'border-collapse text-body-sm text-secondary [&_th]:border-b [&_th]:border-rule-inner [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-label [&_th]:uppercase [&_th]:tracking-label [&_th]:text-tertiary [&_td]:border-b [&_td]:border-rule-inner [&_td]:px-3 [&_td]:py-2';

export function RemoteAccess({
  problem,
  onProblemSeen,
}: {
  /** A pairing that was allowed and could not be saved, in Rust's words. */
  problem: string | null;
  onProblemSeen: () => void;
}) {
  const [status, setStatus] = useState<remote.RemoteStatus | null>(null);
  const [code, setCode] = useState<remote.PairBegin | null>(null);
  const [beginFailure, setBeginFailure] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<PhoneRow | null>(null);
  const [revokeFailure, setRevokeFailure] = useState<string | null>(null);
  const [setFailure, setSetFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Start at login is offered once, right after the switch is turned on. */
  const [offerLogin, setOfferLogin] = useState(false);
  /** Turning off while phones are connected, waiting for a yes. */
  const [confirmOff, setConfirmOff] = useState<string[] | null>(null);
  const [relay, setRelay] = useState('');

  // One follower for every read and every change's answer, so only the
  // newest is drawn. A null status draws nothing: the IPC itself failed.
  const follower = useRef<remote.Follower | null>(null);
  const refresh = useCallback(() => follower.current?.refresh(), []);

  useEffect(() => {
    if (!inShell()) return;
    const f = remote.followStatus(setStatus, [(h) => remote.onPairEnded(h), remote.onConnections]);
    follower.current = f;
    return () => {
      f.stop();
      follower.current = null;
    };
  }, []);

  // The field shows what is in force whenever that changes.
  const inForce = status?.settings.relay ?? '';
  useEffect(() => setRelay(inForce), [inForce]);

  if (status === null) return null;

  /** One change, answered with the status that follows - or Rust's refusal. */
  const apply = (patch: remote.RemotePatch): Promise<remote.RemoteStatus | null> => {
    setBusy(true);
    setSetFailure(null);
    return remote
      .set(patch)
      .then(
        (next) => {
          follower.current?.accept(next);
          return next;
        },
        (why: unknown) => {
          setSetFailure(String(why));
          refresh();
          return null;
        },
      )
      .finally(() => setBusy(false));
  };

  const turn = (on: boolean) => {
    if (on) {
      void apply({ enabled: true }).then((next) => {
        if (next !== null && next.startAtLogin.enabled !== true) setOfferLogin(true);
      });
      return;
    }
    const dropping = offNeedsConfirm(status);
    if (dropping.length > 0) {
      setConfirmOff(dropping);
      return;
    }
    setOfferLogin(false);
    void apply({ enabled: false });
  };

  const begin = () => {
    setBusy(true);
    setBeginFailure(null);
    remote
      .pairBegin()
      .then(setCode, (why: unknown) => setBeginFailure(String(why)))
      .finally(() => {
        setBusy(false);
        refresh();
      });
  };

  const confirmRevoke = (row: PhoneRow) => {
    setBusy(true);
    setRevokeFailure(null);
    remote
      .revoke(row.id)
      .then(
        () => setRevoking(null),
        (why: unknown) => setRevokeFailure(String(why)),
      )
      .finally(() => {
        setBusy(false);
        refresh();
      });
  };

  const on = status.settings.enabled;
  const list = phoneRows(status);
  // What the OS says, never the file: null is a system that could not say,
  // drawn unticked and not pressable, with the sentence beside it.
  const login = status.startAtLogin.enabled;
  const loginNote = loginSentence(status);
  const relayChanged = relay.trim() !== inForce;

  return (
    <section className="flex flex-col gap-2">
      <h3 className={H}>remote access</h3>

      {status.settingsUnreadable !== null && (
        <p className={REFUSED} role="alert">
          <Badge variant="alarm">off</Badge>
          <span>{status.settingsUnreadable}</span>
        </p>
      )}

      <label className={CHECK}>
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => turn(e.target.checked)} />
        <span>Let paired phones reach this desktop</span>
      </label>
      <p className={NOTE}>
        {on
          ? 'A paired phone can do everything this window can, from anywhere. Revoke a phone below to remove it at once; turning this off drops every phone.'
          : 'Off: nothing on this desktop listens for a phone, nothing reaches a relay and nothing is published. Turn it on to pair a phone.'}
      </p>

      {setFailure !== null && (
        <p className={REFUSED} role="alert">
          <Badge variant="alarm">not changed</Badge> {setFailure}
        </p>
      )}

      {on && offerLogin && login !== true && (
        <div className="flex items-center gap-3 rounded-sm bg-active px-3 py-2 text-body-sm text-secondary">
          <span>Start Vibe at login too, so a phone can reach this desktop after it restarts?</span>
          <Button
            variant="secondary"
            size="sm"
            className="ml-auto"
            disabled={busy}
            onClick={() => void apply({ startAtLogin: true }).then(() => setOfferLogin(false))}
          >
            Start at login
          </Button>
          <Button variant="quiet" size="sm" disabled={busy} onClick={() => setOfferLogin(false)}>
            Not now
          </Button>
        </div>
      )}

      {on && !(offerLogin && login !== true) && (
        <>
          <label className={CHECK}>
            <input
              type="checkbox"
              checked={login === true}
              disabled={busy || login === null}
              onChange={(e) => {
                setOfferLogin(false);
                void apply({ startAtLogin: e.target.checked });
              }}
            />
            <span>Start Vibe at login, to the tray</span>
          </label>
          {loginNote !== null && <p className={NOTE}>{loginNote}</p>}
        </>
      )}

      <label className={CHECK}>
        <input
          type="checkbox"
          checked={status.settings.keepAwake}
          disabled={busy}
          onChange={(e) => void apply({ keepAwake: e.target.checked })}
        />
        <span>Keep this machine awake while a run is going</span>
      </label>
      <p className={NOTE}>
        Applies to every run, whether or not a phone is connected. It stops the machine sleeping, on
        its own or when idle; the screen may still turn off.
      </p>
      {status.awake.error !== null && (
        <p className={REFUSED} role="alert">
          <Badge variant="alarm">awake</Badge> The machine could not be kept awake: {status.awake.error}
        </p>
      )}

      {!on ? null : (
        <>
          <div className="mt-2 flex flex-col gap-1">
            <span className="text-label uppercase tracking-label text-tertiary">relay</span>
            <div className="flex items-center gap-2">
              <input
                aria-label="relay"
                className={TEXT}
                value={relay}
                placeholder="n0's public relays"
                spellCheck={false}
                disabled={busy}
                onChange={(e) => setRelay(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && relayChanged) void apply({ relay: relay.trim() === '' ? null : relay.trim() });
                  if (e.key === 'Escape') setRelay(inForce);
                }}
              />
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || !relayChanged}
                onClick={() => void apply({ relay: relay.trim() === '' ? null : relay.trim() })}
              >
                Save
              </Button>
            </div>
            <p className={NOTE}>
              An https URL naming a relay of your own replaces n0&apos;s, and phones find it with no
              change on their side. Empty uses n0&apos;s.
            </p>
          </div>

          {problem !== null && (
            <p className={REFUSED} role="alert">
              <Badge variant="alarm">not paired</Badge>
              <span>This phone was not paired: {problem}</span>
              <Button variant="quiet" size="sm" className="ml-auto" onClick={onProblemSeen}>
                Dismiss
              </Button>
            </p>
          )}

          <div className="grid grid-cols-[9rem_1fr] gap-3 py-2 text-body-sm text-secondary">
            <span className="text-label uppercase tracking-label text-tertiary">this desktop</span>
            {status.endpointId !== null ? (
              <code className="font-mono text-mono-sm text-primary [overflow-wrap:anywhere]">{status.endpointId}</code>
            ) : status.identityUnreadable !== null ? (
              <span>The keychain could not be read, so this desktop&apos;s id is not known: {status.identityUnreadable}</span>
            ) : (
              <span>No device key yet. One is made the first time a phone is paired.</span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Button variant="secondary" disabled={busy} onClick={begin}>
              Pair a phone
            </Button>
          </div>
          {beginFailure !== null && (
            <p className={REFUSED} role="alert">
              <Badge variant="alarm">refused</Badge> {beginFailure}
            </p>
          )}

          <h3 className={`${H} mt-3`}>paired phones</h3>
          {'unreadable' in list ? (
            <p className={REFUSED} role="alert">
              <Badge variant="alarm">unreadable</Badge> {list.unreadable}
            </p>
          ) : list.rows.length === 0 ? (
            <p className={NOTE}>No phones are paired.</p>
          ) : (
            <table className={TABLE}>
              <thead>
                <tr>
                  <th>name</th>
                  <th>paired</th>
                  <th>last connected</th>
                  <th>now</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.rows.map((row) => (
                  <tr key={row.id}>
                    <td className="text-primary">{row.name}</td>
                    <td>{row.pairedAt}</td>
                    <td>{row.lastConnected}</td>
                    <td>{row.connected}</td>
                    <td>
                      <Button
                        variant="loss"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setRevokeFailure(null);
                          setRevoking(row);
                        }}
                      >
                        Revoke
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {code !== null && <PairCode code={code} onClose={() => setCode(null)} />}

      {confirmOff !== null && (
        <Confirm
          kicker="remote access"
          title="Turn remote access off?"
          lead="Every connected phone is dropped at once, and none can reach this desktop until it is turned on again here. Paired phones stay paired."
          facts={confirmOff.map((name) => ({ label: 'drops', value: name }))}
          confirm="Turn off"
          busy={busy}
          problem={setFailure}
          onConfirm={() => {
            setOfferLogin(false);
            void apply({ enabled: false }).then((next) => {
              if (next !== null) setConfirmOff(null);
            });
          }}
          onCancel={() => setConfirmOff(null)}
        />
      )}

      {revoking !== null && (
        <Confirm
          kicker="revoke"
          title={`Revoke ${revoking.name}?`}
          lead="This phone is removed from the list and can no longer reach this desktop. If it is connected now, it is dropped at once. Pairing it again needs a new code."
          facts={[
            { label: 'phone', value: revoking.name },
            { label: 'id', value: revoking.id, mono: true },
          ]}
          confirm="Revoke"
          busy={busy}
          problem={revokeFailure}
          onConfirm={() => confirmRevoke(revoking)}
          onCancel={() => setRevoking(null)}
        />
      )}
    </section>
  );
}

/**
 * The code a phone scans. Drawn from Rust's matrix as SVG, in token colours:
 * a light ground and dark modules, which is what a camera reads.
 */
function PairCode({ code, onClose }: { code: remote.PairBegin; onClose: () => void }) {
  const { size, cells } = qrRects(code.qr);
  return (
    <Modal width={420} onDismiss={onClose} label="Pair a phone">
      <h2 className="m-0 mb-4 text-title font-semibold tracking-tight text-display">Pair a phone</h2>
      <svg
        viewBox={`0 0 ${String(size)} ${String(size)}`}
        className="mx-auto block w-full max-w-72"
        shapeRendering="crispEdges"
        role="img"
        aria-label="pairing code"
      >
        <rect width={size} height={size} className="fill-(--text-display)" />
        {cells.map(({ x, y }) => (
          <rect key={`${String(x)}:${String(y)}`} x={x} y={y} width={1} height={1} className="fill-(--surface-page)" />
        ))}
      </svg>
      <p className="mt-4 mb-1 text-body text-primary">Scan this with the phone&apos;s app.</p>
      <p className="m-0 text-body-sm text-secondary">
        Expires at {clock(code.expiresAt)}. Works once.
      </p>
      <div className="mt-5 flex">
        <Button variant="primary" className="ml-auto" onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}
