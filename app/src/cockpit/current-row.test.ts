import { expect, test } from 'vitest';
import cockpit from './Cockpit.tsx?raw';
import { rail } from './squares';

// *"On the left bar, I can't tell which run I'm in"* (#223). The sidebar was
// handed the LIVE run's id, so opening a past run never moved the highlight.
test('the sidebar highlights the run on screen, before the live one', () => {
  expect(cockpit).toMatch(/currentId=\{viewing\?\.runId \?\? /);
});

test('exactly the named run is current', () => {
  const runs = [
    { id: 'a', task: 'one', status: 'needs-input', liveness: 'stopped' },
    { id: 'b', task: 'two', status: 'running', liveness: 'running' },
  ] as unknown as Parameters<typeof rail>[0];
  expect(rail(runs, 'a').map((r) => r.current)).toEqual([true, false]);
  expect(rail(runs, null).some((r) => r.current)).toBe(false);
});
