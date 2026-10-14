import { describe, expect, test } from 'vitest';
import bridge from '../../src-tauri/src/remote/bridge.rs?raw';
import { PHONE_ORIGIN, phoneOf } from './origin';

/**
 * The spelling is the bridge's (#344): it writes the origin, the window reads
 * it. Read out of the Rust source, the way `artifacts.test.ts` reads the core's
 * names, so the two cannot drift apart without a test saying so.
 */
describe("a phone's origin", () => {
  test('the prefix is the one the bridge writes', () => {
    const written = /fn origin_for[\s\S]*?String::from\("([^"]*)"\)/.exec(bridge);
    expect(written?.[1]).toBe(PHONE_ORIGIN);
  });

  test('only a phone has a name', () => {
    expect(phoneOf("phone:Adam's iPhone")).toBe("Adam's iPhone");
    expect(phoneOf('pilot')).toBeNull();
    expect(phoneOf('gates')).toBeNull();
    expect(phoneOf(null)).toBeNull();
    expect(phoneOf(undefined)).toBeNull();
    expect(phoneOf('phone:')).toBeNull();
    expect(phoneOf(7)).toBeNull();
  });
});
