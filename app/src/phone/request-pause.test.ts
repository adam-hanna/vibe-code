import { afterEach, expect, test } from 'vitest';
import * as host from '../host';
import { ID_RANGE } from '../changed';

/**
 * While a phone reconnects, nothing is sent until the new connection's range is
 * known (#346), and a request made meanwhile is refused with a rejected promise
 * - never a throw, since `pause`, `cancel` and the rest are called from handlers
 * that do not catch.
 */

type Asked = { command: string; args: unknown };

function shell(): Asked[] {
  const asked: Asked[] = [];
  (globalThis as { window?: unknown }).window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: unknown) => {
        asked.push({ command, args });
        return Promise.resolve(null);
      },
      transformCallback: () => 0,
    },
  };
  return asked;
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

test('paused, every request rejects, throws nothing and sends nothing', async () => {
  const asked = shell();
  host.pauseRequests();
  const calls = [
    () => host.pause('run-1'),
    () => host.cancel('run-1', 'stop'),
    () => host.shutdown('run-1'),
    () => host.startRunHost('run-2', { type: 'invoke', id: 9 }),
  ];
  for (const call of calls) {
    let made: Promise<unknown> | undefined;
    expect(() => {
      made = call();
    }).not.toThrow();
    await expect(made).rejects.toThrow(host.RECONNECTING);
  }
  expect(asked).toEqual([]);
});

test('the new range unpauses, and the next id is the first of it', async () => {
  const asked = shell();
  host.pauseRequests();
  host.startRequestIds(ID_RANGE);
  await host.pause('run-1');
  expect(asked).toHaveLength(1);
  const line = JSON.parse((asked[0]!.args as { line: string }).line) as { id: number };
  expect(line.id).toBe(ID_RANGE + 1);
});
