import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAcrossFinders } from '@src/finder-merge.js';
import type { FinderReport } from '@src/finder-merge.js';
import type { Evidence, Finding, FindingsReport } from '@src/types.js';

/**
 * The merge across finders (#388 Part B, decision 8): by claim, and on doubt
 * keep both. Pure, so every rule is one case here.
 */

function finding(id: string, over: Partial<Finding> = {}): Finding {
  return {
    id,
    severity: 'P2',
    title: `Title of ${id}`,
    detail: `Detail of ${id}.`,
    suggested_fix: `Fix ${id}.`,
    ...over,
  };
}

const at = (p: string, line?: number): Evidence => ({ kind: 'code', path: p, ...(line === undefined ? {} : { line }) });

function rep(findings: Finding[], over: Partial<FindingsReport> = {}): FindingsReport {
  return { verdict: findings.length > 0 ? 'REVISE' : 'APPROVE', summary: 'sum', findings, ...over };
}

function finder(k: number, findings: Finding[], over: Partial<FinderReport> = {}): FinderReport {
  return {
    k,
    seat: k === 0 ? 'roles.reviewer' : `review.finders[${k - 1}]`,
    provider: 'codex',
    model: 'default',
    report: rep(findings),
    ...over,
  };
}

test('two finders citing the same code line are one defect', () => {
  const merged = mergeAcrossFinders([
    finder(0, [finding('a', { title: 'Cache never expires', evidence: [at('src/x.ts', 10)] })]),
    finder(1, [finding('b', { title: 'Unbounded growth of the map', evidence: [at('./src/x.ts', 10)] })]),
  ]);
  assert.equal(merged.report.findings.length, 1);
  assert.equal(merged.report.findings[0]?.id, 'a');
  assert.equal(merged.byCitation, 1);
  assert.equal(merged.byTitle, 0);
});

test('two finders with the same title in other words are one defect', () => {
  const merged = mergeAcrossFinders([
    finder(0, [finding('a', { title: 'The retry loop never stops on cancel' })]),
    finder(1, [finding('b', { title: 'retry loop never stops on a cancel' })]),
  ]);
  assert.equal(merged.report.findings.length, 1);
  assert.equal(merged.byTitle, 1);
  assert.equal(merged.byCitation, 0);
});

test('a near miss is kept as two: another line, another claim', () => {
  const merged = mergeAcrossFinders([
    finder(0, [finding('a', { title: 'Cache never expires', evidence: [at('src/x.ts', 10)] })]),
    finder(1, [finding('b', { title: 'Logger drops the last line', evidence: [at('src/x.ts', 11)] })]),
  ]);
  assert.deepEqual(merged.report.findings.map((f) => f.id), ['a', 'b']);
  // A citation with no line matches nothing.
  const lineless = mergeAcrossFinders([
    finder(0, [finding('a', { title: 'Cache never expires', evidence: [at('src/x.ts')] })]),
    finder(1, [finding('b', { title: 'Logger drops the last line', evidence: [at('src/x.ts')] })]),
  ]);
  assert.equal(lineless.report.findings.length, 2);
});

test("one finder's two findings are never merged here", () => {
  // Same title, same line, one finder: that finder chose to say two things, and
  // its own chunk merge has already run.
  const merged = mergeAcrossFinders([
    finder(0, [
      finding('a', { title: 'Retry loop ignores cancel', evidence: [at('src/x.ts', 1)] }),
      finding('b', { title: 'Retry loop ignores cancel', evidence: [at('src/x.ts', 1)] }),
    ]),
    finder(1, []),
  ]);
  assert.deepEqual(merged.report.findings.map((f) => f.id), ['a', 'b']);
  assert.equal(merged.byCitation + merged.byTitle, 0);
});

test('an id two unrelated findings share is re-keyed, and foundBy keeps what each finder said', () => {
  const merged = mergeAcrossFinders([
    finder(0, [finding('same', { title: 'Cache never expires' })]),
    finder(1, [finding('other', { title: 'Retry loop ignores cancel' })]),
    finder(2, [finding('same', { title: 'Logger drops the last line' })]),
  ]);
  assert.deepEqual(merged.report.findings.map((f) => f.id), ['same', 'other', 'same-f2']);
  const logger = merged.report.findings[2];
  assert.equal(logger?.title, 'Logger drops the last line');
  assert.deepEqual(logger?.foundBy, [{ seat: 'review.finders[1]', provider: 'codex', model: 'default', id: 'same' }]);
});

