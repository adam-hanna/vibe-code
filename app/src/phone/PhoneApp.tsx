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
import { Connecting, COVER, NOTE } from './Connecting';
import { Desktops } from './Desktops';
import { lockGate, resync } from './link';
import { networkSignals } from './network';
import { opening } from './opening';
import type { OpenAnswer } from './opening';
import { Pair } from './Pair';
import { called } from './reason';

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
 *
 * While the first open dials, the loading screen says so and offers the
 * desktops list (`Connecting.tsx`). Walking away stops the dial and drops its
 * answer, however late it comes (`opening.ts`).
 */

type Screen = 'loading' | 'desktops' | 'pair' | 'cockpit';

export function PhoneApp() {
  const [settings, setSettings] = useState<PhoneSettings | null>(null);
  const [locked, setLocked] = useState(false);
  const [screen, setScreen] = useState<Screen>('loading');
  const [problem, setProblem] = useState<string | null>(null);
  /** The desktop the loading screen is dialling, as this phone calls it. */
  const [dialling, setDialling] = useState<string | null>(null);
  const started = useRef(false);
  const entering = useRef(false);
  const notifyOn = useRef(true);
  const opener = useRef(opening((id) => local<OpenAnswer>('phone_open', { id })));
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
      // Released now, not when the cockpit mounts: the memory read below is
      // answered by an event, and a held answer is one that never arrives
      // (`phone/tap.ts`). What comes meanwhile is caught for the cockpit.
      await host.catchEarly();
      await link.current.listening();
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
    async (id: string) => {
      const answered = await opener.current.open(id);
      // Overtaken by a later open, or by *Choose another desktop*: the screen
      // is the person's now, and this answer moves nothing.
      if (answered === null) return;
      if (answered.connected) await enter();
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
      const entry = list.desktops.find((d) => d.id === current);
      if (current !== null && entry !== undefined) {
        setDialling(called(entry));
        await open(entry.id);
      } else setScreen('desktops');
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
      // Not after the person walked away from the dial: a connection that came
      // up just before the stop is not the screen they chose.
      listen('phone://connected', () => {
        if (started.current && opener.current.follows()) void enter();
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

  /**
   * *Choose another desktop*, while the first open dials. Before the dial has
   * connected, stop it and go to the list; once the cockpit is being prepared
   * the host has begun catching that desktop's events, so leave the way the
   * cockpit does, by stopping and reloading onto the list.
   */
  const choose = () => {
    if (entering.current) {
      void leave();
      return;
    }
    setScreen('desktops');
    void opener.current.abandon();
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
    return <Connecting dialling={dialling} problem={problem} onChoose={choose} />;
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
