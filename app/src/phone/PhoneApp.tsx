import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/ui/button';
import { prepareCockpit } from '../prepare';
import { Cockpit } from '../cockpit/Cockpit';
import { phoneSink, setNoticeSink } from '../cockpit/notices';
import * as host from '../host';
import { listen, local } from '../transport';
import * as api from './api';
import { bootStep } from './boot';
import type { PhoneSettings } from './boot';
import { Desktops } from './Desktops';
import { lockGate, resync } from './link';
import { networkSignals } from './network';
import { Pair } from './Pair';

/**
 * The phone app (#346): the lock, the paired desktops and pairing, in front of
 * the one cockpit.
 *
 * **Nothing is read before the lock.** `phone_settings` is the first call, and
 * while it says the app is locked only the cover is drawn: no list, no dial, no
 * cockpit. The phone's Rust refuses every desktop command while locked anyway,
 * so this is what the person sees rather than what keeps them out.
 *
 * Opening a desktop counts the cockpit's request ids from that connection's
 * range before the cockpit exists, and lets the held events through only once
 * the cockpit is listening (`link.ts`). Leaving a desktop reloads the page, so
 * nothing the cockpit read about one desktop is drawn for the next.
 */

type Screen = 'loading' | 'desktops' | 'pair' | 'cockpit';

const COVER = 'fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-page p-6 text-center';
const NOTE = 'm-0 max-w-[40ch] text-body-sm text-tertiary';

export function PhoneApp() {
  const [settings, setSettings] = useState<PhoneSettings | null>(null);
  const [locked, setLocked] = useState(false);
  const [screen, setScreen] = useState<Screen>('loading');
  const [problem, setProblem] = useState<string | null>(null);
  const started = useRef(false);
  const entering = useRef(false);
  const notifyOn = useRef(true);
  // The phone's Rust refuses the session and the release while locked, so a
  // connection that comes back under the cover waits for the unlock here.
  const gate = useRef(lockGate());
  const link = useRef(
    resync({
      session: () => gate.current.when(api.session),
      startIds: (base) => host.startRequestIds(base),
      release: (generation) => gate.current.when(() => api.release(generation)),
    }),
  );
  const lock = useCallback((next: boolean) => {
    gate.current.set(next);
    setLocked(next);
  }, []);

  /** The open desktop is connected: count from its range, then draw the cockpit. */
  const enter = useCallback(async () => {
    if (entering.current) return;
    entering.current = true;
    try {
      await link.current.prepare();
      host.setLinkHooks({ connected: (g) => link.current.connected(g), listening: () => link.current.listening() });
      setNoticeSink(
        phoneSink({
          hidden: () => document.hidden,
          notifyOn: () => notifyOn.current,
          send: (n) => void api.notify(n.title, n.body).catch(() => undefined),
        }),
      );
      await prepareCockpit();
      setScreen('cockpit');
    } catch (err) {
      entering.current = false;
      setProblem(err instanceof Error ? err.message : String(err));
      setScreen('desktops');
    }
  }, []);

  const open = useCallback(
    async (id: string | null) => {
      const answered = await local<{ generation?: number | null; reason?: unknown }>('phone_open', { id });
      if (typeof answered.generation === 'number') await enter();
      else setScreen('desktops');
    },
    [enter],
  );

  /** Once unlocked: open the desktop last open, if it is still paired. */
  const start = useCallback(async () => {
    if (started.current) return;
    started.current = true;
    try {
      const list = await api.desktops();
      const current = list.current;
      if (current !== null && list.desktops.some((d) => d.id === current)) await open(current);
      else setScreen('desktops');
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
      setScreen('desktops');
    }
  }, [open]);

  useEffect(() => {
    const stopNet = networkSignals((online) => void api.networkChange(online).catch(() => undefined), window);
    const stops: Promise<() => void>[] = [
      listen('phone://locked', () => lock(true)),
      // The open desktop came back after the first open failed: draw it.
      listen('phone://connected', () => {
        if (started.current) void enter();
      }),
    ];
    void (async () => {
      const read = await local<PhoneSettings>('phone_settings');
      setSettings(read);
      notifyOn.current = read.notify;
      if (bootStep(read) === 'locked') lock(true);
      else {
        lock(false);
        await start();
      }
    })();
    return () => {
      stopNet();
      for (const stop of stops) void stop.then((f) => f());
    };
  }, [enter, start, lock]);

  const unlock = async () => {
    try {
      const still = await api.unlock();
      if (still) return;
      lock(false);
      await start();
    } catch (err) {
      setProblem(err instanceof Error ? err.message : String(err));
    }
  };

  const leave = async () => {
    await local('phone_open', { id: null }).catch(() => undefined);
    window.location.reload();
  };

  const changed = (next: PhoneSettings) => {
    setSettings(next);
    notifyOn.current = next.notify;
  };

  const cover = (
    <div className={COVER}>
      <h1 className="m-0 text-emphasis font-bold text-primary">Vibe is locked</h1>
      <p className={NOTE}>Unlock with Face ID, Touch ID, or this phone's fingerprint or PIN.</p>
      <Button variant="primary" onClick={() => void unlock()}>
        Unlock
      </Button>
      {problem !== null && <p className={NOTE}>{problem}</p>}
    </div>
  );

  if (screen === 'cockpit') {
    // The cockpit stays mounted under the cover: unmounting it would forget
    // the live runs it has folded, and the desktop replays them only to a new
    // connection. A reconnect while locked waits for the unlock (`lockGate`).
    return (
      <>
        <Cockpit onDesktops={() => void leave()} />
        {locked && cover}
      </>
    );
  }

  if (locked) return cover;

  if (settings === null || screen === 'loading') {
    return <div className={COVER}>{problem !== null && <p className={NOTE}>{problem}</p>}</div>;
  }

  if (screen === 'pair') {
    return (
      <Pair
        settings={settings}
        onDone={(id) => void open(id)}
        onBack={() => setScreen('desktops')}
      />
    );
  }

  return (
    <Desktops
      settings={settings}
      problem={problem}
      onSettings={changed}
      onOpen={(id) => void open(id)}
      onPair={() => setScreen('pair')}
    />
  );
}
