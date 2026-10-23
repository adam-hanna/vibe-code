import { expect, test } from 'vitest';
import cockpit from './Cockpit.tsx?raw';

/**
 * A tab's count is how many things are behind it, so it counts what its pane
 * draws (#414).
 *
 * In the discussion phase with the pilot - a draft, not yet started - the bar
 * still read `Code · 3`, `Verify · 2`, `Questions · 1` and the last run's token
 * total, while each pane behind it said there was no run (#319). The panes had
 * learned the draft's one expression, `noRun`; the badges had not, and read the
 * window's last live run. Source-read, as `draft-column.test.ts` is: the cockpit
 * needs a host to mount and the app has no jsdom.
 */

test('the draft guard is decided before anything the badges read', () => {
  const noRun = cockpit.indexOf('const noRun = draftHasNoRun(drafting);');
  expect(noRun).toBeGreaterThan(-1);
  for (const reader of ['const openQuestions = ', 'const verifyOf = ', 'const codeCommits = ']) {
    expect(cockpit.indexOf(reader)).toBeGreaterThan(noRun);
  }
});

test('Code counts the commits its pane draws: none in a draft, the opened run’s for a past run', () => {
  expect(cockpit).toContain(
    'const codeCommits = noRun ? 0 : past ? (opened.run?.commits.length ?? 0) : run.commits.length;',
  );
  expect(cockpit).toContain("Code{codeCommits > 0 ? ` · ${String(codeCommits)}` : ''}");
  // Nothing in the bar counts the live run's commits directly any more.
  expect(cockpit).not.toContain('Code{run.commits.length');
});

test('Verify counts no passes in a draft', () => {
  const verify = cockpit.slice(cockpit.indexOf('const verifyOf = '));
  const body = verify.slice(0, verify.indexOf(';\n'));
  expect(body).toMatch(/: noRun\s*(\/\/[^\n]*\n\s*)*\? \{ passes: \[\], dir: liveRepo, runId: null, waiting: null \}/);
  // And the badge reads that, not the live run.
  expect(cockpit).toContain("Verify{verifyOf.passes.length > 0 ? ` · ${String(verifyOf.passes.length)}` : ''}");
});

test('the Questions badge and its pane read one expression, empty in a draft and on a past run', () => {
  expect(cockpit).toContain('const openQuestions = noRun ? null : latestQuestions(run);');
  expect(cockpit).toContain('const shownQuestions = past ? null : openQuestions;');
  expect(cockpit).toContain('questions={shownQuestions}');
  expect(cockpit).toMatch(/shownQuestions !== null && shownQuestions\.blocking > 0\s*\? ` · \$\{String\(shownQuestions\.blocking\)\}`/);
  // The badge used to read `openQuestions` while the pane read `past ? null :
  // openQuestions` - the shape the comment above them says broke once before.
  expect(cockpit).not.toMatch(/openQuestions !== null && openQuestions\.blocking/);
});

test('the usage readout says there is no run yet, not the last run’s tokens', () => {
  const readout = cockpit.slice(cockpit.indexOf('title="Usage for the live run"'));
  const body = readout.slice(0, readout.indexOf('</Button>'));
  expect(body).toMatch(/\{noRun\s*(\/\/[^\n]*\n\s*)*\? 'No run yet'\s*: run\.spend\.tokens === null/);
});
