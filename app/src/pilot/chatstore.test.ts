import { expect, test } from 'vitest';
import pane from './PilotPane.tsx?raw';
import store from './chatstore.ts?raw';

// *"Have I lost my pilot chats?!"* (#223): localStorage was full and every save
// failed inside a try that said nothing.
test('the pane keeps conversations through the store, never in localStorage', () => {
  expect(pane).not.toMatch(/localStorage\.(getItem|setItem|removeItem)\((key|before|bucket)/);
  expect(pane).toMatch(/putChat\(key, writable\(conversation\)\)/);
});

test('nothing is restored or saved before the stored conversations are read', () => {
  expect(pane).toMatch(/if \(!chats\.ready\) return;/);
  expect(pane).toMatch(/\[dir, runId, opened, chats\.ready\]/);
});

test('a failed save is shown, and a migrated conversation leaves localStorage only once the host has it', () => {
  expect(pane).toMatch(/chats\.failure !== null/);
  expect(store).toMatch(/await host\.saveChat\(key, value\);\s*cache\.set\(key, value\);\s*\}\s*localStorage\.removeItem\(key\);/);
});
