import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as schemas from '@src/schemas.js';
import { EVIDENCE_RULE, FINDINGS_SCHEMA, REPRODUCER_RULE, VOTE_SCHEMA } from '@src/schemas.js';
import { parseFindings, parseVote } from '@src/validate.js';

/**
 * Filler first, content last (#416).
 *
 * The key order of a strict schema is the order the model writes the keys in.
 * With `reproducer` last in a finding and `ref` last in an evidence entry - both
 * usually null, both after the content - 149 of the archive's 150 blank runs sat
 * just before one of them, and twice a run never stopped and used up the whole
 * output limit. `schema-shape.test.ts` is order-blind on purpose; this file is
 * what pins the order, so a reorder back is a red test rather than a stall.
 */

const finding = FINDINGS_SCHEMA.properties.findings.items;
const evidence = finding.properties.evidence.items;
const reproducer = finding.properties.reproducer;

test('a finding ends on its evidence, with the reproducer before it', () => {
  const order = ['id', 'severity', 'title', 'detail', 'suggested_fix', 'defer', 'reproducer', 'evidence'];
  assert.deepEqual(Object.keys(finding.properties), order);
  assert.deepEqual([...finding.required], order);
});

test('an evidence entry ends on its excerpt, with ref second', () => {
  const order = ['kind', 'ref', 'path', 'line', 'excerpt'];
  assert.deepEqual(Object.keys(evidence.properties), order);
  assert.deepEqual([...evidence.required], order);
  // A vote's citations are the same object, so they get the same order.
  assert.equal(VOTE_SCHEMA.properties.evidence.items, evidence);
});

test('a reproducer starts with its gate, which is null when there is one gate', () => {
  const order = ['gate', 'path', 'contents'];
  assert.deepEqual(Object.keys(reproducer.properties), order);
  assert.deepEqual([...reproducer.required], order);
});

test('no description of a required field begins "Optional"', () => {
  // Every key of a strict schema is required, so "Optional" only ever told the
  // model it could leave out a key the schema would not let it leave out.
  const offenders: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${at}[${i}]`));
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const o = node as Record<string, unknown>;
    const required = o['required'];
    const properties = o['properties'];
    if (Array.isArray(required) && typeof properties === 'object' && properties !== null) {
      for (const key of required) {
        const prop = (properties as Record<string, unknown>)[String(key)];
        const description = typeof prop === 'object' && prop !== null ? (prop as Record<string, unknown>)['description'] : undefined;
        if (typeof description === 'string' && /^\s*Optional/.test(description)) offenders.push(`${at}.${String(key)}`);
      }
    }
    for (const [k, v] of Object.entries(o)) walk(v, `${at}.${k}`);
  };
  for (const [name, value] of Object.entries(schemas)) walk(value, name);
  assert.deepEqual(offenders, []);
});

test('REPRODUCER_RULE says the field is always written, and keeps both costs', () => {
  assert.ok(!REPRODUCER_RULE.includes('Omitting it costs nothing'));
  assert.ok(!REPRODUCER_RULE.startsWith('Optional'));
  assert.match(REPRODUCER_RULE, /^Always written: null unless/);
  // What a null one costs, and what a passing one costs.
  assert.match(REPRODUCER_RULE, /judged exactly as findings have always been judged/);
  assert.match(REPRODUCER_RULE, /downgraded to P2/);
});

test('the evidence description ends on the example, written in the new order', () => {
  const description = finding.properties.evidence.description;
  assert.ok(description.startsWith(EVIDENCE_RULE), 'the rule comes first, unchanged');
  assert.ok(
    description.includes(
      '"defer":false,"reproducer":null,"evidence":[{"kind":"code","ref":null,"path":"src/x.ts","line":12,"excerpt":"…"}]}',
    ),
  );
  // The vote's array keeps its own description, with no example.
  assert.ok(!VOTE_SCHEMA.properties.evidence.description.includes('"reproducer":null'));
});

test('EVIDENCE_RULE is byte-identical to what the frozen prompt fixtures render', () => {
  // sha256 of the constant at 010557e: the example goes in the schema, never in
  // the rule, so the three review fixtures that render it do not move.
  assert.equal(
    createHash('sha256').update(EVIDENCE_RULE).digest('hex'),
    'd899abd28bfca8b4e41057849e0566d8d1cf18fd82282a4b04425523a9c3e742',
  );
});

test('a review in the old key order parses exactly as the same review in the new order', () => {
  // Old runs' outputs were written in the old order and must still load.
  const old =
    '{"verdict":"REVISE","summary":"s","findings":[{"id":"a","severity":"P1","title":"t","detail":"d",' +
    '"suggested_fix":"f","defer":false,"evidence":[{"kind":"code","path":"src/x.ts","line":3,' +
    '"excerpt":"x","ref":null}],"reproducer":{"path":"tests/a.test.ts","contents":"c","gate":null}}]}';
  const now =
    '{"verdict":"REVISE","summary":"s","findings":[{"id":"a","severity":"P1","title":"t","detail":"d",' +
    '"suggested_fix":"f","defer":false,"reproducer":{"gate":null,"path":"tests/a.test.ts","contents":"c"},' +
    '"evidence":[{"kind":"code","ref":null,"path":"src/x.ts","line":3,"excerpt":"x"}]}]}';
  assert.deepEqual(parseFindings(JSON.parse(old)), parseFindings(JSON.parse(now)));

  const oldVote = '{"vote":"not-real","reason":"r","evidence":[{"kind":"code","path":"src/x.ts","line":3,"excerpt":"x","ref":null}]}';
  const newVote = '{"vote":"not-real","reason":"r","evidence":[{"kind":"code","ref":null,"path":"src/x.ts","line":3,"excerpt":"x"}]}';
  // `parseVote` hands evidence back as given, so compare what it would ground.
  const a = parseVote(JSON.parse(oldVote));
  const b = parseVote(JSON.parse(newVote));
  assert.equal(a.vote, b.vote);
  assert.equal(a.reason, b.reason);
  assert.deepEqual(a.evidence, b.evidence, 'deepEqual is key-order blind, as the readers are');
});
