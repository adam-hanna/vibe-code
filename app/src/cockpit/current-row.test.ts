import { expect, test } from 'vitest';
import cockpit from './Cockpit.tsx?raw';
import { rail } from './squares';

// *"On the left bar, I can't tell which run I'm in"* (#223). The sidebar was
// handed the LIVE run's id, so opening a past run never moved the highlight.
test('the sidebar highlights the run on screen, before the live one', () => {
  // Case 2 (#246): by repository and id, because an id alone is unique only
  // inside one repository and lit another project's row.
  expect(cockpit).toMatch(/current=\{\n\s*viewing !== null\n\s*\? \{ dir: viewing\.dir, runId: viewing\.runId \}/);
});

test('a run this window hosts is marked live before its archive says so, per project', () => {
  const runs = [{ id: 'a', task: 'one', status: 'running', liveness: 'not-running' }] as unknown as Parameters<typeof rail>[0];
  expect(rail(runs, null).map((r) => r.live)).toEqual([false]);
  expect(rail(runs, null, new Set(['a'])).map((r) => r.live)).toEqual([true]);
});

test('exactly the named run is current', () => {
  const runs = [
    { id: 'a', task: 'one', status: 'needs-input', liveness: 'stopped' },
    { id: 'b', task: 'two', status: 'running', liveness: 'running' },
  ] as unknown as Parameters<typeof rail>[0];
  expect(rail(runs, 'a').map((r) => r.current)).toEqual([true, false]);
  expect(rail(runs, null).some((r) => r.current)).toBe(false);
});
