import { describe, expect, test } from 'vitest';
import { lockWarning, pairStep } from './pairing';
import type { PairInput, PairState } from './pairing';
import type { DesktopEntry, Reason } from './reason';

/** The pairing screen's states (#346), every path, with no camera. */

const entry: DesktopEntry = { id: 'd', relay: null, desktopName: 'Studio', name: null, pairedAt: 1, lastSeen: 1 };

function run(inputs: PairInput[], from: PairState = { step: 'confirming' }): PairState {
  return inputs.reduce(pairStep, from);
}

const toDialling: PairInput[] = [{ type: 'confirmed' }, { type: 'named' }, { type: 'scanned', attempt: 7 }];

describe('pairing', () => {
  test('dialling, then the code, then done', () => {
    expect(run(toDialling)).toEqual({ step: 'dialling', attempt: 7 });
    const coded = run([...toDialling, { type: 'code', attempt: 7, code: '123456' }]);
    expect(coded).toEqual({ step: 'code', attempt: 7, digits: '123456' });
    expect(pairStep(coded, { type: 'outcome', attempt: 7, outcome: { ok: entry } })).toEqual({ step: 'done', entry });
  });

  test('each pairing reason, and unreachable, end as failed', () => {
    const reasons: Reason[] = [
      { kind: 'pairRefused', reason: 'no' },
      { kind: 'pairDeclined' },
      { kind: 'unreachable' },
      { kind: 'phoneListUnreadable', why: 'x' },
      { kind: 'pairedNotSaved', desktopName: null, why: 'y' },
    ];
    for (const reason of reasons) {
      const coded = run([...toDialling, { type: 'code', attempt: 7, code: '1' }]);
      expect(pairStep(coded, { type: 'outcome', attempt: 7, outcome: { reason } })).toEqual({ step: 'failed', reason });
    }
  });

  test('a code from another attempt is ignored', () => {
    expect(run([...toDialling, { type: 'code', attempt: 6, code: '999999' }])).toEqual({ step: 'dialling', attempt: 7 });
  });

  test('after Back a failure is ignored, and the two outcomes where the desktop paired are not', () => {
    const cancelled = run([...toDialling, { type: 'code', attempt: 7, code: '1' }, { type: 'back' }]);
    expect(cancelled).toEqual({ step: 'cancelled' });
    expect(pairStep(cancelled, { type: 'outcome', attempt: 7, outcome: { reason: { kind: 'pairCancelled' } } })).toEqual(cancelled);
    expect(pairStep(cancelled, { type: 'outcome', attempt: 7, outcome: { reason: { kind: 'pairDeclined' } } })).toEqual(cancelled);
    expect(pairStep(cancelled, { type: 'outcome', attempt: 7, outcome: { ok: entry } })).toEqual({ step: 'done', entry });
    const notSaved: Reason = { kind: 'pairedNotSaved', desktopName: 'Studio', why: 'disk' };
    expect(pairStep(cancelled, { type: 'outcome', attempt: 7, outcome: { reason: notSaved } })).toEqual({
      step: 'failed',
      reason: notSaved,
    });
  });

  test('a lock warning only for a phone with no screen lock', () => {
    expect(lockWarning('none')).toBe('This phone has no screen lock, so anybody holding it can control your desktops.');
    expect(lockWarning('none', 'Studio')).toBe('This phone has no screen lock, so anybody holding it can control Studio.');
    expect(lockWarning('set')).toBeNull();
    expect(lockWarning('unknown')).toBeNull();
  });
});
