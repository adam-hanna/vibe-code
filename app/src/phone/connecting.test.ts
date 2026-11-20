import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import clientRs from '../../remote/src/client.rs?raw';
import browserMock from '../../mobile/browser-mock.ts?raw';
import phoneApp from './PhoneApp.tsx?raw';
import { ConnectingView, HINT_WAIT_MS } from './Connecting';
import type { ConnectingProps } from './Connecting';
import { opening } from './opening';
import type { OpenAnswer } from './opening';

/**
 * The phone's loading screen while it dials the desktop last open, and the way
 * out of it. It was a blank cover for as long as the dial took - up to about
 * twenty seconds for a desktop that is off.
 */

function view(over: Partial<ConnectingProps> = {}): string {
  return renderToStaticMarkup(
    createElement(ConnectingView, { dialling: null, slow: false, problem: null, onChoose: () => {}, ...over }),
  );
}

describe('the connecting screen', () => {
  test('before the phone knows which desktop, it says it is starting and offers no way out', () => {
    const html = view();
    expect(html).toContain('Starting…');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('Connecting to');
    expect(html).not.toContain('Choose another desktop');
    expect(html).not.toContain('Still trying');
  });

  test('once known, it names the desktop and offers the list', () => {
    const html = view({ dialling: 'Studio Mac' });
    expect(html).toContain('Connecting to Studio Mac…');
    expect(html).toContain('Choose another desktop');
    expect(html).not.toContain('Still trying');
  });

  test('past the stored address, it says it is still trying without promising a time', () => {
    const html = view({ dialling: 'Studio Mac', slow: true });
    const line = html.match(/<p[^>]*>(Still trying[^<]*)<\/p>/)?.[1];
    expect(line).toBeDefined();
    expect(line).not.toMatch(/\d/);
  });

  test('a problem is still drawn', () => {
    expect(view({ problem: 'the list could not be read' })).toContain('the list could not be read');
  });

  test('the slow line waits for the hint budget the dial actually has', () => {
    const rust = clientRs.match(/pub const HINT_DIAL_TIMEOUT: Duration = Duration::from_secs\((\d+)\);/);
    expect(rust).not.toBeNull();
    expect(HINT_WAIT_MS).toBe(Number(rust?.[1]) * 1000);
  });

  test('the phone app draws it for the loading screen, and the connected event defers to the opener', () => {
    expect(phoneApp).toMatch(/<Connecting dialling=\{dialling\} problem=\{problem\} onChoose=\{choose\} \/>/);
    expect(phoneApp).toMatch(/if \(started\.current && opener\.current\.follows\(\)\) void enter\(\);/);
    // A cockpit already being prepared is left by a reload, as the cockpit's own Desktops button does.
    expect(phoneApp).toMatch(/if \(entering\.current\) \{\s*void leave\(\);/);
  });

  test("the browser mock's slow dial is opt-in", () => {
    expect(browserMock).toMatch(/get\('slowDial'\);\s*if \(asked === null\) return null;/);
    expect(browserMock).toContain("return SLOW_DIAL === null ? { generation: 1 } : slowOpen();");
  });
});

/** A `phone_open` whose answers the case hands out by hand, in any order. */
function fakeOpen() {
  const calls: { id: string | null; answer: (a: OpenAnswer) => void }[] = [];
  const phoneOpen = (id: string | null) =>
    new Promise<OpenAnswer>((resolve) => {
      calls.push({ id, answer: resolve });
    });
  return { calls, phoneOpen };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('walking away from a dial', () => {
  test('an open that is answered is reported', async () => {
    const { calls, phoneOpen } = fakeOpen();
    const o = opening(phoneOpen);
    const opened = o.open('a');
    await flush();
    calls[0]?.answer({ generation: 3 });
    expect(await opened).toEqual({ connected: true });
    const failed = o.open('a');
    await flush();
    calls[1]?.answer({ reason: { kind: 'unreachable' } });
    expect(await failed).toEqual({ connected: false });
  });

  test('a stop sends phone_open with no id, and a success that lands after it moves nothing', async () => {
    const { calls, phoneOpen } = fakeOpen();
    const o = opening(phoneOpen);
    const opened = o.open('a');
    await flush();
    expect(o.follows()).toBe(true);
    const stopped = o.abandon();
    expect(calls.map((c) => c.id)).toEqual(['a', null]);
    expect(o.follows()).toBe(false);
    // The dial had connected just before the stop reached the Rust.
    calls[0]?.answer({ generation: 1 });
    expect(await opened).toBeNull();
    calls[1]?.answer({ generation: null });
    await stopped;
    // A stale `phone://connected` draws nothing either.
    expect(o.follows()).toBe(false);
  });

  test('the next open is not sent until the stop has been answered, so the stop cannot end it', async () => {
    const { calls, phoneOpen } = fakeOpen();
    const o = opening(phoneOpen);
    void o.open('a');
    await flush();
    void o.abandon();
    const next = o.open('b');
    await flush();
    expect(calls.map((c) => c.id)).toEqual(['a', null]);
    expect(o.follows()).toBe(false);
    calls[1]?.answer({ generation: null });
    await flush();
    expect(calls.map((c) => c.id)).toEqual(['a', null, 'b']);
    expect(o.follows()).toBe(true);
    calls[2]?.answer({ generation: 2 });
    expect(await next).toEqual({ connected: true });
  });

  test('a stop the Rust refuses still lets the next open through', async () => {
    const o = opening((id) => (id === null ? Promise.reject(new Error('locked')) : Promise.resolve({ generation: 1 })));
    await o.abandon();
    expect(await o.open('b')).toEqual({ connected: true });
  });

  test('an open overtaken by a later open drops its answer, whichever lands first', async () => {
    const { calls, phoneOpen } = fakeOpen();
    const o = opening(phoneOpen);
    const first = o.open('a');
    await flush();
    const second = o.open('b');
    await flush();
    calls[1]?.answer({ generation: 5 });
    calls[0]?.answer({ generation: 4 });
    expect(await first).toBeNull();
    expect(await second).toEqual({ connected: true });
  });

  test('two opens queued behind one stop: only the newer is sent', async () => {
    const { calls, phoneOpen } = fakeOpen();
    const o = opening(phoneOpen);
    void o.abandon();
    const a = o.open('a');
    const b = o.open('b');
    calls[0]?.answer({ generation: null });
    await flush();
    expect(calls.map((c) => c.id)).toEqual([null, 'b']);
    expect(await a).toBeNull();
    calls[1]?.answer({ generation: 1 });
    expect(await b).toEqual({ connected: true });
  });
});
