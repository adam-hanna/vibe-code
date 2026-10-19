/**
 * Following the phone's connection to its desktop from the webview (#346).
 *
 * Every connection has a **generation**. On a new one the cockpit has to count
 * its request ids from that connection's range, and only then let the held
 * events through (`phone_release`), so the desktop's replay is folded once. Two
 * things can ask for that at once - a `phone://connected` and the cockpit
 * starting to listen - and their reads can land out of order, so the rule is
 * monotonic: a newer generation starts its range and releases; the same one
 * only releases; an older one does nothing.
 */

export interface Session {
  generation: number;
  idBase: number;
}

export interface ResyncDeps {
  session(): Promise<Session>;
  startIds(base: number): void;
  release(generation: number): Promise<void>;
}

export interface Resync {
  /** A new connection's generation arrived. True when it was applied and is still the newest. */
  connected(generation: number): Promise<boolean>;
  /** The cockpit is listening: release what the current connection holds. */
  listening(): Promise<void>;
  /** Count from the current connection's range, releasing nothing: before the cockpit listens. */
  prepare(): Promise<Session>;
}

export function resync(deps: ResyncDeps): Resync {
  let idsGen = 0;
  let newest = 0;
  const apply = async (): Promise<number | null> => {
    const s = await deps.session();
    if (s.generation > idsGen) {
      // Assigned before the release is awaited, so a read landing meanwhile
      // compares against it.
      idsGen = s.generation;
      deps.startIds(s.idBase);
      await deps.release(s.generation);
      return s.generation;
    }
    if (s.generation === idsGen) {
      await deps.release(s.generation);
      return s.generation;
    }
    return null;
  };
  return {
    async connected(generation) {
      newest = Math.max(newest, generation);
      const applied = await apply();
      return applied === generation && generation === newest;
    },
    async listening() {
      await apply();
    },
    async prepare() {
      const s = await deps.session();
      if (s.generation > idsGen) {
        idsGen = s.generation;
        deps.startIds(s.idBase);
      }
      return s;
    },
  };
}

/**
 * The app lock as the reconnect sees it (#346). The phone's Rust refuses
 * `phone_session` and `phone_release` while the app is locked, so a connection
 * that comes back under the cover waits here for the unlock rather than being
 * refused: the link keeps the connection and holds its replay at the gate, and
 * nothing of the desktop's reaches the window until the person has unlocked.
 *
 * It starts locked, which is the fail-closed side: nothing asks before boot has
 * read the settings and said the app is open.
 */
export interface LockGate {
  set(locked: boolean): void;
  locked(): boolean;
  /** Run `ask` once unlocked; asked again if the lock came down while it was in flight. */
  when<T>(ask: () => Promise<T>): Promise<T>;
}

export function lockGate(): LockGate {
  let locked = true;
  let waiting: (() => void)[] = [];
  const unlocked = () =>
    locked ? new Promise<void>((resolve) => waiting.push(resolve)) : Promise.resolve();
  return {
    set(next) {
      locked = next;
      if (!locked) {
        const ready = waiting;
        waiting = [];
        for (const resolve of ready) resolve();
      }
    },
    locked: () => locked,
    async when(ask) {
      for (;;) {
        await unlocked();
        try {
          return await ask();
        } catch (err) {
          // Refused because the lock came down between the wait and the ask:
          // wait for the next unlock. Any other failure is the caller's.
          if (!locked) throw err;
        }
      }
    },
  };
}
