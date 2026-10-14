import { useEffect, useState } from 'react';
import { inShell } from '../host';
import * as remote from './remote';

/**
 * `remote_status`, read once on mount and again on every
 * `remote://connections` (#344). **A push, never a timer**: the connected-phone
 * chip and the diagnostics change only when Rust says a phone came or went.
 * Null outside the app, and when the read itself failed.
 */
export function useRemoteStatus(): remote.RemoteStatus | null {
  const [status, setStatus] = useState<remote.RemoteStatus | null>(null);
  useEffect(() => {
    if (!inShell()) return;
    let live = true;
    const read = () =>
      remote.status().then(
        (s) => live && setStatus(s),
        () => live && setStatus(null),
      );
    void read();
    const stop = remote.onConnections(() => void read());
    return () => {
      live = false;
      void stop.then((f) => f());
    };
  }, []);
  return status;
}
