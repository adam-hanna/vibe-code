import { describe, expect, test } from 'vitest';
import { NO_PROMPT, phoneRows, promptClosesIn, promptStep, qrRects, remoteVisible } from './pairing';
import type { PairRequest, RemoteStatus } from './remote';

/** Remote access in the window (#341): the prompt, the gate, the QR and the list. */

const request = (over: Partial<PairRequest> = {}): PairRequest => ({
  phoneName: 'Pixel',
  code: '077145',
  expiresAt: 10_000,
  ...over,
});

const status = (over: Partial<RemoteStatus> = {}): RemoteStatus => ({
  endpointId: null,
  identityUnreadable: null,
  phones: [],
  phonesUnreadable: null,
  preview: true,
  endpoint: { state: 'off' },
  ...over,
});

describe('the pairing prompt', () => {
  test('a request opens it and a newer one replaces it', () => {
    const first = promptStep(NO_PROMPT, { kind: 'request', request: request() });
    expect(first).toEqual({ kind: 'asking', request: request() });
    const second = promptStep(first, { kind: 'request', request: request({ phoneName: 'iPhone' }) });
    expect(second).toEqual({ kind: 'asking', request: request({ phoneName: 'iPhone' }) });
  });

  test('it closes exactly when its clock reaches expiresAt, and not before', () => {
    const asking = promptStep(NO_PROMPT, { kind: 'request', request: request() });
    expect(promptStep(asking, { kind: 'tick', now: 9_999 })).toBe(asking);
    expect(promptStep(asking, { kind: 'tick', now: 10_000 })).toEqual(NO_PROMPT);
    expect(promptClosesIn(10_000, 9_000)).toBe(1_000);
    expect(promptClosesIn(10_000, 11_000)).toBeLessThanOrEqual(0);
  });

  test('every pair-ended closes it, whatever the outcome', () => {
    // A failed write ends as `declined` too: the prompt still goes, and the
    // sentence is shown in Settings rather than over a dialog nobody can act on.
    const asking = promptStep(NO_PROMPT, { kind: 'request', request: request() });
    expect(promptStep(asking, { kind: 'ended' })).toEqual(NO_PROMPT);
    expect(promptStep(asking, { kind: 'close' })).toEqual(NO_PROMPT);
    expect(promptStep(NO_PROMPT, { kind: 'ended' })).toEqual(NO_PROMPT);
  });

  test('a tick with nothing asking leaves nothing', () => {
    expect(promptStep(NO_PROMPT, { kind: 'tick', now: 99_999 })).toEqual(NO_PROMPT);
  });
});

describe('the section is hidden unless previewed', () => {
  test('only preview: true draws anything', () => {
    expect(remoteVisible(null)).toBe(false);
    expect(remoteVisible(status({ preview: false }))).toBe(false);
    expect(
      remoteVisible(
        status({ preview: false, identityUnreadable: 'locked', phonesUnreadable: 'no data directory' }),
      ),
    ).toBe(false);
    expect(remoteVisible(status({ preview: true }))).toBe(true);
  });
});

describe('the paired list', () => {
  test('an unreadable list is its reason, never an empty list', () => {
    expect(phoneRows(status({ phonesUnreadable: 'the file is garbage' }))).toEqual({
      unreadable: 'the file is garbage',
    });
  });

  test('a phone never seen says never, and connected says so', () => {
    const got = phoneRows(
      status({
        phones: [
          { id: 'a', name: 'Pixel', pairedAt: 1_000, lastSeen: null, connected: false },
          { id: 'b', name: 'iPhone', pairedAt: 1_000, lastSeen: 2_000, connected: true },
        ],
      }),
    );
    if (!('rows' in got)) throw new Error('rows');
    expect(got.rows[0]?.lastConnected).toBe('never');
    expect(got.rows[0]?.connected).toBe('not connected');
    expect(got.rows[1]?.lastConnected).not.toBe('never');
    expect(got.rows[1]?.connected).toBe('connected');
  });
});

describe('the QR code', () => {
  test('dark modules are offset by the quiet zone', () => {
    const got = qrRects({ size: 2, rows: [[true, false], [false, true]] }, 4);
    expect(got.size).toBe(10);
    expect(got.cells).toEqual([
      { x: 4, y: 4 },
      { x: 5, y: 5 },
    ]);
  });
});
