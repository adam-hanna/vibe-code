/**
 * A phone's desktop events, caught before the cockpit listens (#346).
 *
 * The phone's Rust holds every event of a new connection until the webview
 * releases it (`phone_release`), so the desktop's replay is folded once. The
 * cockpit released it when it mounted - but the cockpit mounts only after the
 * window's memory has been read, and that read is a request whose answer is an
 * event. So the answer sat behind the gate it was waiting to open: four asks
 * of fifteen seconds each, then the cockpit drawn on an empty memory, with no
 * projects and therefore none of the desktop's runs. Measured on a real phone,
 * not a mock: the sidebar said *the host did not answer with the window's
 * memory*, and the same request asked a minute later was answered at once.
 *
 * So a phone releases first and catches what comes, and the cockpit is handed
 * everything caught, in order, when it attaches. **One listener, never two**:
 * an event is either held or given to the sink, decided in one place, so it
 * cannot reach the cockpit twice or not at all. The asks made meanwhile have
 * listeners of their own and are answered live.
 *
 * Pure, because the app has no jsdom: `host.ts` feeds it from `listen`.
 */
export interface Tap<K extends string> {
  /** An event arrived: given to the sink, or held while there is none. */
  push(kind: K, payload: unknown): void;
  /**
   * The cockpit is listening: what was held is given to it first, in order,
   * then every event as it comes. Returns the detach. Once a sink has been
   * attached nothing is held again - an event with no listener is dropped,
   * as it is on the desktop.
   */
  attach(sink: (kind: K, payload: unknown) => void): () => void;
}

export function tap<K extends string>(): Tap<K> {
  let held: [K, unknown][] | null = [];
  let sink: ((kind: K, payload: unknown) => void) | null = null;
  return {
    push(kind, payload) {
      if (sink !== null) sink(kind, payload);
      else held?.push([kind, payload]);
    },
    attach(next) {
      sink = next;
      const caught = held ?? [];
      held = null;
      for (const [kind, payload] of caught) next(kind, payload);
      return () => {
        if (sink === next) sink = null;
      };
    },
  };
}