test('a collision on an already re-keyed id counts up', () => {
  const merged = mergeAcrossFinders([
    finder(0, [finding('x', { title: 'Cache never expires' }), finding('x-f2', { title: 'Retry loop ignores cancel' })]),
    finder(2, [finding('x', { title: 'Logger drops the last line' })]),
  ]);
  assert.deepEqual(merged.report.findings.map((f) => f.id), ['x', 'x-f2', 'x-f2-2']);
  assert.equal(merged.report.findings[2]?.foundBy?.[0]?.id, 'x');
});

test('the most blocking wins and carries its own text; a tie goes to the earliest', () => {
  const merged = mergeAcrossFinders([
    finder(0, [finding('a', { severity: 'P2', title: 'Cache never expires', defer: true, evidence: [at('a.ts', 1)] })]),
    finder(1, [finding('b', { severity: 'P1', title: 'Unbounded map growth', detail: 'B says.', suggested_fix: 'B fix.', evidence: [at('a.ts', 1)] })]),
    finder(2, [finding('c', { severity: 'P1', title: 'Memory grows forever', detail: 'C says.', evidence: [at('a.ts', 1)] })]),
  ]);
  const [only] = merged.report.findings;
  assert.equal(merged.report.findings.length, 1);
  assert.equal(only?.id, 'a', "the earliest finder's id");
  assert.equal(only?.severity, 'P1');
  assert.equal(only?.title, 'Unbounded map growth');
  assert.equal(only?.detail, 'B says.');
  assert.equal(only?.suggested_fix, 'B fix.');
  assert.equal(only?.defer, false, 'a blocking finding is never deferred');
  assert.deepEqual(only?.foundBy?.map((f) => f.id), ['a', 'b', 'c']);
});

test('evidence is the union, one entry per kind, path and line', () => {
  const merged = mergeAcrossFinders([
    finder(0, [finding('a', { evidence: [at('a.ts', 1), { kind: 'external', ref: 'docs' }] })]),
    finder(1, [finding('b', { title: 'Something else entirely', evidence: [at('./a.ts', 1), at('a.ts', 2)] })]),
  ]);
  assert.deepEqual(merged.report.findings[0]?.evidence, [at('a.ts', 1), { kind: 'external', ref: 'docs' }, at('a.ts', 2)]);
});

test('a guard downgrade stays with the finding it judged', () => {
  const judged = { from: 'P1' as const, reason: 'cited nothing that resolves' };
  // The loser was downgraded: the winner does not inherit it.
  const loserDowngraded = mergeAcrossFinders([
    finder(0, [finding('a', { severity: 'P2', downgraded: judged, evidence: [at('a.ts', 1)] })]),
    finder(1, [finding('b', { severity: 'P1', evidence: [at('a.ts', 1)] })]),
  ]);
  assert.equal(loserDowngraded.report.findings[0]?.downgraded, undefined);
  // The winner was downgraded and still wins: it keeps its own record.
  const winnerDowngraded = mergeAcrossFinders([
    finder(0, [finding('a', { severity: 'P2', downgraded: judged, evidence: [at('a.ts', 1)] })]),
    finder(1, [finding('b', { severity: 'P3', evidence: [at('a.ts', 1)] })]),
  ]);
  assert.deepEqual(winnerDowngraded.report.findings[0]?.downgraded, judged);
});

test('the verdict is REVISE from any finder, and the summary names each finder', () => {
  const merged = mergeAcrossFinders([
    finder(0, [], { report: rep([], { summary: 'First says fine.' }) }),
    finder(1, [], { model: 'gpt-x', report: rep([], { verdict: 'REVISE', summary: 'One worries.' }) }),
    finder(2, [], { provider: 'claude', report: rep([], { summary: 'Two agrees.' }) }),
  ]);
  assert.equal(merged.report.verdict, 'REVISE');
  assert.equal(
    merged.report.summary,
    'First says fine.\n\nFinder 1 (codex/gpt-x): One worries.\n\nFinder 2 (claude/default): Two agrees.',
  );
  const calm = mergeAcrossFinders([finder(0, []), finder(1, [])]);
  assert.equal(calm.report.verdict, 'APPROVE');
});

test('a finding only the first finder raised still says who found it', () => {
  const merged = mergeAcrossFinders([finder(0, [finding('mine')]), finder(1, [])]);
  assert.deepEqual(merged.report.findings[0]?.foundBy, [
    { seat: 'roles.reviewer', provider: 'codex', model: 'default', id: 'mine' },
  ]);
});
