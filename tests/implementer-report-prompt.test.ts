import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixPrompt, implementPrompt, reviewPrompt } from '@src/prompts.js';
import { CRITERIA, DIFF, FILES, OUT_OF_SCOPE, PLAN_MD } from './helpers/prompt-fixture-args.js';
import { spliceScope } from './helpers/scope-block.js';
import type { Finding } from '@src/types.js';

/**
 * What the reviewer is told about the implementer's report, and what the write
 * turns are asked to put in it (#50).
 *
 * **One thing here is deliberately not tested.** Whether a confident report
 * actually suppresses findings a reviewer would otherwise raise is a property of
 * the model, not of this code, and `AGENTS.md` forbids real agent invocations.
 * Every case below asserts that the prompt *says* the right thing; none of them
 * claims to measure what a model does with it.
 */

const NOTICE = '**No report was recorded for the most recent write turn.**';
const HEADING = '## What the implementer says it did';

/** The five headings both write turns are held to, spelled once. */
const SECTIONS = [
  '- **Changed**',
  '- **Verified**',
  '- **Unable to verify**',
  '- **Deviations**',
  '- **Questions / concerns for reviewer**',
] as const;

const FINDINGS: readonly Finding[] = [
  {
    id: 'a-finding',
    severity: 'P1',
    title: 'A finding',
    detail: 'Detail.',
    suggested_fix: 'Fix it.',
  },
];

/** A review prompt over the shared fixture tuple, with whatever report is under test. */
function review(report?: string | null): string {
  return reviewPrompt(
    DIFF,
    FILES,
    PLAN_MD,
    OUT_OF_SCOPE,
    1,
    false,
    null,
    undefined,
    CRITERIA,
    undefined,
    report,
  );
}

