import { afterEach, describe, expect, test } from 'vitest';
import type { Frame } from '../host';
import { invokeOutcome } from './hosts';
import type { LiveRun } from './hosts';
import { emptyRun } from './model';
import { exitNotice, forgetNotices, offerNotice, phoneSink, pilotNotice, runNotice, setNoticeSink } from './notices';
import type { Notice } from './notices';

/**
 * Local notifications (#346), read off frames by type and id, offered once per
 * key, and fired by the phone only while it is hidden with notifications on.
 */

const live: LiveRun = {
  handle: 'run-7',
  invokeId: 7,
  answered: new Set(),
  live: true,
  dir: '/repo',
  asked: null,
  task: 'build it',
  sent: null,
  draft: null,
  held: null,
  adopted: null,
  pid: 1,
  heard: true,
  pausing: false,
  stopping: false,
  watched: false,
  unclaimed: [],
  run: emptyRun(),
};

/** What the cockpit offers for a frame: `invokeOutcome`, then `runNotice`. */
const offered = (frame: Frame) => runNotice('run-7', frame, invokeOutcome([live], 'run-7', frame), 'build it');

afterEach(() => {
  setNoticeSink(null);
  forgetNotices();
});

describe('a run frame notifies only for what the cockpit reads as an ending or a gate', () => {
  test('a gate held', () => {
    const ask = { type: 'ask', id: 3, context: { boundary: 'plan-approved' } } as unknown as Frame;
    expect(offered(ask)?.title).toBe('Waiting for you');
  });

  test("the invoke's result notifies with its code's wording", () => {
    expect(offered({ type: 'result', id: 7, exit: 0 })?.title).toBe('Run finished');
    expect(offered({ type: 'result', id: 7, exit: 2 })?.title).toBe('Run needs input');
    expect(offered({ type: 'result', id: 7, exit: 4 })?.title).toBe('Run ended: budget');
    expect(offered({ type: 'result', id: 7, exit: 42 })?.title).toBe('Run ended with exit 42');
  });

  test("the invoke's error notifies failed", () => {
    expect(offered({ type: 'error', id: 7, message: 'refused' })).toEqual({
      key: 'run-7:end',
      title: 'Run failed',
      body: 'build it: refused',
    });
  });

  test('a control result and an error that is not the invoke never notify', () => {
    // A pause, unpause or cancel is answered with a `result` too.
    expect(offered({ type: 'result', id: 8, exit: 0 })).toBeNull();
    expect(offered({ type: 'error', id: 8, message: 'x' })).toBeNull();
    expect(offered({ type: 'narration', level: 'info', message: 'done', id: 'review_approved', data: {} })).toBeNull();
  });

  test('a stale host is never offered: invokeOutcome knows no run there', () => {
    expect(runNotice('run-9', { type: 'result', id: 7, exit: 0 }, invokeOutcome([live], 'run-9', { type: 'result', id: 7, exit: 0 }), 'x')).toBeNull();
  });
});

describe('offered once, and only with a sink', () => {
  test('a replayed frame notifies once', () => {
    const got: Notice[] = [];
    setNoticeSink((n) => got.push(n));
    const ask = { type: 'ask', id: 3, context: {} } as unknown as Frame;
    offerNotice(offered(ask));
    offerNotice(offered(ask));
    expect(got).toHaveLength(1);
  });

  test('with no sink nothing happens, and nothing is remembered', () => {
    offerNotice(offered({ type: 'result', id: 7, exit: 0 }));
    const got: Notice[] = [];
    setNoticeSink((n) => got.push(n));
    offerNotice(offered({ type: 'result', id: 7, exit: 0 }));
    expect(got).toHaveLength(1);
  });

  test('the phone sink fires only while hidden with notifications on', () => {
    const sent: Notice[] = [];
    let hidden = false;
    let on = true;
    const sink = phoneSink({ hidden: () => hidden, notifyOn: () => on, send: (n) => sent.push(n) });
    const n: Notice = { key: 'k', title: 't', body: 'b' };
    sink(n);
    hidden = true;
    on = false;
    sink(n);
    on = true;
    sink(n);
    expect(sent).toEqual([n]);
  });
});

describe('a lost run and a pilot turn', () => {
  test('a run host that exited while live is failed, with the exit wording', () => {
    expect(exitNotice('run-7', 9, 'build it')).toEqual({ key: 'run-7:exit', title: 'Run failed', body: 'build it: the host exited 9' });
    expect(exitNotice('run-7', null, 'x').body).toContain('signalled');
  });

  test('ended and failed notify, cancelled does not, and the two roads have their own keys', () => {
    expect(pilotNotice('api', { kind: 'ended', turn: 1 })?.key).toBe('pilot:api:1:ended');
    expect(pilotNotice('host', { kind: 'ended', turn: 1 })?.key).toBe('pilot:host:1:ended');
    expect(pilotNotice('host', { kind: 'failed', turn: 2 })?.title).toBe("The pilot's turn failed");
    expect(pilotNotice('api', { kind: 'cancelled', turn: 3 })).toBeNull();
  });
});
