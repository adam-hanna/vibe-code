import { describe, expect, test } from 'vitest';
import pane from './PilotPane.tsx?raw';
import hostSource from '../host.ts?raw';

/**
 * The pilot's stop button takes the road its turn is on (#223).
 *
 * *"The stop button on the pilot chat doesn't actually do anything."* It called
 * `pilot.cancel`, which is the Rust pilot's and only knows API-backed turns. A
 * subscription turn is a `claude` child of the host, so Rust refused, the
 * refusal was swallowed, and the child ran on. Read from source, like the other
 * wiring tests here: the app has no jsdom, and what went wrong was a route.
 */
describe('stop reaches the turn', () => {
  test('a subscription turn is stopped through the host, an API turn through Rust', () => {
    expect(pane).toContain(
      'if (live === hostTurn.current) void host.stopPilot(live).catch(() => {});',
    );
    expect(pane).toContain('else void pilot.cancel(live).catch(() => {});');
  });

  test('the host has a stop for a pilot turn, separate from a command stop', () => {
    expect(hostSource).toContain("await send({ type: 'pilot_stop', id: nextRequestId(), turn });");
  });

  test('a stopped turn is drawn as stopped, not as a failure', () => {
    const handler = pane.slice(pane.indexOf("if (frame.type === 'pilot_stopped') {"));
    expect(handler).toContain("event: { kind: 'cancelled', turn }");
    expect(hostSource).toContain("type === 'pilot_stopped' ||");
  });

  test('an API turn clears the host turn, so the two id counters cannot collide', () => {
    const api = pane.slice(pane.indexOf('.send({ provider, model, messages, tools: declare()'));
    expect(api.slice(0, 600)).toContain('hostTurn.current = -1;');
  });
});
