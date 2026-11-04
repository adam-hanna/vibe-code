import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachPriorIds } from '@src/findings-ledger.js';
import { mergeAcrossFinders } from '@src/finder-merge.js';
import type { FinderReport } from '@src/finder-merge.js';
import { REVIEW_LEDGER_SCHEMA, REVIEW_SCHEMA } from '@src/schemas.js';
import { validateStoredState } from '@src/stored.js';
import type { Finding, FindingsReport, FoundBy } from '@src/types.js';
import { report, reviewingRun } from './helpers/loop-harness.js';
import { cited, driveReview, threeRoundConfig } from './helpers/ledger-loop.js';

/**
 * A declared `prior_id`, from the schema to the record (#498).
 *
 * It is checked against the ledger the turn was shown, so a guess never counts
 * as a re-raise; it is recorded per seat in `foundBy[].priorId` and once on the
 * merged finding; and a stored value that is not a string or null costs only
 * that key. Nothing in the loop reads it - that is part 2.
 */

// ---- checking ----------------------------------------------------------------

const parsed = (ids: readonly string[]): FindingsReport => ({
  verdict: 'REVISE',
  summary: '',
  findings: ids.map((id) => cited(id)),
});

test('a listed id is kept, an unlisted one becomes null and is handed back, anything else is null', () => {
  const structured = {
    findings: [
      { prior_id: 'first-defect' },
      { prior_id: '  first-defect  ' },
      { prior_id: 'made-up' },
      { prior_id: null },
      { prior_id: 7 },
      { prior_id: '' },
      {},
    ],
  };
  const ids = new Set(['first-defect']);
  const { report: out, unknown } = attachPriorIds(parsed(['a', 'b', 'c', 'd', 'e', 'f', 'g']), structured, ids);
  assert.deepEqual(
    out.findings.map((f) => f.prior_id),
    ['first-defect', 'first-defect', null, null, null, null, null],
  );
  assert.deepEqual(unknown, [{ finding: 'c', value: 'made-up' }]);
});

// ---- through the loop --------------------------------------------------------

test('round 2: each seat keeps its own checked prior_id, the merged one is the first non-null, and a guess is null and said', async () => {
  const state = reviewingRun({ prefix: 'vibe-prior-id-loop-' });
  const review = (label: string): object => {
    if (label === 'review-0') {
      return report([cited('first-defect'), cited('other-defect', { title: 'An unrelated second claim' })]);
    }
    if (label === 'review-1') return report([cited('again', { title: 'The flag is still exported', prior_id: 'first-defect' })]);
    if (label === 'review-1-f1') {
      return report([
        // The same line as the reviewer's, so the two merge by citation.
        cited('again-f', { title: 'Mutable state leaks between callers', prior_id: 'other-defect' }),
        // Its own claim, naming an id no earlier round recorded.
        {
          ...cited('guess', { title: 'Quarterly totals round toward zero', prior_id: 'never-raised' }),
          evidence: [{ kind: 'external', ref: 'a spec' }],
        },
      ]);
    }
    return report([]);
  };
  await driveReview(state, threeRoundConfig(true), review);
  const round2 = JSON.parse(readFileSync(path.join(state.dir, 'code-review-1.json'), 'utf8')) as {
    findings: Finding[];
  };
  const merged = round2.findings.find((f) => f.id === 'again');
  assert.ok(merged !== undefined, JSON.stringify(round2.findings.map((f) => f.id)));
  assert.deepEqual(
    merged.foundBy?.map((s: FoundBy) => [s.seat, s.priorId]),
    [
      ['roles.reviewer', 'first-defect'],
      ['review.finders[0]', 'other-defect'],
    ],
    'two seats that disagree both keep theirs',
  );
  assert.equal(merged.prior_id, 'first-defect', 'the first non-null in finder order');

  const guess = round2.findings.find((f) => f.id === 'guess');
  assert.ok(guess !== undefined);
  assert.equal(guess.prior_id, null, 'an id the ledger did not list is recorded as null');
  assert.deepEqual(guess.foundBy?.map((s) => s.priorId), [null]);
  const said = state.events.filter((e) => e.type === 'prior_id_unknown');
  assert.equal(said.length, 1, JSON.stringify(said));
  assert.equal(said[0]?.['seat'], 'review.finders[0]');
  assert.equal(said[0]?.['value'], 'never-raised');
  assert.equal(said[0]?.['finding'], 'guess');
  assert.equal(said[0]?.['round'], 1);
});

test('the merged prior_id is the first non-null in finder order, and absent when no seat carries one', () => {
  const seat = (k: number, findings: Finding[]): FinderReport => ({
    k,
    seat: k === 0 ? 'roles.reviewer' : `review.finders[${k - 1}]`,
    provider: 'codex',
    model: 'default',
    report: { verdict: 'REVISE', summary: '', findings },
  });
  const { report: merged } = mergeAcrossFinders([
    seat(0, [cited('one', { prior_id: null })]),
    seat(1, [cited('one-f', { prior_id: 'listed-b' })]),
    seat(2, [cited('one-g', { prior_id: 'listed-c' })]),
  ]);
  const [only] = merged.findings;
  assert.equal(merged.findings.length, 1);
  assert.equal(only?.prior_id, 'listed-b');
  assert.deepEqual(only?.foundBy?.map((s) => s.priorId), [null, 'listed-b', 'listed-c']);

  const off = mergeAcrossFinders([seat(0, [cited('one')]), seat(1, [cited('one-f')])]).report.findings[0];
  assert.equal(off !== undefined && 'prior_id' in off, false);
  assert.equal(off?.foundBy?.some((s) => 'priorId' in s), false);
});

