import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANSWERS_SCHEMA, FINDINGS_SCHEMA, PLAN_SCHEMA } from '@src/schemas.js';
import { readEvidenceEntry } from '@src/validate.js';

/**
 * The wire-format rules the schemas must satisfy, checked offline.
 *
 * These schemas are the one thing in the repo that a provider validates and
 * this test suite cannot: `AGENTS.md` forbids real agent invocations, so
 * nothing here ever asked OpenAI whether it would accept what `src/schemas.ts`
 * emits. #68 is what that cost - `FINDINGS_SCHEMA` grew an evidence item whose
 * `required` listed one of its five properties, Codex answered
 * `invalid_json_schema` with HTTP 400 on `text.format.schema`, and every
 * critique and every review on develop died in the same way, 1.8M tokens into a
 * run, before the model was reached.
 *
 * It could not have been caught by a run either: a `vibe` run is driven by the
 * *published* build while the change under test sits in a worktree, so a new
 * schema is never sent to a provider until develop is rebuilt.
 *
 * So the rule is asserted structurally instead. It is the offline stand-in for
 * a request nobody is allowed to make from a test.
 */

const SCHEMAS: ReadonlyArray<readonly [string, unknown]> = [
  ['PLAN_SCHEMA', PLAN_SCHEMA],
  ['FINDINGS_SCHEMA', FINDINGS_SCHEMA],
  ['ANSWERS_SCHEMA', ANSWERS_SCHEMA],
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every node in a schema, with a JSON-pointer-ish path for the failure message. */
function* walk(node: unknown, at: string): Generator<readonly [string, Record<string, unknown>]> {
  if (Array.isArray(node)) {
    for (const [i, child] of node.entries()) yield* walk(child, `${at}[${i}]`);
    return;
  }
  if (!isRecord(node)) return;
  yield [at, node];
  for (const [key, child] of Object.entries(node)) yield* walk(child, `${at}.${key}`);
}

test('every closed object lists all of its properties as required', () => {
  // OpenAI structured outputs: an object with `additionalProperties: false`
  // must have `required` covering every key in `properties`. Optionality is
  // expressed by a nullable *type*, never by omitting the key.
  for (const [name, schema] of SCHEMAS) {
    for (const [at, node] of walk(schema, name)) {
      if (node['additionalProperties'] !== false) continue;
      const properties = node['properties'];
      if (!isRecord(properties)) continue;

      const required = node['required'];
      assert.ok(
        Array.isArray(required),
        `${at} is a closed object with properties but no \`required\` array`,
      );
      const missing = Object.keys(properties).filter((k) => !(required as unknown[]).includes(k));
      assert.deepEqual(
        missing,
        [],
        `${at} omits ${missing.join(', ')} from \`required\`; make the type nullable instead`,
      );
    }
  }
});

test('nothing in required is absent from properties', () => {
  // The other direction. A provider will not complain, but a required key with
  // no schema is a field the model is told to emit and nothing describes.
  for (const [name, schema] of SCHEMAS) {
    for (const [at, node] of walk(schema, name)) {
      const required = node['required'];
      const properties = node['properties'];
      if (!Array.isArray(required) || !isRecord(properties)) continue;
      const unknownKeys = required.filter((k) => typeof k === 'string' && !(k in properties));
      assert.deepEqual(unknownKeys, [], `${at} requires ${unknownKeys.join(', ')} but defines no schema for it`);
    }
  }
});

test('the evidence item is the shape #68 needed, not the shape that 400d', () => {
  const item = FINDINGS_SCHEMA.properties.findings.items.properties.evidence.items;
  assert.deepEqual([...item.required].sort(), ['excerpt', 'kind', 'line', 'path', 'ref']);
  // `kind` stays a plain enum: it is the one field that is never absent.
  assert.equal(item.properties.kind.type, 'string');
  for (const key of ['path', 'excerpt', 'ref'] as const) {
    assert.deepEqual(item.properties[key].type, ['string', 'null'], `${key} must be nullable`);
  }
  assert.deepEqual(item.properties.line.type, ['integer', 'null']);
});

test('an explicit null reads exactly as an omitted field', () => {
  // What the nullable types cost at runtime: nothing. The model now emits
  // `path: null` where it used to omit the key, and `readEvidenceEntry` must
  // produce the same citation either way - otherwise `groundFindings` would
  // start seeing `external` entries carrying a null path.
  const spelled = readEvidenceEntry({
    kind: 'external',
    path: null,
    line: null,
    excerpt: null,
    ref: 'https://example.invalid/spec',
  });
  const omitted = readEvidenceEntry({ kind: 'external', ref: 'https://example.invalid/spec' });
  assert.deepEqual(spelled, omitted);
  assert.deepEqual(spelled, { kind: 'external', ref: 'https://example.invalid/spec' });

  const code = readEvidenceEntry({
    kind: 'code',
    path: 'src/run.ts',
    line: 12,
    excerpt: null,
    ref: null,
  });
  assert.deepEqual(code, { kind: 'code', path: 'src/run.ts', line: 12 });
});
