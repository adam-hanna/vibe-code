import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { applyVotes, groundVoteEvidence } from '@src/evidence.js';
import { tally } from '@src/vote.js';
import type { Ballot, Finding, FindingsReport, Votes, VoteValue } from '@src/types.js';

/**
 * A vote's citations go through the grounding a finding's do, and the vote's
 * outcome moves a severity only through `toP2` (#388 Part C).
 */

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-vote-evidence-'));
  writeFileSync(path.join(dir, 'real.ts'), 'export const one = 1;\nexport const two = 2;\n', 'utf8');
  return dir;
}

test('a citation that resolves is kept and canonicalised; one that does not is reported', () => {
  const dir = repo();
  const ok = groundVoteEvidence(
    [{ kind: 'code', path: path.join(dir, 'real.ts'), line: 2, excerpt: null, ref: null }],
    dir,
    dir,
    null,
  );
  assert.equal(ok.unresolved, null);
  assert.equal(ok.evidence[0]?.path, 'real.ts');

  const missing = groundVoteEvidence(
    [{ kind: 'code', path: 'nowhere.ts', line: 1, excerpt: null, ref: null }],
    dir,
    dir,
    null,
  );
  assert.match(missing.unresolved ?? '', /^no citation resolved: /);
  assert.equal(missing.evidence[0]?.path, 'nowhere.ts', 'kept as the model wrote it');

  const none = groundVoteEvidence([], dir, dir, null);
  assert.deepEqual(none, { evidence: [], unresolved: 'it cited no evidence' });
});

function finding(id: string, severity: Finding['severity']): Finding {
  return { id, severity, title: id, detail: 'd', suggested_fix: 'f' };
}

function votes(...counted: VoteValue[]): Votes {
  const ballots = counted.map(
    (c): Ballot => ({ seat: 's', provider: 'codex', model: 'default', vote: c, counted: c, reason: 'r', evidence: [] }),
  );
  return tally(ballots, null);
}

const REPORT: FindingsReport = {
  verdict: 'REVISE',
  summary: '',
  findings: [
    finding('p0-unconfirmed', 'P0'),
    finding('p1-unconfirmed', 'P1'),
    finding('p1-confirmed', 'P1'),
    finding('p1-undecided', 'P1'),
    finding('p2-untouched', 'P2'),
  ],
};

function voted(): Map<string, Votes> {
  return new Map([
    ['p0-unconfirmed', votes('not-real', 'not-real', 'real')],
    ['p1-unconfirmed', votes('not-real', 'not-real', 'real')],
    ['p1-confirmed', votes('real', 'real', 'not-real')],
    ['p1-undecided', votes('real', 'cannot-tell', 'not-real')],
  ]);
}

test('an unconfirmed P1 is moved to P2 with the tally; confirmed and undecided keep their severity', () => {
  const out = applyVotes(REPORT, voted(), 'block');
  const by = new Map(out.report.findings.map((f) => [f.id, f]));
  assert.equal(by.get('p1-unconfirmed')?.severity, 'P2');
  assert.deepEqual(by.get('p1-unconfirmed')?.downgraded, {
    from: 'P1',
    reason: 'unconfirmed by vote: 1 real, 2 not-real, 0 cannot-tell of 3 (quorum 2)',
  });
  assert.equal(by.get('p1-confirmed')?.severity, 'P1');
  assert.equal(by.get('p1-undecided')?.severity, 'P1');
  assert.equal(by.get('p1-confirmed')?.votes?.outcome, 'confirmed');
  assert.equal(by.get('p1-undecided')?.votes?.outcome, 'undecided');
  // Not voted on: no key at all.
  assert.equal('votes' in (by.get('p2-untouched') ?? {}), false);
  assert.deepEqual(out.downgraded.map((f) => f.id), ['p1-unconfirmed']);
  // Pure: the input is untouched.
  assert.equal(REPORT.findings[1]?.severity, 'P1');
});

test('an unconfirmed P0 blocks, halts or demotes as unconfirmedP0 says', () => {
  const block = applyVotes(REPORT, voted(), 'block');
  assert.equal(block.report.findings[0]?.severity, 'P0');
  assert.equal(block.report.findings[0]?.downgraded, undefined);
  assert.deepEqual(block.held, []);

  const halt = applyVotes(REPORT, voted(), 'halt');
  assert.equal(halt.report.findings[0]?.severity, 'P0');
  assert.deepEqual(halt.held.map((f) => f.id), ['p0-unconfirmed']);
  assert.equal(halt.held[0]?.votes?.outcome, 'unconfirmed');

  const demote = applyVotes(REPORT, voted(), 'demote');
  assert.equal(demote.report.findings[0]?.severity, 'P2');
  assert.equal(demote.report.findings[0]?.downgraded?.from, 'P0');
  assert.deepEqual(demote.downgraded.map((f) => f.id), ['p0-unconfirmed', 'p1-unconfirmed']);
  assert.deepEqual(demote.held, []);
});
