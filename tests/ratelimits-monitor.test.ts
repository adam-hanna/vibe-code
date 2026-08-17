import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CodexRateLimitMonitor } from '@src/ratelimits.js';
import { DEFAULTS } from '@src/config.js';
import type { AppServerTransport } from '@src/appserver.js';
import type { Config } from '@src/types.js';
import { FakeTransport, respondingTransport } from './helpers/fake-transport.js';

const CWD = '/repo';

const READ_RESULT = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 15, windowDurationMins: 10080, resetsAt: 1787196925 },
    secondary: null,
    planType: 'plus',
  },
};

function config(readRateLimits = true): Config {
  return { ...DEFAULTS, codex: { ...DEFAULTS.codex, readRateLimits } };
}

/** Unix seconds, which is what app-server reports. */
const futureEpoch = (): number => Math.floor(Date.now() / 1000) + 3600;
const pastEpoch = (): number => Math.floor(Date.now() / 1000) - 3600;

/** Counts how often the monitor asked for a transport, which is once per connection. */
function countingFactory(make: () => AppServerTransport): {
  factory: (cwd: string) => AppServerTransport;
  calls: () => number;
} {
  let calls = 0;
  return {
    factory: () => {
      calls++;
      return make();
    },
    calls: () => calls,
  };
}

test('a first read handshakes once and returns the parsed window', async () => {
  const transport = respondingTransport({ 'account/rateLimits/read': READ_RESULT });
  const monitor = new CodexRateLimitMonitor(() => transport);

  const limits = await monitor.read(config(), CWD);

  assert.equal(limits?.usedPercent, 15);
  assert.equal(transport.sentFor('initialize').length, 1);
  assert.equal(transport.sentFor('initialized').length, 1);
  assert.equal(transport.sentFor('account/rateLimits/read').length, 1);
  monitor.close();
});

test('a second read inside the TTL is served from the cache', async () => {
  const transport = respondingTransport({ 'account/rateLimits/read': READ_RESULT });
  const monitor = new CodexRateLimitMonitor(() => transport);

  await monitor.read(config(), CWD);
  await monitor.read(config(), CWD);

  assert.equal(transport.sentFor('account/rateLimits/read').length, 1);
  monitor.close();
});

test('invalidate forces the next read back to the server', async () => {
  // The wait path depends on this: budget.maxWaitMinutes may legally be below
  // the cache TTL, so a retry that reused the cached "reached" snapshot would
  // never see the window clear.
  const transport = respondingTransport({ 'account/rateLimits/read': READ_RESULT });
  const monitor = new CodexRateLimitMonitor(() => transport);

  await monitor.read(config(), CWD);
  monitor.invalidate();
  await monitor.read(config(), CWD);

  assert.equal(transport.sentFor('account/rateLimits/read').length, 2);
  assert.equal(transport.sentFor('initialize').length, 1);
  monitor.close();
});

test('a pushed update refreshes the snapshot without a request', async () => {
  const transport = respondingTransport({ 'account/rateLimits/read': READ_RESULT });
  const monitor = new CodexRateLimitMonitor(() => transport);

  await monitor.read(config(), CWD);
  transport.emit({
    method: 'account/rateLimits/updated',
    params: { rateLimits: { primary: { usedPercent: 42, windowDurationMins: 10080 } } },
  });
  const limits = await monitor.read(config(), CWD);

  assert.equal(limits?.usedPercent, 42);
  assert.equal(transport.sentFor('account/rateLimits/read').length, 1);
  monitor.close();
});

test('a child that dies after a good read disables the monitor and drops its snapshot', async () => {
  // The stale-data bug: nothing was in flight for the transport close to reject,
  // so the cached reading kept being served from a process that had exited.
  const { factory, calls } = countingFactory(() =>
    respondingTransport({ 'account/rateLimits/read': READ_RESULT }),
  );
  let live: FakeTransport | null = null;
  const monitor = new CodexRateLimitMonitor((cwd) => {
    const transport = factory(cwd) as FakeTransport;
    live = transport;
    return transport;
  });

  assert.equal((await monitor.read(config(), CWD))?.usedPercent, 15);
  assert.ok(live !== null);
  (live as FakeTransport).emitClose('exited with code 1');

  assert.equal(await monitor.read(config(), CWD), null);
  assert.equal(calls(), 1);
});

test('a client that cannot register its stream callbacks closes the transport', async () => {
  const transport = new FakeTransport();
  transport.failRegistration = true;
  const monitor = new CodexRateLimitMonitor(() => transport);

  assert.equal(await monitor.read(config(), CWD), null);
  assert.equal(transport.closed, true);
});

