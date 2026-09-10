import { describe, expect, test } from 'vitest';
import cockpit from './Cockpit.tsx?raw';
import { initials, rail } from './squares';
import type { ArchiveRun } from '../host';

/**
 * The left rail (hi-fi 1, §1.1 and §1.2 of `design/AUDIT.md`).
 *
 * Two claims are pinned here. The rail draws only what the archive vouched for,
 * and the tab bar it emptied stays empty — a `Settings` or `Runs` tab creeping
 * back would put the bar's twelve tabs back one at a time, which is exactly how
 * it got to twelve in the first place.
 */

const run = (over: Partial<ArchiveRun> = {}): ArchiveRun => ({
  id: '20260908-163330-build-a-todo-app',
  status: 'done',
  task: 'build a todo app',
  costUsd: null,
  ...over,
});

describe('the two letters on a square', () => {
  test('words, not characters — so a hyphenated task is not two letters of one word', () => {
    expect(initials('build a todo app')).toBe('BT');
    expect(initials('fix-ratelimit-wait')).toBe('FR');
  });

  test('articles are skipped, or every square would read the same', () => {
    // A rail of `AT`, `TH` and `AN` abbreviates every workstream to nothing.
    expect(initials('the appserver auth')).toBe('AA');
    expect(initials('a plan for the diff pane')).toBe('PD');
  });

  test('one word takes two of its own letters', () => {
    expect(initials('appserver')).toBe('AP');
  });

  test('nothing legible gets the absence mark, never a letter from an id', () => {
    // `··` is the same "no value" mark the loop column uses. Picking a letter
    // out of the run id would be a label about something the reader is not
    // looking at.
    expect(initials('')).toBe('··');
    expect(initials('!!! ???')).toBe('··');
  });
});

describe('what gets a square', () => {
  test('an entry the archive refused is not drawn at all', () => {
    // A square is an invitation to open something, and a symlink (#53) or an
    // entry `lstat` could not classify are exactly the ones nothing should
    // open. Filtered rather than drawn and disabled.
    const squares = rail(
      [run({ id: 'a' }), run({ id: 'b', linked: true }), run({ id: 'c', unverified: true })],
      null,
    );
    expect(squares.map((s) => s.id)).toEqual(['a']);
  });

  test('live is the archive’s verdict, never one derived here', () => {
    // `livenessOf` reads the lock, probes the pid and reads the ending stamp. A
    // rail deciding a run "looks running" would be a second classifier, and the
    // one on screen would be the one disagreeing with `vibe list`.
    expect(rail([run({ liveness: 'running' })], null)[0]?.live).toBe(true);
    expect(rail([run({ liveness: 'interrupted' })], null)[0]?.live).toBe(false);
    // No verdict at all is not "running". Fail closed.
    expect(rail([run()], null)[0]?.live).toBe(false);
  });

  test('the current run is the one the window says it is showing', () => {
    const squares = rail([run({ id: 'a' }), run({ id: 'b' })], 'b');
    expect(squares.map((s) => s.current)).toEqual([false, true]);
    // And nothing is current when the window has no run — an empty column must
    // not select the first square in the archive.
    expect(rail([run({ id: 'a' })], null)[0]?.current).toBe(false);
  });
});

describe('the tab bar the rail emptied', () => {
  // The bar is markup, so this reads the source. The claim is not about pixels:
  // it is that three specific things moved off the bar and must stay off it,
  // because each one drifting back is how twelve tabs happened.
  //
  // Sliced between the container and the first pane render rather than matched
  // with a `</div>`, which a nested element closes first.
  const from = cockpit.indexOf('<div className="v-cockpit__tabs">');
  const to = cockpit.indexOf("{tab === 'pilot' && ", from);
  const bar = from < 0 ? '' : cockpit.slice(from, to < 0 ? cockpit.length : to);
  /** Where a label first appears in the bar, or Infinity. Order, not pixels. */
  const at = (label: string): number => {
    const i = bar.indexOf(label);
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };

  test('the bar was found and is the bar', () => {
    expect(bar).toMatch(/v-cockpit__tab/);
    expect(bar).toMatch(/Findings/);
  });

  test('Settings and Runs are on the rail, not on the bar', () => {
    // `⚙` and the rail's squares. A tab for either is the divergence returning.
    expect(bar).not.toMatch(/>\s*Settings\b/);
    expect(bar).not.toMatch(/>\s*Runs\b/);
    expect(cockpit).toMatch(/onSettings=/);
    expect(cockpit).toMatch(/onRuns=/);
  });

  test('spend is a readout in the bar rather than a tab', () => {
    // Hi-fi 1 puts `1.9M tok · codex 5h 41%` right-aligned in this bar. The
    // pane behind it survives - the readout is the way in - but it costs no tab.
    expect(bar).not.toMatch(/v-cockpit__tab[^>]*>\s*Spend/);
    expect(bar).toMatch(/v-cockpit__readout/);
  });

  test('the readout says nothing rather than zero before anything is charged', () => {
    // A run that has spent nothing has not spent zero; it has not been measured.
    expect(bar).toMatch(/nothing charged yet/);
  });

  test('the design’s order, as far as the design names it', () => {
    // Hi-fi 1: Pilot chat · Output · Versions · Diff · Findings · Questions ·
    // Prompt. `Pilot chat` first is hi-fi 5 in as many words, and it is where
    // the window lands.
    expect(at('Pilot chat')).toBeLessThan(at('Output'));
    expect(at('Output')).toBeLessThan(at('Versions'));
    expect(at('Versions')).toBeLessThan(at('Diff'));
    expect(at('Diff')).toBeLessThan(at('Findings'));
    expect(at('Findings')).toBeLessThan(at('Questions'));
    // The three that postdate the artwork come after the seven it names, and
    // the readout is last because it is right-aligned.
    expect(at('Questions')).toBeLessThan(at('Verify'));
    expect(at('Prompt')).toBeLessThan(at('v-cockpit__readout'));
  });

  test('the window lands on the pilot', () => {
    expect(cockpit).toMatch(/>\('pilot'\);/);
  });
});
