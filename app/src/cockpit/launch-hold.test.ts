import { describe, expect, test } from 'vitest';
import cockpit from './Cockpit.tsx?raw';
import { chatKey, chatMove } from '../pilot/saved';

// *"Sometimes the run that starts, the pilot chat, progress etc gets confused
// with a previous run. It's like some key isn't unique somewhere"* (#223).
describe('a launch keeps the chat that proposed it until the run has an id', () => {
  const opened = chatKey('/repo', 'run-a');
  const bucket = chatKey('/repo', null);
  const started = chatKey('/repo', 'run-b');

  test('without the hold, the gap restored the project bucket and the run adopted THAT', () => {
    // The defect, as the two moves it was made of.
    expect(chatMove({ from: opened, to: bucket, intoRun: false, opened: false, stored: true, holding: true })).toBe('restore');
    expect(chatMove({ from: bucket, to: started, intoRun: true, opened: false, stored: false, holding: true })).toBe('adopt');
  });

  test('with it, the gap is a stay, and the run adopts the chat that proposed it', () => {
    expect(chatMove({ from: opened, to: opened, intoRun: true, opened: false, stored: true, holding: true })).toBe('stay');
    expect(chatMove({ from: opened, to: started, intoRun: true, opened: false, stored: false, holding: true })).toBe('adopt');
  });

  test('the cockpit holds on a pilot launch, and lets go once the run is known', () => {
    expect(cockpit).toContain('else setHoldChat(pilotAt.current);');
    expect(cockpit).toMatch(/if \(launchSettled \|\| viewing !== null \|\| draftId !== null\) setHoldChat\(null\);/);
  });
});
