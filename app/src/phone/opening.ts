/**
 * Opening a desktop, with a way to walk away from the dial.
 *
 * The phone opens the desktop it last had open as soon as it is unlocked, and
 * `phone_open` answers only once that dial has connected or given up: the
 * stored relay hint first, then the id alone (`HINT_DIAL_TIMEOUT` and
 * `DIAL_TIMEOUT` in `app/remote/src/client.rs`), so up to about twenty seconds
 * for a desktop that is off. The connecting screen offers *Choose another
 * desktop* meanwhile, and three things have to hold for that to be safe:
 *
 * - **The dial is stopped, not just ignored.** `phone_open` with no id is the
 *   phone's one way to stop: its Rust aborts the loop that is dialling and
 *   forgets which desktop was open, as leaving the cockpit does. Left running,
 *   the dial would connect behind the list and the reconnect loop would keep it
 *   connected to a desktop nobody chose.
 * - **The stop reaches the Rust before the next open does.** Tauri runs each
 *   async command as its own task, so a stop and an open sent back to back can
 *   run in either order, and a stop that ran second would end the dial the
 *   person had just asked for. `open` waits for the last stop to be answered.
 * - **A late answer moves nothing.** The dial may already have connected when
 *   the stop arrives, and its answer, or its `phone://connected`, can come after
 *   the person is on the list. Every open takes a ticket; an answer whose ticket
 *   is no longer the newest is dropped, and `follows` stays false from a stop
 *   until the next open has been sent, so a stale connected event draws nothing.
 *
 * What it cannot take back is a cockpit already being prepared: by then the
 * host has begun catching that desktop's events, and the caller leaves the way
 * the cockpit's Desktops button does, by reloading the page.
 */

/** What `phone_open` answers: a generation once connected, else why not. */
export interface OpenAnswer {
  generation?: number | null;
  reason?: unknown;
}

export interface Opening {
  /**
   * Open `id`. `connected` says whether it connected; `null` means a later
   * open or a stop overtook this one, and the caller does nothing with it.
   */
  open(id: string): Promise<{ connected: boolean } | null>;
  /** Stop whatever is dialling. Resolves once the phone's Rust has answered. */
  abandon(): Promise<void>;
  /** May a `phone://connected` draw the cockpit? Not between a stop and the next open. */
  follows(): boolean;
}

export function opening(phoneOpen: (id: string | null) => Promise<OpenAnswer>): Opening {
  let ticket = 0;
  let stopped = false;
  let stopping: Promise<void> = Promise.resolve();
  return {
    async open(id) {
      const mine = ++ticket;
      await stopping;
      if (mine !== ticket) return null;
      stopped = false;
      const answered = await phoneOpen(id);
      if (mine !== ticket) return null;
      return { connected: typeof answered.generation === 'number' };
    },
    abandon() {
      ticket++;
      stopped = true;
      stopping = phoneOpen(null).then(
        () => undefined,
        () => undefined,
      );
      return stopping;
    },
    follows: () => !stopped,
  };
}
