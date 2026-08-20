import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppServerClient, AppServerUnavailableError } from '@src/appserver.js';
import { FakeTransport } from './helpers/fake-transport.js';

const TIMEOUTS = { handshakeTimeoutMs: 1000, requestTimeoutMs: 1000 };

test('handshake sends clientInfo first and initialized only after the response', async () => {
  const transport = new FakeTransport();
  const client = new AppServerClient(transport, TIMEOUTS);

  const done = client.handshake();
  // The failure this guards against: omitting clientInfo makes every later call
  // fail with -32600 Not initialized.
  const init = transport.sent[0];
  assert.equal(init?.['method'], 'initialize');
  assert.deepEqual(init?.['params'], { clientInfo: { name: 'vibe', title: 'vibe', version: '1' } });
  assert.equal(transport.sentFor('initialized').length, 0);

  transport.emit({ id: init?.['id'] as number, result: {} });
  await done;

  assert.equal(transport.sent[1]?.['method'], 'initialized');
  client.close();
});

test('responses are correlated by id even when they arrive out of order', async () => {
  const transport = new FakeTransport();
  const client = new AppServerClient(transport, TIMEOUTS);

  const first = client.request('account/rateLimits/read');
  const second = client.request('account/read');
  const firstId = transport.sent[0]?.['id'] as number;
  const secondId = transport.sent[1]?.['id'] as number;

  transport.emit({ id: secondId, result: 'second' });
  transport.emit({ id: firstId, result: 'first' });

  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  client.close();
});

test('a JSON-RPC error rejects with AppServerUnavailableError', async () => {
  const transport = new FakeTransport();
  const client = new AppServerClient(transport, TIMEOUTS);

  const pending = client.request('account/rateLimits/read');
  transport.emit({
    id: transport.sent[0]?.['id'] as number,
    error: { code: -32600, message: 'Not initialized' },
  });

  await assert.rejects(pending, (err: unknown) => {
    assert.ok(err instanceof AppServerUnavailableError);
    assert.match(err.message, /-32600.*Not initialized/);
    return true;
  });
  client.close();
});

test('a transport close rejects a request in flight rather than hanging', async () => {
  const transport = new FakeTransport();
  const client = new AppServerClient(transport, TIMEOUTS);

  const pending = client.request('account/rateLimits/read');
  transport.emitClose('exited with code 1');

  await assert.rejects(pending, AppServerUnavailableError);
  client.close();
});

test('the request timeout applies to calls after the handshake', async () => {
  const transport = new FakeTransport();
  const client = new AppServerClient(transport, { handshakeTimeoutMs: 60_000, requestTimeoutMs: 20 });

  const started = Date.now();
  await assert.rejects(client.request('account/rateLimits/read'), (err: unknown) => {
    assert.ok(err instanceof AppServerUnavailableError);
    // The distinct-timeout requirement: a read must not inherit the much longer
    // handshake budget, or a hung read stalls the turn it was meant to protect.
    assert.match(err.message, /timed out after 20ms/);
    return true;
  });
  assert.ok(Date.now() - started < 5_000);
  client.close();
});

test('the handshake timeout is the one that applies to initialize', async () => {
  const transport = new FakeTransport();
  const client = new AppServerClient(transport, { handshakeTimeoutMs: 20, requestTimeoutMs: 60_000 });

  await assert.rejects(client.handshake(), (err: unknown) => {
    assert.ok(err instanceof AppServerUnavailableError);
    assert.match(err.message, /initialize timed out after 20ms/);
    return true;
  });
  client.close();
});

test('a notification reaches its handler, and a throwing handler does not escape', () => {
  const transport = new FakeTransport();
  const client = new AppServerClient(transport, TIMEOUTS);

  const seen: unknown[] = [];
  client.onNotification('account/rateLimits/updated', () => {
    throw new Error('handler fault');
  });
  client.onNotification('account/rateLimits/updated', (params) => seen.push(params));

  // A throw here would reach a stream 'data' event, where it is an unhandled
  // exception rather than a rejected promise.
  transport.emit({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex' } } });

  assert.deepEqual(seen, [{ rateLimits: { limitId: 'codex' } }]);
  client.close();
});

test('close is idempotent and settles a pending request exactly once', async () => {
  const transport = new FakeTransport();
  const client = new AppServerClient(transport, TIMEOUTS);

  const pending = client.request('account/rateLimits/read');
  client.close();
  client.close();

  await assert.rejects(pending, AppServerUnavailableError);
  assert.equal(transport.closed, true);
  await assert.rejects(client.request('account/rateLimits/read'), AppServerUnavailableError);
});
