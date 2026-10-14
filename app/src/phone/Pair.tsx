import { useEffect, useReducer, useRef, useState } from 'react';
import { Format, checkPermissions, requestPermissions, scan } from '@tauri-apps/plugin-barcode-scanner';
import { Button } from '@/ui/button';
import { confirmed } from '../confirm';
import { listen, local } from '../transport';
import * as api from './api';
import type { PhoneSettings } from './boot';
import { lockWarning, pairStep } from './pair';
import type { Outcome } from './pair';
import { sentence } from './sentences';

/**
 * Pairing with a desktop (#346): confirm on this phone, name it, scan the
 * desktop's code, then compare six digits.
 *
 * **The digits arrive while `phone_pair` is still waiting**, on
 * `phone://pair-code`, so the listener goes up before the call is made. They
 * carry this screen's attempt number, and `pairStep` drops a code from any
 * other attempt.
 *
 * This is the only module that imports the barcode scanner: it has no Rust API,
 * so it is the one plugin the window is granted permissions for
 * (`capabilities/scan.json`).
 */

const NOTE = 'm-0 max-w-[40ch] text-body-sm text-tertiary';
const TEXT =
  'w-full rounded-sm border border-rule-control bg-card p-2 text-body-sm text-primary outline-none focus-visible:ring-1 focus-visible:ring-accent-border';

export function Pair({
  settings,
  onDone,
  onBack,
}: {
  settings: PhoneSettings;
  onDone: (id: string) => void;
  onBack: () => void;
}) {
  const [state, dispatch] = useReducer(pairStep, { step: 'confirming' });
  const [name, setName] = useState(settings.name);
  const [problem, setProblem] = useState<string | null>(null);
  const begun = useRef(false);

  useEffect(() => {
    if (state.step !== 'confirming') return;
    void confirmed('Pair a desktop')
      .then(() => dispatch({ type: 'confirmed' }))
      .catch(onBack);
  }, [state.step, onBack]);

  useEffect(() => {
    if (state.step !== 'scanning' || begun.current) return;
    begun.current = true;
    let stop: (() => void) | null = null;
    void (async () => {
      try {
        if ((await checkPermissions()) !== 'granted' && (await requestPermissions()) !== 'granted') {
          throw new Error('Vibe needs the camera to scan the pairing code. Allow it in this phone’s settings.');
        }
        const scanned = await scan({ formats: [Format.QRCode] });
        const attempt = Date.now();
        // Listening before the call: the digits arrive before it returns.
        stop = await listen<{ attempt: number; code: string }>('phone://pair-code', (event) =>
          dispatch({ type: 'code', attempt: event.payload.attempt, code: event.payload.code }),
        );
        dispatch({ type: 'scanned', attempt });
        const outcome = await local<Outcome>('phone_pair', { payload: scanned.content, phoneName: name, attempt });
        dispatch({ type: 'outcome', attempt, outcome });
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err));
        onBack();
      } finally {
        stop?.();
      }
    })();
  }, [state.step, name, onBack]);

  const back = () => {
    if (state.step === 'dialling' || state.step === 'code') {
      void local('phone_pair_cancel');
      dispatch({ type: 'back' });
    } else {
      onBack();
    }
  };

  const desktop = 'the desktop';
  const warning = lockWarning(settings.deviceLock);

  return (
    <main className="flex min-h-full flex-col gap-4 bg-page p-4 text-primary">
      <header className="flex items-center justify-between">
        <h1 className="m-0 text-emphasis font-bold">Pair a desktop</h1>
        <Button variant="quiet" onClick={back}>
          Back
        </Button>
      </header>
      {problem !== null && <p className={NOTE}>{problem}</p>}

      {state.step === 'confirming' && <p className={NOTE}>Confirm on this phone to pair it with a desktop.</p>}

      {state.step === 'naming' && (
        <>
          {warning !== null && <p className="m-0 text-body-sm text-secondary">{warning}</p>}
          <label className="flex flex-col gap-1 text-body-sm text-secondary">
            What should your desktop call this phone?
            <input className={TEXT} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <Button
            variant="primary"
            className="self-start"
            disabled={name.trim() === ''}
            onClick={() =>
              void api
                .setSettings({ name })
                .then(() => dispatch({ type: 'named' }))
                .catch((err: unknown) => setProblem(err instanceof Error ? err.message : String(err)))
            }
          >
            Scan the desktop’s code
          </Button>
        </>
      )}

      {state.step === 'scanning' && <p className={NOTE}>Point the camera at the code in Settings → Remote access on your desktop.</p>}

      {state.step === 'dialling' && <p className={NOTE}>Reaching the desktop…</p>}

      {state.step === 'code' && (
        <>
          <p className="m-0 text-center font-mono text-display tracking-label text-emphasis">{state.digits}</p>
          <p className={NOTE}>Check that the desktop shows the same number, then press Allow there.</p>
        </>
      )}

      {state.step === 'done' && (
        <>
          <p className="m-0 text-body text-primary">Paired with {state.entry.name ?? state.entry.desktopName ?? desktop}.</p>
          <Button variant="primary" className="self-start" onClick={() => onDone(state.entry.id)}>
            Open it
          </Button>
        </>
      )}

      {state.step === 'failed' && <p className="m-0 text-body-sm text-secondary">{sentence(state.reason, desktop, null, Date.now()).text}</p>}

      {state.step === 'cancelled' && (
        <p className={NOTE}>{sentence({ kind: 'pairCancelled' }, desktop, null, Date.now()).text}</p>
      )}
    </main>
  );
}
