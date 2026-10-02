import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULTS, withProjectFile } from '@src/config.js';
import type { Config } from '@src/types.js';

/**
 * A resume takes the project's file, not only the run's memory (#223).
 *
 * **The rule this widens, and why it was too narrow.** `state.config` exists so
 * a resume does not silently revert a setting: a run started with
 * `--max-question-rounds 5` used to come back at 3 the next time it was resumed
 * without the flag, and that is still worth preventing. What the stored config
 * being the *only* base also did was make the settings screen useless at the one
 * moment it is most wanted — *"if I adjust the number of maxQuestionRounds,
 * maxPlanRounds, etc, that needs to apply to ALL runs (for example, if I need to
 * bump that and continue)."* A run that stopped on a ceiling could not be
 * resumed past it by raising that ceiling, which is the only reason anybody
 * raises one.
 *
 * So three layers, each a stronger statement of intent than the one under it:
 * the run's **memory**, then the project's **file**, then the **flags** given on
 * this invocation.
 */

function repoWith(config: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-resume-cfg-'));
  mkdirSync(path.join(dir, '.vibe'), { recursive: true });
  writeFileSync(path.join(dir, 'vibe.config.json'), JSON.stringify(config), 'utf8');
  return dir;
}

/** A run's stored config, as `state.config` holds it: complete and resolved. */
function stored(over: Partial<Config> = {}): Config {
  return { ...DEFAULTS, ...over };
}

test('a cap raised in the file reaches a run that has already started', () => {
  // The report, in one case. The run remembers 3 because that is what it began
  // with; the file now says 9 because somebody typed it into the settings
  // screen, which writes this file.
  const dir = repoWith({ loop: { maxQuestionRounds: 9 } });
  const before = stored({ loop: { ...DEFAULTS.loop, maxQuestionRounds: 3 } });

  assert.equal(withProjectFile(before, dir).loop.maxQuestionRounds, 9);
});

test('the budget ceiling the run stopped on is raisable the same way', () => {
  // The screenshot that prompted this: *"a ceiling in `budget` was reached"*,
  // naming `budget.planShare`, beside a footer saying *"Settings has the caps"*
  // — which was true of the round caps and false of these.
  const dir = repoWith({ budget: { planShare: 0.8, maxTokens: 60_000_000 } });
  const before = stored();

  const after = withProjectFile(before, dir);
  assert.equal(after.budget.planShare, 0.8);
  assert.equal(after.budget.maxTokens, 60_000_000);
});

test('a key the file does not name keeps the run’s own value', () => {
  // The property `state.config` was added for, and it survives: a flag from an
  // earlier resume is in the run's memory and nowhere else, so nothing here
  // overwrites it.
  const dir = repoWith({ loop: { maxPlanRounds: 7 } });
  const before = stored({
    loop: { ...DEFAULTS.loop, maxPlanRounds: 2, maxQuestionRounds: 5 },
    claude: { ...DEFAULTS.claude, model: 'sonnet' },
  });

  const after = withProjectFile(before, dir);
  assert.equal(after.loop.maxPlanRounds, 7, 'the file names it, so the file wins');
  assert.equal(after.loop.maxQuestionRounds, 5, 'the file is silent, so the run keeps it');
  assert.equal(after.claude.model, 'sonnet', 'and the model it has been using');
});

test('a repository with no file leaves the run exactly as it was', () => {
  // `readRawConfig` answers `{}` for a repository with no file, which is the
  // honest reading — it claims nothing — and the run is then unchanged.
  const dir = mkdtempSync(path.join(tmpdir(), 'vibe-resume-nofile-'));
  const before = stored({ loop: { ...DEFAULTS.loop, maxPlanRounds: 2 } });

  assert.deepEqual(withProjectFile(before, dir), before);
});

test('an empty file claims nothing and changes nothing', () => {
  const dir = repoWith({});
  const before = stored({ loop: { ...DEFAULTS.loop, maxReviewRounds: 11 } });

  assert.equal(withProjectFile(before, dir).loop.maxReviewRounds, 11);
});

test('a section the file names only partly leaves its other keys alone', () => {
  // `mergeSection` merges keys rather than replacing the section, so naming one
  // cap does not reset the four beside it to their defaults — which would be the
  // silent revert this whole mechanism exists to prevent, arriving by a new
  // route.
  const dir = repoWith({ loop: { maxPlanRounds: 6 } });
  const before = stored({
    loop: { ...DEFAULTS.loop, maxPlanRounds: 2, maxReviewRounds: 9, p1Tolerance: 4 },
  });

  const after = withProjectFile(before, dir);
  assert.equal(after.loop.maxPlanRounds, 6);
  assert.equal(after.loop.maxReviewRounds, 9);
  assert.equal(after.loop.p1Tolerance, 4);
});

test('the file wins over a flag from an EARLIER resume, and that is the point', () => {
  // The one case where this genuinely reverses the old behaviour. A flag was a
  // one-off on one invocation; the file is a decision written into a document
  // the repository keeps. Flags given on *this* invocation still win over both,
  // which `resumeConfig` applies on top of what this returns.
  const dir = repoWith({ loop: { maxQuestionRounds: 2 } });
  const before = stored({ loop: { ...DEFAULTS.loop, maxQuestionRounds: 5 } });

  assert.equal(withProjectFile(before, dir).loop.maxQuestionRounds, 2);
});

test('the run’s own settings are the base, so an unmentioned section is whole', () => {
  // Not `loadConfig`, which would rebuild from DEFAULTS and lose everything the
  // run was carrying that the file does not repeat.
  const dir = repoWith({ loop: { maxPlanRounds: 6 } });
  const before = stored({ codex: { ...DEFAULTS.codex, model: 'gpt-5.6-pro', effort: 'low' } });

  const after = withProjectFile(before, dir);
  assert.equal(after.codex.model, 'gpt-5.6-pro');
  assert.equal(after.codex.effort, 'low');
});
