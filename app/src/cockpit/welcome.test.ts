import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Footer } from './Footer';
import { emptyRun, reduce } from './model';
import type { Run } from './model';

function footer(run: Run, over: { pausing?: boolean; stopping?: boolean } = {}): string {
  return renderToStaticMarkup(createElement(Footer, {
    run, busy: false, pausing: over.pausing ?? false, stopping: over.stopping ?? false, caps: null, gates: null, order: [],
    onDecide: () => {}, onPause: () => {}, onStop: () => {},
    onResume: () => {}, onImplement: () => {},
  }));
}

describe('the empty workspace has no process controls', () => {
  test('before a run exists, pause and stop are absent', () => {
    const html = footer(emptyRun());
    expect(html).toContain('Ready when you are');
    expect(html).not.toContain('<button');
  });

  test('preflight still exposes the controls that can stop a real launch', () => {
    const run = reduce(emptyRun(), {
      type: 'narration', level: 'info', message: 'Checking agents',
      id: 'preflight_started', data: { agents: ['claude', 'codex'] },
    }, Date.now());
    const html = footer(run);
    // The labels were renamed in #253 (`Pause after this step`, `Stop run`); the
    // claim - both controls exist during preflight - is unchanged.
    expect(html).toContain('aria-label="Pause after this step"');
    expect(html).toContain('aria-label="Stop run"');
    expect(html).not.toContain('Ready when you are');
  });

  test('a turn without an identity frame is still controllable', () => {
    const run = reduce(emptyRun(), {
      type: 'narration', level: 'info', message: 'Planning',
      id: 'turn_started', data: { role: 'planner', kind: 'plan' },
    }, Date.now());
    expect(footer(run)).toContain('aria-label="Stop run"');
  });
});

describe('stopping and pausing say what they do (#253)', () => {
  const live = () =>
    reduce(emptyRun(), {
      type: 'narration', level: 'info', message: 'Planning',
      id: 'turn_started', data: { role: 'planner', kind: 'plan' },
    }, Date.now());

  test('a stop that is waiting is said, and offers nothing more to press', () => {
    const html = footer(live(), { stopping: true });
    expect(html).toContain('stopping');
    expect(html).toContain('You can resume the run afterwards');
    expect(html).not.toContain('<button');
  });

  test('a stop waiting on a step that is not an agent turn says it may take minutes', () => {
    const run = reduce(emptyRun(), {
      type: 'narration', level: 'info', message: 'Checking agents',
      id: 'preflight_started', data: { agents: ['claude', 'codex'] },
    }, Date.now());
    expect(footer(run, { stopping: true })).toContain('can take a few minutes');
  });

  test('the pause control speaks of steps, never of gates', () => {
    const idle = footer(live());
    expect(idle).toContain('>Pause<');
    expect(idle).not.toMatch(/at gate|armed/i);
    expect(footer(live(), { pausing: true })).toContain('Pausing after this step');
  });
});
