import { expect, test } from 'vitest';
import settings from './Settings.tsx?raw';

// *"I can't change maxWaitMinutes in project settings"* (#223). The save was
// refused because a run was going; the field kept the typed number, so it read
// as saved. Every save-on-blur field must re-seed when a save is refused.
test('every field that saves on blur resets when a save is refused', () => {
  const fields = ['NumberField', 'TextField', 'ListField'];
  for (const name of fields) {
    const start = settings.indexOf(`function ${name}(`);
    const body = settings.slice(start, settings.indexOf('\nfunction ', start + 1));
    expect(body, name).toMatch(/useContext\(Refusals\)/);
    expect(body, name).toMatch(/refusals\]\);/);
  }
  expect(settings).toMatch(/setRefusals\(\(n\) => n \+ 1\)/);
  expect(settings).toMatch(/<Refusals\.Provider value=\{refusals\}>/);
});