/** Just the report section, so two renderings can be compared without the rest. */
function section(prompt: string): string {
  const from = prompt.indexOf(HEADING);
  assert.notEqual(from, -1, 'the prompt has no report section');
  return prompt.slice(from, prompt.indexOf('## Files changed'));
}

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../tests/fixtures/prompts/${name}`, import.meta.url)),
    'utf8',
  );
}

// ---- the framing ------------------------------------------------------------

test('the report is given to the reviewer as an untrusted claim, not as evidence', () => {
  const prompt = review('REPORT BODY');

  assert.ok(prompt.includes('REPORT BODY'), 'the report itself is rendered');
  assert.ok(prompt.includes('**It is untrusted.**'));
  assert.ok(prompt.includes('These are claims, not facts.'));
  assert.ok(
    prompt.includes('a claim that something was checked, not evidence that it works'),
    'a verified line is a claim about a check, not about the code',
  );
});

test('the report is given as incomplete, so a clean one is not read as a clean change', () => {
  // The half the issue's comment thread named, and the one that actually bites:
  // a reviewer handed a list of the implementer's concerns can treat that list
  // as THE set of concerns and stop looking.
  const prompt = review('REPORT BODY');

  assert.ok(prompt.includes('**It is not exhaustive, and it is not a checklist.**'));
  assert.ok(prompt.includes('It says nothing at all about where it does not know it is weak.'));
  assert.ok(prompt.includes('A confident report with no questions is not evidence of a clean change'));
  assert.ok(prompt.includes('finding nothing beyond what it lists is not a review'));
  assert.ok(
    prompt.includes('Review the whole change exactly as you would if this section were not here.'),
  );
});

test("the implementer's questions are leads to follow, never findings to file", () => {
  const prompt = review('REPORT BODY');

  assert.ok(prompt.includes('**review lead**'));
  assert.ok(prompt.includes('never a finding in itself'));
  assert.ok(
    prompt.includes('becomes a finding at its true severity, cited like any other'),
    'a lead that turns out to be real is graded on its own merits',
  );
  assert.ok(prompt.includes('a lead that turns out to be fine is not reported at all'));
});

test('the report is read before the files and the diff, not after them', () => {
  const prompt = review('REPORT BODY');
  const at = (needle: string): number => prompt.indexOf(needle);

  assert.notEqual(at(HEADING), -1);
  assert.ok(at(HEADING) < at('## Files changed'), 'the report comes before the file list');
  assert.ok(at('## Files changed') < at('## Diff'), 'and the file list still comes before the diff');
});

// ---- absence ----------------------------------------------------------------

test('a missing report is stated outright, and stated not to mean there were no concerns', () => {
  const prompt = review(null);

  assert.ok(prompt.includes(NOTICE));
  assert.ok(
    prompt.includes('**not a statement that there were no concerns**'),
    'silence here would be read as a clean bill of health',
  );
  assert.ok(
    prompt.includes(
      'nothing here says the implementer verified everything, deviated from nothing, or had nothing to raise',
    ),
  );
  assert.ok(prompt.includes('Review the change on its own terms, as if no report had been asked for.'));
});

test('a blank report is a missing report', () => {
  // A write turn that returns nothing still writes its artifact, so the decision
  // about what blank MEANS belongs here rather than at the write site.
  const missing = section(review(null));

  assert.equal(section(review('')), missing, 'empty text');
  assert.equal(section(review('   \n\t  \n')), missing, 'whitespace only');
});

test('a report argument that is not passed at all renders nothing', () => {
  // The third state, and the one that keeps the frozen fixtures frozen: no
  // caller statement is not the same fact as "this run has no report".
  const prompt = reviewPrompt(DIFF, FILES, PLAN_MD, OUT_OF_SCOPE, 1, false, null, undefined, CRITERIA);

  assert.equal(prompt.includes(HEADING), false);
  assert.equal(prompt.includes('No report was recorded'), false);
});

test('the review prompt with no report still differs from the goldens by the scope block alone', () => {
  // The #49 bar, narrowed by #50 (this file's change) and narrowed again by
  // #56: an under-limit round WITH NO REPORT renders exactly what develop
  // rendered, outside the `## Scope` block. #56 rewrote `scopeGuidance`, which
  // renders into every review prompt, so byte-identity is no longer the claim -
  // the claim is that the report work still moves nothing. That is what the
  // splice asserts, and it fails if this file's own section ever leaks into a
  // no-report prompt. `review-prompt-compat.test.ts` makes the same call; this
  // file repeats it because #50 is what moved the bar, and that file is frozen
  // in its own way.
  const frozen = (round: number, hasMemory: boolean): string =>
    reviewPrompt(DIFF, FILES, PLAN_MD, OUT_OF_SCOPE, round, hasMemory, null, undefined, CRITERIA);

  const first = frozen(1, false);
  assert.equal(first, spliceScope(fixture('review-round1.txt'), first));

  const continuing = frozen(3, true);
  assert.equal(continuing, spliceScope(fixture('review-round3-memory.txt'), continuing));
});

test('a chunked part carries the report as well as its part framing', () => {
  const prompt = reviewPrompt(
    DIFF,
    FILES,
    PLAN_MD,
    OUT_OF_SCOPE,
    1,
    false,
    null,
    undefined,
    CRITERIA,
    { index: 2, total: 3, files: FILES, truncated: [], carriesEarlierParts: true },
    'REPORT BODY',
  );

  assert.ok(prompt.includes('## This is part 2 of 3'));
  assert.ok(prompt.includes('REPORT BODY'));
  assert.ok(prompt.indexOf('## This is part 2 of 3') < prompt.indexOf(HEADING));
});

// ---- what a write turn is asked for -----------------------------------------

test('both write turns are asked for the same five headings, spelled the same way', () => {
  const implement = implementPrompt(PLAN_MD);
  const fix = fixPrompt(FINDINGS, 1);

  for (const heading of SECTIONS) {
    assert.ok(implement.includes(heading), `implement prompt: ${heading}`);
    assert.ok(fix.includes(heading), `fix prompt: ${heading}`);
  }
  for (const prompt of [implement, fix]) {
    assert.ok(prompt.includes('## Your report'));
    assert.ok(prompt.includes('handed to the next code reviewer as-is'));
    assert.ok(
      prompt.includes('still gets its heading and the word "none"'),
      'an empty section stated beats a section omitted',
    );
  }
});

