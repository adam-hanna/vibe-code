import { describe, expect, test } from 'vitest';
import settings from './Settings.tsx?raw';
import { PREVIEW, reviewMdLine } from './reviewmd';
import type { ReviewMdFrame } from '../host';

/**
 * The settings note about REVIEW.md (#389). The host never fetches for it, so
 * the note must never claim more than it read: an unfetched remote-tracking
 * base is "as last fetched", and every line says it is a preview, because a
 * run reads the file from the commit it actually starts at.
 */

const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function frame(over: Partial<ReviewMdFrame>): ReviewMdFrame {
  return {
    type: 'review_md',
    id: 1,
    dir: '/repo',
    ref: null,
    tracking: false,
    fetched: false,
    commit: SHA,
    reviewMd: { kind: 'absent' },
    ...over,
  };
}

describe('the REVIEW.md note', () => {
  test('present names where, the short commit and the size', () => {
    const line = reviewMdLine(frame({ reviewMd: { kind: 'present', blob: 'b'.repeat(40), bytes: 4198 } }));
    expect(line).toContain('REVIEW.md at HEAD (a1b2c3d), 4.1 KiB');
    expect(line).toContain(PREVIEW);
    expect(line).not.toContain('Over 32 KiB');
  });

  test('present over 32 KiB says it is sent whole', () => {
    const line = reviewMdLine(frame({ reviewMd: { kind: 'present', blob: 'b'.repeat(40), bytes: 40_000 } }));
    expect(line).toContain('Over 32 KiB; it is sent whole.');
  });

  test('absent says there is none there', () => {
    expect(reviewMdLine(frame({}))).toBe(`No REVIEW.md at HEAD (a1b2c3d). ${PREVIEW}`);
  });

  test('refused gives the reason it is not sent', () => {
    const line = reviewMdLine(frame({ reviewMd: { kind: 'refused', reason: 'REVIEW.md is a symbolic link' } }));
    expect(line).toContain('is not sent: REVIEW.md is a symbolic link');
    expect(line).toContain(PREVIEW);
  });

  test('an unfetched remote-tracking base is "as last fetched", and a local one is not', () => {
    const tracking = reviewMdLine(frame({ ref: 'origin/develop', tracking: true }));
    expect(tracking).toContain('origin/develop (a1b2c3d, as last fetched)');
    expect(reviewMdLine(frame({ ref: 'base', tracking: false }))).not.toContain('as last fetched');
    expect(reviewMdLine(frame({ ref: null }))).not.toContain('as last fetched');
  });

  test('every line with a commit carries the preview clause', () => {
    expect(PREVIEW).toContain('a run reads it from the commit it starts at');
    for (const reviewMd of [
      { kind: 'absent' } as const,
      { kind: 'present', blob: 'b'.repeat(40), bytes: 1 } as const,
      { kind: 'unreadable', reason: 'x' } as const,
    ]) {
      expect(reviewMdLine(frame({ reviewMd }))).toContain(PREVIEW);
    }
  });

  test('no commit to read says why, and claims no file', () => {
    const line = reviewMdLine(frame({ commit: null, reviewMd: null, reason: 'no commit for a run to start from yet' }));
    expect(line).toBe('REVIEW.md: no commit for a run to start from yet.');
  });

  test('the settings screen shows it for a project, in the review seats section, with no editor', () => {
    const at = settings.indexOf('who else reviews, and who votes</h3>');
    const end = settings.indexOf('</section>', at);
    expect(at).toBeGreaterThan(-1);
    expect(settings.slice(at, end)).toContain("{scope === 'project' && <ReviewMdNote dir={dir} />}");
    const note = settings.slice(settings.indexOf('function ReviewMdNote'), settings.indexOf('function Key('));
    expect(note).not.toMatch(/<input|<textarea|ProseField|onSave/);
  });
});
