import { describe, expect, test } from 'vitest';
import { endpointNote } from './remote';
import type { EndpointReport, LinkInfo } from './remote';

/** What the diagnostics say about the endpoint a phone dials (#342). */

const relay = { url: 'https://usw1-1.relay.n0.iroh.link./', connected: true, error: null };
const link = (path: LinkInfo['path']): LinkInfo => ({ id: 'phone', path });
const up = (over: Partial<Extract<EndpointReport, { state: 'up' }>> = {}): EndpointReport => ({
  state: 'up',
  relays: [relay],
  links: [],
  ...over,
});

describe('the endpoint in the diagnostics', () => {
  test('off says nothing at all', () => {
    expect(endpointNote({ state: 'off' })).toBeNull();
  });

  test('every state that is not up says what it is waiting on', () => {
    expect(endpointNote({ state: 'noKey' })).toContain('first pairing code');
    expect(endpointNote({ state: 'starting' })).toBe('starting');
    expect(endpointNote({ state: 'failed', reason: 'no socket' })).toBe('could not start: no socket');
  });

  test('with no phone connected it claims no path', () => {
    const note = endpointNote(up()) ?? '';
    expect(note).toContain(`home relay ${relay.url}`);
    expect(note).toContain('no phone connected, so no path to report');
    expect(note).not.toMatch(/direct/);
  });

  test('a connected phone says whether it is direct or only through the relay', () => {
    expect(endpointNote(up({ links: [link('direct')] }))).toContain('1 direct (1 phone)');
    expect(endpointNote(up({ links: [link('relay')] }))).toContain('1 only through the relay (1 phone)');
    expect(endpointNote(up({ links: [link('direct'), link('relay'), link('none')] }))).toContain(
      '1 direct, 1 only through the relay, 1 between paths (3 phones)',
    );
  });

  test('a relay that is not connected says so, with its error', () => {
    expect(endpointNote(up({ relays: [{ ...relay, connected: false, error: 'timed out' }] }))).toContain(
      `home relay ${relay.url} not connected: timed out`,
    );
    expect(endpointNote(up({ relays: [] }))).toContain('no home relay chosen yet');
  });
});
