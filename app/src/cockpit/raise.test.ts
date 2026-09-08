import { describe, expect, test } from 'vitest';
import raiseSource from '../../../src/raise.ts?raw';
import { DETAIL, FIX, HEADING, raiseBlock } from './raise';

/**
 * The block this pane composes, against the parser that reads it (`1d`, #223).
 *
 * **These two files are one contract and nothing else connects them.** The app
 * does not link the core's modules, so the markers are duplicated — and a
 * duplicate that drifts produces a block the resume refuses rather than one it
 * misreads, which is the fail-closed direction and the one `src/raise.ts` was
 * written to take. This is what catches the drift.
 *
 * The composer **proposes**. There is no raise frame and there is not going to
 * be one: `AGENTS.md` says every `Decision` member that mutates run state needs
 * its own validator before it is offered, and a `raise` member is exactly that.
 * So what is under test is the text, because the text is the whole feature.
 */

const sample = {
  file: 'src/run.ts',
  line: 120,
  title: 'the lock is taken after the first write',
  detail: 'A resume can rewrite state another process is driving.',
  fix: 'Take the lock before loadRun, as cmdResume does.',
  severity: 'P1',
};

describe('the markers match the parser that reads them', () => {
  test('every marker this composes is one src/raise.ts looks for', () => {
    // Read from the core's own source rather than from a copy of it. If somebody
    // renames a marker there, this is what fails - and it fails here rather than
    // on a user's machine, silently, with a finding that was never raised.
    expect(raiseSource).toContain("const HEADING = 'Finding:'");
    expect(raiseSource).toContain(`const DETAIL = '${DETAIL}'`);
    expect(raiseSource).toContain(`const FIX = '${FIX}'`);
    // The heading is written with its `### ` here and without it there, because
    // the parser matches the text after the markdown.
    expect(HEADING).toBe('### Finding:');
  });

  test('the parser’s own template uses the same four markers', () => {
    // The other direction: `raiseSection` writes the empty block into
    // NEEDS-INPUT.md, and what this composes has to be a filled-in version of
    // exactly that - not a second format that happens to parse.
    expect(raiseSource).toContain('*Severity:*');
    expect(raiseSource).toContain('*File:*');
  });
});

describe('what the block says', () => {
  const block = raiseBlock(sample);

  test('the heading, the severity and the citation are all there', () => {
    expect(block).toContain('### Finding: the lock is taken after the first write');
    expect(block).toContain('*Severity:* P1');
    // The citation comes from the hunk rather than being typed, which is what
    // makes the finding grounded: `checkEvidence` runs on a human finding
    // exactly as it does on the reviewer's.
    expect(block).toContain('*File:* src/run.ts:120');
  });

  test('the detail and the fix are blockquote lines under their markers', () => {
    // The parser needs both the marker and the `> ` lines - the same rule
    // AGENTS.md states for answers, in the same words.
    expect(block).toContain('**What is wrong:**\n\n> A resume can rewrite state');
    expect(block).toContain('**Suggested fix:**\n\n> Take the lock before loadRun');
  });

  test('a multi-line paragraph quotes every line, not just the first', () => {
    const many = raiseBlock({ ...sample, detail: 'one\ntwo\n\nthree' });
    expect(many).toContain('> one\n> two\n> three');
  });

  test('an empty field leaves a bare marker, which the resume refuses', () => {
    // Deliberately not a plausible default. A block somebody began and did not
    // finish stops the resume and says which part is missing; filling it in
    // would put a claim nobody made into the one record that exists to say who
    // made which claim.
    const half = raiseBlock({ ...sample, fix: '' });
    expect(half).toContain('**Suggested fix:**\n\n>\n');
    expect(half).not.toContain('> Take the lock');
  });

  test('the severity is whatever was picked, including P0', () => {
    // All four, because a person restoring a P0 is the move #142 reserved for
    // them and this is the surface it happens on.
    for (const severity of ['P0', 'P1', 'P2', 'P3']) {
      expect(raiseBlock({ ...sample, severity })).toContain(`*Severity:* ${severity}`);
    }
  });
});
