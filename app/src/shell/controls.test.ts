import { describe, expect, test } from 'vitest';
import { statusBarControls } from './controls';
import statusBar from './StatusBar.tsx?raw';
import cockpit from '../cockpit/Cockpit.tsx?raw';

/**
 * One set of run controls on screen at a time (#264).
 *
 * The run column's footer and the status bar under it each drew live/pause/stop,
 * one directly above the other. The status bar keeps its controls only where the
 * footer is not showing them for the live run.
 */
describe('which of the two draws the controls', () => {
  test('the column open on the live run: the footer has them, the bar does not', () => {
    expect(statusBarControls(true, true)).toBe(false);
  });

  test('the column collapsed: the bar is the only place left, so it has them', () => {
    expect(statusBarControls(false, true)).toBe(true);
  });

  test('the column open on a past run: the footer answers for that run, so the bar keeps the live one', () => {
    // The footer draws `columnRun`. Hiding the bar here would leave a live run
    // with no way to pause or stop it while somebody browses the archive.
    expect(statusBarControls(true, false)).toBe(true);
  });
});

describe('the wiring', () => {
  test('the cockpit decides from the column and whether it shows the live run', () => {
    expect(cockpit).toContain('controls={statusBarControls(panels.loop, columnRun === run)}');
  });

  test('the bar keeps its state word and draws the buttons only with controls', () => {
    // Both the held gate's continue/stop and the live run's pause/stop.
    expect(statusBar.match(/\{controls && \(/g)?.length).toBe(2);
    expect(statusBar).toContain('<Badge variant="accent">holding</Badge>');
    expect(statusBar).toMatch(/<Badge variant="live">/);
  });
});
