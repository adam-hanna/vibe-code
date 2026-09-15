import { describe, expect, test } from 'vitest';
import cockpit from './Cockpit.tsx?raw';
import settings from './Settings.tsx?raw';
import questions from './QuestionsPane.tsx?raw';
import format from './format.ts?raw';
import { DRAFTS_KEY, draftsFor, findDraft, readDrafts, removeDraft, saveDraft } from './drafts';
import type { Draft } from './drafts';

/**
 * The settings screen's two new powers, and the dead end on the Questions tab
 * (#223).
 *
 * All three are the same complaint from different angles: the window could see
 * something and not act on it. It showed the questions and made you open a text
 * editor; it showed the prompts and made them read-only; and the four caps that
 * decide how hard a run tries were reachable only as CLI flags.
 */

describe('the saved prompt library is the window’s, not the project’s', () => {
  const one: Draft = { block: 'review breadth', name: 'strict', text: 'only the line I named' };

  test('saving twice under one name revises rather than collects', () => {
    // Somebody editing a draft, not making two. A library that appended would
    // fill up with versions nobody can tell apart.
    const once = saveDraft([], one);
    const twice = saveDraft(once, { ...one, text: 'revised' });
    expect(twice).toHaveLength(1);
    expect(twice[0]?.text).toBe('revised');
  });

  test('two blocks may each have a draft called the same thing', () => {
    // Keyed by (block, name). A library keyed by name alone would let a draft of
    // the reviewer's instructions overwrite one of the fixer's.
    const both = saveDraft(saveDraft([], one), { ...one, block: 'fix breadth' });
    expect(both).toHaveLength(2);
    expect(draftsFor(both, 'review breadth')).toHaveLength(1);
    expect(findDraft(both, 'fix breadth', 'strict')?.text).toBe(one.text);
  });

  test('a nameless or empty draft is refused rather than stored', () => {
    // One cannot be picked out of a list; the other is a deletion wearing a
    // save's clothes, and `removeDraft` is how a draft goes.
    expect(saveDraft([], { ...one, name: '  ' })).toHaveLength(0);
    expect(saveDraft([], { ...one, text: '  ' })).toHaveLength(0);
  });

  test('every failure reading the library is an empty library', () => {
    for (const raw of [null, 'not json', '7', '"a string"', '{}']) {
      expect(readDrafts(raw)).toEqual([]);
    }
  });

  test('an entry that cannot be drawn or adopted is dropped, the rest survive', () => {
    // An empty draft could never be adopted — the core ignores a blank override
    // and renders the default — so offering it would be offering a no-op.
    const read = readDrafts(
      JSON.stringify([
        { block: 'review breadth', name: 'kept', text: 'x' },
        { block: 'review breadth', name: '  ', text: 'x' },
        { block: 'review breadth', name: 'blank', text: '   ' },
        { name: 'no block', text: 'x' },
        'not an object',
      ]),
    );
    expect(read).toHaveLength(1);
    expect(read[0]?.name).toBe('kept');
  });

  test('removing takes only the one named', () => {
    const two = saveDraft(saveDraft([], one), { ...one, name: 'loose' });
    expect(removeDraft(two, 'review breadth', 'loose')).toHaveLength(1);
  });

  test('the library is localStorage and the config is what a turn reads', () => {
    // Three places, and the screen says which is which. A draft nobody has
    // adopted is not a fact about any run and has no business in a file the
    // whole team commits.
    expect(DRAFTS_KEY).toMatch(/^vibe\./);
    expect(settings).toMatch(/localStorage\.getItem\(DRAFTS_KEY\)/);
    // Adopting is the one that writes the project's file, and it is a separate
    // control from saving.
    expect(settings).toMatch(/save\(\{ prompts: \{ \[name\]: text \} \}\)/);
  });

  test('“use the default” clears the key rather than copying today’s text in', () => {
    // A cleared key follows the product forward when the default is improved; a
    // copy of today's text pins this project to today's.
    expect(settings).toMatch(/onAdopt\(block\.name, ''\)/);
    expect(settings).toMatch(/use the default/);
  });

  test('the screen no longer claims prompts are not configuration', () => {
    // The reversal, stated rather than quietly dropped.
    expect(settings).not.toMatch(/They are not editable here/);
    expect(settings).toMatch(/which\n\s*is committed/);
  });
});

