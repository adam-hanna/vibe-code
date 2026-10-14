import { useEffect, useState } from 'react';
import { inShell } from '../host';
import * as remote from './remote';

/**
 * `remote_status`, read once listening and again on every
 * `remote://connections` (#344). **A push, never a timer**: the connected-phone
 * chip and the diagnostics change only when Rust says a phone came or went.
 * `followStatus` subscribes before it reads and draws only the newest read.
 * Null outside the app, and when the read itself failed.
 */
export function useRemoteStatus(): remote.RemoteStatus | null {
  const [status, setStatus] = useState<remote.RemoteStatus | null>(null);
  useEffect(() => {
    if (!inShell()) return;
    const follower = remote.followStatus(setStatus, [remote.onConnections]);
    return () => follower.stop();
  }, []);
  return status;
}
