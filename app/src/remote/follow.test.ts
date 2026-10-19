import { describe, expect, it } from 'vitest';
import { followStatus } from './remote';
import type { RemoteStatus, Subscribe } from './remote';

/** A status told apart by its endpoint id alone. */
const snap = (id: string) => ({ endpointId: id }) as unknown as RemoteStatus;

/** A read whose answers the test releases, in any order. */
function reads() {
  const pending: Array<(s: RemoteStatus) => void> = [];
  const read = () => new Promise<RemoteStatus>((resolve) => pending.push(resolve));
  return { read, pending };
}

/** An event whose subscription the test completes, and fires. */
function event() {
  let handler: (() => void) | null = null;
  let ready: (() => void) | null = null;
  const subscribe: Subscribe = (h) =>
    new Promise((resolve) => {
      ready = () => {
        handler = h;
        resolve(() => {
          handler = null;
        });
      };
    });
  return {
    subscribe,
    ready: () => ready?.(),
    fire: () => handler?.(),
    get listening() {
      return handler !== null;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('followStatus', () => {
  it('reads only once every listener is installed', async () => {
    const { read, pending } = reads();
    const ev = event();
    followStatus(() => {}, [ev.subscribe], read);
    await flush();
    expect(pending).toHaveLength(0);
    ev.ready();
    await flush();
    expect(ev.listening).toBe(true);
    expect(pending).toHaveLength(1);
  });

  it('draws only the newest read, whatever order the answers come in', async () => {
    const { read, pending } = reads();
    const ev = event();
    const drawn: Array<RemoteStatus | null> = [];
    followStatus((s) => drawn.push(s), [ev.subscribe], read);
    ev.ready();
    await flush();
    ev.fire();
    ev.fire();
    expect(pending).toHaveLength(3);
    pending[2]!(snap('newest'));
    pending[1]!(snap('older'));
    pending[0]!(snap('first'));
    await flush();
    expect(drawn).toEqual([snap('newest')]);
  });

  it("draws a change's answer, drops reads older than it, and reads once more", async () => {
    const { read, pending } = reads();
    const ev = event();
    const drawn: Array<RemoteStatus | null> = [];
    const f = followStatus((s) => drawn.push(s), [ev.subscribe], read);
    ev.ready();
    await flush();
    f.accept(snap('answer'));
    pending[0]!(snap('before'));
    await flush();
    expect(drawn).toEqual([snap('answer')]);
    expect(pending).toHaveLength(2);
    pending[1]!(snap('after'));
    await flush();
    expect(drawn).toEqual([snap('answer'), snap('after')]);
  });

  it('draws nothing and unsubscribes once stopped', async () => {
    const { read, pending } = reads();
    const ev = event();
    const drawn: Array<RemoteStatus | null> = [];
    const f = followStatus((s) => drawn.push(s), [ev.subscribe], read);
    ev.ready();
    await flush();
    f.stop();
    pending[0]!(snap('late'));
    await flush();
    expect(drawn).toEqual([]);
    expect(ev.listening).toBe(false);
  });
});
