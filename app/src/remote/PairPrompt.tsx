import { useEffect, useReducer, useState } from 'react';
import { Modal } from '../design';
import { Button } from '@/ui/button';
import { inShell } from '../host';
import { NO_PROMPT, promptClosesIn, promptStep } from './pairing';
import * as remote from './remote';

/**
 * *Allow `<phoneName>`?* (#341), on whatever screen is open when a phone asks.
 *
 * Mounted once in the cockpit, so the question reaches somebody who is not
 * looking at Settings. It draws only on `remote://pair-request`, which nothing
 * sends until the endpoint exists (#342) - so with remote access off it is
 * never on screen.
 *
 * **Escape declines and a click outside does nothing**, which is `Modal`'s own
 * contract: a yes here admits a device to everything the window can do, so the
 * only answer a stray key may give is no.
 */
export function PairPrompt({ onFailed }: { onFailed: (why: string) => void }) {
  const [state, step] = useReducer(promptStep, NO_PROMPT);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!inShell()) return;
    const stops = [
      remote.onPairRequest((request) => step({ kind: 'request', request })),
      remote.onPairEnded(() => step({ kind: 'ended' })),
    ];
    return () => {
      for (const stop of stops) void stop.then((f) => f());
    };
  }, []);

  // No timer in Rust: the window closes the prompt when its clock reaches the
  // expiry the request carried.
  const expiresAt = state.kind === 'asking' ? state.request.expiresAt : null;
  useEffect(() => {
    if (expiresAt === null) return;
    const timer = setTimeout(
      () => step({ kind: 'tick', now: Date.now() }),
      Math.max(0, promptClosesIn(expiresAt, Date.now())),
    );
    return () => clearTimeout(timer);
  }, [expiresAt]);

  if (state.kind !== 'asking') return null;

  const answer = (yes: boolean) => {
    setBusy(true);
    remote
      .pairAnswer(yes)
      .catch((why: unknown) => onFailed(String(why)))
      .finally(() => {
        setBusy(false);
        // `pair-ended` closes it too; this covers an answer that reached Rust
        // after the window had already stopped listening.
        step({ kind: 'close' });
      });
  };

  return (
    <Modal width={440} onDismiss={() => answer(false)} label="Allow this phone?">
      <h2 className="m-0 mb-4 text-title font-semibold tracking-tight text-display [overflow-wrap:anywhere]">
        Allow {state.request.phoneName}?
      </h2>
      <p className="m-0 mb-2 font-mono text-title font-semibold tracking-[0.3em] text-emphasis" aria-label="matching code">
        {state.request.code}
      </p>
      <p className="mt-0 mb-5 text-body text-primary">Press allow only if your phone shows this number.</p>
      <div className="flex gap-3">
        <Button variant="secondary" disabled={busy} onClick={() => answer(true)}>
          Allow
        </Button>
        <Button variant="primary" className="ml-auto" disabled={busy} onClick={() => answer(false)}>
          Decline
        </Button>
      </div>
    </Modal>
  );
}
