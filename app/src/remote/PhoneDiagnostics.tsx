import { Diagnostics, Fact } from '../cockpit/Diagnostics';
import { PANE } from '../cockpit/pane';
import { EXPECTED_PROTOCOL, type Status } from '../host';
import { connectionOf } from './pairing';
import type { RemoteStatus } from './remote';
import { usePhoneIdentity } from './PhoneSettings';

/**
 * The phone's diagnostics (#347): the desktop popover's facts as a screen of
 * their own, because a popover is wider than a phone, plus the one fact only a
 * phone has - how it reaches the desktop.
 *
 * **The connection is the desktop's measurement**, read off `remote_status`
 * through the bridge and matched by this phone's id. The phone's own end is
 * not measured in this build, so the line says whose reading it is, and a
 * relayed connection is drawn as a path rather than as an error, as the
 * product spec asks.
 *
 * Everything below it is the desktop's: the same `Diagnostics` body the
 * popover holds, so the two cannot disagree about what a fact means.
 */
export function PhoneDiagnostics({
  status,
  remote,
  identity,
}: {
  status: Status | null;
  /** The desktop's remote access, read through the bridge, or null. */
  remote: RemoteStatus | null;
  /** The run on screen's identity, or null. */
  identity: { runId: string; dir: string } | null;
}) {
  const phone = usePhoneIdentity();
  const id = phone !== null && 'id' in phone ? phone.id : null;
  const link = connectionOf(remote, id);

  return (
    <div className={`${PANE} gap-6 px-4`}>
      <h2 className="m-0 text-title font-semibold tracking-tight text-display">Diagnostics</h2>

      <section>
        <div className="mb-1 text-chip font-bold uppercase tracking-wide text-tertiary">This phone</div>
        <Fact label="link" value={link.value} note={phone === null ? 'reading this phone’s id…' : link.note} />
      </section>

      <section>
        <Diagnostics status={status} expected={EXPECTED_PROTOCOL} identity={identity} title="The desktop" />
      </section>
    </div>
  );
}
