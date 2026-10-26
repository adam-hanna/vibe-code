import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineVerdicts, disagreements } from '@src/judge.js';
import type { SeatJudgement } from '@src/judge.js';
import type { JudgeFile, JudgeVerdict } from '@src/types.js';

/**
 * The rule that combines every review seat's verdict on a change to the judge
 * (#404), one case per row: any "not justified" wins, then any "unjudged", and
 * only a unanimous "justified" is justified. A dissent is never outvoted.
 */

const yes = (reason: string): JudgeVerdict => ({ justified: true, reason });
const no = (reason: string): JudgeVerdict => ({ justified: false, reason });

function file(verdict: JudgeFile['verdict'], path = 'tests/a.test.ts'): JudgeFile {
  return { path, oldPath: null, status: 'modified', added: 1, removed: 1, verdict };
}

function seat(k: number, ...files: JudgeFile[]): SeatJudgement {
  return {
    seat: k === 0 ? 'roles.reviewer' : `review.finders[${k - 1}]`,
    provider: k === 2 ? 'claude' : 'codex',
    model: k === 2 ? 'opus' : 'default',
    files,
  };
}

const combinedOf = (...seats: SeatJudgement[]): JudgeFile['verdict'] => combineVerdicts(seats)[0]?.verdict ?? 'unjudged';

test('every seat justified: justified, with the reviewer’s reason', () => {
  assert.deepEqual(
    combinedOf(seat(0, file(yes('reviewer'))), seat(1, file(yes('f1'))), seat(2, file(yes('f2')))),
    yes('reviewer'),
  );
});

test('one seat not justified among justified ones: not justified, with that seat’s reason', () => {
  assert.deepEqual(
    combinedOf(seat(0, file(yes('reviewer'))), seat(1, file(yes('f1'))), seat(2, file(no('f2 objects')))),
    no('f2 objects'),
  );
});

test('two dissents: the first in config order carries the reason', () => {
  assert.deepEqual(
    combinedOf(seat(0, file(yes('reviewer'))), seat(1, file(no('f1 objects'))), seat(2, file(no('f2 objects')))),
    no('f1 objects'),
  );
});

test('not justified beside unjudged: not justified', () => {
  assert.deepEqual(combinedOf(seat(0, file('unjudged')), seat(1, file(no('f1 objects')))), no('f1 objects'));
});

test('unjudged beside justified: unjudged, never justified', () => {
  assert.equal(combinedOf(seat(0, file(yes('reviewer'))), seat(1, file('unjudged')), seat(2, file(yes('f2')))), 'unjudged');
});

test('one seat alone: its own verdict, whatever it is', () => {
  for (const v of [yes('only'), no('only'), 'unjudged' as const]) assert.deepEqual(combinedOf(seat(0, file(v))), v);
});

test('a file a seat somehow lacks reads as unjudged for that seat', () => {
  assert.equal(combinedOf(seat(0, file(yes('reviewer'))), seat(1)), 'unjudged');
});

test('verdicts hold every seat in config order, with its provenance, after the file’s own fields', () => {
  const [only] = combineVerdicts([seat(0, file(yes('r'))), seat(1, file('unjudged')), seat(2, file(no('f2')))]);
  assert.deepEqual(only, {
    path: 'tests/a.test.ts',
    oldPath: null,
    status: 'modified',
    added: 1,
    removed: 1,
    verdict: no('f2'),
    verdicts: [
      { seat: 'roles.reviewer', provider: 'codex', model: 'default', verdict: yes('r') },
      { seat: 'review.finders[0]', provider: 'codex', model: 'default', verdict: 'unjudged' },
      { seat: 'review.finders[1]', provider: 'claude', model: 'opus', verdict: no('f2') },
    ],
  });
  assert.deepEqual(Object.keys(only ?? {}), ['path', 'oldPath', 'status', 'added', 'removed', 'verdict', 'verdicts']);
});

test('files keep the reviewer’s order, each combined on its own', () => {
  const a = 'tests/a.test.ts';
  const b = 'vibe.config.json';
  const files = combineVerdicts([
    seat(0, file(yes('r'), a), file(yes('r'), b)),
    seat(1, file(yes('f1'), a), file(no('f1'), b)),
  ]);
  assert.deepEqual(files.map((f) => [f.path, f.verdict]), [
    [a, yes('r')],
    [b, no('f1')],
  ]);
});

test('disagreements count only a justified seat against a not-justified one', () => {
  const files = combineVerdicts([
    seat(0, file(yes('r'), 'a'), file(yes('r'), 'b'), file(no('r'), 'c'), file('unjudged', 'd')),
    seat(1, file(no('f1'), 'a'), file('unjudged', 'b'), file('unjudged', 'c'), file(no('f1'), 'd')),
  ]);
  // a: justified vs not - a disagreement. b: justified vs unjudged - an omission.
  // c: not vs unjudged - no one said justified. d: unjudged vs not - likewise.
  assert.equal(disagreements(files), 1);
  assert.equal(disagreements([file(yes('no verdicts key'))]), 0);
});

test('no seats at all: nothing', () => {
  assert.deepEqual(combineVerdicts([]), []);
});
