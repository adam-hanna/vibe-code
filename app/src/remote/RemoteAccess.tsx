import { useCallback, useEffect, useState } from 'react';
import { Modal } from '../design';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { inShell } from '../host';
import { Confirm } from '../cockpit/Confirm';
import { clock, phoneRows, qrRects, remoteVisible } from './pairing';
import type { PhoneRow } from './pairing';
import * as remote from './remote';

/**
 * Remote access, in the settings for all projects (#341).
 *
 * **Hidden until the real switch lands** (#344): everything here, an error
 * included, is behind `remoteVisible`, and `remote_status` never fails, so the
 * gate always has its answer. A release built today shows nothing new.
 */

const NOTE = 'm-0 max-w-[78ch] text-body-sm text-tertiary';
const H = 'm-0 font-bold text-label uppercase tracking-label text-tertiary';
const REFUSED = 'flex items-baseline gap-3 rounded-sm bg-alarm px-3 py-2 text-body-sm text-primary';
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
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    if (!inShell()) return;
    // A rejection leaves the status null, which draws nothing: this is the
    // IPC itself failing, and the command never refuses.
    remote.status().then(setStatus, () => setStatus(null));
  }, []);

  useEffect(() => {
    refresh();
    if (!inShell()) return;
    const stop = remote.onPairEnded(refresh);
    return () => void stop.then((f) => f());
  }, [refresh]);

  if (!remoteVisible(status) || status === null) return null;

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

  const list = phoneRows(status);

  return (
    <section className="flex flex-col gap-2">
      <h3 className={H}>remote access</h3>
      <p className={NOTE}>
        A paired phone can do everything this window can. Pair one by scanning a code from its app;
        revoke it here to remove it at once.
      </p>

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

      {code !== null && <PairCode code={code} onClose={() => setCode(null)} />}

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
