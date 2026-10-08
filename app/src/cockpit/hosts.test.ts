import { describe, expect, test } from 'vitest';
import { exitMeans, hostExitWording, invokeOutcome, mayAnswer, routeFrame } from './hosts';
import type { LiveHost } from './hosts';
import { CONFIG_WRITE_DURING_RUN, configWriteRefusal, SERVICE_HOST } from '../host';
import type { Frame } from '../host';
import serve from '../../../src/serve.ts?raw';

/**
 * Routing by host handle (#246).
 *
 * One host process per run: the service host answers everything that is not a
 * run, and each `invoke` has a run host of its own. These are the window's
 * decisions about which is which, and none of them is "the current run".
 */

const live: LiveHost = { handle: 'run-7', invokeId: 7, answered: new Set([3]) };
const result = (id: number): Frame => ({ type: 'result', id, exit: 0 });
const error = (id: number): Frame => ({ type: 'error', id, message: 'refused' });

describe('a frame goes where its handle says', () => {
  test('the service host, the live run host, and anything else', () => {
    expect(routeFrame(live, SERVICE_HOST)).toBe('service');
    expect(routeFrame(live, 'run-7')).toBe('run');
    expect(routeFrame(live, 'run-2')).toBe('stale');
    // With no run live, a run host's frame belongs to nobody.
    expect(routeFrame(null, 'run-7')).toBe('stale');
    expect(routeFrame(null, SERVICE_HOST)).toBe('service');
  });
});

describe('what ends the live invoke', () => {
  test("its own result completes it; a pause's result does not", () => {
    expect(invokeOutcome(live, 'run-7', result(7))).toBe('completed');
    expect(invokeOutcome(live, 'run-7', result(8))).toBeNull();
    // The same id on another host is that host's business.
    expect(invokeOutcome(live, 'run-2', result(7))).toBeNull();
    expect(invokeOutcome(null, 'run-7', result(7))).toBeNull();
  });

  test('an error with its id fails it, even when that id is a gate already answered', () => {
    expect(invokeOutcome(live, 'run-7', error(7))).toBe('failed');
    // Gate ids are the host's counter and invoke ids the window's, so they can
    // coincide. Answer-once is what keeps this unambiguous, not membership.
    const coincide: LiveHost = { handle: 'run-1', invokeId: 1, answered: new Set([1]) };
    expect(invokeOutcome(coincide, 'run-1', error(1))).toBe('failed');
    expect(invokeOutcome(live, 'run-7', error(9))).toBeNull();
  });

  test('a gate is answered once, and only while a run is live', () => {
    expect(mayAnswer(live, 4)).toBe(true);
    expect(mayAnswer(live, 3)).toBe(false);
    expect(mayAnswer(null, 4)).toBe(false);
  });
});

describe('what an exit means', () => {
  test('the service host, the live run lost, or the expected close', () => {
    expect(exitMeans(live, SERVICE_HOST)).toBe('service');
    expect(exitMeans(live, 'run-7')).toBe('run-lost');
    // After its result the window has let it go, so its exit is expected.
    expect(exitMeans(null, 'run-7')).toBe('expected');
    expect(exitMeans(live, 'run-2')).toBe('expected');
  });

  test('the two sentences the cockpit always said', () => {
    expect(hostExitWording(3)).toBe('the host exited 3');
    expect(hostExitWording(null)).toBe('the host was signalled and reported no exit code');
  });
});

describe('a config write while a run is live', () => {
  test('is refused in the sentence serve.ts uses, and a read never is', () => {
    expect(configWriteRefusal({ loop: {} }, true)).toBe(CONFIG_WRITE_DURING_RUN);
    expect(configWriteRefusal(undefined, true)).toBeNull();
    expect(configWriteRefusal({ loop: {} }, false)).toBeNull();
  });

  test('the sentence is the core’s own, word for word', () => {
    // Moved rather than reworded: the service host no longer sees a run, and a
    // person who saw the old refusal should see the same one.
    const quoted = CONFIG_WRITE_DURING_RUN.split(' ').slice(0, 8).join(' ');
    expect(serve).toContain(quoted);
    expect(serve.replace(/'\s*\+\s*'/g, '')).toContain(CONFIG_WRITE_DURING_RUN);
  });
});
