import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { BriefOffer } from './BriefOffer';
import cockpit from './Cockpit.tsx?raw';

/**
 * The column's way into a run, said for the moment it is in (#410).
 *
 * A run finished with exit 0 and the top of its column read *waiting for the
 * brief · Describe the work to your pilot*, above the rail and the summary of
 * the run that had just finished, two inches from a status card saying *Run
 * complete*. The offer of a next run was right - `serve.ts` takes another invoke
 * once the first settles (#304) - but it was made in the empty column's words
 * and in the place a run's own status goes.
 */

function offer(after: boolean): string {
  return renderToStaticMarkup(createElement(BriefOffer, { after, onCustomize: () => {}, disabled: false }));
}

test('the empty column still waits for the brief, as HANDOFF.md draws it', () => {
  const html = offer(false);
  expect(html).toContain('waiting for the brief');
  expect(html).toContain('Customize this run');
});

test('after a run, the offer says it is the next one and never that it is waiting', () => {
  const html = offer(true);
  expect(html).toContain('Next run');
  expect(html).toContain('This run has ended.');
  expect(html).not.toContain('waiting for the brief');
  // The way to set this run's options is still offered beside it.
  expect(html).toContain('Customize this run');
});

/*
 * Where each is drawn. Source-read, as the other placement pins are
 * (`opened-run.test.ts`): the cockpit needs a host to mount, and the app has no
 * jsdom.
 */

test('the empty column offers the brief only when no run is on screen', () => {
  // The old guard was `shownLive === null || settled(run)`, which is what put
  // the empty column's words above an ended run.
  // (The pilot pane's `Kickoff` keeps that guard, rightly: it is the repository
  // field, not a sentence about the run.)
  expect(cockpit).not.toMatch(/\(shownLive === null \|\| settled\(run\)\) && !outside/);
  expect(cockpit).toMatch(/\{shownLive === null && !outside && \(\s*<BriefOffer\s+after=\{false\}/);
});

test('an ended run is offered the next one after its rail and summary, not above them', () => {
  const rail = cockpit.indexOf('<LoopColumn\n                run={columnRun}');
  const summary = cockpit.indexOf('{columnRun.completed?.exit === 0 && <Summary run={columnRun} />}');
  const next = cockpit.search(/settled\(run\) && !outside && \(\s*<BriefOffer\s+after\s/);
  expect(rail).toBeGreaterThan(-1);
  expect(summary).toBeGreaterThan(rail);
  expect(next).toBeGreaterThan(summary);
  // Only the live run's command has returned; an archived run opened for
  // reading is not an invitation to start one from it.
  expect(cockpit).toMatch(/\{!past && shownLive !== null && settled\(run\) && !outside && \(/);
});
