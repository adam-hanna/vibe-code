import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collapseBlankRuns, cutOffNote, salvageFindings, trailingBlank } from '@src/cutoff.js';
import { emptySnapshot, parseCodexLine } from '@src/progress.js';
import { FINDINGS_SCHEMA } from '@src/schemas.js';
import { parseFinding } from '@src/validate.js';

/**
 * What a cut-off Codex answer is allowed to keep: the findings it wrote in
 * full, read as written, and nothing that vibe would have had to finish for it
 * (#416). And the blank space it ended on, shortened wherever a person reads it.
 */

const whole = (id: string, severity = 'P1'): string =>
  `{"id":"${id}","severity":"${severity}","title":"title ${id}","detail":"a } and a ] inside a string",` +
  `"suggested_fix":"fix it","defer":false,"reproducer":null,` +
  `"evidence":[{"kind":"code","ref":null,"path":"src/x.ts","line":12,"excerpt":"if (a) {"}]}`;

test('the #389 shape - one whole finding, then a comma and blank space - gives that finding', () => {
  const text = `{"verdict":"REVISE","summary":"three findings","findings":[${whole('one')},${' '.repeat(5_000)}`;
  const got = salvageFindings(text);
  assert.equal(got.length, 1);
  // Never filled in: exactly what parsing the written object yields.
  assert.deepEqual(got[0], parseFinding(JSON.parse(whole('one')) as unknown, 0));
});

test('the #393 shape - cut inside the first evidence entry - gives none', () => {
  const text =
    '{"verdict":"REVISE","summary":"s","findings":[{"id":"one","severity":"P1","title":"t",' +
    '"detail":"d","suggested_fix":"f","defer":false,"reproducer":null,' +
    `"evidence":[{"kind":"code","path":"src/x.ts","line":3,"excerpt":"const a = 1;"${' '.repeat(5_000)}`;
  assert.deepEqual(salvageFindings(text), []);
});

test('every whole finding is kept, in order, and the incomplete one after them is not', () => {
  const text = `{"verdict":"REVISE","summary":"s","findings":[${whole('a')} , ${whole('b')},{"id":"c","sev`;
  assert.deepEqual(
    salvageFindings(text).map((f) => f.id),
    ['a', 'b'],
  );
});

test('a whole element that parseFinding refuses is dropped, never repaired', () => {
  const bad = whole('bad', 'P9');
  const text = `{"verdict":"REVISE","summary":"s","findings":[${bad},${whole('good')},`;
  assert.deepEqual(
    salvageFindings(text).map((f) => f.id),
    ['good'],
  );
});

test('a "findings" key that is not the top-level one is not mistaken for it', () => {
  const text = `{"summary":"s","nested":{"findings":[${whole('inner')}]},"findings":[${whole('outer')},`;
  assert.deepEqual(
    salvageFindings(text).map((f) => f.id),
    ['outer'],
  );
});

test('a top-level value that is the word "findings" is scanned past, not taken for the end (#429)', () => {
  // Before #429 the scan returned null at the first `"findings"` at depth 1 that
  // was not followed by `:`, so a summary of one word lost every whole finding.
  const text = `{"verdict":"REVISE","summary":"findings","findings":[${whole('after-the-word')},${' '.repeat(2_000)}`;
  assert.deepEqual(
    salvageFindings(text).map((f) => f.id),
    ['after-the-word'],
  );
  // Still nothing when the word is the only "findings" there is.
  assert.deepEqual(salvageFindings('{"verdict":"REVISE","summary":"findings",'), []);
});

test('anything unreadable gives an empty list rather than an error', () => {
  for (const text of ['', '   ', 'not json', '{"findings":', '{"findings":{"a":1}}', '{"findings":["x"]}', '[]']) {
    assert.deepEqual(salvageFindings(text), [], JSON.stringify(text));
  }
});

test('collapseBlankRuns leaves code indentation alone and shortens a stall, keeping its count', () => {
  const indented = `"excerpt":"if (a) {\n${' '.repeat(25)}return b;"`;
  assert.equal(collapseBlankRuns(indented), indented);
  assert.equal(collapseBlankRuns(' '.repeat(999)), ' '.repeat(999), 'below the threshold');
  assert.equal(collapseBlankRuns(`{}${' \n\t\r'.repeat(25_000)}x`), '{}<… 100,000 blank characters …>x');
  assert.equal(trailingBlank(`{} \n${' '.repeat(10)}`), 12);
  assert.equal(trailingBlank('{}'), 0);
});

test('a model_said line for a message that stalled into blank space is short', () => {
  const snapshot = emptySnapshot();
  const text = `{"verdict":"REVISE"${' '.repeat(100_000)}`;
  parseCodexLine(snapshot, JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
  assert.equal(snapshot.said.length, 1);
  const said = snapshot.said[0] ?? '';
  assert.ok(said.length < 200, `said ${said.length} characters`);
  assert.match(said, /<… 100,000 blank characters …>/);
});

test('the retry note hands the findings over as unverified, and says so when there are none', () => {
  const finding = parseFinding(JSON.parse(whole('one')) as unknown, 0);
  const note = cutOffNote([finding], FINDINGS_SCHEMA);
  assert.match(note, /^## An earlier attempt at this turn was cut off/);
  assert.match(note, /It had written these findings in full\. Check each one again as if it were new; it has not been verified\./);
  assert.ok(note.includes('"id": "one"'));

  const none = cutOffNote([], FINDINGS_SCHEMA);
  assert.match(none, /cut off at its output limit before it finished/);
  assert.ok(!none.includes('```'), 'no findings, no findings block');
});
