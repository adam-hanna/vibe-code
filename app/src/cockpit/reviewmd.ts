import type { ReviewMdFrame } from '../host';

/**
 * The settings note about the repository's REVIEW.md (#389), as one sentence.
 *
 * **It never claims more than it read.** The host answers without fetching, so
 * a remote-tracking base is the commit as last fetched, and says so; and it is
 * a PREVIEW of the next run's start - a run reads REVIEW.md from the commit it
 * actually starts at, which this screen cannot know in advance.
 *
 * Pure, and kept out of `Settings.tsx` so it can be tested without rendering
 * the screen.
 */
export const PREVIEW = 'A preview: a run reads it from the commit it starts at.';

/** The same 32 KiB the core warns at - see `REVIEW_MD_WARN_BYTES` for where it comes from. */
const WARN_BYTES = 32 * 1024;

/** The core's `describeBytes` rule: "812 bytes", "4.1 KiB". */
function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(1)} KiB`;
}

export function reviewMdLine(frame: ReviewMdFrame): string {
  const read = frame.reviewMd;
  if (read === null || frame.commit === null) return `REVIEW.md: ${frame.reason ?? 'no commit to read it from'}.`;
  const at = frame.ref ?? 'HEAD';
  const stale = !frame.fetched && frame.tracking ? ', as last fetched' : '';
  const where = `${at} (${frame.commit.slice(0, 7)}${stale})`;
  switch (read.kind) {
    case 'present':
      return (
        `REVIEW.md at ${where}, ${size(read.bytes)} - the reviewer, finders and verifiers get it. ${PREVIEW}` +
        (read.bytes > WARN_BYTES ? ' Over 32 KiB; it is sent whole.' : '')
      );
    case 'absent':
      return `No REVIEW.md at ${where}. ${PREVIEW}`;
    default:
      return `REVIEW.md at ${where} is not sent: ${read.reason}. ${PREVIEW}`;
  }
}
