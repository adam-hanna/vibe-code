import { expect, test } from 'vitest';
import { networkSignals } from './network';
import type { NetworkWindow } from './network';

/** Every network signal reaches the phone's Rust, whether or not `onLine` moved (#346). */

function fakeWindow(connection: EventTarget | undefined) {
  const listeners = new Map<string, Set<() => void>>();
  const win: NetworkWindow = {
    navigator: { onLine: true, connection },
    addEventListener: (type, l) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(l);
    },
    removeEventListener: (type, l) => listeners.get(type)?.delete(l),
  };
  const fire = (type: string) => {
    for (const l of listeners.get(type) ?? []) l();
  };
  return { win, fire };
}

test('sends on boot, online, offline and a connection change', () => {
  const connection = new EventTarget();
  const { win, fire } = fakeWindow(connection);
  const sent: boolean[] = [];
  const stop = networkSignals((online) => sent.push(online), win);
  expect(sent).toEqual([true]);
  win.navigator.onLine = false;
  fire('offline');
  win.navigator.onLine = true;
  fire('online');
  connection.dispatchEvent(new Event('change'));
  connection.dispatchEvent(new Event('change'));
  expect(sent).toEqual([true, false, true, true, true]);
  stop();
  fire('online');
  connection.dispatchEvent(new Event('change'));
  expect(sent).toHaveLength(5);
});

test('a webview with no navigator.connection still sends the rest', () => {
  const { win, fire } = fakeWindow(undefined);
  const sent: boolean[] = [];
  networkSignals((online) => sent.push(online), win);
  fire('online');
  expect(sent).toEqual([true, true]);
});