test('a cached reading of a reached limit is never reused', async () => {
  // The one state that changes what the run does must not come from a cache:
  // the retry after a wait has to be able to see the window clear.
  const reached = {
    rateLimits: {
      primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: futureEpoch() },
      rateLimitReachedType: 'primary',
    },
  };
  const transport = respondingTransport({ 'account/rateLimits/read': reached });
  const monitor = new CodexRateLimitMonitor(() => transport);

  await monitor.read(config(), CWD);
  await monitor.read(config(), CWD);

  assert.equal(transport.sentFor('account/rateLimits/read').length, 2);
  monitor.close();
});

test('a cached reading whose window has since reset is never reused', async () => {
  const expired = {
    rateLimits: { primary: { usedPercent: 96, windowDurationMins: 300, resetsAt: pastEpoch() } },
  };
  const transport = respondingTransport({ 'account/rateLimits/read': expired });
  const monitor = new CodexRateLimitMonitor(() => transport);

  await monitor.read(config(), CWD);
  await monitor.read(config(), CWD);

  assert.equal(transport.sentFor('account/rateLimits/read').length, 2);
  monitor.close();
});

test('an ordinary reading is still served from the cache', async () => {
  const healthy = {
    rateLimits: { primary: { usedPercent: 15, windowDurationMins: 10080, resetsAt: futureEpoch() } },
  };
  const transport = respondingTransport({ 'account/rateLimits/read': healthy });
  const monitor = new CodexRateLimitMonitor(() => transport);

  await monitor.read(config(), CWD);
  await monitor.read(config(), CWD);

  assert.equal(transport.sentFor('account/rateLimits/read').length, 1);
  monitor.close();
});

test('a factory that throws synchronously disables the monitor for the run', async () => {
  // codexBin() throws a plain Error when codex cannot be located, before any
  // child exists to reject a promise.
  let calls = 0;
  const monitor = new CodexRateLimitMonitor(() => {
    calls++;
    throw new Error('Could not locate "codex"');
  });

  assert.equal(await monitor.read(config(), CWD), null);
  assert.equal(await monitor.read(config(), CWD), null);
  assert.equal(calls, 1);
});

test('a handshake timeout closes the transport instead of stranding the child', async () => {
  const transport = new FakeTransport();
  const monitor = new CodexRateLimitMonitor(() => transport, { handshakeTimeoutMs: 20 });

  // A never-answered initialize is the shape that used to leak: the rejection
  // carried the only reference to the spawned app-server.
  assert.equal(await monitor.read(config(), CWD), null);
  assert.equal(transport.closed, true);
});

test('a read that hangs times out on the request budget, not the handshake one', async () => {
  const transport = respondingTransport({});
  const monitor = new CodexRateLimitMonitor(() => transport, {
    handshakeTimeoutMs: 60_000,
    requestTimeoutMs: 20,
  });

  const started = Date.now();
  assert.equal(await monitor.read(config(), CWD), null);
  assert.ok(Date.now() - started < 5_000);
  assert.equal(transport.sentFor('account/rateLimits/read').length, 1);
});

test('a handshake that errors closes the transport', async () => {
  const transport = respondingTransport({}, { failInitialize: 'Not initialized' });
  const monitor = new CodexRateLimitMonitor(() => transport);

  assert.equal(await monitor.read(config(), CWD), null);
  assert.equal(transport.closed, true);
});

test('a transport that closes before responding disables the monitor', async () => {
  const transport = respondingTransport({}, { closeOnInitialize: true });
  const { factory, calls } = countingFactory(() => transport);
  const monitor = new CodexRateLimitMonitor(factory);

  assert.equal(await monitor.read(config(), CWD), null);
  assert.equal(await monitor.read(config(), CWD), null);
  assert.equal(calls(), 1);
  assert.equal(transport.closed, true);
});

test('a read that fails after a good handshake disables the monitor', async () => {
  const transport = respondingTransport({});
  transport.onSend = (msg, t) => {
    const id = msg['id'];
    if (typeof id !== 'number') return;
    if (msg['method'] === 'initialize') t.emit({ id, result: {} });
    if (msg['method'] === 'account/rateLimits/read') {
      t.emit({ id, error: { code: -32000, message: 'not logged in' } });
    }
  };
  const monitor = new CodexRateLimitMonitor(() => transport);

  assert.equal(await monitor.read(config(), CWD), null);
  assert.equal(await monitor.read(config(), CWD), null);
  assert.equal(transport.sentFor('account/rateLimits/read').length, 1);
});

test('the config switch skips the connection entirely', async () => {
  const { factory, calls } = countingFactory(() => new FakeTransport());
  const monitor = new CodexRateLimitMonitor(factory);

  assert.equal(await monitor.read(config(false), CWD), null);
  assert.equal(calls(), 0);
});

test('close is final: a later read does not reconnect', async () => {
  const { factory, calls } = countingFactory(() =>
    respondingTransport({ 'account/rateLimits/read': READ_RESULT }),
  );
  const monitor = new CodexRateLimitMonitor(factory);

  await monitor.read(config(), CWD);
  monitor.close();
  monitor.close();

  assert.equal(await monitor.read(config(), CWD), null);
  assert.equal(calls(), 1);
});
