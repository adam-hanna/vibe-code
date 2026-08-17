import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMessage, LineDecoder, parseIncoming } from '@src/appserver.js';

test('encodeMessage ends in exactly one newline and embeds none', () => {
  const line = encodeMessage({ method: 'initialize', id: 0, params: { text: 'a\nb' } });

  assert.equal(line.endsWith('\n'), true);
  assert.equal(line.slice(0, -1).includes('\n'), false);
  assert.deepEqual(JSON.parse(line), { method: 'initialize', id: 0, params: { text: 'a\nb' } });
});

test('LineDecoder reassembles a message split across chunks', () => {
  const decoder = new LineDecoder();

  assert.deepEqual(decoder.push('{"id":'), []);
  assert.deepEqual(decoder.push('1,"result"'), []);
  assert.deepEqual(decoder.push(':null}\n'), ['{"id":1,"result":null}']);
});

test('LineDecoder splits two messages arriving in one chunk', () => {
  const decoder = new LineDecoder();

  assert.deepEqual(decoder.push('{"a":1}\n{"b":2}\n'), ['{"a":1}', '{"b":2}']);
});

test('LineDecoder handles CRLF endings and drops blank lines', () => {
  const decoder = new LineDecoder();

  assert.deepEqual(decoder.push('{"a":1}\r\n\r\n{"b":2}\r\n'), ['{"a":1}', '{"b":2}']);
});

test('LineDecoder reassembles a message larger than any plausible chunk', () => {
  const decoder = new LineDecoder();
  const big = JSON.stringify({ id: 1, result: { blob: 'x'.repeat(100_000) } });

  const chunks = big.match(/.{1,4096}/g) ?? [];
  for (const chunk of chunks) assert.deepEqual(decoder.push(chunk), []);

  assert.deepEqual(decoder.push('\n'), [big]);
});

test('parseIncoming reads a response that omits the jsonrpc member', () => {
  const incoming = parseIncoming('{"id":6,"result":{"rateLimits":{"limitId":"codex"}}}');

  assert.equal(incoming?.kind, 'response');
  assert.equal(incoming?.kind === 'response' && incoming.id, 6);
  assert.deepEqual(incoming?.kind === 'response' ? incoming.result : null, {
    rateLimits: { limitId: 'codex' },
  });
});

test('parseIncoming reads the Not initialized error with its code', () => {
  const incoming = parseIncoming('{"id":2,"error":{"code":-32600,"message":"Not initialized"}}');

  assert.equal(incoming?.kind, 'error');
  if (incoming?.kind !== 'error') return;
  assert.equal(incoming.code, -32600);
  assert.equal(incoming.message, 'Not initialized');
});

test('parseIncoming reads a rate-limit notification', () => {
  const incoming = parseIncoming(
    '{"method":"account/rateLimits/updated","params":{"rateLimits":{"limitId":"codex"}}}',
  );

  assert.equal(incoming?.kind, 'notification');
  assert.equal(incoming?.kind === 'notification' && incoming.method, 'account/rateLimits/updated');
});

test('parseIncoming ignores a server-initiated request', () => {
  assert.equal(parseIncoming('{"id":9,"method":"item/askForApproval","params":{}}'), null);
});

test('parseIncoming ignores anything that is not a JSON-RPC message', () => {
  assert.equal(parseIncoming('warning: experimental interface'), null);
  assert.equal(parseIncoming('[]'), null);
  assert.equal(parseIncoming('"a string"'), null);
  assert.equal(parseIncoming('{"id":1}'), null);
});