describe('how many rounds, and what it will accept', () => {
  test('all four caps and the tolerance are on the screen', () => {
    // Every one was reachable only as a `--max-*` flag. `maxQuestionRounds` is
    // the one the report named directly, and it is first because it is the loop
    // that runs before any of the others.
    for (const key of [
      'maxQuestionRounds',
      'maxPlanRounds',
      'maxReviewRounds',
      'maxVerifyRounds',
      'p1Tolerance',
    ]) {
      expect(settings).toMatch(new RegExp(key));
    }
  });

  test('P0 is stated as having no setting, not offered as one', () => {
    // `gate()` refuses a round with any P0 before it looks at the tolerance at
    // all, so a run cannot be configured to accept one. A control would be a
    // promise the loop does not keep.
    expect(settings).toMatch(/Always zero, and there is no setting for it/);
  });

  test('a number is saved when you leave the field, not per keystroke', () => {
    // Each save rewrites `vibe.config.json` and answers with the result, so a
    // patch per character rewrites it five times to type `12` — and the
    // intermediate `1` is a real, valid, wrong setting.
    expect(settings).toMatch(/onBlur=\{commit\}/);
    expect(settings).not.toMatch(/onChange=\{\(e\) => onSave\(/);
  });
});

describe('a model is typed, never picked from a list', () => {
  test('the role table has a model field and it is free text', () => {
    // `RoleSetting.model` is validated only for being a non-empty string,
    // because "no allowlist and no default table: guessing whether a model
    // exists is the never-invent-a-number rule applied to a name". A dropdown
    // would be exactly that guess, going stale the week either vendor ships one
    // — which is the report: *"models are always evolving."*
    expect(settings).toMatch(/<th>model<\/th>/);
    expect(settings).toMatch(/id=\{`model-\$\{role\}`\}/);
    const cell = settings.slice(settings.indexOf('id={`model-'), settings.indexOf('id={`model-') + 400);
    expect(cell).not.toMatch(/<option/);
  });
});

describe('questions are answered where they are shown', () => {
  test('the halt no longer sends you to a text editor', () => {
    // *"It says I need to answer the questions in needs-input.md but thats
    // crazy, I should answer directly in the app on the questions page."*
    expect(format).toMatch(/Answer them on the Questions tab/);
    // The file is still what gets written and still what the resume reads, so
    // it is named as the same act rather than deleted from the copy.
    expect(format).toMatch(/NEEDS-INPUT\.md by hand still works/);
  });

  test('the form writes the file and resumes as two acts, in that order', () => {
    // A write that also spent tokens would be one nobody could take back, and
    // would put spending behind a Save button.
    expect(questions).toMatch(/host\s*\n?\s*\.answerQuestions\(dir, runId, answers\)/);
    expect(questions).toMatch(/save\(\(\) => onResume\(runId, dir\)\)/);
    expect(questions).toMatch(/save \d+|save \$\{String\(answers\.length\)\} answer/);
  });

  test('the form appears on a halt, and is told rather than inferring one', () => {
    // An advisory question the answerer handled leaves open questions on a run
    // nobody is waiting on, and a box beside one would be refused by the core
    // for having no NEEDS-INPUT.md.
    expect(cockpit).toMatch(/halted=\{!past && run\.completed\?\.exit === NEEDS_HUMAN\}/);
    expect(questions).toMatch(/halted && runId !== null/);
  });

  test('a declined question is not offered a box', () => {
    // A decline already has the planner's own fallback behind it and is not
    // what the run is waiting on.
    expect(questions).toMatch(/\.filter\(\(q\) => q\.answer === null && !q\.declined\)/);
  });

  test('what it says about a blank is on the wire, not invented', () => {
    // The escalation file records what the planner would default to; `Question`
    // on the wire does not carry it. So the form says whether leaving one blank
    // ENDS the run rather than inventing the default it would take.
    expect(questions).toMatch(/q\.blocking/);
    expect(questions).not.toMatch(/recommended/);
  });
});
