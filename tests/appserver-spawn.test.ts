import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppServerClient, AppServerUnavailableError, spawnCodexAppServer } from '@src/appserver.js';
import { CodexRateLimitMonitor } from '@src/ratelimits.js';
import { DEFAULTS } from '@src/config.js';
import { isAlive, waitFor, writeStub } from './helpers/stub-server.js';

/**
 * The one place a real child is spawned.
 *
 * It is a node stub, not `codex` - no account, no network, no seconds of
 * startup - but everything below the transport seam is the production path:
 * the shim/shell rule, the argument vector, stdout framing across writes, the
 * child-exit route into a rejected request, and the cleanup on close. Every
 * assertion is bounded by a timeout so a broken transport fails rather than
 * hanging the suite.
 */
const TIMEOUTS = { handshakeTimeoutMs: 5000, requestTimeoutMs: 5000 };

test('a spawned app-server completes a handshake and answers a read', async () => {
  const stub = writeStub('ok');
  const client = new AppServerClient(spawnCodexAppServer(stub.bin, stub.dir), TIMEOUTS);

  try {
    await client.handshake();
    const result = await client.request('account/rateLimits/read');
    const rateLimits = (result as { rateLimits: { planType: string } }).rateLimits;

    assert.equal(rateLimits.planType, 'plus');
  } finally {
    client.close();
  }
});

test('non-JSON on stdout does not break the exchange', async () => {
  // app-server is experimental; a warning line on stdout must be skipped rather
  // than treated as a protocol failure.
  const stub = writeStub('noise');
  const client = new AppServerClient(spawnCodexAppServer(stub.bin, stub.dir), TIMEOUTS);

  try {
    await client.handshake();
    assert.ok(await client.request('account/rateLimits/read'));
  } finally {
    client.close();
  }
});

test('a child that exits rejects the request in flight', async () => {
  const stub = writeStub('exit');
  const client = new AppServerClient(spawnCodexAppServer(stub.bin, stub.dir), TIMEOUTS);

  try {
    await assert.rejects(client.handshake(), AppServerUnavailableError);
    assert.equal(client.isClosed, true);
  } finally {
    client.close();
  }
});

test('close kills the spawned process, including behind a shim', async () => {
  const stub = writeStub('ok');
  const transport = spawnCodexAppServer(stub.bin, stub.dir);
  const client = new AppServerClient(transport, TIMEOUTS);
  await client.handshake();

  const pid = stub.pid();
  assert.ok(pid !== null && isAlive(pid), 'the stub should be running');

  client.close();

  // On Windows the shim is a .cmd, so the node process under test is the
  // grandchild: killing only the spawned process would leave it running and
  // holding vibe's pipes open.
  assert.equal(await waitFor(() => !isAlive(pid)), true, 'the child should be gone after close');
});

test('the monitor reads a real spawned child end to end and cleans it up', async () => {
  const stub = writeStub('ok');
  const monitor = new CodexRateLimitMonitor((cwd) => spawnCodexAppServer(stub.bin, cwd));
  const cfg = DEFAULTS;

  try {
    const limits = await monitor.read(cfg, stub.dir);
    assert.equal(limits?.usedPercent, 15);
    assert.equal(limits?.planType, 'plus');
  } finally {
    monitor.close();
  }

  const pid = stub.pid();
  assert.ok(pid !== null);
  assert.equal(await waitFor(() => !isAlive(pid)), true, 'the monitor should clean up its child');
});
