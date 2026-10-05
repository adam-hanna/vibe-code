import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Footer } from './Footer';
import { emptyRun, reduce } from './model';
import type { Run } from './model';

function footer(run: Run): string {
  return renderToStaticMarkup(createElement(Footer, {
    run, busy: false, pausing: false, caps: null, gates: null, order: [],
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
    expect(html).toContain('Pause at the next gate');
    expect(html).toContain('Stop this turn now');
    expect(html).not.toContain('Ready when you are');
  });

  test('a turn without an identity frame is still controllable', () => {
    const run = reduce(emptyRun(), {
      type: 'narration', level: 'info', message: 'Planning',
      id: 'turn_started', data: { role: 'planner', kind: 'plan' },
    }, Date.now());
    expect(footer(run)).toContain('Stop this turn now');
  });
});
