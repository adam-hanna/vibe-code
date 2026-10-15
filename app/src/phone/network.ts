/**
 * What the OS says about the network, sent to the phone's Rust (#346).
 *
 * `online` and `offline` fire only when connectivity is gained or lost, so a
 * Wi-Fi to cellular handover - online on both sides - is caught by
 * `navigator.connection`'s `change` where the webview has it (Android's does;
 * WKWebView has no `navigator.connection`, and iOS relies on the foreground,
 * the connection closing and iroh's own interface watch). **Every signal is
 * sent**, whether or not `onLine` moved: the Rust side pokes the reconnect loop
 * and `endpoint.network_change()` on each one.
 */

export interface NetworkWindow {
  navigator: { onLine: boolean; connection?: EventTarget | undefined };
  addEventListener(type: 'online' | 'offline', listener: () => void): void;
  removeEventListener(type: 'online' | 'offline', listener: () => void): void;
}

/** Start sending. Sends once at once. Returns a function that stops. */
export function networkSignals(send: (online: boolean) => void, win: NetworkWindow): () => void {
  const now = (): void => send(win.navigator.onLine);
  now();
  win.addEventListener('online', now);
  win.addEventListener('offline', now);
  const connection = win.navigator.connection;
  connection?.addEventListener('change', now);
  return () => {
    win.removeEventListener('online', now);
    win.removeEventListener('offline', now);
    connection?.removeEventListener('change', now);
  };
}
