import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cutOffNote, findingsItemSchema, inWireShape, salvageFindings } from '@src/cutoff.js';
import { ANSWERS_SCHEMA, FINDINGS_SCHEMA, REVIEW_SCHEMA, VOTE_SCHEMA } from '@src/schemas.js';
import type { Finding } from '@src/types.js';
import { parseFinding } from '@src/validate.js';

/**
 * What the retry of a cut-off turn is shown (#429): the findings the cut-off
 * attempt wrote in full, laid out as the turn's schema puts them on the wire,
 * and wording that fits the schema the turn was sent with.
 *
 * `parseFinding` gives vibe's own shape - `reproducer` after `evidence`, null
 * keys dropped - so a note rendered from it showed the retry the order #416
 * removed, straight after the schema told it to write every key.
 */

const ITEM = FINDINGS_SCHEMA.properties.findings.items;
const EVIDENCE_ITEM = ITEM.properties.evidence.items;
const REPRODUCER = ITEM.properties.reproducer;

/** An `external` finding with no reproducer: the shape with the most nulls. */
const EXTERNAL =
  '{"id":"external-one","severity":"P1","title":"t","detail":"d","suggested_fix":"f","defer":false,' +
  '"reproducer":null,"evidence":[{"kind":"external","ref":"https://example.invalid/spec","path":null,"line":null,"excerpt":null}]}';

/** The JSON block of a note, parsed. */
function shown(note: string): Record<string, unknown>[] {
  const m = /```json\n([\s\S]*)\n```$/.exec(note);
  assert.ok(m?.[1] !== undefined, `no JSON block in:\n${note}`);
  return JSON.parse(m[1]) as Record<string, unknown>[];
}

test('the note shows a salvaged finding in the schema order, with every key and its nulls', () => {
  const finding = parseFinding(JSON.parse(EXTERNAL) as unknown, 0);
  // The internal shape is what the defect was: no null keys, no reproducer key.
  assert.equal('reproducer' in finding, false);

  const [f] = shown(cutOffNote([finding], FINDINGS_SCHEMA));
  assert.ok(f !== undefined);
  // Against both lists the schema carries: if `properties` and `required` ever
  // disagree, or the note stops following them, this fails.
  assert.deepEqual(Object.keys(f), Object.keys(ITEM.properties));
  assert.deepEqual(Object.keys(f), [...ITEM.required]);
  assert.equal(f['reproducer'], null);

  const evidence = f['evidence'] as Record<string, unknown>[];
  assert.equal(evidence.length, 1);
  const [e] = evidence;
  assert.ok(e !== undefined);
  assert.deepEqual(Object.keys(e), Object.keys(EVIDENCE_ITEM.properties));
  assert.deepEqual(Object.keys(e), [...EVIDENCE_ITEM.required]);
  assert.deepEqual(e, { kind: 'external', ref: 'https://example.invalid/spec', path: null, line: null, excerpt: null });

  // And it is exactly what the model wrote: the wire shape round-trips.
  assert.deepEqual(f, JSON.parse(EXTERNAL));
});

test('a reproducer is shown in its schema order, its missing gate as null', () => {
  const finding: Finding = {
    ...parseFinding(JSON.parse(EXTERNAL) as unknown, 0),
    reproducer: { path: 'tests/r.test.ts', contents: 'test()' },
  };
  const [f] = shown(cutOffNote([finding], FINDINGS_SCHEMA));
  const reproducer = f?.['reproducer'] as Record<string, unknown>;
  assert.deepEqual(Object.keys(reproducer), [...REPRODUCER.required]);
  assert.deepEqual(reproducer, { gate: null, path: 'tests/r.test.ts', contents: 'test()' });
});

test("keys vibe adds are left out, and a finding with no usable citation shows an empty list", () => {
  const finding: Finding = {
    id: 'no-citation',
    severity: 'P2',
    title: 't',
    detail: 'd',
    suggested_fix: 'f',
    defer: false,
    raisedBy: 'reviewer',
  };
  const [f] = shown(cutOffNote([finding], REVIEW_SCHEMA));
  assert.ok(f !== undefined);
  assert.deepEqual(Object.keys(f), Object.keys(ITEM.properties));
  assert.equal('raisedBy' in f, false);
  assert.deepEqual(f['evidence'], []);
});

test('the order is read from the schema, not restated', () => {
  // A schema with the finding's keys reversed reverses the note: there is no
  // second list in `cutoff.ts` for the two to drift apart on.
  const reversed = Object.fromEntries(Object.entries(ITEM.properties).reverse());
  const schema = { properties: { findings: { items: { ...ITEM, properties: reversed } } } };
  const finding = parseFinding(JSON.parse(EXTERNAL) as unknown, 0);
  const [f] = shown(cutOffNote([finding], schema));
  assert.ok(f !== undefined);
  assert.deepEqual(Object.keys(f), Object.keys(ITEM.properties).reverse());
  assert.deepEqual(findingsItemSchema(schema), { ...ITEM, properties: reversed });
  assert.equal(inWireShape('plain', ITEM), 'plain', 'a value that is not an object passes through');
});

test('a schema with findings keeps its wording, byte for byte', () => {
  assert.equal(
    cutOffNote([], FINDINGS_SCHEMA),
    '## An earlier attempt at this turn was cut off\n\n' +
      'An earlier attempt at this turn was cut off at its output limit before it finished. ' +
      'It had not written any finding in full.',
  );
  assert.equal(cutOffNote([], REVIEW_SCHEMA), cutOffNote([], FINDINGS_SCHEMA));
});

test('an answerer or a verifier is told only that it was cut off, with nothing about findings', () => {
  const finding = parseFinding(JSON.parse(EXTERNAL) as unknown, 0);
  for (const [name, schema] of [
    ['ANSWERS_SCHEMA', ANSWERS_SCHEMA],
    ['VOTE_SCHEMA', VOTE_SCHEMA],
    ['no schema', undefined],
  ] as const) {
    assert.equal(findingsItemSchema(schema), null, name);
    for (const findings of [[], [finding]]) {
      const note = cutOffNote(findings, schema);
      assert.equal(
        note,
        '## An earlier attempt at this turn was cut off\n\n' +
          'An earlier attempt at this turn was cut off at its output limit before it finished.',
        name,
      );
      assert.doesNotMatch(note, /finding/i, name);
    }
  }
});

test('salvage finds nothing in a cut-off answer or vote, so their retries carry none', () => {
  // Their schemas have no top-level `findings`: the scan reaches the end and
  // gives an empty list, including where a string happens to say "findings".
  const answers =
    '{"answers":[{"question":"Which findings?","answer":"findings","confidence":"high",' +
    `"defer_to_human":false,"rationale":"r"},${' \n'.repeat(3_000)}`;
  const vote =
    '{"vote":"not-real","reason":"findings","evidence":[{"kind":"code","ref":null,"path":"src/x.ts",' +
    `"line":1,"excerpt":"x"}${' '.repeat(3_000)}`;
  assert.deepEqual(salvageFindings(answers), []);
  assert.deepEqual(salvageFindings(vote), []);
});