// ---- the schema --------------------------------------------------------------

test('prior_id sits directly after id and before severity, and nothing else in the finding moves', () => {
  const item = REVIEW_LEDGER_SCHEMA.properties.findings.items;
  const base = REVIEW_SCHEMA.properties.findings.items;
  assert.deepEqual(item.required.slice(0, 3), ['id', 'prior_id', 'severity']);
  assert.deepEqual(Object.keys(item.properties).slice(0, 3), ['id', 'prior_id', 'severity']);
  assert.deepEqual(
    item.required.filter((k) => k !== 'prior_id'),
    [...base.required],
  );
  assert.deepEqual(
    Object.keys(item.properties).filter((k) => k !== 'prior_id'),
    Object.keys(base.properties),
  );
  assert.deepEqual(item.properties.prior_id.type, ['string', 'null']);
  // The rest of the schema is the reviewer's own.
  assert.deepEqual(REVIEW_LEDGER_SCHEMA.required, REVIEW_SCHEMA.required);
  assert.equal(REVIEW_LEDGER_SCHEMA.properties.test_verdicts, REVIEW_SCHEMA.properties.test_verdicts);
});

// ---- stored state ------------------------------------------------------------

function widest(): Record<string, unknown> {
  const file = fileURLToPath(new URL('../../tests/fixtures/state/done-widest.json', import.meta.url));
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

const read = (raw: Record<string, unknown>): ReturnType<typeof validateStoredState> =>
  validateStoredState(raw, String(raw['id']), 'C:/nowhere');

/** A finding whose identity is malformed in both places, and one whose identity is fine. */
function damaged(severity: Finding['severity']): Record<string, unknown> {
  return {
    id: 'damaged',
    severity,
    title: 'A claim',
    detail: 'Detail.',
    suggested_fix: 'Fix it.',
    prior_id: 7,
    foundBy: [
      { seat: 'roles.reviewer', provider: 'codex', model: 'default', id: 'damaged', priorId: {} },
      { seat: 'review.finders[0]', provider: 'claude', model: 'default', id: 'damaged-f1', priorId: 'listed' },
    ],
  };
}

const repaired = {
  id: 'damaged',
  title: 'A claim',
  detail: 'Detail.',
  suggested_fix: 'Fix it.',
  foundBy: [
    { seat: 'roles.reviewer', provider: 'codex', model: 'default', id: 'damaged' },
    { seat: 'review.finders[0]', provider: 'claude', model: 'default', id: 'damaged-f1', priorId: 'listed' },
  ],
};

test('a malformed stored prior_id or priorId drops that key alone, with a repair at its path, wherever a finding is stored', () => {
  const cases: { field: string; raw: Record<string, unknown>; at: string; get: (s: Record<string, unknown>) => unknown }[] = [
    {
      field: 'pendingFindings',
      raw: { pendingFindings: { phase: 'review', findings: [damaged('P1')] } },
      at: 'pendingFindings.findings[0]',
      get: (s) => (s['pendingFindings'] as { findings: unknown[] }).findings[0],
    },
    {
      field: 'carried',
      raw: { carried: [damaged('P1')] },
      at: 'carried[0]',
      get: (s) => (s['carried'] as unknown[])[0],
    },
    {
      field: 'unaddressed',
      raw: { unaddressed: [{ finding: damaged('P2'), outcome: 'rebutted', reason: 'no' }] },
      at: 'unaddressed[0].finding',
      get: (s) => (s['unaddressed'] as { finding: unknown }[])[0]?.finding,
    },
    {
      field: 'finalFixConfirmations',
      raw: {
        finalFixConfirmations: { round: 2, since: null, claims: [damaged('P1')], findings: [] },
      },
      at: 'finalFixConfirmations.claims[0]',
      get: (s) => (s['finalFixConfirmations'] as { claims: unknown[] }).claims[0],
    },
  ];
  for (const c of cases) {
    const { state, repairs } = read({ ...widest(), ...c.raw });
    const finding = c.get(state as unknown as Record<string, unknown>) as Record<string, unknown> | undefined;
    assert.ok(finding !== undefined, `${c.field}: the finding survived`);
    const { severity: _severity, ...rest } = finding;
    assert.deepEqual(rest, repaired, c.field);
    assert.deepEqual(
      repairs.map((r) => r.field).filter((f) => f.startsWith(c.at)).sort(),
      [`${c.at}.foundBy[0].priorId`, `${c.at}.prior_id`],
      `${c.field}: ${JSON.stringify(repairs)}`,
    );
  }
});

test('a stored string or null prior_id loads untouched, with no repair', () => {
  const fine = { ...damaged('P1'), prior_id: null, foundBy: [{ seat: 'roles.reviewer', provider: 'codex', model: 'default', id: 'damaged', priorId: 'listed' }] };
  const { state, repairs } = read({ ...widest(), carried: [fine] });
  assert.deepEqual(state.carried, [fine]);
  assert.deepEqual(repairs.filter((r) => r.field.startsWith('carried')), []);
});