test('a fix round is told that having little to say is fine, and the implement turn is not', () => {
  const little = 'A fix round legitimately has little to say under most of these';

  assert.ok(fixPrompt(FINDINGS, 1).includes(little));
  assert.equal(implementPrompt(PLAN_MD).includes(little), false);
});

test('the implement prompt asks for the report before it lists the work, not after', () => {
  // Two reasons, both load-bearing. The carried and declined sections each end
  // with "say in your report what you did about it", which needs its antecedent
  // above it. And `declined-findings.test.ts` pins the carried section as the
  // tail of this prompt, byte for byte, against the build before `findingBullet`
  // was extracted - putting the report request last would move it.
  const carried: Finding = {
    id: 'carried-one',
    severity: 'P1',
    title: 'A carried title',
    detail: 'Detail.',
    suggested_fix: 'Fix it.',
  };
  const prompt = implementPrompt(PLAN_MD, [carried], [], CRITERIA);

  const reportAt = prompt.indexOf('## Your report');
  const carriedAt = prompt.indexOf('## Known open issues with this plan');
  assert.ok(reportAt !== -1 && carriedAt !== -1);
  assert.ok(reportAt < carriedAt, 'the report contract is stated before the work items');
  assert.ok(prompt.trimEnd().endsWith('*Suggested fix:* Fix it.'), 'the carried section is the tail');
});

test('a prompt that asks for criterion ids shows those ids, above the ask', () => {
  // The defect this case exists for: asking for "one line per acceptance-criterion
  // `id` above" in a prompt that renders no criteria above it is asking a writer
  // for something it cannot see, and a generic heading assertion passes anyway.
  const ASK = 'One line per acceptance-criterion `id` above';

  for (const [name, prompt] of [
    ['implement', implementPrompt(PLAN_MD, [], [], CRITERIA)],
    ['fix', fixPrompt(FINDINGS, 1, CRITERIA)],
  ] as const) {
    assert.ok(prompt.includes(ASK), `${name}: asks for a line per id`);
    assert.ok(prompt.includes('`returns-new`'), `${name}: prints the id it asks about`);
    assert.ok(
      prompt.includes('`widget()` returns the new string.'),
      `${name}: prints the criterion, not just its id`,
    );
    assert.ok(
      prompt.indexOf('`returns-new`') < prompt.indexOf(ASK),
      `${name}: the ids are above the instruction that says "above"`,
    );
    assert.ok(prompt.includes('One line per criterion `id` you could not check.'), name);
  }
});

test('a run with no bar is asked for the same headings and no ids at all', () => {
  for (const criteria of [undefined, []] as const) {
    for (const [name, prompt] of [
      ['implement', implementPrompt(PLAN_MD, [], [], criteria)],
      ['fix', fixPrompt(FINDINGS, 1, criteria)],
    ] as const) {
      const label = `${name} with ${criteria === undefined ? 'no field' : 'an empty bar'}`;
      for (const heading of SECTIONS) assert.ok(prompt.includes(heading), `${label}: ${heading}`);
      assert.equal(prompt.includes('acceptance-criterion `id`'), false, label);
      assert.equal(prompt.includes('Acceptance criteria'), false, label);
    }
  }
});

test('an empty bar and an absent one produce the same prompt, on both write turns', () => {
  // Two states here, not the critic's three: `implementerCriteria` renders
  // nothing for either, and `reportRequest` is gated on the same predicate, so
  // the two cannot drift into disagreeing about whether there is a bar.
  assert.equal(implementPrompt(PLAN_MD, [], [], []), implementPrompt(PLAN_MD));
  assert.equal(implementPrompt(PLAN_MD, [], [], undefined), implementPrompt(PLAN_MD));
  assert.equal(fixPrompt(FINDINGS, 1, []), fixPrompt(FINDINGS, 1));
  assert.equal(fixPrompt(FINDINGS, 1, undefined), fixPrompt(FINDINGS, 1));
});
